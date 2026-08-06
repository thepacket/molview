/**
 * The in-memory structure model.
 *
 * Everything is stored as flat typed arrays in structure-of-arrays layout —
 * a 500k-atom virus capsid is perfectly ordinary in the PDB, and one JS object
 * per atom would be both slow to build and hostile to the GPU upload path.
 */

import type { CifBlock } from '../rcsb/cif';
import { parseAssemblies, type Assembly } from './assembly';
import type { UnitCell } from './spacegroup';
import { elementIndex, isAminoAcid, isNucleotide, isWater } from './elements';

export const enum SS {
  Coil = 0,
  Helix = 1,
  Sheet = 2,
  Turn = 3,
}

export const enum MolKind {
  Protein = 0,
  Nucleic = 1,
  Ligand = 2,
  Water = 3,
  Ion = 4,
}

export interface Structure {
  readonly id: string;
  readonly title: string;

  // ---- atoms ----
  readonly atomCount: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly element: Uint8Array;
  readonly bFactor: Float32Array;
  /** Index into `nameTable`; interned so the model stays transferable. */
  readonly atomNameId: Uint16Array;
  readonly atomResidue: Uint32Array;

  // ---- residues ----
  readonly residueCount: number;
  readonly resNameId: Uint16Array;
  /** Shared string table for atom and residue names. */
  readonly nameTable: string[];
  readonly resSeq: Int32Array;
  readonly resChain: Uint32Array;
  readonly resSS: Uint8Array;
  readonly resKind: Uint8Array;
  /** Offsets into the atom arrays; length residueCount + 1. */
  readonly resAtomStart: Uint32Array;
  /** Backbone anchor (CA for protein, C4' for nucleic), or -1. */
  readonly resAnchor: Int32Array;
  /** Carbonyl O (protein) or C1' (nucleic) used to orient the ribbon, or -1. */
  readonly resOrient: Int32Array;

  // ---- chains ----
  readonly chainCount: number;
  readonly chainAuthId: string[];
  readonly chainLabelId: string[];
  readonly chainEntity: string[];
  readonly chainKind: Uint8Array;
  /** Model each chain came from; all 1 unless the ensemble is loaded whole. */
  readonly chainModel: Int32Array;
  /** Offsets into the residue arrays; length chainCount + 1. */
  readonly chainResStart: Uint32Array;

  // ---- bounds ----
  readonly center: Float32Array;
  readonly radius: number;
  readonly bMin: number;
  readonly bMax: number;

  /** Biological assemblies declared in the file; empty if none. */
  readonly assemblies: Assembly[];
  /**
   * Unit cell and space group, when the entry is a crystal structure. Null for
   * NMR, cryo-EM and predictions, which have no lattice to speak of — some of
   * them still carry a placeholder P 1 cell of 1 Å, which is why this is
   * rejected rather than trusted.
   */
  readonly crystal: CrystalInfo | null;
  /** Model actually built, and how many the file contains (NMR ensembles). */
  readonly modelNum: number;
  readonly modelCount: number;
}

export interface CrystalInfo {
  cell: UnitCell;
  /** International Tables number, the key the operator table uses. */
  spaceGroupNumber: number;
  /** As deposited, for display. */
  spaceGroupName: string;
}

/**
 * Cell and space group, or null when there is no usable lattice.
 *
 * The placeholder check matters: structures solved by NMR or cryo-EM, and
 * every prediction, are written with `P 1` and a 1 Å cell so the columns are
 * not empty. Taking that at face value would surround the model with copies
 * one Ångström away, which is not a crystal contact but a pile-up.
 */
