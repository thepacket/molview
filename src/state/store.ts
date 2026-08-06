/**
 * Application state.
 *
 * Deliberately excludes the structures themselves: a few hundred megabytes of
 * typed arrays have no business travelling through a React store. Those live
 * in the viewer controller, and the store holds only what the UI renders.
 */

import { create } from 'zustand';
import {
  EMPTY_FILTERS, type EntryDetail, type EntrySummary, type SearchFilters,
} from '../rcsb/api';
import { DEFAULT_REPRESENTATION, type Representation } from '../gfx/geometry';
import type { Component } from '../mol/components';
import type { Measurement, MeasurementKind } from '../mol/measure';
import { DEFAULT_VISUAL_SETTINGS, MAX_SLOTS, type SlotVisualSettings } from '../gfx/engine';
import type { ColorScheme } from '../mol/coloring';

export type LayoutMode = 'single' | 'columns' | 'rows' | 'triple' | 'quad';

export const LAYOUT_SLOT_COUNT: Record<LayoutMode, number> = {
  single: 1,
  columns: 2,
  rows: 2,
  triple: 3,
  quad: 4,
};

export const DEFAULT_PROJECT_NAME = 'Untitled';

export type SlotStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface SlotStats {
  atoms: number;
  residues: number;
  chains: number;
  triangles: number;
  instances: number;
}

/**
 * Experimental density for one pane.
 *
 * The grids themselves live in the controller — a map is a few million floats
 * and has no business in a React store — so this is only what the panel draws
 * and what a saved project needs to restore the same view.
 */
export interface DensityState {
  status: 'off' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** PDB id for X-ray, EMDB accession for EM. What was actually fetched. */
  source: string | null;
  kind: 'x-ray' | 'em' | null;
  /** Contour of the main map (2Fo-Fc, or the EM map), in sigma. */
  level: number;
  /** Contour of the difference map; drawn at both +level and -level. */
  diffLevel: number;
  showDifference: boolean;
  wireframe: boolean;
  opacity: number;
  /**
   * Ångströms around the drawn atoms to keep; 0 shows the whole box. A box
   * query returns the crystal packing too, and unmasked density buries the
   * model in its neighbours'.
   */
  radius: number;
  triangles: number;
  bytes: number;
  /** Set when the surface hit the triangle budget and is therefore partial. */
  truncated: boolean;
}

export const DEFAULT_DENSITY: DensityState = {
  status: 'off',
  error: null,
  source: null,
  kind: null,
  level: 1.5,
  diffLevel: 3,
  showDifference: false,
  wireframe: true,
  opacity: 0.35,
  radius: 5,
  triangles: 0,
  bytes: 0,
  truncated: false,
};

export interface SlotState {
  entryId: string | null;
  status: SlotStatus;
  progressStage: string;
  progressLoaded: number;
  progressTotal: number;
  error: string | null;
  detail: EntryDetail | null;
  representation: Representation;
  /** Draw layers, applied in order; the last one covering an atom wins. */
  components: Component[];
  /** Assembly id from the file, or '' for the deposited asymmetric unit. */
  assemblyId: string;
  colorScheme: ColorScheme;
  uniformColor: number;
  visual: SlotVisualSettings;
  stats: SlotStats | null;
  /** Atoms matched per component, and parse failures, from the last rebuild. */
  componentCounts: Map<string, number>;
  componentErrors: Map<string, string>;
  /** Residue the pointer is currently over, as a display string. */
  hoverLabel: string | null;
  selectedResidue: number | null;
  selectionLabel: string | null;
  spinning: boolean;
  /** Completed measurements drawn in the pane. */
  measurements: Measurement[];
  /** Atoms clicked so far towards the next measurement. */
  pendingAtoms: number[];
  /** null means clicking selects rather than measures. */
  measureMode: MeasurementKind | null;
  showHydrogenBonds: boolean;
  hydrogenBondCount: number;
  showLabels: boolean;
  /** Set when this pane was opened from a local file rather than an id. */
  sourceFileName: string | null;
  /** Other panes whose structures are also drawn in this one. */
  overlaySlots: number[];
  /** Set when this pane has been superposed onto another. */
  superposedOnto: number | null;
  superposeRmsd: number | null;
  superposePairs: number | null;
  density: DensityState;
}

function emptySlot(): SlotState {
  return {
    entryId: null,
    status: 'empty',
    progressStage: '',
    progressLoaded: 0,
    progressTotal: 0,
    error: null,
    detail: null,
    representation: { ...DEFAULT_REPRESENTATION, hiddenChains: new Set() },
    components: [],
    assemblyId: '',
    colorScheme: 'chain',
    uniformColor: 0x7bb0ff,
    visual: { ...DEFAULT_VISUAL_SETTINGS },
    stats: null,
    componentCounts: new Map(),
    componentErrors: new Map(),
    hoverLabel: null,
    selectedResidue: null,
    selectionLabel: null,
    spinning: false,
    measurements: [],
    pendingAtoms: [],
    measureMode: null,
    showHydrogenBonds: false,
    hydrogenBondCount: 0,
    showLabels: true,
    sourceFileName: null,
    overlaySlots: [],
    superposedOnto: null,
    superposeRmsd: null,
    superposePairs: null,
    density: { ...DEFAULT_DENSITY },
  };
}

export type PanelId =
  | 'browse' | 'entry' | 'style' | 'sequence' | 'measure' | 'scene' | 'project'
  | 'settings';

