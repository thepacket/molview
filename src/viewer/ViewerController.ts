/**
 * Bridges the React shell and the WebGPU engine.
 *
 * Owns the structures, the per-slot geometry rebuilds, the render loop and all
 * pointer interaction. React never touches GPU resources directly; it changes
 * store state, and the controller reconciles.
 */

import { Engine, MAX_SLOTS, type PickResult, type ViewportRect } from '../gfx/engine';
import type { CameraState } from '../gfx/camera';
import { buildGeometry, type SceneGeometry } from '../gfx/geometry';
import { computeBonds, type BondList } from '../mol/bonds';
import {
  defaultComponents, resolveComponents, Style, type ResolvedScene,
} from '../mol/components';
import { MolKind, resNameOf, atomNameOf, type Structure } from '../mol/structure';
import { loadStructure, type LoadHandle } from '../mol/loader';
import { fetchEntryDetail } from '../rcsb/api';
import { useStore, visibleSlotCount, type SlotState } from '../state/store';

interface SlotData {
  structure: Structure | null;
  ligandBonds: BondList;
  allBonds: BondList | null;
  geometry: SceneGeometry | null;
  loadHandle: LoadHandle | null;
  /** Snapshot of the settings the current geometry was built from. */
  builtSignature: string;
}

const EMPTY_BONDS: BondList = { indices: new Uint32Array(0), count: 0 };
/** Above this, whole-structure bond perception is not worth the stall. */
const BOND_PERCEPTION_LIMIT = 250_000;
/** copies x atoms above which assembly 1 is offered but not auto-selected. */
const ASSEMBLY_AUTO_LIMIT = 20_000_000;

/**
 * Whole-structure bond perception is expensive, so only run it when a layer
 * actually asks for sticks on polymer atoms — ligand connectivity is already
 * computed during load.
 */
function componentsNeedPolymerBonds(s: Structure, resolved: ResolvedScene): boolean {
  const { atomStyle } = resolved;
  for (let r = 0; r < s.residueCount; r++) {
    const kind = s.resKind[r];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;
    for (let a = s.resAtomStart[r], e = s.resAtomStart[r + 1]; a < e; a++) {
      if (atomStyle[a] === Style.BallStick || atomStyle[a] === Style.Licorice) return true;
    }
  }
  return false;
}

function emptySlotData(): SlotData {
  return {
    structure: null,
    ligandBonds: EMPTY_BONDS,
    allBonds: null,
    geometry: null,
    loadHandle: null,
    builtSignature: '',
  };
}

type DragMode = 'none' | 'rotate' | 'pan' | 'roll';

export class ViewerController {
  readonly engine = new Engine();
  private data: SlotData[] = Array.from({ length: MAX_SLOTS }, emptySlotData);
  private container: HTMLElement | null = null;
  private paneElements: (HTMLElement | null)[] = new Array(MAX_SLOTS).fill(null);
  private rafHandle = 0;
  private dirty = true;
  private running = false;
  private initialised = false;
  private initStarted = false;

  private dragMode: DragMode = 'none';
  private dragSlot = -1;
  private lastX = 0;
  private lastY = 0;
  private dragDistance = 0;
  private lastHoverTime = 0;
  private lastFrameTime = 0;
  private frameAccumulator = 0;
  private frameSamples = 0;

  async init(canvas: HTMLCanvasElement, container: HTMLElement): Promise<void> {
    this.container = container;
    // React StrictMode runs effects twice; device creation must not race.
    if (this.initStarted) return;
    this.initStarted = true;
    await this.engine.init(canvas);
    this.initialised = true;
    this.engine.onDeviceLost = (message) => {
      useStore.getState().setGpuInfo(this.engine.adapterInfo, message);
      this.stop();
    };
    useStore.getState().setGpuInfo(this.engine.adapterInfo, null);
    this.start();
  }

  get isReady(): boolean {
    return this.initialised;
  }

  registerPane(slot: number, element: HTMLElement | null): void {
    this.paneElements[slot] = element;
    this.invalidate();
  }

  getStructure(slot: number): Structure | null {
    return this.data[slot].structure;
  }

