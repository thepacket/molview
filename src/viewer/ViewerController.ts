/**
 * Bridges the React shell and the WebGPU engine.
 *
 * Owns the structures, the per-slot geometry rebuilds, the render loop and all
 * pointer interaction. React never touches GPU resources directly; it changes
 * store state, and the controller reconciles.
 */

import { Engine, MAX_SLOTS, type PickResult, type ViewportRect } from '../gfx/engine';
import type { Camera, CameraState } from '../gfx/camera';
import { buildGeometry, type SceneGeometry } from '../gfx/geometry';
import { computeBonds, type BondList } from '../mol/bonds';
import {
  defaultComponents, resolveComponents, Style, type ResolvedScene,
} from '../mol/components';
import { MolKind, resNameOf, atomNameOf, type Structure } from '../mol/structure';
import { loadStructure, type LoadHandle } from '../mol/loader';
import {
  atomsNeeded, createMeasurement, describeAtom, findHydrogenBonds,
  measurementAnchor, type HydrogenBond,
} from '../mol/measure';
import { buildLabelInstances, type LabelRequest } from '../gfx/text';
import {
  AlignmentError, alignableChains, superposeChains,
  type AlignableChain, type AlignedPair,
} from '../mol/align';
import { evaluateSelection, parseSelection, selectionError } from '../mol/selection';
import { fetchEntryDetail } from '../rcsb/api';
import { orientationFor } from '../gfx/orient';
import {
  isosurface, levelWithinBudget, nearMask, type IsoMesh,
} from '../gfx/isosurface';
import {
  DEFAULT_SURFACE_OPTIONS, chargesOf, colorSurfaceByPotential, gaussianSurface,
} from '../gfx/surface';
import { VDW_RADII } from '../mol/elements';
import type { VolumeStyle } from '../gfx/engine';
import { recordTurntable } from './recorder';
import {
  mat4, mat4FromQuat, multiply, quat, quatFromAxisAngle, quatMultiply,
  quatNormalize, quatRotateInverse,
} from '../gfx/math';
import { colorKeyFor, type ColorKey } from '../mol/colorKey';
import {
  fetchAlphaMissense, fetchPae, fetchPrediction, type PaeMatrix,
} from '../rcsb/alphafold';
import { paintColorKey } from '../ui/colorKeyPainter';
import { QUANTITATIVE_SCHEMES, VALIDATION_SCHEMES, type ColorScheme } from '../mol/coloring';
import {
  fetchResidueValidation, worstResidues, type ResidueValidation,
} from '../rcsb/residueValidation';
import {
  NoVolumeError, fetchVolumes, sampleSigma,
  type Box, type MapKind, type VolumeGrid, type VolumeSet,
} from '../rcsb/volume';
import { useStore, visibleSlotCount, type SlotState } from '../state/store';

interface SlotData {
  structure: Structure | null;
  ligandBonds: BondList;
  allBonds: BondList | null;
  geometry: SceneGeometry | null;
  /** Last resolved component layers, reused by the contact search. */
  resolved: ResolvedScene | null;
  hydrogenBonds: HydrogenBond[];
  loadHandle: LoadHandle | null;
  /** Snapshot of the settings the current geometry was built from. */
  builtSignature: string;
  /** Raw bytes of a locally opened file, kept so projects can embed them. */
  sourceFile: { name: string; buffer: ArrayBuffer } | null;
  /**
   * Coordinates as loaded, kept only while a morph is running so the pane can
   * be put back exactly rather than approximately.
   */
  morphOrigin: { x: Float32Array; y: Float32Array; z: Float32Array } | null;
  /** Per-atom displacement towards the reference conformation. */
  morphDelta: Float32Array | null;
  /** The residue-by-residue result of the last superposition of this pane. */
  alignment: {
    pairs: AlignedPair[];
    referenceSlot: number;
    mobileChain: string;
    referenceChain: string;
  } | null;
  /** AlphaFold extras for this pane, if it holds a prediction. */
  predictionUrls: { pae: string | null; missense: string | null; length: number } | null;
  pae: PaeMatrix | null;
  missense: Float32Array | null;
  /** Per-residue wwPDB metrics, fetched the first time a scheme wants them. */
  residueValidation: ResidueValidation | null;
  residueValidationRequest: Promise<void> | null;
  /** Fetched density grids, kept so the contour can move without refetching. */
  volumes: VolumeSet | null;
  volumeRequest: AbortController | null;
  /**
   * The molecular surface mesh, cached against the settings that shaped it.
   * Generating one is seconds of work; changing its opacity should not be.
   */
  surfaceMesh: IsoMesh | null;
  surfaceSignature: string;
}

/**
 * Above this a local file is not worth holding a second copy of, and embedding
 * it in a project would be impractical anyway.
 */
const EMBEDDABLE_FILE_LIMIT = 25 * 1024 * 1024;

const EMPTY_BONDS: BondList = { indices: new Uint32Array(0), count: 0 };
const EMPTY_F32 = new Float32Array(0);
const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** Above this, whole-structure bond perception is not worth the stall. */
const BOND_PERCEPTION_LIMIT = 250_000;
/** copies x atoms above which assembly 1 is offered but not auto-selected. */
const ASSEMBLY_AUTO_LIMIT = 20_000_000;

/**
 * VolumeServer detail levels. Both saturate at the map's own sampling, so
 * these are ceilings rather than targets: 4 returns a small X-ray map at full
 * resolution, and 3 keeps an EM map near a megabyte instead of the eight it
 * would send at 4 — eight million samples is a two-second contour and millions
 * of triangles for detail no one can see through the model.
 */
const XRAY_DETAIL = 4;
const EM_DETAIL = 3;

const DEFAULT_LEVEL: Record<MapKind, number> = { 'x-ray': 1.5, em: 4 };

const MAIN_COLOR: [number, number, number] = [0.42, 0.62, 0.95];
const EM_COLOR: [number, number, number] = [0.62, 0.70, 0.82];
const DIFFERENCE_POSITIVE: [number, number, number] = [0.30, 0.82, 0.45];
const DIFFERENCE_NEGATIVE: [number, number, number] = [0.95, 0.35, 0.35];

/** Cartesian bounds of a structure, padded, as the box query wants it. */
function paddedBox(s: Structure, pad: number): Box {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let a = 0; a < s.atomCount; a++) {
    if (s.x[a] < minX) minX = s.x[a];
    if (s.x[a] > maxX) maxX = s.x[a];
    if (s.y[a] < minY) minY = s.y[a];
    if (s.y[a] > maxY) maxY = s.y[a];
    if (s.z[a] < minZ) minZ = s.z[a];
    if (s.z[a] > maxZ) maxZ = s.z[a];
  }
  return {
    min: [minX - pad, minY - pad, minZ - pad],
    max: [maxX + pad, maxY + pad, maxZ + pad],
  };
}

/**
 * "SOLUTION NMR" reads as "Solution NMR", not "Solution nmr". The archive
 * stores methods in capitals and the acronyms in them stay capitals.
 */
const METHOD_ACRONYMS = /\b(nmr|em|epr|xfel|3d)\b/gi;

function methodPhrase(method: string): string {
  const lower = method.toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return lower.replace(METHOD_ACRONYMS, (m) => m.toUpperCase());
}

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
    resolved: null,
    hydrogenBonds: [],
    loadHandle: null,
    builtSignature: '',
    sourceFile: null,
    morphOrigin: null,
    morphDelta: null,
    alignment: null,
    predictionUrls: null,
    pae: null,
    missense: null,
    residueValidation: null,
    residueValidationRequest: null,
    volumes: null,
    volumeRequest: null,
    surfaceMesh: null,
    surfaceSignature: '',
  };
}

type DragMode = 'none' | 'rotate' | 'pan' | 'roll';

/**
 * The clicked residue's cage, and its label, share one colour so the two read
 * as the same thing. Distinct from the measurement gold, the pending orange and
 * the hydrogen-bond blue already in the overlay.
 */
const SELECTION_COLOR: [number, number, number] = [1.0, 0.45, 0.85];