export interface SearchState {
  filters: SearchFilters;
  status: 'idle' | 'loading' | 'error';
  error: string | null;
  results: EntrySummary[];
  total: number;
  loadedPages: number;
  history: string[];
}

export interface AppState {
  slots: SlotState[];
  layout: LayoutMode;
  activeSlot: number;
  linkedCameras: boolean;
  panel: PanelId;
  panelOpen: boolean;
  inspectorOpen: boolean;
  commandPaletteOpen: boolean;
  gpuName: string;
  gpuError: string | null;
  frameMs: number;
  /** Name of the session being worked on; shown in the title bar. */
  projectName: string;
  /** Id of the saved project this session came from, if any. */
  projectId: string | null;
  search: SearchState;

  setLayout: (layout: LayoutMode) => void;
  setActiveSlot: (slot: number) => void;
  setPanel: (panel: PanelId) => void;
  togglePanel: () => void;
  toggleInspector: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setLinkedCameras: (linked: boolean) => void;
  setGpuInfo: (name: string, error: string | null) => void;
  setFrameMs: (ms: number) => void;
  setProjectName: (name: string) => void;
  setProjectId: (id: string | null) => void;
  /** Wipes every pane back to defaults; the controller frees the GPU side. */
  resetSession: (name: string) => void;

  patchSlot: (slot: number, patch: Partial<SlotState>) => void;
  updateRepresentation: (slot: number, patch: Partial<Representation>) => void;
  setComponents: (slot: number, components: Component[]) => void;
  updateComponent: (slot: number, id: string, patch: Partial<Component>) => void;
  removeComponent: (slot: number, id: string) => void;
  updateVisual: (slot: number, patch: Partial<SlotVisualSettings>) => void;
  updateDensity: (slot: number, patch: Partial<DensityState>) => void;
  clearSlot: (slot: number) => void;

  setFilters: (patch: Partial<SearchFilters>) => void;
  setSearchState: (patch: Partial<SearchState>) => void;
  pushHistory: (term: string) => void;
}

export const useStore = create<AppState>((set) => ({
  slots: Array.from({ length: MAX_SLOTS }, emptySlot),
  layout: 'single',
  activeSlot: 0,
  linkedCameras: false,
  panel: 'browse',
  panelOpen: true,
  inspectorOpen: true,
  commandPaletteOpen: false,
  gpuName: '',
  gpuError: null,
  frameMs: 0,
  projectName: DEFAULT_PROJECT_NAME,
  projectId: null,
  search: {
    filters: { ...EMPTY_FILTERS },
    status: 'idle',
    error: null,
    results: [],
    total: 0,
    loadedPages: 0,
    history: [],
  },

  setLayout: (layout) => set((s) => ({
    layout,
    activeSlot: Math.min(s.activeSlot, LAYOUT_SLOT_COUNT[layout] - 1),
  })),
  setActiveSlot: (activeSlot) => set({ activeSlot }),
  setPanel: (panel) => set((s) => ({
    panel,
    panelOpen: s.panel === panel ? !s.panelOpen : true,
  })),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setLinkedCameras: (linkedCameras) => set({ linkedCameras }),
  setGpuInfo: (gpuName, gpuError) => set({ gpuName, gpuError }),
  setFrameMs: (frameMs) => set({ frameMs }),
  setProjectName: (projectName) => set({
    projectName: projectName.trim() || DEFAULT_PROJECT_NAME,
  }),
  setProjectId: (projectId) => set({ projectId }),

  resetSession: (name) => set({
    slots: Array.from({ length: MAX_SLOTS }, emptySlot),
    layout: 'single',
    activeSlot: 0,
    linkedCameras: false,
    projectName: name.trim() || DEFAULT_PROJECT_NAME,
    projectId: null,
  }),

  patchSlot: (slot, patch) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = { ...slots[slot], ...patch };
    return { slots };
  }),

  updateRepresentation: (slot, patch) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = {
      ...slots[slot],
      representation: { ...slots[slot].representation, ...patch },
    };
    return { slots };
  }),

  setComponents: (slot, components) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = { ...slots[slot], components };
    return { slots };
  }),

  updateComponent: (slot, id, patch) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = {
      ...slots[slot],
      components: slots[slot].components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    };
    return { slots };
  }),

  removeComponent: (slot, id) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = {
      ...slots[slot],
      components: slots[slot].components.filter((c) => c.id !== id),
    };
    return { slots };
  }),

  updateVisual: (slot, patch) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = { ...slots[slot], visual: { ...slots[slot].visual, ...patch } };
    return { slots };
  }),

  updateDensity: (slot, patch) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = { ...slots[slot], density: { ...slots[slot].density, ...patch } };
    return { slots };
  }),

  clearSlot: (slot) => set((s) => {
    const slots = s.slots.slice();
    slots[slot] = emptySlot();
    return { slots };
  }),

  setFilters: (patch) => set((s) => ({
    search: { ...s.search, filters: { ...s.search.filters, ...patch } },
  })),

  setSearchState: (patch) => set((s) => ({ search: { ...s.search, ...patch } })),

  pushHistory: (term) => set((s) => {
    const trimmed = term.trim();
    if (!trimmed) return {};
    const history = [trimmed, ...s.search.history.filter((h) => h !== trimmed)].slice(0, 12);
    return { search: { ...s.search, history } };
  }),
}));

export function visibleSlotCount(layout: LayoutMode): number {
  return LAYOUT_SLOT_COUNT[layout];
}

if (import.meta.env.DEV) {
  // Companion to `window.viewer`; lets state be driven from the console.
  (window as unknown as { store: typeof useStore }).store = useStore;
}
