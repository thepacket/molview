/**
 * The scene as a PyMOL or ChimeraX script.
 *
 * MolView is not where a figure is finished. It is a good place to work out
 * what a figure should show — which chains, which ligand, which slab, which
 * orientation — and a bad place to spend an afternoon on ray-traced ambient
 * occlusion. A script that reproduces the view somewhere else turns it into a
 * first step rather than a dead end.
 *
 * The interesting part is translating selections. MolView's grammar is its
 * own, so the component expressions are recompiled from their parsed form
 * rather than string-substituted — string substitution gets `not water` and
 * nested parentheses wrong in ways that are silent until someone runs the
 * script and gets the wrong picture.
 */

import { Style, type Component } from '../mol/components';
import { parseSelection, selectionError, type SelectionNode } from '../mol/selection';
import { MolKind } from '../mol/structure';
import { useStore, type SlotState } from './store';
import { viewer } from '../viewer/ViewerController';

export type ScriptTarget = 'pymol' | 'chimerax';

/** What each target calls a thing. `null` means it has no equivalent. */
interface Dialect {
  extension: string;
  comment: string;
  fetch: (id: string) => string;
  hideAll: string;
  show: (style: Style, selection: string) => string | null;
  color: (color: string, selection: string) => string;
  background: (hex: string) => string;
  /** PyMOL takes 0xRRGGBB, ChimeraX takes #RRGGBB, and each rejects the other. */
  hex: (color: number) => string;
  /** MolKind and secondary-structure words. */
  kind: Record<number, string | null>;
  helix: string;
  sheet: string;
  coil: string;
  polymer: string;
  backbone: string;
  sidechain: string;
  hydrogen: string;
  chain: (values: string[]) => string;
  residue: (values: string[]) => string;
  atom: (values: string[]) => string;
  element: (values: string[]) => string;
  and: string;
  or: string;
  not: string;
}

const PYMOL: Dialect = {
  extension: 'pml',
  comment: '#',
  fetch: (id) => `fetch ${id.toLowerCase()}, async=0`,
  hideAll: 'hide everything',
  show: (style, selection) => {
    const name = {
      [Style.Cartoon]: 'cartoon',
      [Style.Backbone]: 'ribbon',
      [Style.BallStick]: 'sticks',
      [Style.Licorice]: 'sticks',
      [Style.Spacefill]: 'spheres',
      [Style.None]: null,
    }[style];
    return name ? `show ${name}, ${selection}` : null;
  },
  color: (color, selection) => `color ${color}, ${selection}`,
  background: (value) => `bg_color ${value}`,
  hex: (color) => `0x${color.toString(16).padStart(6, '0')}`,
  kind: {
    [MolKind.Protein]: 'polymer.protein',
    [MolKind.Nucleic]: 'polymer.nucleic',
    [MolKind.Water]: 'solvent',
    [MolKind.Ion]: 'inorganic',
    [MolKind.Ligand]: 'organic',
  },
  helix: 'ss H',
  sheet: 'ss S',
  coil: 'ss L+""',
  polymer: 'polymer',
  backbone: 'backbone',
  sidechain: 'sidechain',
  hydrogen: 'hydro',
  chain: (v) => `chain ${v.join('+')}`,
  residue: (v) => residueTerm(v, (list) => `resi ${list.join('+')}`, (list) => `resn ${list.join('+')}`),
  atom: (v) => `name ${v.join('+')}`,
  element: (v) => `elem ${v.join('+')}`,
  and: 'and',
  or: 'or',
  not: 'not',
};

