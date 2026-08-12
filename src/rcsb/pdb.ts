/**
 * The legacy PDB format.
 *
 * Everything MolView can show was bounded by what RCSB serves as mmCIF, and
 * most tools that produce a structure — refinement, docking, prediction — still
 * emit the old fixed-column format. This reads it.
 *
 * It produces a `CifBlock` rather than a `Structure`, which is the decision
 * that matters: the structure builder, the assembly code, the altloc
 * resolution, the secondary-structure fallback and everything downstream then
 * work unchanged, and a PDB file is not a second kind of model with its own
 * quirks to maintain. The adapter's whole job is to answer the same questions
 * mmCIF answers.
 *
 * Fixed columns are the format's defining property and its trap: fields are
 * identified by position, so a file that pads differently produces plausible
 * nonsense rather than an error. Nothing here splits on whitespace.
 */

import {
  ArrayColumn, MapBlock, MapCategory, type CifBlock, type CifColumn,
} from './cif';
import { elementIndex, isAminoAcid, isNucleotide, isWater } from '../mol/elements';
import { normaliseSpaceGroup, spaceGroupNumber } from '../mol/spacegroup';

/** Column ranges, 1-based inclusive as the format specification writes them. */
function field(line: string, from: number, to: number): string {
  return line.slice(from - 1, to).trim();
}

function numberField(line: string, from: number, to: number): number {
  const raw = field(line, from, to);
  if (!raw) return Number.NaN;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

function textColumn(values: string[], nullWhenEmpty = false): CifColumn {
  let mask: Uint8Array | null = null;
  if (nullWhenEmpty) {
    mask = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i++) if (values[i] === '') mask[i] = 1;
  }
  return new ArrayColumn(values.length, values, mask, false);
}

function numericColumn(values: number[]): CifColumn {
  const mask = new Uint8Array(values.length);
  let any = false;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) { mask[i] = 1; any = true; }
  }
  return new ArrayColumn(values.length, values, any ? mask : null, true);
}

/**
 * The element symbol, from columns 77-78 where the file provides it and from
 * the atom name where it does not.
 *
 * Older files and plenty of modern writers leave 77-78 blank. The name field
 * is not free-form either: a one-letter element is right-justified into column
 * 14, leaving 13 blank, so a leading space or digit means the element is the
 * single character that follows. Two-letter elements start in column 13 —
 * which is how CA the calcium is told from CA the alpha carbon, and getting it
 * wrong turns every protein backbone into a chain of calcium atoms.
 */
function elementOf(line: string, rawName: string, comp: string): string {
  const explicit = field(line, 77, 78);
  if (explicit && elementIndex(explicit) > 0) return explicit;

  const first = rawName.charAt(0);
  if (first === ' ' || (first >= '0' && first <= '9')) {
    return rawName.trim().charAt(0);
  }

  const name = rawName.trim();
  // A standard residue's atoms are all C, N, O, S or H, so a two-letter guess
  // there is always wrong. Only an unrecognised component can hold a metal.
  const known = isAminoAcid(comp) || isNucleotide(comp) || isWater(comp);
  if (!known && name.length >= 2) {
    const two = name.slice(0, 2);
    if (elementIndex(two) > 0 && !/\d/.test(two)) return two;
  }
  return name.charAt(0);
}

interface SecondaryRange {
  chain: string;
  from: number;
  to: number;
}

function rangeCategory(name: string, ranges: SecondaryRange[]): MapCategory {
  const columns = new Map<string, CifColumn>([
    ['beg_auth_asym_id', textColumn(ranges.map((r) => r.chain))],
    ['end_auth_asym_id', textColumn(ranges.map((r) => r.chain))],
    ['beg_auth_seq_id', numericColumn(ranges.map((r) => r.from))],
    ['end_auth_seq_id', numericColumn(ranges.map((r) => r.to))],
  ]);
  return new MapCategory(name, ranges.length, columns);
}

