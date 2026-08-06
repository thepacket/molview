/**
 * The command vocabulary MolView exposes to the assistant.
 *
 * Deliberately free of app imports: the reply parser and the prompt builder
 * both need this, and neither should have to drag in the WebGPU engine.
 */

export const ACTION_TYPES = [
  'load', 'clear', 'layout', 'pane',
  'component', 'remove-component', 'color', 'assembly',
  'focus', 'reset-view', 'spin', 'lighting', 'background',
  'hbonds', 'interfaces', 'measure', 'superpose', 'overlay', 'ensemble',
  'nucleotides',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface Action {
  type: ActionType;
  reason: string;
  value: string | null;
}

export function isAction(candidate: unknown): candidate is Action {
  if (!candidate || typeof candidate !== 'object') return false;
  const a = candidate as Record<string, unknown>;
  return typeof a.type === 'string'
    && (ACTION_TYPES as readonly string[]).includes(a.type)
    && (typeof a.value === 'string' || a.value === null || a.value === undefined);
}

/** Documentation injected into the system prompt, one line per action. */
export const ACTION_REFERENCE: { type: ActionType; value: string; note: string }[] = [
  { type: 'load', value: '"4HHB" or "4HHB pane 2"', note: 'Load a PDB entry into a pane (the active one unless a pane is named).' },
  { type: 'clear', value: '"" or "2"', note: 'Empty a pane.' },
  { type: 'layout', value: '"single" | "columns" | "rows" | "quad"', note: 'Change how many panes are shown.' },
  { type: 'pane', value: '"2"', note: 'Make a pane active so later actions apply to it.' },
  { type: 'component', value: '"Name | selection | style | colour"', note: 'Add a draw layer. Style is one of cartoon, backbone, ball-stick, licorice, spacefill, hidden. Colour is optional and is a colour scheme name. Later layers win where selections overlap.' },
  { type: 'remove-component', value: '"Name" or "all"', note: 'Remove a draw layer by name.' },
  { type: 'color', value: 'a colour scheme name', note: "Set the pane's default colour scheme." },
  { type: 'assembly', value: '"1" or "asymmetric"', note: 'Switch between the deposited asymmetric unit and a biological assembly.' },
  { type: 'focus', value: 'a selection expression', note: 'Move the camera to centre on a selection.' },
  { type: 'reset-view', value: 'null', note: 'Frame the whole structure again.' },
  { type: 'spin', value: '"on" | "off"', note: 'Auto-rotate the active pane.' },
  { type: 'lighting', value: '"studio" | "soft" | "flat" | "plain"', note: 'Shading preset.' },
  { type: 'background', value: '"void" | "slate" | "ink" | "bone"', note: 'Background colour.' },
  { type: 'hbonds', value: '"on" | "off"', note: 'Show hydrogen bonds among the visible atoms.' },
  { type: 'interfaces', value: '"" or "A" or "top 5"', note: 'Find which chains touch which, by heavy-atom contact, including symmetry copies when an assembly is shown. Returns the ranked pairs — use it instead of reasoning from stoichiometry about what packs against what.' },
  { type: 'measure', value: '"distance /A:142@FE /A:87@NE2"', note: 'Measure between atoms. Kind is distance (2 atoms), angle (3) or torsion (4); each atom is a selection matching exactly one atom.' },
  { type: 'superpose', value: '"2 onto 1" or "2 onto 1 chain B onto A"', note: 'Align one pane onto another by sequence, then fit the matched CA atoms.' },
  { type: 'overlay', value: '"2" or "2,3" or "off"', note: "Draw other panes' structures inside the active pane, in their superposed frames." },
  { type: 'nucleotides', value: '"slab" | "ladder" | "stubs" | "none"', note: 'How nucleic acid bases are drawn inside the cartoon. Ladder joins Watson-Crick partners into one rung. To colour by base, use the color action with the "base" scheme — it is not a style.' },
  { type: 'ensemble', value: '"on" | "off"', note: 'Draw every model of an NMR ensemble at once, or just one.' },
];