const CHIMERAX: Dialect = {
  extension: 'cxc',
  comment: '#',
  fetch: (id) => `open ${id.toLowerCase()}`,
  hideAll: 'hide #1 target acs',
  show: (style, selection) => {
    switch (style) {
      case Style.Cartoon: return `cartoon ${selection}`;
      case Style.Backbone: return `cartoon ${selection} style tube`;
      case Style.BallStick: return `show ${selection} atoms\nstyle ${selection} ball`;
      case Style.Licorice: return `show ${selection} atoms\nstyle ${selection} stick`;
      case Style.Spacefill: return `show ${selection} atoms\nstyle ${selection} sphere`;
      default: return null;
    }
  },
  color: (color, selection) => `color ${selection} ${color}`,
  background: (value) => `set bgColor ${value}`,
  hex: (color) => `#${color.toString(16).padStart(6, '0')}`,
  kind: {
    [MolKind.Protein]: 'protein',
    [MolKind.Nucleic]: 'nucleic',
    [MolKind.Water]: 'solvent',
    [MolKind.Ion]: 'ions',
    [MolKind.Ligand]: 'ligand',
  },
  helix: 'helix',
  sheet: 'strand',
  coil: 'coil',
  polymer: 'polymer',
  backbone: 'backbone',
  sidechain: 'sidechain',
  hydrogen: 'H',
  chain: (v) => `/${v.join(',')}`,
  residue: (v) => residueTerm(v, (list) => `:${list.join(',')}`, (list) => `:${list.join(',')}`),
  atom: (v) => `@${v.join(',')}`,
  element: (v) => `@@element=${v.join(',')}`,
  and: '&',
  or: '|',
  not: '~',
};

/**
 * MolView's `:` list mixes sequence numbers and component names; the targets
 * separate them, so the term is split and rejoined.
 */
function residueTerm(
  values: string[],
  numeric: (list: string[]) => string,
  named: (list: string[]) => string,
): string {
  const numbers = values.filter((v) => /^-?\d+(--?\d+)?$/.test(v));
  const names = values.filter((v) => !/^-?\d+(--?\d+)?$/.test(v));
  const parts: string[] = [];
  if (numbers.length) parts.push(numeric(numbers));
  if (names.length) parts.push(named(names));
  return parts.length > 1 ? `(${parts.join(' or ')})` : parts[0] ?? 'none';
}

/** Recompiles a parsed selection into a target's own grammar. */
function translate(node: SelectionNode, d: Dialect): string {
  switch (node.type) {
    case 'all': return 'all';
    case 'none': return 'none';
    case 'and': return `(${translate(node.left, d)} ${d.and} ${translate(node.right, d)})`;
    case 'or': return `(${translate(node.left, d)} ${d.or} ${translate(node.right, d)})`;
    case 'not': return `(${d.not} ${translate(node.operand, d)})`;
    case 'kind': {
      const terms = node.kinds.map((k) => d.kind[k]).filter(Boolean) as string[];
      if (terms.length === 0) return 'none';
      return terms.length === 1 ? terms[0] : `(${terms.join(` ${d.or} `)})`;
    }
    case 'ss': {
      // 1 = helix, 2 = sheet in the SS enum; anything else is coil or turn.
      const terms = new Set(node.values.map((v) => (v === 1 ? d.helix : v === 2 ? d.sheet : d.coil)));
      return terms.size === 1 ? [...terms][0] : `(${[...terms].join(` ${d.or} `)})`;
    }
    case 'chain': return d.chain(node.values);
    case 'residue': return d.residue(node.values);
    case 'atom': return d.atom(node.values);
    case 'element': return d.element(node.values);
    case 'backbone': return d.backbone;
    case 'sidechain': return d.sidechain;
    case 'hydrogen': return d.hydrogen;
    case 'polymer': return d.polymer;
    // NMR model membership is MolView's own idea of a chain split; neither
    // target has an equivalent that means the same thing.
    case 'model': return 'all';
    default: return 'all';
  }
}

function packRgb(rgb: [number, number, number]): number {
  const to = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255);
  return (to(rgb[0]) << 16) | (to(rgb[1]) << 8) | to(rgb[2]);
}

/**
 * A script for one pane.
 *
 * Colours come out as the flat per-component colour where a component has one,
 * and as the target's own nearest scheme otherwise: reproducing MolView's exact
 * per-residue tables would mean emitting a colour command per residue, which is
 * a worse script than a one-line `spectrum`.
 */
