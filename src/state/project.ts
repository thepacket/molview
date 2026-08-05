/**
 * Project documents: a whole session as JSON.
 *
 * Coordinates are deliberately not stored — a project references entries by
 * PDB id and refetches them, because a four-pane project of real structures
 * would otherwise be hundreds of megabytes.
 *
 * The same document is what saving writes to IndexedDB and what export writes
 * to disk, so a project is portable between browsers without a second
 * serialiser.
 */

import { makeComponent, type Component } from '../mol/components';
import type { ColorScheme } from '../mol/coloring';
import { createMeasurement, type Measurement, type MeasurementKind } from '../mol/measure';
import { atomNameOf, resNameOf, type Structure } from '../mol/structure';
import type { SlotVisualSettings } from '../gfx/engine';
import { LAYOUT_SLOT_COUNT, useStore, type LayoutMode } from './store';
import { viewer } from '../viewer/ViewerController';

export const PROJECT_FORMAT = 1;

/**
 * Atoms are referenced by what a person would call them, not by array index:
 * indices depend on how the file was filtered and would silently point at the
 * wrong atom if that ever changed.
 */
interface AtomRef {
  chain: string;
  seq: number;
  residue: string;
  atom: string;
}

interface MeasurementDocument {
  kind: MeasurementKind;
  atoms: AtomRef[];
}

interface PaneDocument {
  entryId: string | null;
  assemblyId: string;
  modelNum?: number;
  components: Omit<Component, 'id'>[];
  representation: {
    showHydrogens: boolean;
    atomScale: number;
    bondRadius: number;
    hiddenChains: string[];
  };
  colorScheme: ColorScheme;
  uniformColor: number;
  visual: SlotVisualSettings;
  camera: {
    target: [number, number, number];
    orientation: [number, number, number, number];
    distance: number;
  } | null;
  /** Present only when the pane has been superposed onto another. */
  sceneTransform?: number[];
  superposedOnto?: number | null;
  superposeRmsd?: number | null;
  superposePairs?: number | null;
  measurements: MeasurementDocument[];
  showHydrogenBonds: boolean;
  showLabels: boolean;
  spinning: boolean;
}

export interface ProjectDocument {
  format: number;
  app: 'molview';
  created: string;
  session: {
    layout: LayoutMode;
    activeSlot: number;
    linkedCameras: boolean;
  };
  panes: PaneDocument[];
}

export class ProjectError extends Error {}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

function atomRef(s: Structure, atom: number): AtomRef {
  const r = s.atomResidue[atom];
  return {
    chain: s.chainAuthId[s.resChain[r]],
    seq: s.resSeq[r],
    residue: resNameOf(s, r),
    atom: atomNameOf(s, atom),
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function serialiseProject(): ProjectDocument {
  const state = useStore.getState();
  const paneCount = LAYOUT_SLOT_COUNT[state.layout];

  const panes: PaneDocument[] = [];
  for (let i = 0; i < paneCount; i++) {
    const slot = state.slots[i];
    const structure = viewer.getStructure(i);
    const camera = viewer.engine.getCamera(i);
    const transform = Array.from(viewer.engine.getSceneTransform(i));
    const superposed = transform.some((v, k) => Math.abs(v - IDENTITY[k]) > 1e-6);

    panes.push({
      entryId: slot.entryId,
      assemblyId: slot.assemblyId,
      modelNum: structure?.modelCount && structure.modelCount > 1
        ? structure.modelNum
        : undefined,
      components: slot.components.map(({ id: _id, ...rest }) => rest),
      representation: {
        showHydrogens: slot.representation.showHydrogens,
        atomScale: slot.representation.atomScale,
        bondRadius: slot.representation.bondRadius,
        hiddenChains: [...slot.representation.hiddenChains],
      },
      colorScheme: slot.colorScheme,
      uniformColor: slot.uniformColor,
      visual: { ...slot.visual },
      camera: slot.status === 'ready'
        ? {
            target: [camera.target[0], camera.target[1], camera.target[2]],
            orientation: [
              camera.orientation[0], camera.orientation[1],
              camera.orientation[2], camera.orientation[3],
            ],
            distance: camera.distance,
          }
        : null,
      sceneTransform: superposed ? transform : undefined,
      superposedOnto: slot.superposedOnto,
      superposeRmsd: slot.superposeRmsd,
      superposePairs: slot.superposePairs,
      measurements: structure
        ? slot.measurements.map((m) => ({
            kind: m.kind,
            atoms: m.atoms.map((a) => atomRef(structure, a)),
          }))
        : [],
      showHydrogenBonds: slot.showHydrogenBonds,
      showLabels: slot.showLabels,
      spinning: slot.spinning,
    });
  }

  return {
    format: PROJECT_FORMAT,
    app: 'molview',
    created: new Date().toISOString(),
    session: {
      layout: state.layout,
      activeSlot: state.activeSlot,
      linkedCameras: state.linkedCameras,
    },
    panes,
  };
}

// ---------------------------------------------------------------------------
// Deserialise
// ---------------------------------------------------------------------------

export function parseProject(text: string): ProjectDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProjectError('That is not valid JSON');
  }

  const doc = parsed as Partial<ProjectDocument>;
  if (!doc || doc.app !== 'molview') {
    throw new ProjectError('This file is not a MolView project');
  }
  if (typeof doc.format !== 'number') {
    throw new ProjectError('Project is missing a format version');
  }
  if (doc.format > PROJECT_FORMAT) {
    throw new ProjectError(
      `Project format ${doc.format} is newer than this build understands (${PROJECT_FORMAT})`,
    );
  }
  if (!Array.isArray(doc.panes)) {
    throw new ProjectError('Project has no panes');
  }
  return doc as ProjectDocument;
}