export function parsePdb(text: string, id = ''): CifBlock {
  const lines = text.split('\n');

  // atom_site, built as parallel arrays.
  const groupPDB: string[] = [];
  const symbol: string[] = [];
  const atomId: string[] = [];
  const altId: string[] = [];
  const compId: string[] = [];
  const authAsym: string[] = [];
  const labelAsym: string[] = [];
  const entityId: string[] = [];
  const authSeq: number[] = [];
  const insCode: string[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const occ: number[] = [];
  const bfac: number[] = [];
  const modelNum: number[] = [];

  const helices: SecondaryRange[] = [];
  const sheets: SecondaryRange[] = [];

  const titleParts: string[] = [];
  let cryst: string | null = null;
  let model = 1;

  /**
   * mmCIF gives waters and each non-polymer component their own
   * `label_asym_id`; the PDB format has one chain identifier and puts
   * everything in it. Without a synthetic split, a ligand and its waters land
   * inside the polymer chain, which changes what the chain is made of, where
   * the cartoon stops and which residues count as adjacent.
   *
   * What cannot be used to make that split is the component's name. A
   * selenomethionine is a HETATM in the middle of a chain, so splitting on
   * ATOM/HETATM cuts the polymer at every MSE; and a name that is not in the
   * standard lists is not a ligand either — 6LU7's inhibitor is a peptide
   * built from 02J, Ala, Val, Leu, PJE and 010, and treating those components
   * as ligands broke one chain into four and cost the residues between them
   * their backbone angles.
   *
   * So it is measured instead: a component is part of a chain when it carries
   * a backbone to be part of one with. There is no chemical component
   * dictionary here to ask, and carrying the backbone is the property that
   * actually decides whether the chain continues through it.
   */
  const atomsOfComp = new Map<string, Set<string>>();
  for (const raw of lines) {
    const record = raw.slice(0, 6);
    if (record !== 'ATOM  ' && record !== 'HETATM') continue;
    const comp = field(raw, 18, 20).toUpperCase();
    let set = atomsOfComp.get(comp);
    if (!set) { set = new Set(); atomsOfComp.set(comp, set); }
    set.add(raw.slice(12, 16).trim().replace(/"/g, ''));
  }

  const polymeric = new Set<string>();
  for (const [comp, atoms] of atomsOfComp) {
    if (isWater(comp)) continue;
    const peptide = atoms.has('N') && atoms.has('CA') && atoms.has('C');
    const nucleic = (atoms.has("C4'") || atoms.has('C4*'))
      && (atoms.has("C1'") || atoms.has('C1*'));
    if (peptide || nucleic) polymeric.add(comp);
  }

  const asymOf = (chain: string, comp: string): string => {
    if (isWater(comp)) return `${chain}_w`;
    return polymeric.has(comp) ? chain : `${chain}_${comp}`;
  };

  for (const raw of lines) {
    const record = raw.slice(0, 6);

    if (record === 'ATOM  ' || record === 'HETATM') {
      const x = numberField(raw, 31, 38);
      const y = numberField(raw, 39, 46);
      const z = numberField(raw, 47, 54);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

      const rawName = raw.slice(12, 16);
      const comp = field(raw, 18, 20).toUpperCase();
      // Column 21 is blank in a conforming file, so reading 21-22 costs
      // nothing and picks up the two-character chain ids some writers emit.
      const chain = field(raw, 21, 22) || 'A';

      groupPDB.push(record.trim());
      symbol.push(elementOf(raw, rawName, comp));
      atomId.push(rawName.trim().replace(/"/g, ''));
      altId.push(field(raw, 17, 17));
      compId.push(comp);
      authAsym.push(chain);
      const asym = asymOf(chain, comp);
      labelAsym.push(asym);
      entityId.push(asym);
      authSeq.push(numberField(raw, 23, 26));
      insCode.push(field(raw, 27, 27));
      xs.push(x); ys.push(y); zs.push(z);
      const o = numberField(raw, 55, 60);
      occ.push(Number.isFinite(o) ? o : 1);
      const b = numberField(raw, 61, 66);
      bfac.push(Number.isFinite(b) ? b : 0);
      modelNum.push(model);
      continue;
    }

    if (record === 'MODEL ') {
      const n = numberField(raw, 11, 14);
      model = Number.isFinite(n) ? n : model + 1;
      continue;
    }

    if (record === 'TITLE ') {
      titleParts.push(raw.slice(10).trim());
      continue;
    }

    if (record === 'CRYST1') {
      cryst = raw;
      continue;
    }

    if (record === 'HELIX ') {
      const chain = field(raw, 20, 20) || field(raw, 19, 20);
      const from = numberField(raw, 22, 25);
      const to = numberField(raw, 34, 37);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        helices.push({ chain, from, to });
      }
      continue;
    }

    if (record === 'SHEET ') {
      const chain = field(raw, 22, 22) || field(raw, 21, 22);
      const from = numberField(raw, 23, 26);
      const to = numberField(raw, 34, 37);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        sheets.push({ chain, from, to });
      }
      continue;
    }
  }

  if (xs.length === 0) {
    throw new Error('No ATOM or HETATM records found — this does not look like a PDB file');
  }

  const categories = new Map<string, MapCategory>();

  categories.set('atom_site', new MapCategory('atom_site', xs.length, new Map<string, CifColumn>([
    ['group_PDB', textColumn(groupPDB)],
    ['type_symbol', textColumn(symbol)],
    ['label_atom_id', textColumn(atomId)],
    ['label_alt_id', textColumn(altId, true)],
    ['label_comp_id', textColumn(compId)],
    ['auth_comp_id', textColumn(compId)],
    ['auth_asym_id', textColumn(authAsym)],
    ['label_asym_id', textColumn(labelAsym)],
    ['label_entity_id', textColumn(entityId)],
    ['auth_seq_id', numericColumn(authSeq)],
    ['label_seq_id', numericColumn(authSeq)],
    ['pdbx_PDB_ins_code', textColumn(insCode, true)],
    ['Cartn_x', numericColumn(xs)],
    ['Cartn_y', numericColumn(ys)],
    ['Cartn_z', numericColumn(zs)],
    ['occupancy', numericColumn(occ)],
    ['B_iso_or_equiv', numericColumn(bfac)],
    ['pdbx_PDB_model_num', numericColumn(modelNum)],
  ])));

  const title = titleParts.join(' ').replace(/\s+/g, ' ').trim();
  categories.set('struct', new MapCategory('struct', 1, new Map<string, CifColumn>([
    ['title', textColumn([title || id])],
  ])));

  if (helices.length > 0) categories.set('struct_conf', rangeCategory('struct_conf', helices));
  if (sheets.length > 0) {
    categories.set('struct_sheet_range', rangeCategory('struct_sheet_range', sheets));
  }

  if (cryst) {
    const a = numberField(cryst, 7, 15);
    const b = numberField(cryst, 16, 24);
    const c = numberField(cryst, 25, 33);
    const alpha = numberField(cryst, 34, 40);
    const beta = numberField(cryst, 41, 47);
    const gamma = numberField(cryst, 48, 54);
    const group = field(cryst, 56, 66);
    // The number is what `parseCrystal` keys on, and CRYST1 carries only the
    // Hermann-Mauguin symbol, so it comes from the operator table — which is
    // itself keyed by symbol, for the reasons set out there. A symbol the
    // table does not know yields no cell rather than a guessed one.
    const number = spaceGroupNumber(normaliseSpaceGroup(group));
    if (Number.isFinite(a) && number !== null) {
      categories.set('cell', new MapCategory('cell', 1, new Map<string, CifColumn>([
        ['length_a', numericColumn([a])],
        ['length_b', numericColumn([b])],
        ['length_c', numericColumn([c])],
        ['angle_alpha', numericColumn([alpha])],
        ['angle_beta', numericColumn([beta])],
        ['angle_gamma', numericColumn([gamma])],
      ])));
      categories.set('symmetry', new MapCategory('symmetry', 1, new Map<string, CifColumn>([
        ['Int_Tables_number', numericColumn([number])],
        ['space_group_name_H-M', textColumn([group])],
      ])));
    }
  }

  return new MapBlock(id || 'PDB', categories);
}