export function paneScript(slot: number, target: ScriptTarget): string {
  const d = target === 'pymol' ? PYMOL : CHIMERAX;
  const state: SlotState = useStore.getState().slots[slot];
  const camera = viewer.engine.getCamera(slot);
  const lines: string[] = [];

  const note = (text: string) => lines.push(`${d.comment} ${text}`);

  note(`Generated by MolView — pane ${slot + 1}`);
  if (state.prediction) {
    note(`AlphaFold model of ${state.prediction.accession}. Neither target fetches`);
    note('from AlphaFold DB, so open the model yourself and delete the fetch line.');
    lines.push(`${d.comment} ${d.fetch(state.entryId ?? '')}`);
  } else if (state.sourceFileName) {
    note(`This pane came from the local file ${state.sourceFileName}; open it yourself.`);
  } else if (state.entryId) {
    lines.push(d.fetch(state.entryId));
  }
  lines.push('');

  if (state.assemblyId) {
    note(`MolView was showing biological assembly ${state.assemblyId}.`);
    lines.push(target === 'pymol'
      ? `${d.comment} set assembly, ${state.assemblyId}   (then re-fetch)`
      : `${d.comment} open ${state.entryId} format mmcif structureFactors false`);
    lines.push('');
  }

  lines.push(d.hideAll);

  const visible: Component[] = state.components.filter((c) => c.visible);
  for (const component of visible) {
    const problem = selectionError(component.selection);
    if (problem) {
      note(`skipped "${component.name}": ${problem}`);
      continue;
    }
    const selection = translate(parseSelection(component.selection).node, d);
    lines.push('');
    note(`${component.name} — MolView selection: ${component.selection}`);
    const show = d.show(component.style, selection);
    if (show) lines.push(show);
    else note('(hidden in MolView)');

    if (component.colorScheme === 'uniform') {
      lines.push(d.color(d.hex(component.uniformColor), selection));
    }
  }

  lines.push('');
  if (state.colorScheme === 'chain' && visible.length > 0) {
    lines.push(target === 'pymol' ? 'util.cbc' : 'color bychain');
  } else if (state.colorScheme === 'element') {
    lines.push(target === 'pymol' ? 'util.cbaw' : 'color byhetero');
  } else if (state.colorScheme === 'secondary') {
    lines.push(target === 'pymol' ? 'color red, ss H\ncolor yellow, ss S' : 'color bystructure');
  } else if (state.colorScheme === 'bfactor' || state.colorScheme === 'plddt') {
    lines.push(target === 'pymol'
      ? 'spectrum b, blue_white_red'
      : 'color byattribute bfactor');
  } else if (state.colorScheme === 'rainbow') {
    lines.push(target === 'pymol' ? 'spectrum count, rainbow' : 'rainbow');
  } else if (state.colorScheme === 'uniform') {
    lines.push(d.color(d.hex(state.uniformColor), 'all'));
  } else {
    note(`MolView was colouring by ${state.colorScheme}, which has no direct equivalent.`);
  }

  lines.push(d.background(d.hex(packRgb(state.visual.background))));

  // The camera as a quaternion is not something either target takes, but the
  // target point and the distance are, and matching those gets the framing
  // right even when the rotation has to be redone by hand.
  lines.push('');
  note('MolView camera: target '
    + `${[...camera.target].map((v) => v.toFixed(1)).join(', ')}, `
    + `distance ${camera.distance.toFixed(1)} A.`);
  note('Orientation is not transferable; orient by hand or use the target\'s own.');
  lines.push(target === 'pymol' ? 'orient' : 'view');

  return `${lines.join('\n')}\n`;
}

export function scriptFilename(slot: number, target: ScriptTarget): string {
  const id = useStore.getState().slots[slot].entryId ?? 'scene';
  return `molview-${id.toLowerCase()}.${target === 'pymol' ? 'pml' : 'cxc'}`;
}