  invalidate(): void {
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async load(slot: number, entryId: string, file?: File): Promise<void> {
    const store = useStore.getState();
    const id = entryId.trim().toUpperCase();
    if (!id && !file) return;

    this.data[slot].loadHandle?.cancel();

    store.patchSlot(slot, {
      entryId: id,
      status: 'loading',
      error: null,
      progressStage: 'Fetching',
      progressLoaded: 0,
      progressTotal: 0,
      detail: null,
      stats: null,
      selectedResidue: null,
      selectionLabel: null,
      hoverLabel: null,
      representation: {
        ...store.slots[slot].representation,
        hiddenChains: new Set<string>(),
      },
    });

    // Metadata and coordinates are independent; the panel can populate while
    // the atoms are still downloading.
    if (!file) {
      void fetchEntryDetail(id)
        .then((detail) => {
          if (useStore.getState().slots[slot].entryId === id) {
            useStore.getState().patchSlot(slot, { detail });
          }
        })
        .catch(() => { /* metadata is a nicety; coordinates are the payload */ });
    }

    const fileData = file
      ? { buffer: await file.arrayBuffer(), name: file.name }
      : undefined;

    const handle = loadStructure(id, (p) => {
      const current = useStore.getState().slots[slot];
      if (current.entryId !== id) return;
      useStore.getState().patchSlot(slot, {
        progressStage: p.stage,
        progressLoaded: p.loaded,
        progressTotal: p.total,
      });
    }, fileData);

    this.data[slot].loadHandle = handle;

    try {
      const result = await handle.promise;
      if (useStore.getState().slots[slot].entryId !== id) return;

      this.data[slot] = {
        ...emptySlotData(),
        structure: result.structure,
        ligandBonds: result.ligandBonds,
      };
      this.engine.setStructure(slot, result.structure);

      const s = result.structure;
      useStore.getState().patchSlot(slot, {
        status: 'ready',
        progressStage: '',
        stats: {
          atoms: s.atomCount,
          residues: s.residueCount,
          chains: s.chainCount,
          triangles: 0,
          instances: 0,
        },
      });

      // A structure that is mostly nucleic or ligand should not open as an
      // empty cartoon; pick a representation that will actually show something.
      // Assembly first: it decides how many atoms are really on screen, which
      // is what the representation choice has to be based on.
      const copies = this.autoSelectAssembly(slot, s);
      // Components are rebuilt per structure: carrying the previous pane's
      // layers over is how you end up looking at a ligand in capsid spacefill.
      useStore.getState().setComponents(slot, defaultComponents(s, s.atomCount * copies));
      this.rebuild(slot);
      // Frame after the rebuild, not inside it: a store subscriber may already
      // have built this slot's geometry, and that path must never move a
      // camera the user is driving.
      this.frameSlot(slot);
    } catch (err) {
      if (useStore.getState().slots[slot].entryId !== id) return;
      useStore.getState().patchSlot(slot, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        progressStage: '',
      });
    } finally {
      this.data[slot].loadHandle = null;
    }
  }

  /**
   * The deposited coordinates are the asymmetric unit, which is frequently not
   * the biological molecule, so assembly 1 is the more honest default. The
   * guard is for icosahedral entries whose complete assembly is a few thousand
   * copies — those stay opt-in rather than ambushing the user on load.
   */
  private autoSelectAssembly(slot: number, s: Structure): number {
    const first = s.assemblies.find((a) => a.id === '1');
    const use = first && first.totalCopies * s.atomCount <= ASSEMBLY_AUTO_LIMIT;
    useStore.getState().patchSlot(slot, { assemblyId: use ? first.id : '' });
    return use ? first.totalCopies : 1;
  }