function parseCrystal(block: CifBlock): CrystalInfo | null {
  if (!block.hasCategory('cell') || !block.hasCategory('symmetry')) return null;
  const cellCat = block.category('cell');
  const symCat = block.category('symmetry');

  const cell: UnitCell = {
    a: cellCat.field('length_a').num(0),
    b: cellCat.field('length_b').num(0),
    c: cellCat.field('length_c').num(0),
    alpha: cellCat.field('angle_alpha').num(0),
    beta: cellCat.field('angle_beta').num(0),
    gamma: cellCat.field('angle_gamma').num(0),
  };
  // A real protein cell is tens of Ångström on a side. The 1 Å placeholder and
  // any zero or missing edge fail this together.
  if (!(cell.a > 2 && cell.b > 2 && cell.c > 2)) return null;
  if (!(cell.alpha > 0 && cell.beta > 0 && cell.gamma > 0)) return null;

  const number = symCat.field('Int_Tables_number').num(0);
  if (!Number.isFinite(number) || number < 1 || number > 230) return null;

  return {
    cell,
    spaceGroupNumber: number,
    spaceGroupName: symCat.field('space_group_name_H-M').str(0) || `#${number}`,
  };
}

export function atomNameOf(s: Structure, atom: number): string {
  return s.nameTable[s.atomNameId[atom]];
}

export function resNameOf(s: Structure, residue: number): string {
  return s.nameTable[s.resNameId[residue]];
}

/** Interns strings into a shared table so per-atom names cost 2 bytes. */
class NameTable {
  readonly strings: string[] = [];
  private lookup = new Map<string, number>();

  intern(value: string): number {
    let id = this.lookup.get(value);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(value);
      this.lookup.set(value, id);
    }
    return id;
  }
}

/** Growable Float32 column. */
class F32 {
  data = new Float32Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  trim() { return this.data.subarray(0, this.length).slice(); }
}

class U32 {
  data = new Uint32Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  trim() { return this.data.subarray(0, this.length).slice(); }
}

class U16 {
  data = new Uint16Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Uint16Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  trim() { return this.data.subarray(0, this.length).slice(); }
}