/** Resolves a saved atom reference against a freshly loaded structure. */
function resolveAtom(s: Structure, ref: AtomRef): number {
  for (let r = 0; r < s.residueCount; r++) {
    if (s.resSeq[r] !== ref.seq) continue;
    if (s.chainAuthId[s.resChain[r]] !== ref.chain) continue;
    if (resNameOf(s, r) !== ref.residue) continue;
    for (let a = s.resAtomStart[r], e = s.resAtomStart[r + 1]; a < e; a++) {
      if (atomNameOf(s, a) === ref.atom) return a;
    }
  }
  return -1;
}

export interface RestoreReport {
  panesRestored: number;
  measurementsDropped: number;
  failures: string[];
}

/**
 * Rebuilds a session. Entries are loaded first and cameras applied afterwards,
 * because loading auto-frames the view and would otherwise overwrite whatever
 * was saved.
 */
export async function restoreProject(doc: ProjectDocument): Promise<RestoreReport> {
  const store = useStore.getState();
  const report: RestoreReport = { panesRestored: 0, measurementsDropped: 0, failures: [] };

  const layout = doc.session?.layout ?? 'single';
  store.setLayout(layout);
  store.setLinkedCameras(doc.session?.linkedCameras ?? false);

  const paneCount = Math.min(doc.panes.length, LAYOUT_SLOT_COUNT[layout]);

  // Clear panes this project does not use, so nothing stale is left behind.
  for (let i = 0; i < LAYOUT_SLOT_COUNT[layout]; i++) {
    if (i >= paneCount || !doc.panes[i]?.entryId) viewer.unload(i);
  }

  for (let i = 0; i < paneCount; i++) {
    const pane = doc.panes[i];
    if (!pane?.entryId) continue;
    try {
      await viewer.load(i, pane.entryId, undefined, pane.modelNum);
    } catch (err) {
      report.failures.push(
        `Pane ${i + 1} (${pane.entryId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const structure = viewer.getStructure(i);
    if (!structure) {
      report.failures.push(`Pane ${i + 1} (${pane.entryId}) did not load`);
      continue;
    }

    useStore.getState().patchSlot(i, {
      assemblyId: pane.assemblyId ?? '',
      colorScheme: pane.colorScheme,
      uniformColor: pane.uniformColor,
      visual: { ...pane.visual },
      showHydrogenBonds: false,
      showLabels: pane.showLabels ?? true,
      spinning: pane.spinning ?? false,
      superposedOnto: pane.superposedOnto ?? null,
      superposeRmsd: pane.superposeRmsd ?? null,
      superposePairs: pane.superposePairs ?? null,
      representation: {
        showHydrogens: pane.representation.showHydrogens,
        atomScale: pane.representation.atomScale,
        bondRadius: pane.representation.bondRadius,
        hiddenChains: new Set(pane.representation.hiddenChains ?? []),
      },
    });

    if (Array.isArray(pane.components) && pane.components.length > 0) {
      useStore.getState().setComponents(
        i,
        pane.components.map((c) => makeComponent(c)),
      );
    }

    const measurements: Measurement[] = [];
    for (const m of pane.measurements ?? []) {
      const atoms = m.atoms.map((ref) => resolveAtom(structure, ref));
      if (atoms.some((a) => a < 0)) {
        report.measurementsDropped++;
        continue;
      }
      measurements.push(createMeasurement(structure, m.kind, atoms));
    }
    useStore.getState().patchSlot(i, { measurements });

    if (pane.sceneTransform?.length === 16) {
      viewer.engine.setSceneTransform(i, Float32Array.from(pane.sceneTransform));
    }

    viewer.rebuild(i);
    if (pane.camera) {
      viewer.engine.getCamera(i).setState({
        target: pane.camera.target,
        orientation: pane.camera.orientation,
        distance: pane.camera.distance,
      });
    }
    if (pane.showHydrogenBonds) viewer.toggleHydrogenBonds(i, true);
    viewer.refreshOverlay(i);

    report.panesRestored++;
  }

  useStore.getState().setActiveSlot(
    Math.min(doc.session?.activeSlot ?? 0, LAYOUT_SLOT_COUNT[layout] - 1),
  );
  viewer.invalidate();
  return report;
}

/** Suggests a filename from what the project contains. */
export function projectFilename(doc: ProjectDocument): string {
  const ids = doc.panes.map((p) => p.entryId).filter(Boolean) as string[];
  const stem = ids.length > 0 ? ids.join('-').toLowerCase() : 'session';
  return `${stem}.molview.json`;
}

if (import.meta.env.DEV) {
  // Companion to `window.viewer` / `window.store`, for driving round trips
  // from the console.
  Object.assign(window as unknown as Record<string, unknown>, {
    serialiseProject, parseProject, restoreProject,
  });
}