  unload(slot: number): void {
    this.data[slot].loadHandle?.cancel();
    this.data[slot] = emptySlotData();
    this.engine.setStructure(slot, null);
    this.engine.setGeometry(slot, null);
    useStore.getState().clearSlot(slot);
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private signatureOf(state: SlotState): string {
    const r = state.representation;
    return [
      r.showHydrogens, r.atomScale, r.bondRadius,
      [...r.hiddenChains].sort().join(','),
      state.colorScheme, state.uniformColor, state.assemblyId,
      state.components.map((c) => [
        c.selection, c.style, c.colorScheme ?? '', c.uniformColor, c.visible,
      ].join(',')).join(';'),
    ].join('|');
  }

  /** Points a slot's camera at all of its current geometry. */
  frameSlot(slot: number, animate = false): void {
    const geometry = this.data[slot].geometry;
    if (!geometry) return;
    this.engine.getCamera(slot).frame(geometry.center, geometry.radius, animate);
    this.invalidate();
  }

  /** Rebuilds a slot's GPU geometry if its settings changed. */
  rebuild(slot: number): void {
    const data = this.data[slot];
    const structure = data.structure;
    if (!structure) return;

    const state = useStore.getState().slots[slot];
    const signature = this.signatureOf(state);
    if (signature === data.builtSignature && data.geometry) return;

    const rep = state.representation;
    const resolved = resolveComponents(structure, state.components, {
      paneColorScheme: state.colorScheme,
      paneUniformColor: state.uniformColor,
      hiddenChains: rep.hiddenChains,
      showHydrogens: rep.showHydrogens,
      paletteOffset: slot * 3,
    });

    // Whole-structure connectivity is only needed when a component covering
    // polymer atoms asks for sticks; ligand bonds are always available.
    const needsAllBonds = componentsNeedPolymerBonds(structure, resolved);
    if (needsAllBonds && !data.allBonds) {
      data.allBonds = structure.atomCount <= BOND_PERCEPTION_LIMIT
        ? computeBonds(structure)
        : data.ligandBonds;
    }

    const assembly = structure.assemblies.find((a) => a.id === state.assemblyId) ?? null;

    const geometry = buildGeometry(
      structure,
      resolved,
      rep,
      data.ligandBonds,
      needsAllBonds ? data.allBonds : null,
      assembly,
    );

    data.geometry = geometry;
    data.builtSignature = signature;
    this.engine.setGeometry(slot, geometry);

    useStore.getState().patchSlot(slot, {
      componentCounts: resolved.counts,
      componentErrors: resolved.errors,
      stats: {
        atoms: geometry.totalAtoms,
        residues: structure.residueCount,
        chains: geometry.totalChains,
        triangles: geometry.totalTriangles,
        instances: geometry.totalSpheres + geometry.totalCylinders,
      },
    });

    this.invalidate();
  }

  syncSettings(): void {
    const { slots } = useStore.getState();
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.engine.setVisualSettings(i, slots[i].visual);
      if (this.data[i].structure) this.rebuild(i);
    }
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Camera commands
  // -------------------------------------------------------------------------

  resetView(slot: number): void {
    const geometry = this.data[slot].geometry;
    if (!geometry) return;
    const camera = this.engine.getCamera(slot);
    camera.orientation.set([0, 0, 0, 1]);
    camera.frame(geometry.center, geometry.radius, true);
    this.invalidate();
  }

  focusResidue(slot: number, residueIndex: number): void {
    const structure = this.data[slot].structure;
    if (!structure) return;
    const start = structure.resAtomStart[residueIndex];
    const end = structure.resAtomStart[residueIndex + 1];
    if (end <= start) return;

    let cx = 0, cy = 0, cz = 0;
    for (let a = start; a < end; a++) {
      cx += structure.x[a]; cy += structure.y[a]; cz += structure.z[a];
    }
    const n = end - start;
    const camera = this.engine.getCamera(slot);
    camera.animateTo({
      target: [cx / n, cy / n, cz / n],
      orientation: [
        camera.orientation[0], camera.orientation[1],
        camera.orientation[2], camera.orientation[3],
      ],
      distance: Math.max(12, camera.sceneRadius * 0.18),
    });
    this.invalidate();
  }

  focusChain(slot: number, chainAuthId: string): void {
    const structure = this.data[slot].structure;
    if (!structure) return;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let c = 0; c < structure.chainCount; c++) {
      if (structure.chainAuthId[c] !== chainAuthId) continue;
      const rStart = structure.chainResStart[c];
      const rEnd = structure.chainResStart[c + 1];
      if (rEnd <= rStart) continue;
      for (let a = structure.resAtomStart[rStart], e = structure.resAtomStart[rEnd]; a < e; a++) {
        if (structure.x[a] < minX) minX = structure.x[a];
        if (structure.x[a] > maxX) maxX = structure.x[a];
        if (structure.y[a] < minY) minY = structure.y[a];
        if (structure.y[a] > maxY) maxY = structure.y[a];
        if (structure.z[a] < minZ) minZ = structure.z[a];
        if (structure.z[a] > maxZ) maxZ = structure.z[a];
      }
    }
    if (!Number.isFinite(minX)) return;

    const camera = this.engine.getCamera(slot);
    const center: [number, number, number] = [
      (minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2,
    ];
    const radius = Math.max(0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ), 5);
    camera.animateTo({
      target: center,
      orientation: [
        camera.orientation[0], camera.orientation[1],
        camera.orientation[2], camera.orientation[3],
      ],
      distance: (radius * 1.2) / Math.sin(camera.fovY / 2),
    });
    this.invalidate();
  }

