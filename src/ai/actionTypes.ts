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
  'nucleotides', 'view', 'density', 'surface', 'clip', 'validation', 'predicted',
  'similar', 'pockets', 'annotations', 'palette',
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
  { type: 'palette', value: '"saturation 0.6" | "intensity 1.3" | "reset"', note: 'Adjust how strong the pane\'s colours are, without changing the colour scheme itself. 1 is the scheme as authored, 0 saturation is greyscale, above 1 pushes further from grey. Applies to every representation and to a molecular surface, but never to a density map, whose colours identify which map and which sign of the difference.' },
  { type: 'background', value: '"void" | "slate" | "ink" | "bone"', note: 'Background colour.' },
  { type: 'hbonds', value: '"on" | "off"', note: 'Show hydrogen bonds among the visible atoms.' },
  { type: 'interfaces', value: '"A,B" for one pair, "A" for one chain, "" for all, or "top 5"', note: 'Find which chains touch which, by heavy-atom contact and by the area each pair buries (Shrake-Rupley SASA, reported as interface area — half the total change, the convention PISA uses), including symmetry copies when an assembly is shown. Use it instead of reasoning from stoichiometry about what packs against what. Naming a pair also returns a ready-made selection covering the contact residues on both sides: pass that string to a component action to draw the interface itself. There is no distance operator in the selection grammar, so this is the only way to select an interface.' },
  { type: 'measure', value: '"distance /A:142@FE /A:87@NE2"', note: 'Measure between atoms. Kind is distance (2 atoms), angle (3) or torsion (4); each atom is a selection matching exactly one atom.' },
  { type: 'superpose', value: '"2 onto 1" or "2 onto 1 chain B onto A"', note: 'Align one pane onto another by sequence, then fit the matched CA atoms.' },
  { type: 'overlay', value: '"2" or "2,3" or "off"', note: "Draw other panes' structures inside the active pane, in their superposed frames." },
  { type: 'nucleotides', value: '"slab" | "ladder" | "stubs" | "none"', note: 'How nucleic acid bases are drawn inside the cartoon. Ladder joins Watson-Crick partners into one rung. To colour by base, use the color action with the "base" scheme — it is not a style.' },
  { type: 'view', value: '"orient" | "x" | "y" | "z" | "-x" | "-y" | "-z"', note: 'Point the camera. "orient" turns the pane to the structure\'s own principal axes and refits it — the view it was given on load, after the user has moved it. The axis values look straight down a world axis instead.' },
  { type: 'ensemble', value: '"on" | "off"', note: 'Draw every model of an NMR ensemble at once, or just one.' },
  { type: 'annotations', value: '"" or "binding" or "active site"', note: 'UniProt\'s functional annotations for the entry, mapped onto its own residue numbering — active and binding sites, modified residues, motifs, domains, mutagenesis results, variants. Each comes with a ready-made selection. This is the only source in the app for what a residue is *for*: everything else here is geometry. Positions are translated through the entity-to-UniProt alignment, so they are this entry\'s numbering and not the sequence database\'s.' },
  { type: 'pockets', value: '"" or "top 3"', note: 'Find the enclosed cavities, ranked by volume, with the residues lining each and any ligand sitting in one — plus a ready-made selection for the largest. Ligands are excluded from the scan, so a ligand named in the answer was found rather than assumed, which is the check on the method. It measures concavity, not affinity: use it to locate a site, not to claim one binds anything.' },
  { type: 'similar', value: '"shape" | "sequence" | "sequence 10"', note: 'Find structures resembling the one in the active pane — by the shape of the assembly on screen, or by the sequence of its longest chain, with the identity of each hit. This answers what the search box cannot: the interesting cases are the ones you cannot name, an unfamiliar fold or a family you are trying to establish. Shape and sequence disagree usefully, and a hit in one but not the other is usually the one worth looking at.' },
  { type: 'predicted', value: '"P69905" or "haemoglobin alpha human" or "P69905 pane 2"', note: 'Load an AlphaFold model. Given a UniProt accession it loads that model; given anything else it searches UniProt and returns the matching accessions for you to choose from — AlphaFold is keyed by accession only. Use it whenever a protein has no experimental structure, or when the question is about a sequence rather than about a deposition. What comes back is a prediction: say so, and reach for the pLDDT and AlphaMissense colour schemes rather than for resolution or validation, which do not exist for it.' },
  { type: 'validation', value: '"density" | "geometry" | "top 5"', note: 'Ask the wwPDB report which individual residues are suspect, and get back a ranked list plus a ready-made selection covering them — pass that string to a component or focus action. "density" ranks by RSRZ, how badly a residue fits its own experimental density; "geometry" ranks by counted clashes and bond, angle and stereochemistry outliers. Use it whenever the question is which part of a model to distrust: the entry summary only gives a percentage, and this says where.' },
  { type: 'clip', value: '"off" | "front 20" | "back 15" | "slab 10"', note: 'Cut the scene with planes perpendicular to the view, in angstroms measured inward from the front and the back of the structure. "slab N" centres a section N angstroms thick through the middle, which is how to see inside a capsid or down a channel. The planes follow the camera, so rotating rotates the cut.' },
  { type: 'surface', value: '"on" | "off" | a selection | "opacity 0.4" | "wireframe" | "solid" | "probe 1.4"', note: 'A molecular surface over the atoms drawn, or over a selection if one is given — the envelope the molecule presents to the solvent. It is coloured by the pane\'s scheme, so a per-chain surface shows the subunit boundaries. Building it blocks for up to a couple of seconds on a large structure, so do not set it and immediately change it.' },
  { type: 'density', value: '"on" | "off" | "1.5 sigma" | "solid" | "wireframe" | "difference on" | "around 3"', note: 'The experimental density this model was built into: 2Fo-Fc and Fo-Fc for X-ray entries, the deposited map for cryo-EM. "on" fetches and contours it; the other values retune what is already loaded. Contours are in sigma. "difference on" adds the Fo-Fc map, green where the data want atoms the model does not have and red where the model has atoms the data do not support. "around N" keeps only density within N angstroms of the drawn atoms, and "around 0" shows the whole box. Use this whenever the question is whether the model is supported by the evidence rather than what the model looks like.' },
];