class U8 {
  data = new Uint8Array(1 << 14);
  length = 0;
  push(v: number) {
    if (this.length === this.data.length) {
      const next = new Uint8Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  trim() { return this.data.subarray(0, this.length).slice(); }
}

function classifyResidue(comp: string, atomNames: Set<string>, atomCount: number): MolKind {
  if (isWater(comp)) return MolKind.Water;
  if (isAminoAcid(comp) && atomNames.has('CA')) return MolKind.Protein;
  if (isNucleotide(comp) && (atomNames.has("C4'") || atomNames.has('C4*'))) return MolKind.Nucleic;
  if (atomCount === 1) return MolKind.Ion;
  return MolKind.Ligand;
}

export interface BuildOptions {
  /** Model number to keep; NMR ensembles otherwise stack on top of each other. */
  modelNum?: number;
  /** Keep every model, as separate chains, for ensemble overlays. */
  allModels?: boolean;
  includeWater?: boolean;
}

export function buildStructure(
  block: CifBlock,
  id: string,
  title: string,
  options: BuildOptions = {},
): Structure {
  const includeWater = options.includeWater ?? true;
  const cat = block.category('atom_site');
  if (cat.rowCount === 0) throw new Error('No atom_site records in file');

  const n = cat.rowCount;
  const fX = cat.field('Cartn_x');
  const fY = cat.field('Cartn_y');
  const fZ = cat.field('Cartn_z');
  const fSymbol = cat.field('type_symbol');
  const fAtomId = cat.field('label_atom_id');
  const fCompId = cat.field('label_comp_id');
  const fAuthComp = cat.field('auth_comp_id');
  const fAuthAsym = cat.field('auth_asym_id');
  const fLabelAsym = cat.field('label_asym_id');
  const fAuthSeq = cat.field('auth_seq_id');
  const fLabelSeq = cat.field('label_seq_id');
  const fInsCode = cat.field('pdbx_PDB_ins_code');
  const fAltLoc = cat.field('label_alt_id');
  const fModel = cat.field('pdbx_PDB_model_num');
  const fEntity = cat.field('label_entity_id');
  const fBFactor = cat.field('B_iso_or_equiv');
  const fOccupancy = cat.field('occupancy');

  // NMR depositions stack every model in one atom_site loop, so without this
  // an ensemble renders as a dozen structures on top of each other.
  const models: number[] = [];
  if (fModel.isDefined) {
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const m = fModel.num(i);
      if (!seen.has(m)) { seen.add(m); models.push(m); }
    }
  }
  if (models.length === 0) models.push(1);

  const allModels = options.allModels ?? false;
  const requested = options.modelNum;
  const targetModel = requested !== undefined && models.includes(requested)
    ? requested
    : models[0];

  const names = new NameTable();
  const ax = new F32(), ay = new F32(), az = new F32();
  const aElem = new U8(), aBf = new F32(), aRes = new U32();
  const aName = new U16();

  const resName: string[] = [];
  const resNameId = new U16();
  const resSeq: number[] = [];
  const resChain: number[] = [];
  const resKind: number[] = [];
  const resAtomStart: number[] = [];
  const resAnchor: number[] = [];
  const resOrient: number[] = [];

  const chainAuthId: string[] = [];
  const chainLabelId: string[] = [];
  const chainEntity: string[] = [];
  const chainModel: number[] = [];
  const chainResStart: number[] = [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let bMin = Infinity, bMax = -Infinity;

  let curChainKey = '\u0000?';
  let curResKey = '\u0000?';
  let chainIdx = -1;
  let resIdx = -1;
  let pendingNames = new Set<string>();
  let pendingStart = 0;

  const finishResidue = () => {
    if (resIdx < 0) return;
    const count = aRes.length - pendingStart;
    resKind[resIdx] = classifyResidue(resName[resIdx], pendingNames, count);
  };

  for (let i = 0; i < n; i++) {
    const rowModel = fModel.isDefined ? fModel.num(i) : 1;
    if (!allModels && fModel.isDefined && rowModel !== targetModel) continue;

    // Keep only the dominant alternate conformation.
    if (fAltLoc.isDefined && !fAltLoc.isNull(i)) {
      const alt = fAltLoc.str(i);
      if (alt !== '' && alt !== '.' && alt !== 'A' && alt !== '1') continue;
    }
    if (fOccupancy.isDefined && fOccupancy.num(i) === 0) continue;

    const comp = (fCompId.isDefined ? fCompId.str(i) : fAuthComp.str(i)).toUpperCase();
    if (!includeWater && isWater(comp)) continue;

    const authAsym = fAuthAsym.isDefined ? fAuthAsym.str(i) : fLabelAsym.str(i);
    const labelAsym = fLabelAsym.isDefined ? fLabelAsym.str(i) : authAsym;
    const seq = fAuthSeq.isDefined && !fAuthSeq.isNull(i) ? fAuthSeq.num(i) : fLabelSeq.num(i);
    const ins = fInsCode.isDefined && !fInsCode.isNull(i) ? fInsCode.str(i) : '';

    // With the whole ensemble loaded the model is part of chain identity, so
    // a ribbon never runs from one model into the next.
    const chainKey = allModels
      ? `${rowModel}|${labelAsym}|${authAsym}`
      : `${labelAsym}|${authAsym}`;
    if (chainKey !== curChainKey) {
      finishResidue();
      curChainKey = chainKey;
      curResKey = '\u0000?';
      chainIdx++;
      chainAuthId.push(authAsym);
      chainLabelId.push(labelAsym);
      chainEntity.push(fEntity.isDefined ? fEntity.str(i) : '');
      chainModel.push(rowModel);
      chainResStart.push(resIdx + 1);
    }

    const resKey = `${seq}|${ins}|${comp}`;
    if (resKey !== curResKey) {
      finishResidue();
      curResKey = resKey;
      resIdx++;
      resName.push(comp);
      resNameId.push(names.intern(comp));
      resSeq.push(Number.isFinite(seq) ? seq : 0);
      resChain.push(chainIdx);
      resKind.push(MolKind.Ligand);
      resAtomStart.push(aRes.length);
      resAnchor.push(-1);
      resOrient.push(-1);
      pendingNames = new Set();
      pendingStart = aRes.length;
    }

    const name = fAtomId.str(i).replace(/"/g, '');
    const px = fX.num(i), py = fY.num(i), pz = fZ.num(i);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;

    const atomIndex = aRes.length;
    ax.push(px); ay.push(py); az.push(pz);
    aElem.push(elementIndex(fSymbol.isDefined ? fSymbol.str(i) : name.charAt(0)));
    const bf = fBFactor.isDefined ? fBFactor.num(i) : 0;
    aBf.push(Number.isFinite(bf) ? bf : 0);
    aRes.push(resIdx);
    aName.push(names.intern(name));
    pendingNames.add(name);

    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    if (Number.isFinite(bf)) { if (bf < bMin) bMin = bf; if (bf > bMax) bMax = bf; }

    // Remember the atoms the cartoon builder needs.
    if (name === 'CA' || name === "C4'" || name === 'C4*') resAnchor[resIdx] = atomIndex;
    else if (name === 'O' || name === "C1'" || name === 'C1*') {
      if (resOrient[resIdx] < 0) resOrient[resIdx] = atomIndex;
    }
  }
  finishResidue();

  const residueCount = resIdx + 1;
  const chainCount = chainIdx + 1;
  if (residueCount === 0) throw new Error('No atoms survived filtering');

  resAtomStart.push(aRes.length);
  chainResStart.push(residueCount);

  // A chain takes the identity of whatever polymer dominates it.
  const chainKind = new Uint8Array(chainCount);
  for (let c = 0; c < chainCount; c++) {
    const counts = [0, 0, 0, 0, 0];
    for (let r = chainResStart[c]; r < chainResStart[c + 1]; r++) counts[resKind[r]]++;
    let best = MolKind.Ligand;
    let bestN = -1;
    for (let k = 0; k < counts.length; k++) {
      if (counts[k] > bestN) { bestN = counts[k]; best = k; }
    }
    chainKind[c] = best;
  }

  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const radius = Math.max(
    0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    1,
  );

  const structure: Structure = {
    id,
    title,
    atomCount: aRes.length,
    x: ax.trim(), y: ay.trim(), z: az.trim(),
    element: aElem.trim(),
    bFactor: aBf.trim(),
    atomNameId: aName.trim(),
    atomResidue: aRes.trim(),
    residueCount,
    resNameId: resNameId.trim(),
    nameTable: names.strings,
    resSeq: Int32Array.from(resSeq),
    resChain: Uint32Array.from(resChain),
    resSS: new Uint8Array(residueCount),
    resKind: Uint8Array.from(resKind),
    resAtomStart: Uint32Array.from(resAtomStart),
    resAnchor: Int32Array.from(resAnchor),
    resOrient: Int32Array.from(resOrient),
    chainCount,
    chainAuthId,
    chainLabelId,
    chainEntity,
    chainKind,
    chainModel: Int32Array.from(chainModel),
    chainResStart: Uint32Array.from(chainResStart),
    center: Float32Array.from([cx, cy, cz]),
    radius,
    bMin: Number.isFinite(bMin) ? bMin : 0,
    bMax: Number.isFinite(bMax) ? bMax : 100,
    assemblies: parseAssemblies(block),
    crystal: parseCrystal(block),
    modelNum: allModels ? 0 : targetModel,
    modelCount: models.length,
  };

  assignSecondaryStructure(block, structure);
  return structure;
}

/**
 * Prefer the depositor's annotation; fall back to CA geometry when the file
 * carries none (common for cryo-EM and predicted models).
 */
function assignSecondaryStructure(block: CifBlock, s: Structure): void {
  const ss = s.resSS;

  // Residue lookup keyed by auth chain + sequence number.
  const key = (chain: string, seq: number) => `${chain}|${seq}`;
  const index = new Map<string, number>();
  for (let r = 0; r < s.residueCount; r++) {
    index.set(key(s.chainAuthId[s.resChain[r]], s.resSeq[r]), r);
  }

  let annotated = false;

  const applyRange = (cat: ReturnType<CifBlock['category']>, value: SS, helixCheck: boolean) => {
    if (cat.rowCount === 0) return;
    const bChain = cat.hasField('beg_auth_asym_id')
      ? cat.field('beg_auth_asym_id') : cat.field('beg_label_asym_id');
    const eChain = cat.hasField('end_auth_asym_id')
      ? cat.field('end_auth_asym_id') : cat.field('end_label_asym_id');
    const bSeq = cat.hasField('beg_auth_seq_id')
      ? cat.field('beg_auth_seq_id') : cat.field('beg_label_seq_id');
    const eSeq = cat.hasField('end_auth_seq_id')
      ? cat.field('end_auth_seq_id') : cat.field('end_label_seq_id');
    const type = cat.hasField('conf_type_id') ? cat.field('conf_type_id') : null;

    for (let i = 0; i < cat.rowCount; i++) {
      if (helixCheck && type?.isDefined) {
        const t = type.str(i).toUpperCase();
        if (!t.startsWith('HELX')) {
          // struct_conf also carries turns and strands in some depositions.
          if (t.startsWith('STRN')) { /* handled below as sheet */ }
          else if (t.startsWith('TURN')) { /* ignored: rendered as coil */ continue; }
          else continue;
        }
      }
      const chain = bChain.str(i) || eChain.str(i);
      const from = bSeq.num(i);
      const to = eSeq.num(i);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;

      const isStrand = helixCheck && type?.isDefined
        && type.str(i).toUpperCase().startsWith('STRN');
      const v = isStrand ? SS.Sheet : value;

      for (let seq = from; seq <= to; seq++) {
        const r = index.get(key(chain, seq));
        if (r !== undefined) { ss[r] = v; annotated = true; }
      }
    }
  };

  applyRange(block.category('struct_conf'), SS.Helix, true);
  applyRange(block.category('struct_sheet_range'), SS.Sheet, false);

  if (annotated) return;
  assignSecondaryStructureGeometric(s);
}

/**
 * Cheap CA-trace heuristic: an i→i+3 span near 5.5 Å is helical, an i→i+2 span
 * near 6.7 Å with an extended i→i+3 is a strand. Not DSSP, but it gives the
 * cartoon the right shape when no annotation is present.
 */
function assignSecondaryStructureGeometric(s: Structure): void {
  const { x, y, z, resAnchor, resSS, chainResStart, chainCount } = s;
  const dist = (a: number, b: number) =>
    Math.hypot(x[a] - x[b], y[a] - y[b], z[a] - z[b]);

  for (let c = 0; c < chainCount; c++) {
    const start = chainResStart[c];
    const end = chainResStart[c + 1];

    for (let r = start; r + 3 < end; r++) {
      const a0 = resAnchor[r], a2 = resAnchor[r + 2], a3 = resAnchor[r + 3];
      if (a0 < 0 || a2 < 0 || a3 < 0) continue;
      if (s.resKind[r] !== MolKind.Protein) continue;

      const d3 = dist(a0, a3);
      const d2 = dist(a0, a2);
      if (d3 > 4.5 && d3 < 6.4) {
        for (let k = r; k <= r + 3; k++) resSS[k] = SS.Helix;
      } else if (d3 > 9.5 && d2 > 6.0 && d2 < 7.4) {
        for (let k = r; k <= r + 2; k++) {
          if (resSS[k] === SS.Coil) resSS[k] = SS.Sheet;
        }
      }
    }

    // Drop 1–2 residue fragments; they only make the ribbon twitch.
    for (let r = start; r < end; r++) {
      const v = resSS[r];
      if (v === SS.Coil) continue;
      let run = r;
      while (run < end && resSS[run] === v) run++;
      if (run - r < 3) for (let k = r; k < run; k++) resSS[k] = SS.Coil;
      r = run - 1;
    }
  }
}