  /** Copies the active pane's camera onto every other loaded pane. */
  syncCameras(from: number): void {
    const source = this.engine.getCamera(from).getState();
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i === from || !this.data[i].structure) continue;
      const camera = this.engine.getCamera(i);
      const geometry = this.data[i].geometry;
      camera.animateTo({
        // Keep each structure centred on its own content, share the rotation.
        target: geometry ? [geometry.center[0], geometry.center[1], geometry.center[2]]
          : source.target,
        orientation: source.orientation,
        distance: source.distance,
      });
    }
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------------

  private slotAt(event: PointerEvent | WheelEvent): number {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const el = this.paneElements[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (
        event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      ) return i;
    }
    return -1;
  }

  private localCoords(slot: number, clientX: number, clientY: number): [number, number] {
    const el = this.paneElements[slot];
    if (!el) return [0, 0];
    const rect = el.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  onPointerDown(event: PointerEvent): void {
    const slot = this.slotAt(event);
    if (slot < 0) return;
    useStore.getState().setActiveSlot(slot);
    if (!this.data[slot].structure) return;

    this.dragSlot = slot;
    this.dragDistance = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;

    if (event.button === 1 || event.button === 2 || event.shiftKey) this.dragMode = 'pan';
    else if (event.altKey) this.dragMode = 'roll';
    else this.dragMode = 'rotate';

    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  onPointerMove(event: PointerEvent): void {
    if (this.dragMode === 'none') {
      this.handleHover(event);
      return;
    }
    const slot = this.dragSlot;
    const camera = this.engine.getCamera(slot);
    const el = this.paneElements[slot];
    if (!el) return;

    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.dragDistance += Math.abs(dx) + Math.abs(dy);

    const height = el.clientHeight || 1;
    const before = camera.getState();

    if (this.dragMode === 'rotate') {
      camera.rotate((dx / height) * 3.2, (dy / height) * 3.2);
    } else if (this.dragMode === 'pan') {
      camera.pan(dx, dy, height);
    } else {
      camera.roll((dx / height) * 3.2);
    }

    if (useStore.getState().linkedCameras) {
      this.applyLinkedDelta(slot, before, camera.getState());
    }
    this.invalidate();
  }

  private applyLinkedDelta(from: number, before: CameraState, after: CameraState): void {
    const distanceRatio = before.distance > 0 ? after.distance / before.distance : 1;
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i === from || !this.data[i].structure) continue;
      const camera = this.engine.getCamera(i);
      // Orientation is shared outright; distance is relative so each structure
      // keeps a sensible framing for its own size.
      camera.orientation.set(after.orientation);
      camera.distance *= distanceRatio;
    }
  }

  onPointerUp(event: PointerEvent): void {
    const wasDragging = this.dragMode !== 'none';
    const slot = this.dragSlot;
    const moved = this.dragDistance > 4;
    this.dragMode = 'none';
    this.dragSlot = -1;

    if (wasDragging && !moved && slot >= 0 && event.button === 0) {
      const [lx, ly] = this.localCoords(slot, event.clientX, event.clientY);
      const hit = this.engine.pick(slot, lx, ly);
      const structure = this.data[slot].structure;
      useStore.getState().patchSlot(slot, {
        selectedResidue: hit ? hit.residueIndex : null,
        selectionLabel: hit && structure ? describePick(structure, hit) : null,
      });
      this.invalidate();
    }
  }

  onDoubleClick(event: MouseEvent): void {
    const slot = this.slotAt(event as unknown as PointerEvent);
    if (slot < 0) return;
    const [lx, ly] = this.localCoords(slot, event.clientX, event.clientY);
    const hit = this.engine.pick(slot, lx, ly);
    if (hit) this.focusResidue(slot, hit.residueIndex);
    else this.resetView(slot);
  }

  onWheel(event: WheelEvent): void {
    const slot = this.slotAt(event);
    if (slot < 0 || !this.data[slot].structure) return;
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.0016);
    const camera = this.engine.getCamera(slot);
    const before = camera.getState();
    camera.zoom(factor);
    if (useStore.getState().linkedCameras) {
      this.applyLinkedDelta(slot, before, camera.getState());
    }
    this.invalidate();
  }

  private handleHover(event: PointerEvent): void {
    const slot = this.slotAt(event);
    const store = useStore.getState();
    if (slot < 0) return;

    const structure = this.data[slot].structure;
    if (!structure) return;

    // Picking is a linear scan over atom centres, repeated for every assembly
    // copy the ray could touch. Stretch the hover interval with the size of the
    // scene actually on screen so the cost stays a small fraction of the frame
    // budget instead of fighting the renderer.
    const now = performance.now();
    const sceneAtoms = this.data[slot].geometry?.totalAtoms ?? structure.atomCount;
    const interval = Math.max(45, sceneAtoms / 20000);
    if (now - this.lastHoverTime < interval) return;
    this.lastHoverTime = now;

    const [lx, ly] = this.localCoords(slot, event.clientX, event.clientY);
    const hit = this.engine.pick(slot, lx, ly);
    const label = hit ? describePick(structure, hit) : null;
    if (store.slots[slot].hoverLabel !== label) {
      store.patchSlot(slot, { hoverLabel: label });
    }
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(tick);
      this.frame();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  private frame(): void {
    if (!this.initialised || !this.container) return;

    const store = useStore.getState();
    const now = performance.now();
    const dt = this.lastFrameTime ? (now - this.lastFrameTime) / 1000 : 0;
    this.lastFrameTime = now;

    // Auto-spin runs independently of user input.
    let spinning = false;
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (!store.slots[i].spinning || !this.data[i].structure) continue;
      this.engine.getCamera(i).rotate(dt * 0.45, 0);
      spinning = true;
    }
    if (spinning) this.dirty = true;

    const rect = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.engine.resize(rect.width, rect.height, dpr)) this.dirty = true;

    const rects: (ViewportRect | null)[] = new Array(MAX_SLOTS).fill(null);
    const count = visibleSlotCount(store.layout);
    for (let i = 0; i < MAX_SLOTS; i++) {
      const el = i < count ? this.paneElements[i] : null;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      rects[i] = {
        x: r.left - rect.left,
        y: r.top - rect.top,
        width: r.width,
        height: r.height,
      };
    }
    this.engine.setLayout(rects);

    if (!this.dirty) return;
    this.dirty = false;

    const stillAnimating = this.engine.render();
    if (stillAnimating) this.dirty = true;

    // Averaged frame cost; a per-frame store write would cause more work than
    // it measures.
    this.frameAccumulator += this.engine.lastFrameMs;
    this.frameSamples++;
    if (this.frameSamples >= 30) {
      store.setFrameMs(this.frameAccumulator / this.frameSamples);
      this.frameAccumulator = 0;
      this.frameSamples = 0;
    }
  }

  async screenshot(slot: number): Promise<Blob | null> {
    // Force a fresh render so the swap-chain texture is valid this task.
    this.dirty = true;
    this.frame();
    const canvas = this.engine.canvasElement;
    if (!canvas) return null;

    const pane = this.paneElements[slot];
    const container = this.container;
    if (!pane || !container) return null;

    const dpr = this.engine.pixelRatio;
    const containerRect = container.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();

    const sx = Math.floor((paneRect.left - containerRect.left) * dpr);
    const sy = Math.floor((paneRect.top - containerRect.top) * dpr);
    const sw = Math.floor(paneRect.width * dpr);
    const sh = Math.floor(paneRect.height * dpr);

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  dispose(): void {
    this.stop();
    for (const d of this.data) d.loadHandle?.cancel();
    this.engine.destroy();
  }
}

function describePick(structure: Structure, hit: PickResult): string {
  const r = hit.residueIndex;
  const chain = structure.chainAuthId[structure.resChain[r]];
  const comp = resNameOf(structure, r);
  const atom = atomNameOf(structure, hit.atomIndex);
  return `${comp} ${structure.resSeq[r]} · ${chain} · ${atom}`;
}

export const viewer = new ViewerController();

if (import.meta.env.DEV) {
  // Handy for poking at a loaded structure from the console.
  (window as unknown as { viewer: ViewerController }).viewer = viewer;
}