/** A label the pointer can pick up, in the frame the last render left it. */
interface LabelHandle {
  key: string;
  world: [number, number, number];
  offset: { x: number; y: number };
  width: number;
  height: number;
}

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
  private readyResolve!: () => void;
  /** Resolves once the engine exists, so callers can queue work behind it. */
  readonly ready = new Promise<void>((resolve) => { this.readyResolve = resolve; });

  /**
   * Pixel offsets for labels the user has moved, keyed `slot:measurementId`.
   * Kept here rather than on the measurement because it is a property of how
   * the scene is being looked at, not of the thing measured.
   */
  private labelOffsets = new Map<string, { x: number; y: number }>();
  /** Screen-space boxes of the draggable labels, rebuilt with the overlay. */
  private labelHandles: LabelHandle[][] = Array.from({ length: MAX_SLOTS }, () => []);
  private draggingLabel: LabelHandle | null = null;

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
    this.readyResolve();
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

  /** Raw bytes of a pane opened from disk, if they were small enough to keep. */
  getSourceFile(slot: number): { name: string; buffer: ArrayBuffer } | null {
    return this.data[slot].sourceFile;
  }

  invalidate(): void {
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  async load(
    slot: number, entryId: string, file?: File, modelNum?: number,
    allModels?: boolean, sourceUrl?: string,
  ): Promise<void> {
    const store = useStore.getState();
    const id = entryId.trim().toUpperCase();
    if (!id && !file) return;

    this.data[slot].loadHandle?.cancel();
    const keepCamera = (modelNum !== undefined || allModels !== undefined)
      && store.slots[slot].entryId === entryId.trim().toUpperCase();
    // A map belongs to the structure it was fetched for. Leaving it up would
    // draw one entry's density around another's model, which is the single
    // most misleading thing this feature could do.
    if (!keepCamera) {
      this.hideDensity(slot);
      this.hideSurface(slot);
    }

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
      measurements: [],
      pendingAtoms: [],
      hydrogenBondCount: 0,
      sourceFileName: file ? file.name : null,
      superposedOnto: null,
      superposeRmsd: null,
      superposePairs: null,
      representation: {
        ...store.slots[slot].representation,
        hiddenChains: new Set<string>(),
      },
    });

    // Metadata and coordinates are independent; the panel can populate while
    // the atoms are still downloading.
    // An AlphaFold model has no PDB entry behind it, so asking for one would
    // only produce a 404 and an empty Definition panel.
    if (!file && !sourceUrl) {
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

    // The buffer is transferred to the worker, so keep a copy first if we
    // might need to write it into a project later.
    const retained = fileData && fileData.buffer.byteLength <= EMBEDDABLE_FILE_LIMIT
      ? { name: fileData.name, buffer: fileData.buffer.slice(0) }
      : null;

    const handle = loadStructure(id, (p) => {
      const current = useStore.getState().slots[slot];
      if (current.entryId !== id) return;
      useStore.getState().patchSlot(slot, {
        progressStage: p.stage,
        progressLoaded: p.loaded,
        progressTotal: p.total,
      });
    }, { file: fileData, modelNum, allModels, sourceUrl });

    this.data[slot].loadHandle = handle;

    try {
      const result = await handle.promise;
      if (useStore.getState().slots[slot].entryId !== id) return;

      this.data[slot] = {
        ...emptySlotData(),
        structure: result.structure,
        ligandBonds: result.ligandBonds,
        sourceFile: retained,
      };
      this.engine.setStructure(slot, result.structure);
      this.engine.setSceneTransform(slot, IDENTITY);

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
      // camera the user is driving. Switching between models of one ensemble
      // keeps the current view, since the members are already superposed.
      // Orienting also frames, against the pane's aspect; fall back to the
      // bounding-sphere fit when the shape has no axes worth using.
      if (!keepCamera && !this.orientSlot(slot)) this.frameSlot(slot);
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
  /**
   * Loads an AlphaFold model by UniProt accession.
   *
   * Nearly all of this is the ordinary load path: the model is BinaryCIF and
   * the worker fetches it from a different address. What is different is
   * afterwards — a prediction has no experiment behind it, so the pane opens
   * coloured by confidence rather than by chain, because "how much of this
   * should I believe" is the first question a predicted structure raises and
   * a per-chain rainbow answers a question nobody asked of a monomer.
   */
  async loadPrediction(slot: number, accession: string): Promise<void> {
    const store = useStore.getState();
    try {
      const prediction = await fetchPrediction(accession);
      const id = `AF-${prediction.accession}`;

      await this.load(slot, id, undefined, undefined, undefined, prediction.bcifUrl);
      if (useStore.getState().slots[slot].entryId !== id) return;

      useStore.getState().patchSlot(slot, {
        colorScheme: 'plddt',
        prediction: {
          accession: prediction.accession,
          uniprotId: prediction.uniprotId,
          description: prediction.description,
          gene: prediction.gene,
          organism: prediction.organism,
          meanPlddt: prediction.meanPlddt,
          version: prediction.version,
          paeStatus: prediction.paeUrl ? 'idle' : 'absent',
          paeSize: 0,
          paeMax: 0,
          missenseStatus: prediction.alphaMissenseUrl ? 'idle' : 'absent',
          error: null,
        },
      });
      this.data[slot].predictionUrls = {
        pae: prediction.paeUrl,
        missense: prediction.alphaMissenseUrl,
        length: prediction.sequence.length,
      };
      this.rebuild(slot);
    } catch (err) {
      store.patchSlot(slot, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The PAE matrix for a pane, fetched on first use. */
  async loadPae(slot: number): Promise<PaeMatrix | null> {
    const data = this.data[slot];
    if (data.pae) return data.pae;
    const url = data.predictionUrls?.pae;
    if (!url) return null;

    useStore.getState().updatePrediction(slot, { paeStatus: 'loading', error: null });
    try {
      const pae = await fetchPae(url);
      this.data[slot].pae = pae;
      useStore.getState().updatePrediction(slot, {
        paeStatus: 'ready', paeSize: pae.size, paeMax: pae.max,
      });
      return pae;
    } catch (err) {
      useStore.getState().updatePrediction(slot, {
        paeStatus: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  getPae(slot: number): PaeMatrix | null {
    return this.data[slot].pae;
  }

  /** Per-residue AlphaMissense means, fetched on first use. */
  async loadMissense(slot: number): Promise<Float32Array | null> {
    const data = this.data[slot];
    if (data.missense) return data.missense;
    const urls = data.predictionUrls;
    if (!urls?.missense) return null;

    useStore.getState().updatePrediction(slot, { missenseStatus: 'loading', error: null });
    try {
      const scores = await fetchAlphaMissense(urls.missense, urls.length);
      this.data[slot].missense = scores;
      useStore.getState().updatePrediction(slot, { missenseStatus: 'ready' });
      // The colour scheme reads it straight from here.
      this.data[slot].builtSignature = '';
      this.rebuild(slot);
      return scores;
    } catch (err) {
      useStore.getState().updatePrediction(slot, {
        missenseStatus: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  getMissense(slot: number): Float32Array | null {
    return this.data[slot].missense;
  }

  private autoSelectAssembly(slot: number, s: Structure): number {
    const first = s.assemblies.find((a) => a.id === '1');
    const use = first && first.totalCopies * s.atomCount <= ASSEMBLY_AUTO_LIMIT;
    useStore.getState().patchSlot(slot, { assemblyId: use ? first.id : '' });
    return use ? first.totalCopies : 1;
  }

  /**
   * Starts a fresh project. Panes are unloaded individually rather than by
   * resetting the store alone, because the GPU buffers and structures live
   * outside it and would otherwise leak.
   */
  newProject(name: string): void {
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.data[i].loadHandle?.cancel();
      this.data[i] = emptySlotData();
      this.engine.setStructure(i, null);
      this.engine.setGeometry(i, null);
      this.engine.setSceneTransform(i, IDENTITY);
      this.engine.setOverlaySources(i, []);
      this.engine.setOverlay(i, EMPTY_F32);
      this.engine.setLabels(i, EMPTY_F32);
      this.engine.setVolumes(i, []);
    }
    useStore.getState().resetSession(name);
    this.invalidate();
  }

  unload(slot: number): void {
    // Nothing should keep drawing a structure that no longer exists.
    for (let i = 0; i < MAX_SLOTS; i++) {
      const sources = useStore.getState().slots[i].overlaySlots;
      if (sources.includes(slot)) this.setOverlaySlots(i, sources.filter((s) => s !== slot));
    }
    this.data[slot].loadHandle?.cancel();
    this.data[slot].volumeRequest?.abort();
    this.data[slot] = emptySlotData();
    this.engine.setStructure(slot, null);
    this.engine.setGeometry(slot, null);
    this.engine.setVolumes(slot, []);
    useStore.getState().clearSlot(slot);
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private signatureOf(state: SlotState): string {
    const r = state.representation;
    return [
      r.showHydrogens, r.atomScale, r.bondRadius, r.nucleotideStyle,
      [...r.hiddenChains].sort().join(','),
      state.colorScheme, state.uniformColor, state.assemblyId,
      state.components.map((c) => [
        c.selection, c.style, c.colorScheme ?? '', c.uniformColor, c.visible,
      ].join(',')).join(';'),
    ].join('|');
  }

  /**
   * Draws other panes' structures inside this one. They keep their own scene
   * transforms, so a superposed pair lands on top of each other rather than
   * side by side.
   */
  setOverlaySlots(slot: number, sources: number[]): void {
    const valid = sources.filter((s) => s !== slot && this.data[s].structure);
    this.engine.setOverlaySources(slot, valid);
    useStore.getState().patchSlot(slot, { overlaySlots: valid });
    this.frameSlot(slot, true);
    this.invalidate();
  }

  /**
   * Points a slot's camera at its geometry, plus anything overlaid onto it.
   * Overlaid bounds are pushed through their own scene transform first.
   */
  /**
   * Points the camera down the structure's shortest principal axis, once, when
   * it first loads. A deposited frame is an accident of the crystal, so the
   * default view is otherwise whatever the cell happened to give — 1BNA arrives
   * end-on down its own helix axis. Reset view deliberately does not do this:
   * once someone has turned a structure, snapping it back to a computed pose
   * would be the app overruling them.
   */
  /**
   * Re-orients an already-loaded pane to its own principal axes.
   *
   * The same computation that runs on load, offered as a command: after turning
   * a structure by hand it is the only way back to a view that was chosen for
   * the molecule rather than by the crystal. Distinct from reset, which returns
   * to the deposited frame and its arbitrary orientation.
   */
  orientView(slot: number): void {
    this.orientSlot(slot, true);
  }

  /**
   * Looks down a world axis, keeping the structure framed.
   *
   * Useful when the molecule has an axis of its own that matters — a helix, a
   * barrel, a fibre — and you want the standard views of it rather than the
   * one that happens to show the most.
   */
  viewAlongAxis(slot: number, axis: 'x' | 'y' | 'z', negative = false): void {
    const geometry = this.data[slot].geometry;
    if (!geometry) return;
    const camera = this.engine.getCamera(slot);

    // Quaternions that put each world axis down the camera's line of sight.
    const h = Math.SQRT1_2;
    const table: Record<string, [number, number, number, number]> = {
      x: [0, h, 0, h],
      y: [-h, 0, 0, h],
      z: [0, 0, 0, 1],
    };
    const q = table[axis];
    const flip: [number, number, number, number] = negative
      ? [q[1], -q[0], q[3], -q[2]]
      : q;

    camera.animateTo({
      target: [geometry.center[0], geometry.center[1], geometry.center[2]],
      orientation: flip,
      distance: (geometry.radius * 1.15) / Math.sin(camera.fovY / 2),
    });
    this.invalidate();
  }

  private orientSlot(slot: number, animate = false): boolean {
    const s = this.data[slot].structure;
    const geometry = this.data[slot].geometry;
    if (!s || !geometry) return false;

    // Judge the assembly as displayed, not the asymmetric unit: one group's
    // transforms are representative, and the largest group dominates the shape.
    let group = geometry.groups[0];
    for (const g of geometry.groups) {
      if (g.transformCount > group.transformCount) group = g;
    }

    const pose = orientationFor(
      s.x, s.y, s.z, s.atomCount,
      group ? group.transforms : new Float32Array(0),
      group ? group.transformCount : 0,
    );
    if (!pose) return false;

    const camera = this.engine.getCamera(slot);
    const { orientation: q, half, centre } = pose;
    // On load the orientation is set before framing; as a command both happen
    // in one animation, so the turn is passed to the fit rather than snapped.
    if (q && !animate) {
      camera.setState({ ...camera.getState(), orientation: [q[0], q[1], q[2], q[3]] });
    }

    // Sampling misses the outermost atoms and ignores every radius, so pad by
    // a spacefill sphere's worth rather than clipping the silhouette.
    const pad = 3;
    const element = this.paneElements[slot];
    const aspect = element && element.clientHeight > 0
      ? element.clientWidth / element.clientHeight
      : 1;
    camera.fitExtents(
      centre, half[0] + pad, half[1] + pad, half[2] + pad, aspect, animate,
      animate && q ? [q[0], q[1], q[2], q[3]] : undefined,
    );
    this.invalidate();
    return true;
  }

  frameSlot(slot: number, animate = false): void {
    const geometry = this.data[slot].geometry;
    const sources = [slot, ...useStore.getState().slots[slot].overlaySlots];

    let cx = 0, cy = 0, cz = 0, radius = 0;
    const spheres: { c: [number, number, number]; r: number }[] = [];

    for (const source of sources) {
      const g = this.data[source].geometry;
      if (!g) continue;
      const m = this.engine.getSceneTransform(source);
      const x = g.center[0], y = g.center[1], z = g.center[2];
      spheres.push({
        c: [
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ],
        r: g.radius,
      });
    }
    if (spheres.length === 0) {
      if (!geometry) return;
      this.engine.getCamera(slot).frame(geometry.center, geometry.radius, animate);
      this.invalidate();
      return;
    }

    // Centroid of the sphere centres, then the radius that reaches them all.
    for (const s of spheres) { cx += s.c[0]; cy += s.c[1]; cz += s.c[2]; }
    cx /= spheres.length; cy /= spheres.length; cz /= spheres.length;
    for (const s of spheres) {
      radius = Math.max(radius, Math.hypot(s.c[0] - cx, s.c[1] - cy, s.c[2] - cz) + s.r);
    }

    this.engine.getCamera(slot).frame([cx, cy, cz], radius, animate);
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
    // A validation scheme without its data would draw the whole structure the
    // colour of "not measured", so the fetch is kicked off here and the
    // rebuild repeats when it lands.
    this.ensureResidueValidation(slot, state);
    const resolved = resolveComponents(structure, state.components, {
      paneColorScheme: state.colorScheme,
      paneUniformColor: state.uniformColor,
      hiddenChains: rep.hiddenChains,
      showHydrogens: rep.showHydrogens,
      paletteOffset: slot * 3,
      residueValidation: data.residueValidation,
      missense: data.missense,
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
    data.resolved = resolved;
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

    // Contacts depend on what is visible, so they follow the layers.
    if (useStore.getState().slots[slot].showHydrogenBonds) {
      const bonds = findHydrogenBonds(structure, { mask: this.drawnAtomMask(slot) });
      this.data[slot].hydrogenBonds = bonds;
      useStore.getState().patchSlot(slot, { hydrogenBondCount: bonds.length });
    }
    this.refreshOverlay(slot);

    this.invalidate();
  }

  /**
   * Fetches per-residue validation once, if any layer wants to colour by it.
   *
   * Deliberately lazy: it is a second GraphQL round trip carrying a value per
   * residue, and most sessions never ask for it.
   */
  private ensureResidueValidation(slot: number, state: SlotState): void {
    const wanted = VALIDATION_SCHEMES.has(state.colorScheme)
      || state.components.some((c) => c.colorScheme && VALIDATION_SCHEMES.has(c.colorScheme));
    const data = this.data[slot];
    if (!wanted || data.residueValidation || data.residueValidationRequest) return;
    if (!state.entryId || state.sourceFileName) return;

    const entryId = state.entryId;
    data.residueValidationRequest = fetchResidueValidation(entryId)
      .then((validation) => {
        // The pane may have been reloaded with something else meanwhile.
        if (useStore.getState().slots[slot].entryId !== entryId) return;
        this.data[slot].residueValidation = validation;
        // Force the rebuild past its signature check: the settings did not
        // change, only what they can be evaluated against.
        this.data[slot].builtSignature = '';
        this.rebuild(slot);
      })
      .catch((err: unknown) => {
        useStore.getState().patchSlot(slot, {
          error: `Per-residue validation could not be fetched: ${
            err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => { this.data[slot].residueValidationRequest = null; });
  }

  /** The last superposition of this pane, residue by residue. */
  getAlignment(slot: number) {
    return this.data[slot].alignment;
  }

  // -------------------------------------------------------------------------
  // Morphing between two superposed conformations
  // -------------------------------------------------------------------------

  /**
   * Works out where every atom of this pane would have to go to become the
   * reference conformation.
   *
   * Each aligned residue is translated bodily by the displacement of its own
   * anchor, and residues with no partner are carried by their nearest aligned
   * neighbours. That is a straight line through space, not a physical path:
   * bond lengths stretch in the middle of the morph and no barrier is
   * respected. It shows *what* moved, which is what a 7 Å RMSD cannot say, and
   * it must not be read as *how*.
   *
   * Returns false when there is nothing to morph towards.
   */
  prepareMorph(slot: number): boolean {
    const structure = this.data[slot].structure;
    const alignment = this.data[slot].alignment;
    if (!structure || !alignment || alignment.pairs.length < 3) return false;
    const reference = this.data[alignment.referenceSlot].structure;
    if (!reference) return false;

    // The pane is already placed on the reference by a rigid transform, and the
    // shader applies it. Displacements therefore have to be expressed in this
    // structure's own frame, which means pulling the reference target back
    // through the inverse of that transform.
    const inv = this.engine.getSceneTransform(alignment.referenceSlot);
    const t = this.engine.getSceneTransform(slot);
    const invT = invertRigid(t);

    const delta = new Float32Array(structure.atomCount * 3);
    // Per residue first, then spread over its atoms.
    const residueDelta = new Map<number, [number, number, number]>();

    for (const pair of alignment.pairs) {
      const refAnchor = reference.resAnchor[pair.referenceResidue];
      const mobAnchor = structure.resAnchor[pair.mobileResidue];
      if (refAnchor < 0 || mobAnchor < 0) continue;

      // Reference position in world space, then into this pane's local frame.
      const rx = inv[0] * reference.x[refAnchor] + inv[4] * reference.y[refAnchor]
        + inv[8] * reference.z[refAnchor] + inv[12];
      const ry = inv[1] * reference.x[refAnchor] + inv[5] * reference.y[refAnchor]
        + inv[9] * reference.z[refAnchor] + inv[13];
      const rz = inv[2] * reference.x[refAnchor] + inv[6] * reference.y[refAnchor]
        + inv[10] * reference.z[refAnchor] + inv[14];

      const lx = invT[0] * rx + invT[4] * ry + invT[8] * rz + invT[12];
      const ly = invT[1] * rx + invT[5] * ry + invT[9] * rz + invT[13];
      const lz = invT[2] * rx + invT[6] * ry + invT[10] * rz + invT[14];

      residueDelta.set(pair.mobileResidue, [
        lx - structure.x[mobAnchor],
        ly - structure.y[mobAnchor],
        lz - structure.z[mobAnchor],
      ]);
    }
    if (residueDelta.size < 3) return false;

    // A homo-oligomer aligns on one chain, and morphing only that one makes
    // the other half look broken rather than stationary. Identical chains get
    // the same displacement, matched by residue number; chains with a
    // different sequence are left alone, because a displacement computed for
    // one protein means nothing for another.
    const chains = alignableChains(structure);
    const source = chains.find((c) => c.authId === alignment.mobileChain);
    if (source) {
      const bySeq = new Map<number, [number, number, number]>();
      for (const [residue, d] of residueDelta) bySeq.set(structure.resSeq[residue], d);
      for (const chain of chains) {
        if (chain.authId === source.authId || chain.sequence !== source.sequence) continue;
        for (const residue of chain.residues) {
          if (residueDelta.has(residue)) continue;
          const d = bySeq.get(structure.resSeq[residue]);
          if (d) residueDelta.set(residue, d);
        }
      }
    }

    // Unaligned residues follow the nearest aligned one in sequence, so a gap
    // or a ligand-adjacent loop is carried along rather than left behind while
    // everything around it moves.
    const aligned = [...residueDelta.keys()].sort((a, b) => a - b);
    for (let r = 0; r < structure.residueCount; r++) {
      let d = residueDelta.get(r);
      if (!d) {
        let nearest = aligned[0];
        let best = Math.abs(r - nearest);
        for (const candidate of aligned) {
          const distance = Math.abs(r - candidate);
          if (distance < best) { best = distance; nearest = candidate; }
        }
        // Only within a short reach: a separate chain should not be dragged
        // across the scene by a displacement computed for another one.
        d = best <= 20 ? residueDelta.get(nearest)! : [0, 0, 0];
      }
      for (let a = structure.resAtomStart[r]; a < structure.resAtomStart[r + 1]; a++) {
        delta[a * 3] = d[0];
        delta[a * 3 + 1] = d[1];
        delta[a * 3 + 2] = d[2];
      }
    }

    this.data[slot].morphOrigin = {
      x: structure.x.slice(), y: structure.y.slice(), z: structure.z.slice(),
    };
    this.data[slot].morphDelta = delta;
    return true;
  }

  /** Places the pane a fraction of the way to the reference conformation. */
  setMorph(slot: number, fraction: number): void {
    const data = this.data[slot];
    const structure = data.structure;
    if (!structure || !data.morphOrigin || !data.morphDelta) return;

    const t = Math.min(Math.max(fraction, 0), 1);
    const { morphOrigin: origin, morphDelta: delta } = data;
    for (let a = 0; a < structure.atomCount; a++) {
      structure.x[a] = origin.x[a] + delta[a * 3] * t;
      structure.y[a] = origin.y[a] + delta[a * 3 + 1] * t;
      structure.z[a] = origin.z[a] + delta[a * 3 + 2] * t;
    }

    // Coordinates live in GPU buffers built by the geometry pass, so moving
    // them means rebuilding. Forced, because none of the settings changed.
    data.builtSignature = '';
    this.rebuild(slot);
  }

  /** Runs the morph back and forth once, for looking at or for recording. */
  async playMorph(slot: number, seconds = 3, cycles = 1): Promise<void> {
    if (!this.data[slot].morphDelta && !this.prepareMorph(slot)) return;
    const started = performance.now();
    const total = seconds * 1000;

    for (;;) {
      const elapsed = performance.now() - started;
      if (elapsed >= total) break;
      // A cosine sweep rather than a sawtooth: the ends are where the two real
      // conformations are, and easing into them is what makes the middle read
      // as a transition rather than as a jump.
      const phase = (elapsed / total) * cycles * Math.PI * 2;
      this.setMorph(slot, (1 - Math.cos(phase)) / 2);
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      if (!this.data[slot].morphDelta) return;
    }
    this.setMorph(slot, 0);
  }

  /** Puts the coordinates back exactly as loaded. */
  clearMorph(slot: number): void {
    const data = this.data[slot];
    if (!data.morphOrigin || !data.structure) return;
    data.structure.x.set(data.morphOrigin.x);
    data.structure.y.set(data.morphOrigin.y);
    data.structure.z.set(data.morphOrigin.z);
    data.morphOrigin = null;
    data.morphDelta = null;
    data.builtSignature = '';
    this.rebuild(slot);
  }

  canMorph(slot: number): boolean {
    const alignment = this.data[slot].alignment;
    return !!alignment && alignment.pairs.length >= 3;
  }

  /** Frames one aligned pair in both panes at once, so the eye can compare. */
  focusAlignedPair(slot: number, pair: AlignedPair): void {
    const alignment = this.data[slot].alignment;
    if (!alignment) return;
    this.focusResidue(slot, pair.mobileResidue);
    // The panes share a frame after a superposition, so the reference follows
    // the same camera and does not need its own focus call — but it does when
    // the cameras have since been unlinked.
    if (!useStore.getState().linkedCameras) {
      this.focusResidue(alignment.referenceSlot, pair.referenceResidue);
    }
  }

  /** Per-residue metrics for a pane, once a validation scheme has loaded them. */
  getResidueValidation(slot: number): ResidueValidation | null {
    return this.data[slot].residueValidation;
  }

  /** The same data, fetched on demand rather than as a side effect of colouring. */
  async loadResidueValidation(slot: number): Promise<ResidueValidation | null> {
    const data = this.data[slot];
    if (data.residueValidation) return data.residueValidation;
    const entryId = useStore.getState().slots[slot].entryId;
    if (!entryId) return null;
    if (data.residueValidationRequest) await data.residueValidationRequest;
    if (data.residueValidation) return data.residueValidation;

    try {
      const validation = await fetchResidueValidation(entryId);
      if (useStore.getState().slots[slot].entryId !== entryId) return null;
      data.residueValidation = validation;
      return validation;
    } catch {
      return null;
    }
  }

  /**
   * The residues a report singles out, as selection-ready descriptions. This
   * is what turns "9.5% rotamer outliers" into somewhere to look.
   */
  worstResidues(
    slot: number, metric: 'rsrz' | 'outliers', limit = 10,
  ): { chain: string; seq: number; value: number }[] {
    const validation = this.data[slot].residueValidation;
    if (!validation) return [];
    return worstResidues(validation, metric, limit).map(({ key, value }) => {
      const [chain, seq] = key.split(':');
      return { chain, seq: Number(seq), value };
    });
  }

  /**
   * Rebuilds every loaded pane, for a change that colours cannot express
   * through settings — the palette itself moving under them.
   */
  rebuildAll(): void {
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (!this.data[i].structure) continue;
      this.data[i].builtSignature = '';
      this.rebuild(i);
    }
    this.invalidate();
  }

  syncSettings(): void {
    const { slots } = useStore.getState();
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.engine.setVisualSettings(i, slots[i].visual, showsQuantity(slots[i]));
      if (this.data[i].structure) this.rebuild(i);
    }
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Experimental density
  // -------------------------------------------------------------------------

  /**
   * Fetches the map for a pane and contours it.
   *
   * Which map exists is a property of how the structure was determined, not
   * something to ask the user: X-ray entries have 2Fo-Fc and Fo-Fc if
   * structure factors were deposited, EM entries have the deposited map under
   * an EMDB accession, and everything else has nothing. Saying which of those
   * it is when there is no map is more useful than a bare failure.
   */
  async showDensity(slot: number): Promise<void> {
    const structure = this.data[slot].structure;
    const state = useStore.getState().slots[slot];
    const store = useStore.getState();
    if (!structure) return;

    const detail = state.detail;
    const method = detail?.method ?? '';
    const emdbId = detail?.emdbIds?.[0] ?? null;
    let kind: MapKind;
    let source: string;

    if (emdbId) {
      kind = 'em';
      source = emdbId;
    } else if (/X-RAY|NEUTRON/i.test(method) && state.entryId) {
      // The validation summary already knows: fit to density can only be
      // measured when structure factors were deposited, so a null there means
      // there is no map to fetch. Asking anyway costs a request that fails as
      // an opaque CORS error rather than as the 404 it really is.
      if (detail && detail.validation.rsrzOutliers === null) {
        store.updateDensity(slot, {
          status: 'error',
          error: 'No density map for this entry — structure factors were never '
            + 'deposited, so there is nothing to compare the model against. '
            + 'The validation panel says the same thing under "Density fit".',
        });
        return;
      }
      kind = 'x-ray';
      source = state.entryId;
    } else {
      store.updateDensity(slot, {
        status: 'error',
        error: method
          ? `${methodPhrase(method)} entries have no deposited map to show.`
          : 'This pane was opened from a local file, so there is no deposited '
            + 'map to fetch.',
      });
      return;
    }

    this.data[slot].volumeRequest?.abort();
    const controller = new AbortController();
    this.data[slot].volumeRequest = controller;
    store.updateDensity(slot, {
      status: 'loading',
      error: null,
      kind,
      source,
      // Sigma means something different in the two experiments. An X-ray map
      // is conventionally read at 1σ-2σ; a cryo-EM map at that level is mostly
      // noise and a solid blob, and is normally contoured far higher. Only
      // applied when the kind changes, so a restored project keeps its own.
      ...(state.density.kind === kind ? {} : { level: DEFAULT_LEVEL[kind] }),
    });

    try {
      // Always a box around the model rather than the whole cell or map. For
      // X-ray that is what makes the server apply the spacegroup and return
      // density where the molecule actually is. For EM it is what spends the
      // detail budget on the particle: an EMDB box is usually much larger than
      // the model, and asking for the whole thing bought 4 Å sampling where
      // the same bytes over the model give 2 Å. It also means sigma is
      // computed over the region being looked at, which is the sigma a contour
      // level ought to mean.
      const box = paddedBox(structure, kind === 'em' ? 8 : 6);
      const set = await fetchVolumes(
        kind, source, box, kind === 'em' ? EM_DETAIL : XRAY_DETAIL, controller.signal,
      );
      if (this.data[slot].volumeRequest !== controller) return;
      this.data[slot].volumes = set;
      store.updateDensity(slot, { status: 'ready', bytes: set.bytes, error: null });

      // How much surface a level buys varies enormously between maps, so the
      // opening contour is checked against the budget before it is drawn. A
      // fixed default lands on a clean surface for one entry and a truncated
      // one for the next.
      const main = set.maps.find((m) => !/^fo-fc$/i.test(m.name));
      const wanted = useStore.getState().slots[slot].density;
      if (main) {
        const points = wanted.radius > 0 ? this.drawnAtomPositions(slot) : null;
        const mask = points ? nearMask(main, points, wanted.radius) : null;
        const level = levelWithinBudget(main, wanted.level, mask);
        if (level !== wanted.level) store.updateDensity(slot, { level });
      }
      this.rebuildDensity(slot);
    } catch (err) {
      if (controller.signal.aborted) return;
      store.updateDensity(slot, {
        status: 'error',
        error: err instanceof NoVolumeError || err instanceof Error
          ? err.message
          : String(err),
      });
    } finally {
      if (this.data[slot].volumeRequest === controller) {
        this.data[slot].volumeRequest = null;
      }
    }
  }

  hideDensity(slot: number): void {
    this.data[slot].volumeRequest?.abort();
    this.data[slot].volumeRequest = null;
    this.data[slot].volumes = null;
    this.engine.setVolumes(slot, []);
    useStore.getState().updateDensity(slot, {
      status: 'off', error: null, triangles: 0, bytes: 0, truncated: false,
    });
    this.invalidate();
  }

  /**
   * Re-contours the maps already in hand. Every control except the region
   * radius comes through here, so moving the contour is local work rather than
   * another few megabytes over the wire.
   */
  rebuildDensity(slot: number): void {
    const set = this.data[slot].volumes;
    const structure = this.data[slot].structure;
    if (!set || !structure) {
      this.pushVolumes(slot, []);
      return;
    }

    const d = useStore.getState().slots[slot].density;
    const points = d.radius > 0 ? this.drawnAtomPositions(slot) : null;

    const entries: { mesh: IsoMesh; style: VolumeStyle }[] = [];
    let triangles = 0;
    let truncated = false;

    // The difference map is contoured twice, at +level and -level, over the
    // same grid; rasterising the mask once for it rather than twice is most of
    // the cost of turning the difference map on.
    const masks = new Map<VolumeGrid, Uint8Array | null>();
    const maskFor = (grid: VolumeGrid) => {
      if (!masks.has(grid)) {
        masks.set(grid, points ? nearMask(grid, points, d.radius) : null);
      }
      return masks.get(grid) ?? null;
    };

    const contour = (grid: VolumeGrid, sigma: number, color: [number, number, number]) => {
      const mesh = isosurface(grid, { sigma, mask: maskFor(grid) });
      triangles += mesh.triangleCount;
      truncated = truncated || mesh.truncated;
      entries.push({
        mesh,
        style: {
          color, opacity: d.opacity, wireframe: d.wireframe,
          silhouette: 1, followsPalette: false,
        },
      });
    };

    for (const grid of set.maps) {
      const isDifference = /^fo-fc$/i.test(grid.name);
      if (isDifference) {
        if (!d.showDifference) continue;
        // Both lobes: green where the data want atoms the model does not have,
        // red where the model has atoms the data do not support. Showing only
        // the positive half is the commonest way to misread a difference map.
        contour(grid, d.diffLevel, DIFFERENCE_POSITIVE);
        contour(grid, -d.diffLevel, DIFFERENCE_NEGATIVE);
      } else {
        contour(grid, d.level, set.kind === 'em' ? EM_COLOR : MAIN_COLOR);
      }
    }

    useStore.getState().updateDensity(slot, { triangles, truncated });
    this.pushVolumes(slot, entries);
  }

  /**
   * Hands the engine everything drawn in the forward transparent pass.
   *
   * Density and the molecular surface are separate features with separate
   * controls, but they share one list on the GPU, so whichever of them changes
   * has to re-present both. The surface goes last: it is the outer envelope,
   * and blending it over the density reads better than the reverse.
   */
  private pushVolumes(
    slot: number, densityEntries: { mesh: IsoMesh; style: VolumeStyle }[],
  ): void {
    const s = useStore.getState().slots[slot].surface;
    const mesh = this.data[slot].surfaceMesh;
    const entries = [...densityEntries];

    if (mesh && s.status === 'ready') {
      entries.push({
        mesh,
        style: {
          // Per-vertex colour is already baked into the mesh; white here lets
          // it through, and a chosen colour multiplies over a white mesh.
          // Per-vertex colour is baked into the mesh for both the atom and the
          // Coulombic modes; only the flat mode tints from the uniform.
          color: s.coloring !== 'flat'
            ? [1, 1, 1]
            : [
                ((s.uniformColor >> 16) & 0xff) / 255,
                ((s.uniformColor >> 8) & 0xff) / 255,
                (s.uniformColor & 0xff) / 255,
              ],
          opacity: s.opacity,
          wireframe: s.wireframe,
          silhouette: 0.2,
          followsPalette: true,
        },
      });
    }

    this.engine.setVolumes(slot, entries);
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Molecular surface
  // -------------------------------------------------------------------------

  /**
   * Builds the pane's molecular surface, or reuses the cached mesh when only
   * its appearance changed. Synchronous and therefore a visible stall on a
   * large structure — the panel says so before you press the button.
   */
  showSurface(slot: number): void {
    const structure = this.data[slot].structure;
    const store = useStore.getState();
    if (!structure) return;

    const state = store.slots[slot];
    const s = state.surface;

    let atoms: Int32Array;
    try {
      atoms = this.surfaceAtoms(slot, s.selection);
    } catch (err) {
      store.updateSurface(slot, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (atoms.length === 0) {
      store.updateSurface(slot, {
        status: 'error',
        error: s.selection
          ? `Nothing matches "${s.selection}".`
          : 'No atoms are drawn in this pane to build a surface from.',
      });
      return;
    }

    const resolved = this.data[slot].resolved;
    const signature = [
      s.selection, s.probeRadius, s.resolution, s.coloring,
      state.colorScheme, state.uniformColor, atoms.length,
      state.components.map((c) => `${c.selection}:${c.style}:${c.colorScheme}`).join(';'),
    ].join('|');

    if (this.data[slot].surfaceMesh && this.data[slot].surfaceSignature === signature) {
      store.updateSurface(slot, { status: 'ready', error: null });
      this.pushVolumesFor(slot);
      return;
    }

    const radii = new Float32Array(structure.atomCount);
    for (let a = 0; a < structure.atomCount; a++) {
      radii[a] = VDW_RADII[structure.element[a]];
    }

    const field = gaussianSurface(
      structure.x, structure.y, structure.z, radii, atoms,
      {
        ...DEFAULT_SURFACE_OPTIONS,
        probeRadius: s.probeRadius,
        resolution: s.resolution,
        atomColors: s.coloring === 'atom' ? resolved?.atomColor ?? null : null,
      },
    );

    const mesh = isosurface(field.grid, {
      sigma: field.level,
      owner: field.owner,
      colors: field.colors,
    });

    // Potential is evaluated per vertex rather than per grid point: a surface
    // has a few hundred thousand vertices and the grid a few million points,
    // and only the ones on the surface are ever looked at.
    if (s.coloring === 'coulombic') {
      colorSurfaceByPotential(mesh.vertices, chargesOf(structure, atoms));
    }

    this.data[slot].surfaceMesh = mesh;
    this.data[slot].surfaceSignature = signature;
    store.updateSurface(slot, {
      status: 'ready',
      error: null,
      triangles: mesh.triangleCount,
      actualResolution: field.resolution,
    });
    this.pushVolumesFor(slot);
  }

  hideSurface(slot: number): void {
    this.data[slot].surfaceMesh = null;
    this.data[slot].surfaceSignature = '';
    useStore.getState().updateSurface(slot, { status: 'off', error: null, triangles: 0 });
    this.pushVolumesFor(slot);
  }

  /** Re-presents both volume features after either one changed. */
  private pushVolumesFor(slot: number): void {
    if (this.data[slot].volumes) this.rebuildDensity(slot);
    else this.pushVolumes(slot, []);
  }

  /** Re-applies surface appearance without regenerating the mesh. */
  refreshSurfaceStyle(slot: number): void {
    this.pushVolumesFor(slot);
  }

  /** Atom indices the surface covers: a selection, or everything drawn. */
  private surfaceAtoms(slot: number, selection: string): Int32Array {
    const structure = this.data[slot].structure!;
    const out: number[] = [];

    if (selection.trim()) {
      const error = selectionError(selection);
      if (error) throw new Error(error);
      const mask = evaluateSelection(parseSelection(selection), structure);
      for (let a = 0; a < structure.atomCount; a++) if (mask[a]) out.push(a);
      return Int32Array.from(out);
    }

    const drawn = this.drawnAtomMask(slot);
    for (let a = 0; a < structure.atomCount; a++) {
      // Water makes a surface out of a shell of unconnected beads, which is
      // never what someone asking for a molecular surface meant.
      if (structure.resKind[structure.atomResidue[a]] === MolKind.Water) continue;
      if (drawn && !drawn[a]) continue;
      out.push(a);
    }
    return Int32Array.from(out);
  }

  /** Positions of the atoms actually drawn, for masking the map to the model. */
  private drawnAtomPositions(slot: number): Float32Array | null {
    const structure = this.data[slot].structure;
    if (!structure) return null;
    const mask = this.drawnAtomMask(slot);
    const out: number[] = [];
    for (let a = 0; a < structure.atomCount; a++) {
      if (mask && !mask[a]) continue;
      out.push(structure.x[a], structure.y[a], structure.z[a]);
    }
    return out.length > 0 ? Float32Array.from(out) : null;
  }

  /** Density at a point, in sigma, for the pane's main map. Null when absent. */
  densitySigmaAt(slot: number, x: number, y: number, z: number): number | null {
    const set = this.data[slot].volumes;
    if (!set) return null;
    const grid = set.maps.find((m) => !/^fo-fc$/i.test(m.name));
    if (!grid) return null;
    const value = sampleSigma(grid, x, y, z);
    return Number.isNaN(value) ? null : value;
  }


  // -------------------------------------------------------------------------
  // Measurements, hydrogen bonds and labels
  // -------------------------------------------------------------------------

  /** Feeds a clicked atom into the pending measurement, completing it if full. */
  private addMeasurementAtom(slot: number, atom: number): void {
    const store = useStore.getState();
    const state = store.slots[slot];
    const structure = this.data[slot].structure;
    const kind = state.measureMode;
    if (!kind || !structure) return;

    // Clicking the same atom twice in a row removes it, so a misclick is
    // undoable without abandoning the whole measurement.
    const pending = state.pendingAtoms.includes(atom)
      ? state.pendingAtoms.filter((a) => a !== atom)
      : [...state.pendingAtoms, atom];

    if (pending.length < atomsNeeded(kind)) {
      store.patchSlot(slot, { pendingAtoms: pending });
      this.refreshOverlay(slot);
      return;
    }

    const measurement = createMeasurement(structure, kind, pending);
    store.patchSlot(slot, {
      measurements: [...state.measurements, measurement],
      pendingAtoms: [],
    });
    this.refreshOverlay(slot);
  }

  clearMeasurements(slot: number): void {
    useStore.getState().patchSlot(slot, { measurements: [], pendingAtoms: [] });
    this.refreshOverlay(slot);
  }

  removeMeasurement(slot: number, id: string): void {
    const state = useStore.getState().slots[slot];
    useStore.getState().patchSlot(slot, {
      measurements: state.measurements.filter((m) => m.id !== id),
    });
    this.refreshOverlay(slot);
  }

  setMeasureMode(slot: number, kind: SlotState['measureMode']): void {
    useStore.getState().patchSlot(slot, { measureMode: kind, pendingAtoms: [] });
    this.refreshOverlay(slot);
  }

  toggleHydrogenBonds(slot: number, enabled: boolean): void {
    const structure = this.data[slot].structure;
    if (!structure) return;

    if (!enabled) {
      this.data[slot].hydrogenBonds = [];
      useStore.getState().patchSlot(slot, { showHydrogenBonds: false, hydrogenBondCount: 0 });
      this.refreshOverlay(slot);
      return;
    }

    const bonds = findHydrogenBonds(structure, { mask: this.drawnAtomMask(slot) });
    this.data[slot].hydrogenBonds = bonds;
    useStore.getState().patchSlot(slot, {
      showHydrogenBonds: true,
      hydrogenBondCount: bonds.length,
    });
    this.refreshOverlay(slot);
  }

  /**
   * Atoms with a visible style. Contacts to hidden waters are noise, and a
   * bond drawn to something the user cannot see reads as a rendering error.
   */
  private drawnAtomMask(slot: number): Uint8Array | null {
    const resolved = this.data[slot].resolved;
    if (!resolved) return null;
    const mask = new Uint8Array(resolved.atomStyle.length);
    for (let a = 0; a < mask.length; a++) mask[a] = resolved.atomStyle[a] === Style.None ? 0 : 1;
    return mask;
  }

  /** Rebuilds the overlay sticks and the label instances for a pane. */
  refreshOverlay(slot: number): void {
    const structure = this.data[slot].structure;
    if (!structure) {
      this.engine.setOverlay(slot, EMPTY_F32);
      this.engine.setLabels(slot, EMPTY_F32);
      this.invalidate();
      return;
    }

    const state = useStore.getState().slots[slot];
    const hbonds = state.showHydrogenBonds ? this.data[slot].hydrogenBonds : [];

    const sticks: number[] = [];
    const pushStick = (
      a: number, b: number, radius: number, color: [number, number, number],
    ) => {
      sticks.push(
        structure.x[a], structure.y[a], structure.z[a], radius,
        structure.x[b], structure.y[b], structure.z[b], 0,
        color[0], color[1], color[2], 0,
      );
    };

    for (const bond of hbonds) {
      pushStick(bond.donor, bond.acceptor, 0.05, [0.45, 0.85, 0.98]);
    }
    for (const m of state.measurements) {
      for (let i = 0; i + 1 < m.atoms.length; i++) {
        pushStick(m.atoms[i], m.atoms[i + 1], 0.08, [1.0, 0.82, 0.3]);
      }
    }
    for (let i = 0; i + 1 < state.pendingAtoms.length; i++) {
      pushStick(state.pendingAtoms[i], state.pendingAtoms[i + 1], 0.08, [1.0, 0.55, 0.35]);
    }

    // The clicked residue, as a cage around its own bonds.
    //
    // Until this existed, clicking marked a residue with a floating text label
    // and nothing else, and double-clicking flew the camera to it — so you
    // arrived somewhere inside the structure with no idea which part of it you
    // had asked for. Worst on nucleic acids, where the base slabs are large,
    // uniform and identical to their neighbours: "DT 20" written across a wall
    // of slabs names one of them without pointing at it.
    //
    // Drawn as overlay sticks rather than by recolouring, because colours are
    // baked into the geometry buffers and a click should not cost a rebuild.
    if (state.selectedResidue !== null) {
      const r = state.selectedResidue;
      const start = structure.resAtomStart[r];
      const end = structure.resAtomStart[r + 1];
      const mask = new Uint8Array(structure.atomCount);
      for (let a = start; a < end; a++) mask[a] = 1;

      const bonds = computeBonds(structure, mask);
      for (let i = 0; i < bonds.count; i++) {
        pushStick(bonds.indices[i * 2], bonds.indices[i * 2 + 1], 0.11, SELECTION_COLOR);
      }
      // A lone ion or water has no bonds to outline, so it gets a small cross
      // instead — clicking one is common and it would otherwise mark nothing.
      if (bonds.count === 0 && end > start) {
        const a = start;
        const x = structure.x[a], y = structure.y[a], z = structure.z[a];
        const arm = 0.55;
        for (const [dx, dy, dz] of [[arm, 0, 0], [0, arm, 0], [0, 0, arm]]) {
          sticks.push(
            x - dx, y - dy, z - dz, 0.08,
            x + dx, y + dy, z + dz, 0,
            SELECTION_COLOR[0], SELECTION_COLOR[1], SELECTION_COLOR[2], 0,
          );
        }
      }
    }

    this.engine.setOverlay(slot, Float32Array.from(sticks));

    // ---- labels ----
    const labels: LabelRequest[] = [];
    if (state.showLabels) {
      const background: [number, number, number, number] = [0.05, 0.07, 0.1, 0.82];

      // Measurement labels are the draggable ones: they are the labels that
      // end up in a figure, and the one that lands on top of the bond it is
      // measuring is the reason anyone wants to move a label at all.
      this.labelHandles[slot] = [];
      for (const m of state.measurements) {
        const [x, y, z] = measurementAnchor(structure, m);
        const offset = this.labelOffsets.get(`${slot}:${m.id}`) ?? { x: 0, y: 0 };
        labels.push({
          text: m.label, x, y, z, color: [1, 0.85, 0.4, 1], background, fontSize: 13,
          offsetX: offset.x, offsetY: offset.y,
        });
        this.labelHandles[slot].push({
          key: `${slot}:${m.id}`,
          world: [x, y, z],
          offset,
          // Matches the layout in buildLabelInstances: 0.62 of the cell width
          // per character, and the pill's padding around it.
          width: m.label.length * 13 * 0.62 + 8,
          height: 13 + 4,
        });
      }

      for (const atom of state.pendingAtoms) {
        labels.push({
          text: describeAtom(structure, atom),
          x: structure.x[atom], y: structure.y[atom], z: structure.z[atom],
          color: [1, 0.7, 0.45, 1], background, offsetY: -14, fontSize: 11,
        });
      }

      if (state.selectedResidue !== null && state.selectionLabel) {
        const r = state.selectedResidue;
        const anchor = structure.resAnchor[r] >= 0
          ? structure.resAnchor[r]
          : structure.resAtomStart[r];
        labels.push({
          text: state.selectionLabel,
          x: structure.x[anchor], y: structure.y[anchor], z: structure.z[anchor],
          color: [SELECTION_COLOR[0], SELECTION_COLOR[1], SELECTION_COLOR[2], 1],
          background, offsetY: -16, fontSize: 12,
        });
      }
    }

    this.engine.setLabels(
      slot,
      labels.length > 0 ? buildLabelInstances(this.engine.fontAtlasRef, labels) : EMPTY_F32,
    );
    this.invalidate();
  }

  // -------------------------------------------------------------------------
  // Superposition
  // -------------------------------------------------------------------------

  /** Chains in a pane that can take part in an alignment. */
  alignableChains(slot: number): AlignableChain[] {
    const structure = this.data[slot].structure;
    return structure ? alignableChains(structure) : [];
  }

  /**
   * Superposes the mobile pane onto the reference pane's frame. Only the mobile
   * pane moves, and the transform is applied at draw time rather than to the
   * coordinates, so the structure's own numbering stays intact.
   */
  superpose(
    mobileSlot: number, referenceSlot: number,
    mobileChainId?: string, referenceChainId?: string,
  ): { rmsd: number; pairs: number } | string {
    const mobile = this.data[mobileSlot].structure;
    const reference = this.data[referenceSlot].structure;
    if (!mobile || !reference) return 'Both panes need a loaded structure';
    if (mobileSlot === referenceSlot) return 'Pick two different panes';

    const mobileChains = alignableChains(mobile);
    const referenceChains = alignableChains(reference);
    if (mobileChains.length === 0 || referenceChains.length === 0) {
      return 'One of the structures has no polymer chain to align';
    }

    const longest = (list: AlignableChain[]) =>
      list.reduce((a, b) => (b.residues.length > a.residues.length ? b : a));
    const mc = mobileChains.find((c) => c.authId === mobileChainId) ?? longest(mobileChains);
    const rc = referenceChains.find((c) => c.authId === referenceChainId)
      ?? longest(referenceChains);

    try {
      const result = superposeChains(reference, rc, mobile, mc);
      if (!Number.isFinite(result.rmsd)) return 'Alignment produced too few matched residues';

      // The reference pane defines the shared frame, so it is reset to identity.
      this.engine.setSceneTransform(referenceSlot, IDENTITY);
      this.engine.setSceneTransform(mobileSlot, result.transform);

      useStore.getState().patchSlot(mobileSlot, {
        superposedOnto: referenceSlot,
        superposeRmsd: result.rmsd,
        superposePairs: result.pairsUsed,
      });
      useStore.getState().patchSlot(referenceSlot, {
        superposedOnto: null, superposeRmsd: null, superposePairs: null,
      });

      // Kept so the panel can show where the two structures agree; it is the
      // by-product of the fit, and discarding it was throwing away the answer
      // and keeping only its average.
      this.data[mobileSlot].alignment = {
        pairs: result.alignment,
        referenceSlot,
        mobileChain: mc.authId,
        referenceChain: rc.authId,
      };

      // Both panes now share a frame, so give them the same camera.
      this.syncCameras(referenceSlot);
      this.invalidate();
      return { rmsd: result.rmsd, pairs: result.pairsUsed };
    } catch (err) {
      if (err instanceof AlignmentError) return err.message;
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Rebuilds a pane from a different model of an NMR ensemble. The coordinates
   * are refetched, but the browser has them cached, so this is quick.
   */
  async setModel(slot: number, modelNum: number): Promise<void> {
    const entryId = useStore.getState().slots[slot].entryId;
    if (!entryId) return;
    await this.load(slot, entryId, undefined, modelNum);
  }

  /**
   * Loads every model of an ensemble at once. A backbone trace is the
   * conventional way to read the spread — twenty cartoons on top of each other
   * is a solid mass.
   */
  async setEnsembleOverlay(slot: number, enabled: boolean): Promise<void> {
    const entryId = useStore.getState().slots[slot].entryId;
    if (!entryId) return;
    await this.load(slot, entryId, undefined, enabled ? undefined : 1, enabled);
    if (!enabled) return;

    const components = useStore.getState().slots[slot].components.map((c) => (
      c.selection === 'polymer' ? { ...c, style: Style.Backbone } : c
    ));
    useStore.getState().setComponents(slot, components);
  }

  clearSuperposition(slot: number): void {
    this.engine.setSceneTransform(slot, IDENTITY);
    this.data[slot].alignment = null;
    this.clearMorph(slot);
    useStore.getState().patchSlot(slot, {
      superposedOnto: null, superposeRmsd: null, superposePairs: null,
    });
    this.frameSlot(slot, true);
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

  /**
   * Frames whatever a selection covers. Distance comes from the selection's own
   * extent rather than a fixed zoom, so an interface between two chains and a
   * single side chain both end up filling the pane.
   */
  /**
   * Moves the point the camera turns about without moving the camera.
   *
   * Distinct from focusing, which also flies in and reframes. Once you are
   * looking at an active site, the useful thing is to orbit *that* rather than
   * the centre of a molecule the camera has long since left behind — and
   * flying somewhere is exactly what you do not want at that moment.
   * Null recentres on the whole structure.
   */
  setPivot(slot: number, selection: string | null): boolean {
    const structure = this.data[slot].structure;
    const geometry = this.data[slot].geometry;
    if (!structure) return false;

    let target: [number, number, number];
    if (selection === null) {
      if (!geometry) return false;
      target = [geometry.center[0], geometry.center[1], geometry.center[2]];
    } else {
      if (selectionError(selection)) return false;
      const mask = evaluateSelection(parseSelection(selection), structure);
      let n = 0, cx = 0, cy = 0, cz = 0;
      for (let a = 0; a < mask.length; a++) {
        if (!mask[a]) continue;
        cx += structure.x[a]; cy += structure.y[a]; cz += structure.z[a];
        n++;
      }
      if (n === 0) return false;
      target = [cx / n, cy / n, cz / n];
    }

    const camera = this.engine.getCamera(slot);
    camera.animateTo({
      target,
      orientation: [
        camera.orientation[0], camera.orientation[1],
        camera.orientation[2], camera.orientation[3],
      ],
      // Unchanged: this is a pivot, not a flight.
      distance: camera.distance,
    });
    this.invalidate();
    return true;
  }

  /** Pivots on the residue the user last clicked, or on the whole structure. */
  pivotOnSelection(slot: number): boolean {
    const structure = this.data[slot].structure;
    const residue = useStore.getState().slots[slot].selectedResidue;
    if (!structure || residue === null) return this.setPivot(slot, null);

    let cx = 0, cy = 0, cz = 0, n = 0;
    for (let a = structure.resAtomStart[residue]; a < structure.resAtomStart[residue + 1]; a++) {
      cx += structure.x[a]; cy += structure.y[a]; cz += structure.z[a];
      n++;
    }
    if (n === 0) return false;

    const camera = this.engine.getCamera(slot);
    camera.animateTo({
      target: [cx / n, cy / n, cz / n],
      orientation: [
        camera.orientation[0], camera.orientation[1],
        camera.orientation[2], camera.orientation[3],
      ],
      distance: camera.distance,
    });
    this.invalidate();
    return true;
  }

  /**
   * Frames a selection. Returns false when there was nothing to frame.
   *
   * The silent version of this shipped three separate callers that built
   * selection strings the grammar rejects — `127` where it wants `:127` — and
   * every one of them looked like a dead button rather than like a bug. A
   * caller that cannot act on the answer can still ignore it; the dev warning
   * is what makes the next one visible.
   */
  focusSelection(slot: number, selection: string): boolean {
    const structure = this.data[slot].structure;
    if (!structure) return false;
    const problem = selectionError(selection);
    if (problem) {
      if (import.meta.env.DEV) {
        console.warn(`focusSelection: "${selection}" is not a valid selection — ${problem}`);
      }
      return false;
    }

    const mask = evaluateSelection(parseSelection(selection), structure);
    let n = 0, cx = 0, cy = 0, cz = 0;
    for (let a = 0; a < mask.length; a++) {
      if (!mask[a]) continue;
      cx += structure.x[a]; cy += structure.y[a]; cz += structure.z[a];
      n++;
    }
    if (n === 0) return false;
    cx /= n; cy /= n; cz /= n;

    let radius = 0;
    for (let a = 0; a < mask.length; a++) {
      if (!mask[a]) continue;
      radius = Math.max(radius, Math.hypot(
        structure.x[a] - cx, structure.y[a] - cy, structure.z[a] - cz,
      ));
    }

    const camera = this.engine.getCamera(slot);
    camera.animateTo({
      target: [cx, cy, cz],
      orientation: [
        camera.orientation[0], camera.orientation[1],
        camera.orientation[2], camera.orientation[3],
      ],
      distance: Math.max(10, (radius + 4) * 2.6),
    });
    this.invalidate();
    return true;
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

    // A label under the pointer takes the drag: nudging one out of the way is
    // a far commoner intention than starting an orbit from exactly there, and
    // the camera is reachable from every other pixel in the pane.
    const [localX, localY] = this.localCoords(slot, event.clientX, event.clientY);
    this.draggingLabel = this.labelAt(slot, localX, localY);
    if (this.draggingLabel) {
      this.dragMode = 'none';
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      return;
    }

    if (event.button === 1 || event.button === 2 || event.shiftKey) this.dragMode = 'pan';
    else if (event.altKey) this.dragMode = 'roll';
    else this.dragMode = 'rotate';

    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  /** The topmost draggable label containing a point, in pane-local pixels. */
  private labelAt(slot: number, localX: number, localY: number): LabelHandle | null {
    const handles = this.labelHandles[slot];
    const el = this.paneElements[slot];
    if (!el || handles.length === 0) return null;
    const width = el.clientWidth || 1;
    const height = el.clientHeight || 1;
    const camera = this.engine.getCamera(slot);
    const transform = this.engine.getSceneTransform(slot);

    // Last drawn wins, matching the order they are blended in.
    for (let i = handles.length - 1; i >= 0; i--) {
      const handle = handles[i];
      const screen = projectToPane(camera, transform, handle.world, width, height);
      if (!screen) continue;
      const cx = screen[0] + handle.offset.x;
      const cy = screen[1] + handle.offset.y;
      if (Math.abs(localX - cx) <= handle.width / 2
        && Math.abs(localY - cy) <= handle.height / 2) {
        return handle;
      }
    }
    return null;
  }

  onPointerMove(event: PointerEvent): void {
    if (this.draggingLabel) {
      // The offset is in the same pixel space the label shader lays out in, so
      // the label tracks the pointer exactly and stays put as the camera moves.
      this.draggingLabel.offset.x += event.clientX - this.lastX;
      this.draggingLabel.offset.y += event.clientY - this.lastY;
      this.lastX = event.clientX;
      this.lastY = event.clientY;
      this.labelOffsets.set(this.draggingLabel.key, { ...this.draggingLabel.offset });
      this.refreshOverlay(this.dragSlot);
      return;
    }
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

    // With the pane in move mode the same gestures drive the structure instead
    // of the camera, which is what lets two overlaid structures be placed
    // against each other by hand.
    if (useStore.getState().slots[slot].moveModel) {
      this.moveModel(slot, dx, dy, height);
      this.invalidate();
      return;
    }

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

  /**
   * Turns or shifts a pane's structure under the pointer, leaving the camera
   * alone.
   *
   * The gesture has to mean the same thing it means for the camera, so the
   * rotation axes are the camera's own right and up expressed in world space —
   * dragging right turns the near face right whichever way the camera is
   * pointing. Rotation is about the structure's centre rather than the origin,
   * or a small turn throws the molecule off screen.
   */
  private moveModel(slot: number, dx: number, dy: number, height: number): void {
    const geometry = this.data[slot].geometry;
    if (!geometry) return;
    const camera = this.engine.getCamera(slot);
    const current = this.engine.getSceneTransform(slot);

    if (this.dragMode === 'pan') {
      const worldPerPixel = (2 * Math.tan(camera.fovY / 2) * camera.distance) / height;
      const shift = quatRotateInverse(
        new Float32Array(3), camera.orientation, [dx * worldPerPixel, -dy * worldPerPixel, 0],
      );
      const next = current.slice();
      next[12] += shift[0];
      next[13] += shift[1];
      next[14] += shift[2];
      this.engine.setSceneTransform(slot, next);
      return;
    }

    const right = quatRotateInverse(new Float32Array(3), camera.orientation, [1, 0, 0]);
    const up = quatRotateInverse(new Float32Array(3), camera.orientation, [0, 1, 0]);
    const forward = quatRotateInverse(new Float32Array(3), camera.orientation, [0, 0, 1]);

    const rotation = quat();
    const scratch = quat();
    if (this.dragMode === 'roll') {
      quatFromAxisAngle(rotation, forward[0], forward[1], forward[2], (dx / height) * 3.2);
    } else {
      quatFromAxisAngle(rotation, up[0], up[1], up[2], (dx / height) * 3.2);
      quatFromAxisAngle(scratch, right[0], right[1], right[2], (dy / height) * 3.2);
      quatMultiply(rotation, scratch, rotation);
    }
    quatNormalize(rotation);

    const delta = mat4FromQuat(mat4(), rotation);
    // The pivot is the structure's centre in its *current* placed position, so
    // successive drags compose without the molecule creeping away.
    const c = geometry.center;
    const pivot: [number, number, number] = [
      current[0] * c[0] + current[4] * c[1] + current[8] * c[2] + current[12],
      current[1] * c[0] + current[5] * c[1] + current[9] * c[2] + current[13],
      current[2] * c[0] + current[6] * c[1] + current[10] * c[2] + current[14],
    ];

    const next = multiply(mat4(), delta, current);
    // Undo the translation the rotation about the origin introduced, so the
    // pivot ends up exactly where it started.
    const moved: [number, number, number] = [
      delta[0] * pivot[0] + delta[4] * pivot[1] + delta[8] * pivot[2],
      delta[1] * pivot[0] + delta[5] * pivot[1] + delta[9] * pivot[2],
      delta[2] * pivot[0] + delta[6] * pivot[1] + delta[10] * pivot[2],
    ];
    next[12] += pivot[0] - moved[0];
    next[13] += pivot[1] - moved[1];
    next[14] += pivot[2] - moved[2];

    this.engine.setSceneTransform(slot, next);
  }

  onPointerUp(event: PointerEvent): void {
    if (this.draggingLabel) {
      this.draggingLabel = null;
      this.dragSlot = -1;
      return;
    }
    const wasDragging = this.dragMode !== 'none';
    const slot = this.dragSlot;
    const moved = this.dragDistance > 4;
    this.dragMode = 'none';
    this.dragSlot = -1;

    if (wasDragging && !moved && slot >= 0 && event.button === 0) {
      const [lx, ly] = this.localCoords(slot, event.clientX, event.clientY);
      const hit = this.engine.pick(slot, lx, ly);
      const structure = this.data[slot].structure;

      if (useStore.getState().slots[slot].measureMode && hit) {
        this.addMeasurementAtom(slot, hit.atomIndex);
      } else {
        useStore.getState().patchSlot(slot, {
          selectedResidue: hit ? hit.residueIndex : null,
          selectionLabel: hit && structure ? describePick(structure, hit) : null,
        });
        this.refreshOverlay(slot);
      }
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

  /**
   * Records a pane turning through one or more full revolutions.
   *
   * The camera is restored afterwards whatever happens, including on failure:
   * a recording that leaves the view somewhere else is worse than one that
   * fails, because the failure is at least visible.
   */
  async recordTurntable(
    slot: number,
    options: { seconds: number; fps: number; turns: number; maxSize: number },
    onProgress?: (fraction: number) => void,
  ): Promise<Blob | null> {
    const canvas = this.engine.canvasElement;
    const pane = this.paneElements[slot];
    const container = this.container;
    if (!canvas || !pane || !container || !this.data[slot].structure) return null;

    const dpr = this.engine.pixelRatio;
    const containerRect = container.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const camera = this.engine.getCamera(slot);
    const start = camera.getState();

    // Spin would fight the frame-by-frame rotation and make the turn uneven.
    const wasSpinning = useStore.getState().slots[slot].spinning;
    if (wasSpinning) useStore.getState().patchSlot(slot, { spinning: false });

    try {
      return await recordTurntable(
        {
          canvas,
          rect: {
            x: Math.floor((paneRect.left - containerRect.left) * dpr),
            y: Math.floor((paneRect.top - containerRect.top) * dpr),
            width: Math.floor(paneRect.width * dpr),
            height: Math.floor(paneRect.height * dpr),
          },
          step: (turnFraction) => {
            // Absolute from the starting pose rather than incremental, so a
            // dropped frame cannot accumulate into a drifting turn.
            camera.setState(start);
            camera.rotate(turnFraction * Math.PI * 2, 0);
            this.dirty = true;
            this.frame();
          },
          // The key is laid out in CSS pixels; `zoom` converts framebuffer to
          // output pixels and `dpr` CSS to framebuffer, so it keeps the same
          // apparent size on a 640px clip and a 1920px one alike.
          paintOverlay: (ctx, height, zoom) => {
            paintColorKey(ctx, this.colorKeyFor(slot), height, zoom * dpr);
          },
        },
        {
          frames: Math.max(1, Math.round(options.seconds * options.fps)),
          framesPerSecond: options.fps,
          turns: options.turns,
          maxSize: options.maxSize,
          onProgress,
        },
      );
    } finally {
      camera.setState(start);
      if (wasSpinning) useStore.getState().patchSlot(slot, { spinning: true });
      this.invalidate();
    }
  }

  /** The key for a pane, or null when it is switched off or has nothing to say. */
  colorKeyFor(slot: number): ColorKey {
    const structure = this.data[slot].structure;
    const state = useStore.getState().slots[slot];
    if (!structure || !state.showColorKey) return null;
    return colorKeyFor(structure, state.colorScheme, {
      paletteOffset: slot * 3,
      uniformColor: state.uniformColor,
      saturation: state.visual.saturation,
      intensity: state.visual.intensity,
    });
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
    // The overlay lives in the DOM, so an export has to paint its own copy or
    // ship a picture whose colours are unexplained.
    paintColorKey(ctx, this.colorKeyFor(slot), sh, dpr);

    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }

  dispose(): void {
    this.stop();
    for (const d of this.data) d.loadHandle?.cancel();
    this.engine.destroy();
  }
}

/**
 * A world point in pane-local CSS pixels, or null when it is behind the camera.
 * The same projection the label shader does, so a hit test agrees with what is
 * on screen.
 */
function projectToPane(
  camera: Camera,
  transform: Float32Array,
  world: [number, number, number],
  width: number,
  height: number,
): [number, number] | null {
  const [x, y, z] = world;
  const wx = transform[0] * x + transform[4] * y + transform[8] * z + transform[12];
  const wy = transform[1] * x + transform[5] * y + transform[9] * z + transform[13];
  const wz = transform[2] * x + transform[6] * y + transform[10] * z + transform[14];

  const m = camera.viewProjection;
  const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
  if (cw <= 0) return null;
  const cx = (m[0] * wx + m[4] * wy + m[8] * wz + m[12]) / cw;
  const cy = (m[1] * wx + m[5] * wy + m[9] * wz + m[13]) / cw;

  return [(cx * 0.5 + 0.5) * width, (0.5 - cy * 0.5) * height];
}

/** Inverse of a rigid transform: transpose the rotation, undo the translation. */
function invertRigid(m: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  }
  out[15] = 1;
  out[12] = -(out[0] * m[12] + out[4] * m[13] + out[8] * m[14]);
  out[13] = -(out[1] * m[12] + out[5] * m[13] + out[9] * m[14]);
  out[14] = -(out[2] * m[12] + out[6] * m[13] + out[10] * m[14]);
  return out;
}

function describePick(structure: Structure, hit: PickResult): string {
  const r = hit.residueIndex;
  const chain = structure.chainAuthId[structure.resChain[r]];
  const comp = resNameOf(structure, r);
  const atom = atomNameOf(structure, hit.atomIndex);
  return `${comp} ${structure.resSeq[r]} · ${chain} · ${atom}`;
}

export const viewer = new ViewerController();

/**
 * Whether anything in a pane is coloured by a quantity — its own scheme or any
 * component's.
 *
 * One component coloured by B-factor is enough to pin the whole pane, because
 * the palette uniform is per pane and the legend beside that component has to
 * keep meaning. Erring this way costs a slightly duller picture; erring the
 * other way silently breaks the reading of a ramp.
 */
function showsQuantity(state: {
  colorScheme: ColorScheme;
  components: { colorScheme?: ColorScheme | null }[];
  surface: { status: string; coloring: string };
}): boolean {
  if (QUANTITATIVE_SCHEMES.has(state.colorScheme)) return true;
  // A Coulombic surface is a ramp like any other, but it is a surface setting
  // rather than a colour scheme, so it has to be asked for separately. Missed
  // on the first pass, which is exactly the gap the scheme list was meant to
  // close.
  if (state.surface.status !== 'off' && state.surface.coloring === 'coulombic') return true;
  return state.components.some((c) => c.colorScheme && QUANTITATIVE_SCHEMES.has(c.colorScheme));
}

if (import.meta.env.DEV) {
  // Handy for poking at a loaded structure from the console.
  (window as unknown as { viewer: ViewerController }).viewer = viewer;
}
