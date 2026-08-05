/**
 * Components: a selection plus how to draw it.
 *
 * A pane's appearance is a list of these, applied in order like layers — the
 * last component covering an atom wins. That replaces the old "one style for
 * polymers, one for ligands" model, which could not express anything as
 * ordinary as "cartoon everywhere, but sticks for the active site".
 */

import { makeColorProvider, type ColorScheme } from './coloring';
import { evaluateSelection, parseSelection } from './selection';
import { MolKind, type Structure } from './structure';

export const enum Style {
  None = 0,
  Cartoon = 1,
  Backbone = 2,
  BallStick = 3,
  Licorice = 4,
  Spacefill = 5,
}

export const STYLE_LABELS: Record<Style, string> = {
  [Style.None]: 'Hidden',
  [Style.Cartoon]: 'Cartoon',
  [Style.Backbone]: 'Backbone trace',
  [Style.BallStick]: 'Ball and stick',
  [Style.Licorice]: 'Licorice',
  [Style.Spacefill]: 'Spacefill',
};

export const STYLE_ORDER: Style[] = [
  Style.Cartoon, Style.Backbone, Style.BallStick,
  Style.Licorice, Style.Spacefill, Style.None,
];

export interface Component {
  id: string;
  name: string;
  /** Selection expression; see selection.ts for the grammar. */
  selection: string;
  style: Style;
  /** null inherits the pane's colour scheme. */
  colorScheme: ColorScheme | null;
  uniformColor: number;
  visible: boolean;
}

let nextComponentId = 1;

export function componentId(): string {
  return `c${nextComponentId++}`;
}

export function makeComponent(patch: Partial<Component> = {}): Component {
  return {
    id: componentId(),
    name: 'Component',
    selection: 'all',
    style: Style.BallStick,
    colorScheme: null,
    uniformColor: 0x7bb0ff,
    visible: true,
    ...patch,
  };
}

/**
 * Sensible starting layers for a structure. Chosen from what the file actually
 * contains so a nucleic-only entry does not open as an empty protein cartoon.
 */
export function defaultComponents(s: Structure, effectiveAtoms: number): Component[] {
  let polymerResidues = 0;
  let ligandResidues = 0;
  let ionResidues = 0;
  let waterResidues = 0;
  for (let r = 0; r < s.residueCount; r++) {
    switch (s.resKind[r]) {
      case MolKind.Protein: case MolKind.Nucleic: polymerResidues++; break;
      case MolKind.Ligand: ligandResidues++; break;
      case MolKind.Ion: ionResidues++; break;
      case MolKind.Water: waterResidues++; break;
      default: break;
    }
  }

  const components: Component[] = [];

  if (polymerResidues > 0) {
    // At assembly scale a ribbon is thinner than a pixel; spheres read better
    // and skip building a mesh with millions of triangles.
    const huge = effectiveAtoms > 400_000;
    components.push(makeComponent({
      name: 'Polymer',
      selection: 'polymer',
      style: huge ? Style.Spacefill : Style.Cartoon,
    }));
    if (ligandResidues > 0 && !huge) {
      components.push(makeComponent({
        name: 'Ligands', selection: 'ligand', style: Style.BallStick,
      }));
    }
  } else {
    components.push(makeComponent({
      name: 'Molecule', selection: 'not water', style: Style.BallStick,
    }));
  }

  if (ionResidues > 0) {
    components.push(makeComponent({ name: 'Ions', selection: 'ion', style: Style.Spacefill }));
  }
  if (waterResidues > 0) {
    components.push(makeComponent({
      name: 'Water', selection: 'water', style: Style.BallStick, visible: false,
    }));
  }

  return components;
}

export interface ResolveOptions {
  paneColorScheme: ColorScheme;
  paneUniformColor: number;
  hiddenChains: ReadonlySet<string>;
  showHydrogens: boolean;
  paletteOffset: number;
}

export interface ResolvedScene {
  /** Style per atom after all layers are applied. */
  atomStyle: Uint8Array;
  /** Packed 0xRRGGBB per atom. */
  atomColor: Uint32Array;
  /** Cartoon/backbone decision per residue, taken from its anchor atom. */
  residueStyle: Uint8Array;
  /** Per-component atom counts, for the panel readout. */
  counts: Map<string, number>;
  /** Parse failures, keyed by component id. */
  errors: Map<string, string>;
}

const HYDROGEN = 1;

/**
 * Flattens the component list into per-atom style and colour arrays. Doing this
 * once, up front, keeps the geometry builder a straight loop over atoms rather
 * than a nest of per-component special cases.
 */
export function resolveComponents(
  s: Structure,
  components: readonly Component[],
  options: ResolveOptions,
): ResolvedScene {
  const atomStyle = new Uint8Array(s.atomCount);
  const atomColor = new Uint32Array(s.atomCount);
  const counts = new Map<string, number>();
  const errors = new Map<string, string>();

  for (const component of components) {
    if (!component.visible) {
      counts.set(component.id, 0);
      continue;
    }

    let mask: Uint8Array;
    try {
      mask = evaluateSelection(parseSelection(component.selection), s);
    } catch (err) {
      errors.set(component.id, err instanceof Error ? err.message : String(err));
      counts.set(component.id, 0);
      continue;
    }

    const colors = makeColorProvider(s, {
      scheme: component.colorScheme ?? options.paneColorScheme,
      uniformColor: component.colorScheme === 'uniform'
        ? component.uniformColor
        : options.paneUniformColor,
      paletteOffset: options.paletteOffset,
    });

    let count = 0;
    for (let a = 0; a < s.atomCount; a++) {
      if (!mask[a]) continue;
      count++;
      atomStyle[a] = component.style;
      atomColor[a] = colors.atom(a);
    }
    counts.set(component.id, count);
  }

  // Global filters sit on top of every layer.
  if (!options.showHydrogens) {
    for (let a = 0; a < s.atomCount; a++) {
      if (s.element[a] === HYDROGEN) atomStyle[a] = Style.None;
    }
  }
  if (options.hiddenChains.size > 0) {
    for (let r = 0; r < s.residueCount; r++) {
      if (!options.hiddenChains.has(s.chainAuthId[s.resChain[r]])) continue;
      atomStyle.fill(Style.None, s.resAtomStart[r], s.resAtomStart[r + 1]);
    }
  }

  // A residue joins the ribbon when its backbone anchor asks for one; using the
  // anchor rather than a vote keeps the trace continuous and predictable.
  const residueStyle = new Uint8Array(s.residueCount);
  for (let r = 0; r < s.residueCount; r++) {
    const anchor = s.resAnchor[r];
    if (anchor < 0) continue;
    const style = atomStyle[anchor];
    if (style === Style.Cartoon || style === Style.Backbone) residueStyle[r] = style;
  }

  return { atomStyle, atomColor, residueStyle, counts, errors };
}
