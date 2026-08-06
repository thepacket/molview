/**
 * Applying assistant actions to the viewer.
 *
 * The vocabulary itself lives in actionTypes.ts; this is only the executor.
 * Actions arrive inside the model's JSON reply as `{type, reason, value}` and
 * are applied here. Every branch re-validates against live state and returns a
 * sentence for the transcript, so a wrong id becomes "rejected: ..." rather
 * than a silent no-op.
 *
 * The surface is deliberately small and made only of reversible view changes.
 * Nothing here writes to disk, sends data anywhere, or touches the API key.
 */

import { type Action } from './actionTypes';
import { Style, makeComponent, STYLE_LABELS } from '../mol/components';
import { COLOR_SCHEME_LABELS, type ColorScheme } from '../mol/coloring';
import { evaluateSelection, parseSelection, selectionError } from '../mol/selection';
import { createMeasurement, describeAtom, type MeasurementKind } from '../mol/measure';
import {
  findInterfaces, interfaceSelection, measureInterfaceAreas,
} from '../mol/interfaces';
import { findPockets, pocketSelection } from '../mol/pockets';
import { searchUniProt } from '../rcsb/alphafold';
import { fetchSummaries, searchByShape, searchBySequence } from '../rcsb/api';
import { MolKind } from '../mol/structure';
import type { NucleotideStyle } from '../gfx/geometry';
import {
  LAYOUT_SLOT_COUNT, useStore,
  type DensityState, type LayoutMode, type SurfaceState,
} from '../state/store';
import { viewer } from '../viewer/ViewerController';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STYLE_BY_NAME: Record<string, Style> = {
  cartoon: Style.Cartoon,
  backbone: Style.Backbone,
  'backbone-trace': Style.Backbone,
  trace: Style.Backbone,
  'ball-stick': Style.BallStick,
  'ball-and-stick': Style.BallStick,
  ballstick: Style.BallStick,
  licorice: Style.Licorice,
  sticks: Style.Licorice,
  spacefill: Style.Spacefill,
  spheres: Style.Spacefill,
  hidden: Style.None,
  none: Style.None,
};

const LIGHTING: Record<string, { aoIntensity: number; aoRadius: number; outline: number; fogDensity: number }> = {
  studio: { aoIntensity: 1, aoRadius: 4.5, outline: 0.85, fogDensity: 0.006 },
  soft: { aoIntensity: 1.45, aoRadius: 8, outline: 0, fogDensity: 0.004 },
  flat: { aoIntensity: 0, aoRadius: 0, outline: 1.2, fogDensity: 0 },
  plain: { aoIntensity: 0, aoRadius: 0, outline: 0, fogDensity: 0 },
};

const BACKGROUNDS: Record<string, [number, number, number]> = {
  void: [0.043, 0.051, 0.071],
  slate: [0.11, 0.13, 0.16],
  ink: [0.02, 0.02, 0.03],
  bone: [0.87, 0.88, 0.9],
};

function reject(message: string): string {
  return `Rejected: ${message}`;
}

/** Pane index from a trailing "pane N", or the active pane. */
function paneFrom(text: string | null | undefined): { pane: number; rest: string } {
  const state = useStore.getState();
  const raw = (text ?? '').trim();
  const match = /\s*\bpane\s*(\d+)\s*$/i.exec(raw);
  if (match) {
    return { pane: Number(match[1]) - 1, rest: raw.slice(0, match.index).trim() };
  }
  return { pane: state.activeSlot, rest: raw };
}

function paneExists(pane: number): boolean {
  const state = useStore.getState();
  return Number.isInteger(pane) && pane >= 0 && pane < LAYOUT_SLOT_COUNT[state.layout];
}

/** Resolves a selection that is meant to name exactly one atom. */
function singleAtom(slot: number, spec: string): number | string {
  const structure = viewer.getStructure(slot);
  if (!structure) return 'that pane has no structure';
  const problem = selectionError(spec);
  if (problem) return `"${spec}" is not a valid selection (${problem})`;

  const mask = evaluateSelection(parseSelection(spec), structure);
  let found = -1;
  let count = 0;
  for (let a = 0; a < mask.length; a++) {
    if (!mask[a]) continue;
    count++;
    if (found < 0) found = a;
  }
  if (count === 0) return `"${spec}" matched no atoms`;
  // More than one is usually a too-loose spec; taking the first would quietly
  // measure something the user did not mean.
  if (count > 1) return `"${spec}" matched ${count} atoms; name a single atom`;
  return found;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function applyAction(action: Action): Promise<string> {
  const store = useStore.getState();
  const value = (action.value ?? '').trim();

  switch (action.type) {
    case 'load': {
      const { pane, rest } = paneFrom(value);
      const id = rest.toUpperCase();
      if (!/^[0-9][A-Z0-9]{3}$/.test(id)) return reject(`"${rest}" is not a PDB id`);
      if (!paneExists(pane)) return reject(`pane ${pane + 1} is not in the current layout`);
      await viewer.load(pane, id);
      const slot = useStore.getState().slots[pane];
      return slot.status === 'error'
        ? reject(`${id} did not load (${slot.error})`)
        : `Loaded ${id} into pane ${pane + 1}.`;
    }

    case 'clear': {
      const pane = value ? Number(value) - 1 : store.activeSlot;
      if (!paneExists(pane)) return reject(`pane ${value} is not in the current layout`);
      viewer.unload(pane);
      return `Cleared pane ${pane + 1}.`;
    }

    case 'layout': {
      const layouts: LayoutMode[] = ['single', 'columns', 'rows', 'quad'];
      if (!layouts.includes(value as LayoutMode)) return reject(`unknown layout "${value}"`);
      store.setLayout(value as LayoutMode);
      return `Switched to the ${value} layout.`;
    }

    case 'pane': {
      const pane = Number(value) - 1;
      if (!paneExists(pane)) return reject(`pane ${value} is not in the current layout`);
      store.setActiveSlot(pane);
      return `Pane ${pane + 1} is now active.`;
    }

    case 'component': {
      const parts = value.split('|').map((p) => p.trim());
      if (parts.length < 3) {
        return reject('component needs "Name | selection | style" at least');
      }
      const [name, selection, styleName, colorName] = parts;
      const style = STYLE_BY_NAME[styleName.toLowerCase()];
      if (style === undefined) {
        return reject(
          `unknown style "${styleName}" — use one of `
          + `${Object.values(STYLE_LABELS).join(', ')}. `
          + 'For nucleotide bases use the nucleotides action, and for colouring '
          + 'name a colour scheme in the fourth field instead.',
        );
      }

      const problem = selectionError(selection);
      if (problem) return reject(`selection "${selection}" is invalid (${problem})`);

      let colorScheme: ColorScheme | null = null;
      if (colorName) {
        const key = colorName.toLowerCase().replace(/\s+/g, '');
        const match = (Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[])
          .find((s) => s === key || COLOR_SCHEME_LABELS[s].toLowerCase().startsWith(key));
        if (!match) return reject(`unknown colour scheme "${colorName}"`);
        colorScheme = match;
      }

      const slot = store.activeSlot;
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);

      const existing = store.slots[slot].components;
      store.setComponents(slot, [
        ...existing.filter((c) => c.name.toLowerCase() !== name.toLowerCase()),
        makeComponent({ name, selection, style, colorScheme }),
      ]);
      return `Added "${name}" — ${selection} as ${STYLE_LABELS[style].toLowerCase()}.`;
    }

    case 'remove-component': {
      const slot = store.activeSlot;
      const components = store.slots[slot].components;
      if (value.toLowerCase() === 'all') {
        store.setComponents(slot, []);
        return 'Removed every draw layer.';
      }
      const target = components.find((c) => c.name.toLowerCase() === value.toLowerCase());
      if (!target) return reject(`no layer named "${value}"`);
      store.removeComponent(slot, target.id);
      return `Removed "${target.name}".`;
    }

    case 'color': {
      const key = value.toLowerCase().replace(/\s+/g, '');
      const scheme = (Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[])
        .find((s) => s === key || COLOR_SCHEME_LABELS[s].toLowerCase().startsWith(key));
      if (!scheme) return reject(`unknown colour scheme "${value}"`);

      const slot = store.activeSlot;
      // Two schemes need data fetched before they mean anything, and a scheme
      // that silently paints everything "not measured" is worse than a refusal.
      if (scheme === 'pathogenicity') {
        if (!store.slots[slot].prediction) {
          return reject('AlphaMissense only exists for predicted structures');
        }
        if (!await viewer.loadMissense(slot)) {
          return reject('the AlphaMissense annotation could not be fetched');
        }
      }
      if (scheme === 'plddt' && !store.slots[slot].prediction) {
        return reject('pLDDT only exists for predicted structures — this pane holds an experiment');
      }

      store.patchSlot(slot, { colorScheme: scheme });
      return `Colouring by ${COLOR_SCHEME_LABELS[scheme].toLowerCase()}.`;
    }

    case 'assembly': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);
      if (/^(asym|asymmetric|au|none)$/i.test(value)) {
        store.patchSlot(slot, { assemblyId: '' });
        return 'Showing the deposited asymmetric unit.';
      }
      const assembly = structure.assemblies.find((a) => a.id === value);
      if (!assembly) {
        const ids = structure.assemblies.map((a) => a.id).join(', ') || 'none';
        return reject(`this entry has no assembly "${value}" (available: ${ids})`);
      }
      store.patchSlot(slot, { assemblyId: assembly.id });
      const copies = assembly.totalCopies;
      return `Showing assembly ${assembly.id} — ${copies} cop${copies === 1 ? 'y' : 'ies'}.`;
    }

    case 'focus': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);
      const problem = selectionError(value);
      if (problem) return reject(`selection "${value}" is invalid (${problem})`);

      const mask = evaluateSelection(parseSelection(value), structure);
      let first = -1;
      let count = 0;
      for (let a = 0; a < mask.length; a++) {
        if (mask[a]) { count++; if (first < 0) first = a; }
      }
      if (count === 0) return reject(`"${value}" matched no atoms`);
      viewer.focusResidue(slot, structure.atomResidue[first]);
      return `Focused on ${value} (${count.toLocaleString()} atoms).`;
    }

    case 'reset-view':
      viewer.resetView(store.activeSlot);
      return 'Framed the whole structure.';

    case 'spin': {
      const on = /^(on|true|yes|start)$/i.test(value);
      store.patchSlot(store.activeSlot, { spinning: on });
      return on ? 'Auto-rotate on.' : 'Auto-rotate off.';
    }

    case 'lighting': {
      const preset = LIGHTING[value.toLowerCase()];
      if (!preset) return reject(`unknown lighting preset "${value}"`);
      store.updateVisual(store.activeSlot, preset);
      return `Lighting set to ${value.toLowerCase()}.`;
    }

    case 'background': {
      const background = BACKGROUNDS[value.toLowerCase()];
      if (!background) return reject(`unknown background "${value}"`);
      store.updateVisual(store.activeSlot, { background });
      return `Background set to ${value.toLowerCase()}.`;
    }

    case 'hbonds': {
      const on = /^(on|true|yes|show)$/i.test(value);
      const slot = store.activeSlot;
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);
      viewer.toggleHydrogenBonds(slot, on);
      const count = useStore.getState().slots[slot].hydrogenBondCount;
      return on ? `Showing ${count.toLocaleString()} hydrogen bonds.` : 'Hydrogen bonds hidden.';
    }

    case 'view': {
      const slot = store.activeSlot;
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);
      const want = (value ?? '').trim().toLowerCase();
      if (want === 'orient') {
        viewer.orientView(slot);
        return 'Turned to the structure\'s own axes.';
      }
      const m = /^(-?)([xyz])$/.exec(want);
      if (!m) return reject('view takes "orient", or an axis such as "x" or "-z"');
      viewer.viewAlongAxis(slot, m[2] as 'x' | 'y' | 'z', m[1] === '-');
      return `Looking down ${m[1]}${m[2].toUpperCase()}.`;
    }

    case 'pockets': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);

      const limit = Math.min(8, Number(/(\d+)/.exec(value)?.[1] ?? 5));
      const pockets = findPockets(structure).slice(0, limit);
      if (pockets.length === 0) return 'No enclosed cavity above 40 A3 in this structure.';

      const lines = pockets.map((p, i) => {
        const ligands = p.ligands.length > 0 ? ` containing ${p.ligands.join(', ')}` : '';
        const lining = p.lining.slice(0, 6).map((r) => `${r.name}${r.seq}`).join(' ');
        return `${i + 1}. ${Math.round(p.volume)} A3${ligands}, lined by ${lining}`;
      });

      // The same shape the other query actions use: a ranking plus one string
      // that can be handed to a component or focus action unchanged.
      return `Cavities by volume:\n${lines.join('\n')}\n`
        + `Selection for the largest: ${pocketSelection(pockets[0])}\n`
        + 'Ligands were excluded from the scan, so any named above were found rather '
        + 'than assumed. This is concavity, not affinity.';
    }

    case 'similar': {
      const slot = store.activeSlot;
      const state = store.slots[slot];
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);
      if (!state.entryId || state.prediction) {
        return reject('similar searches from a PDB entry; this pane holds a prediction or a file');
      }

      const want = value.toLowerCase();
      const byShape = !/seq/.test(want);
      const limit = Math.min(15, Number(/(\d+)/.exec(want)?.[1] ?? 8));

      let result;
      if (byShape) {
        result = await searchByShape(state.entryId, state.assemblyId || '1', limit + 1);
      } else {
        const chain = state.detail?.polymerEntities
          .filter((e) => e.sequence)
          .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0))[0];
        if (!chain?.sequence) return reject('this entry has no polymer sequence to search with');
        result = await searchBySequence(chain.sequence, 0.3, (limit + 1) * 2);
      }

      // An entry is always its own best match; reporting it is noise the model
      // would otherwise repeat back as a finding.
      const hits = result.hits.filter((h) => h.entryId !== state.entryId).slice(0, limit);
      if (hits.length === 0) return `Nothing else in the archive matches ${state.entryId}.`;

      const summaries = await fetchSummaries(hits.map((h) => h.entryId));
      const lines = hits.map((h) => {
        const summary = summaries.get(h.entryId);
        const measure = byShape
          ? `shape ${h.score.toFixed(3)}`
          : `${Math.round((h.identity ?? 0) * 100)}% identity`;
        return `${h.entryId} (${measure}): ${summary?.title ?? 'unknown'}`;
      });

      return `${result.total.toLocaleString()} structures resemble ${state.entryId} by `
        + `${byShape ? 'shape' : 'sequence'}. Closest: ${lines.join('; ')}. `
        + 'Use the load action to open any of them.';
    }

    case 'predicted': {
      const { pane, rest } = paneFrom(value);
      if (!paneExists(pane)) return reject(`pane ${pane + 1} is not in the current layout`);
      const query = rest.trim();
      if (!query) return reject('predicted needs a protein name, a gene, or a UniProt accession');

      const accession = /^[A-NR-Z][0-9][A-Z0-9]{3}[0-9]$|^[OPQ][0-9][A-Z0-9]{3}[0-9]$/i;
      if (accession.test(query)) {
        await viewer.loadPrediction(pane, query.toUpperCase());
        const slot = useStore.getState().slots[pane];
        if (slot.status === 'error') return reject(slot.error ?? 'the model could not be loaded');
        const p = slot.prediction;
        return `Loaded the AlphaFold model of ${p?.description ?? query} into pane ${pane + 1}`
          + `${p ? `, mean pLDDT ${p.meanPlddt.toFixed(0)}` : ''}. It is a prediction, `
          + 'not a measurement.';
      }

      // A name is ambiguous, so the hits come back for the model to choose from
      // rather than the first one being loaded on its behalf.
      const hits = await searchUniProt(query);
      if (hits.length === 0) return reject(`nothing in UniProt matches "${query}"`);
      const lines = hits.slice(0, 8).map((h) => `${h.accession} ${h.id}: ${h.name}`
        + `${h.gene ? ` (${h.gene})` : ''}${h.organism ? ` — ${h.organism}` : ''}`);
      return `UniProt entries matching "${query}":\n${lines.join('\n')}\n`
        + 'Run predicted again with the accession you want.';
    }

    case 'validation': {
      const slot = store.activeSlot;
      const state = store.slots[slot];
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);
      if (!state.entryId || state.sourceFileName) {
        return reject('a local file has no wwPDB report');
      }

      const raw = value.toLowerCase();
      const metric = /geom|clash|bond|angle|rotamer|rama/.test(raw) ? 'outliers' : 'rsrz';
      const limitMatch = /top\s+(\d+)/.exec(raw);
      const limit = limitMatch ? Math.min(25, Number(limitMatch[1])) : 8;

      const validation = await viewer.loadResidueValidation(slot);
      if (!validation) return reject('the per-residue report could not be fetched');
      if (metric === 'rsrz' && !validation.hasDensityFit) {
        return 'This entry has no per-residue fit to density: structure factors '
          + 'were never deposited, so only geometry can be checked.';
      }

      const worst = viewer.worstResidues(slot, metric, limit);
      if (worst.length === 0) {
        return metric === 'rsrz'
          ? 'No residue in this entry is an outlier by fit to density.'
          : 'The report lists no geometry outliers in this entry.';
      }

      const lines = worst.map((r) => `${r.chain} ${r.seq}: ${
        metric === 'rsrz'
          ? `RSRZ ${r.value.toFixed(1)}`
          : `${r.value} outlier${r.value === 1 ? '' : 's'}`}`);
      // The same shape the interfaces action returns: a ranked list and one
      // string that can be handed straight to a component or focus action.
      const selection = worst
        .map((r) => `(/${r.chain} and :${r.seq})`)
        .join(' or ');

      return `Worst residues by ${metric === 'rsrz' ? 'fit to density' : 'geometry'}:\n`
        + `${lines.join('\n')}\nSelection covering them: ${selection}`;
    }

    case 'clip': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);
      const want = value.toLowerCase();

      if (/^(off|none|clear|no)$/.test(want)) {
        store.updateVisual(slot, { clipNear: 0, clipFar: 0 });
        viewer.syncSettings();
        return 'Clipping cleared.';
      }

      const span = structure.radius * 2;
      const m = /^(front|back|near|far|slab|section)\s+([\d.]+)/.exec(want);
      if (!m) return reject('clip takes "off", or "front N", "back N" or "slab N" in angstroms');
      const amount = Number(m[2]);
      if (!Number.isFinite(amount) || amount < 0) return reject('the distance must be positive');

      if (/slab|section/.test(m[1])) {
        // A slab is described by its thickness, but stored as the two insets
        // that produce it, centred on the middle of the structure.
        const inset = Math.max(0, (span - Math.min(amount, span)) / 2);
        store.updateVisual(slot, { clipNear: inset, clipFar: inset });
        viewer.syncSettings();
        return `Showing a ${Math.min(amount, span).toFixed(0)} A slab through the middle.`;
      }

      const key = /front|near/.test(m[1]) ? 'clipNear' : 'clipFar';
      const other = key === 'clipNear' ? store.slots[slot].visual.clipFar
        : store.slots[slot].visual.clipNear;
      store.updateVisual(slot, { [key]: Math.min(amount, Math.max(0, span - other - 1)) });
      viewer.syncSettings();
      const v = useStore.getState().slots[slot].visual;
      return `Clipping ${v.clipNear.toFixed(0)} A off the front and `
        + `${v.clipFar.toFixed(0)} A off the back, leaving a `
        + `${(span - v.clipNear - v.clipFar).toFixed(0)} A slab.`;
    }

    case 'surface': {
      const slot = store.activeSlot;
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);
      const want = value.toLowerCase();

      if (/^(off|hide|no|false|none)$/.test(want)) {
        viewer.hideSurface(slot);
        return 'Molecular surface removed.';
      }

      const patch: Partial<SurfaceState> = {};
      let rebuild = true;
      const opacity = /^opacity\s+([\d.]+)$/.exec(want);
      const probe = /^probe\s+([\d.]+)$/.exec(want);

      if (opacity) {
        patch.opacity = Math.min(1, Math.max(0.05, Number(opacity[1])));
        rebuild = false;
      } else if (probe) {
        patch.probeRadius = Math.min(3, Math.max(0, Number(probe[1])));
      } else if (/^(wire|wireframe|mesh)$/.test(want)) {
        patch.wireframe = true;
        rebuild = false;
      } else if (/^(solid|opaque|surface)$/.test(want)) {
        patch.wireframe = false;
        rebuild = false;
      } else if (want && !/^(on|show|yes|true)$/.test(want)) {
        // Anything else is a selection; reject a bad one here rather than
        // spending two seconds discovering it matches nothing.
        const error = selectionError(value);
        if (error) return reject(`selection error: ${error}`);
        patch.selection = value;
      }

      store.updateSurface(slot, patch);
      const ready = useStore.getState().slots[slot].surface.status === 'ready';
      if (rebuild || !ready) viewer.showSurface(slot);
      else viewer.refreshSurfaceStyle(slot);

      const now = useStore.getState().slots[slot].surface;
      if (now.status !== 'ready') return reject(now.error ?? 'the surface could not be built');
      return `Molecular surface over ${now.selection || 'everything drawn'}: `
        + `${now.triangles.toLocaleString()} triangles at a ${now.actualResolution.toFixed(2)} A grid, `
        + `${now.wireframe ? 'as wireframe' : `${now.opacity.toFixed(2)} opacity`}.`;
    }

    case 'density': {
      const slot = store.activeSlot;
      if (!viewer.getStructure(slot)) return reject(`pane ${slot + 1} has no structure`);
      const want = value.toLowerCase();

      if (/^(off|hide|no|false)$/.test(want)) {
        viewer.hideDensity(slot);
        return 'Density map removed.';
      }

      const loaded = () => useStore.getState().slots[slot].density.status === 'ready';
      // Everything except "off" implies the map should be there, so a tuning
      // value on a pane with no map loads it rather than being rejected.
      if (!loaded()) {
        await viewer.showDensity(slot);
        const after = useStore.getState().slots[slot].density;
        if (after.status !== 'ready') return reject(after.error ?? 'the map could not be fetched');
      }

      const patch: Partial<DensityState> = {};
      const sigma = /(-?\d+(?:\.\d+)?)\s*(?:sigma|σ)?$/.exec(want);
      if (/difference|fo-?fc/.test(want)) {
        patch.showDifference = !/\b(off|no|hide)\b/.test(want);
      } else if (/^around\b/.test(want)) {
        const n = Number.parseFloat(want.replace(/^around\s*/, ''));
        if (!Number.isFinite(n) || n < 0) return reject('"around" needs a distance in angstroms');
        patch.radius = Math.min(n, 12);
      } else if (/solid|surface|opaque/.test(want)) {
        patch.wireframe = false;
      } else if (/wire|mesh|chicken/.test(want)) {
        patch.wireframe = true;
      } else if (sigma && !/^(on|show|yes|true)$/.test(want)) {
        const n = Number.parseFloat(sigma[1]);
        if (!Number.isFinite(n) || n <= 0) return reject('a contour level must be positive');
        patch.level = n;
      }

      if (Object.keys(patch).length > 0) {
        store.updateDensity(slot, patch);
        viewer.rebuildDensity(slot);
      }

      const now = useStore.getState().slots[slot].density;
      const parts = [
        `${now.source} at ${now.level.toFixed(1)} sigma`,
        now.wireframe ? 'as wireframe' : `as a solid surface at ${now.opacity.toFixed(2)} opacity`,
      ];
      if (now.showDifference) parts.push(`with the Fo-Fc map at ±${now.diffLevel.toFixed(1)} sigma`);
      parts.push(now.radius > 0
        ? `within ${now.radius} A of the drawn atoms`
        : 'over the whole box');

      const summary = `Showing ${parts.join(', ')}.`;
      return now.truncated
        ? `${summary} The surface hit its triangle budget and is incomplete — `
          + 'raise the contour or narrow the region around the model.'
        : summary;
    }

    case 'nucleotides': {
      const styles = ['slab', 'ladder', 'stubs', 'none'] as const;
      const want = (value ?? '').trim().toLowerCase();
      if (!(styles as readonly string[]).includes(want)) {
        return reject(`nucleotide style must be one of ${styles.join(', ')}`);
      }
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);
      let hasNucleic = false;
      for (let c = 0; c < structure.chainCount; c++) {
        if (structure.chainKind[c] === MolKind.Nucleic) { hasNucleic = true; break; }
      }
      if (!hasNucleic) return reject('this structure has no nucleic acid');
      store.updateRepresentation(slot, { nucleotideStyle: want as NucleotideStyle });
      return `Nucleotide bases drawn as ${want}.`;
    }

    case 'interfaces': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);

      // The assembly on screen, so a capsid reports its lattice contacts rather
      // than only what its asymmetric unit happens to contain.
      const assemblyId = store.slots[slot].assemblyId;
      const assembly = structure.assemblies.find((a) => a.id === assemblyId) ?? null;
      const all = findInterfaces(structure, { assembly });
      if (all.length === 0) return 'No chain touches another in this pane.';

      const raw = (value ?? '').trim();
      const limitMatch = /^top\s+(\d+)$/i.exec(raw);
      const limit = limitMatch ? Math.min(20, Number(limitMatch[1])) : 8;

      // "A", "A,B", "A B" and "A-B" are all natural ways to ask, and a pair is
      // the commonest: the answer to "show me the A-B interface" is one entry
      // plus the selection that draws it.
      const parts = limitMatch ? [] : raw.split(/[\s,;-]+/).filter(Boolean);
      const [wantA, wantB] = parts;

      let matching = all;
      if (wantA && wantB) {
        matching = all.filter((i) => (i.chainA === wantA && i.chainB === wantB)
          || (i.chainA === wantB && i.chainB === wantA));
        if (matching.length === 0) {
          return reject(`chains ${wantA} and ${wantB} do not touch`);
        }
      } else if (wantA) {
        matching = all.filter((i) => i.chainA === wantA || i.chainB === wantA);
        if (matching.length === 0) {
          return reject(`chain ${wantA} touches nothing, or is not a chain here`);
        }
      }
      const chainFilter = parts.join(' and ');

      // Areas only for what is being reported: it is four SASA passes per pair,
      // and a capsid's full list would be a hundred of them for lines nobody
      // reads.
      const reported = matching.slice(0, limit);
      measureInterfaceAreas(structure, reported);

      const lines = reported.map((i) => {
        const partner = i.copyB === undefined ? i.chainB : `${i.chainB} (copy ${i.copyB})`;
        const area = i.area != null ? `, buries ${Math.round(i.area)} A2` : '';
        return `${i.chainA}-${partner}: ${i.contacts} contacts, ${i.polar} polar${area}`;
      });
      const more = matching.length > lines.length
        ? ` (${matching.length - lines.length} weaker `
          + `pair${matching.length - lines.length === 1 ? '' : 's'} omitted)`
        : '';

      // A named pair is nearly always a prelude to drawing it, so hand back the
      // selection rather than making the model reconstruct residue lists it has
      // not been shown. Without this it invents one, and invents it wrong.
      const draw = wantA && wantB && matching.length === 1
        ? ` To draw it, use this selection: ${interfaceSelection(matching[0])}`
        : '';

      return `Contacts by chain pair${chainFilter ? ` for ${chainFilter}` : ''}: `
        + `${lines.join('; ')}${more}.${draw}`;
    }

    case 'measure': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);

      const [kindWord, ...specs] = value.split(/\s+/).filter(Boolean);
      const kind = (kindWord ?? '').toLowerCase() as MeasurementKind;
      const needed = kind === 'distance' ? 2 : kind === 'angle' ? 3 : kind === 'torsion' ? 4 : 0;
      if (!needed) return reject(`unknown measurement "${kindWord}"`);
      if (specs.length !== needed) {
        const article = kind === 'angle' ? 'an' : 'a';
        return reject(`${article} ${kind} needs ${needed} atoms, got ${specs.length}`);
      }

      const atoms: number[] = [];
      for (const spec of specs) {
        const resolved = singleAtom(slot, spec);
        if (typeof resolved === 'string') return reject(resolved);
        atoms.push(resolved);
      }

      const measurement = createMeasurement(structure, kind, atoms);
      store.patchSlot(slot, {
        measurements: [...store.slots[slot].measurements, measurement],
      });
      viewer.refreshOverlay(slot);
      const labels = atoms.map((a) => describeAtom(structure, a)).join(' → ');
      return `${kind} ${labels} = ${measurement.label}`;
    }

    case 'superpose': {
      const match = /^(\d+)\s+onto\s+(\d+)(?:\s+chain\s+(\S+)\s+onto\s+(\S+))?$/i.exec(value);
      if (!match) return reject('superpose expects "2 onto 1" or "2 onto 1 chain B onto A"');
      const mobile = Number(match[1]) - 1;
      const reference = Number(match[2]) - 1;
      if (!paneExists(mobile) || !paneExists(reference)) {
        return reject('one of those panes is not in the current layout');
      }
      const result = viewer.superpose(mobile, reference, match[3], match[4]);
      if (typeof result === 'string') return reject(result);
      return `Superposed pane ${mobile + 1} onto pane ${reference + 1} — `
        + `RMSD ${result.rmsd.toFixed(2)} Å over ${result.pairs} matched Cα.`;
    }

    case 'overlay': {
      const slot = store.activeSlot;
      if (/^(off|none|clear)$/i.test(value)) {
        viewer.setOverlaySlots(slot, []);
        return 'Cleared the overlay.';
      }
      const panes = value.split(',').map((p) => Number(p.trim()) - 1);
      if (panes.some((p) => !paneExists(p))) {
        return reject('one of those panes is not in the current layout');
      }
      viewer.setOverlaySlots(slot, panes);
      const applied = useStore.getState().slots[slot].overlaySlots;
      if (applied.length === 0) return reject('none of those panes has a structure');
      return `Drawing pane${applied.length > 1 ? 's' : ''} `
        + `${applied.map((p) => p + 1).join(', ')} inside pane ${slot + 1}.`;
    }

    case 'ensemble': {
      const slot = store.activeSlot;
      const structure = viewer.getStructure(slot);
      if (!structure) return reject(`pane ${slot + 1} has no structure`);
      if (structure.modelCount < 2) return reject('this entry has only one model');
      const on = /^(on|true|yes|all)$/i.test(value);
      await viewer.setEnsembleOverlay(slot, on);
      return on
        ? `Showing all ${structure.modelCount} models.`
        : 'Showing a single model.';
    }

    default:
      return reject('unsupported action');
  }
}
