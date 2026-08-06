/** Colour schemes. Each returns packed 0xRRGGBB for an atom or a residue. */

import {
  ELEMENT_COLORS, HYDROPATHY, unpackColor,
} from './elements';
import { MolKind, SS, resNameOf, type Structure } from './structure';

export type ColorScheme =
  | 'chain'
  | 'element'
  | 'secondary'
  | 'residue'
  | 'bfactor'
  | 'hydrophobicity'
  | 'rainbow'
  | 'entity'
  | 'base'
  | 'uniform';

export const COLOR_SCHEME_LABELS: Record<ColorScheme, string> = {
  chain: 'Chain',
  element: 'Element (CPK)',
  secondary: 'Secondary structure',
  residue: 'Residue type',
  bfactor: 'B-factor / pLDDT',
  hydrophobicity: 'Hydrophobicity',
  rainbow: 'Rainbow (N→C)',
  entity: 'Entity',
  base: 'Nucleotide base',
  uniform: 'Uniform',
};

/**
 * Nucleotide bases. Purines warm, pyrimidines cool, so a strand reads as its
 * purine/pyrimidine pattern even before you can tell A from G — and the two
 * members of a Watson-Crick pair always contrast. Covers DNA and RNA residue
 * names, including the deoxy- forms deposited as DA/DC/DG/DT.
 */
export const BASE_COLORS: Record<string, number> = {
  A: 0xff9e4a, DA: 0xff9e4a,
  G: 0xffd94a, DG: 0xffd94a,
  C: 0x4cc9f0, DC: 0x4cc9f0,
  T: 0x5ddb9a, DT: 0x5ddb9a,
  U: 0x9d7bf5, DU: 0x9d7bf5,
  I: 0xc78cff, DI: 0xc78cff,
};

/** Qualitative palette — distinguishable, and legible against a dark scene. */
export const CHAIN_PALETTE = [
  0x4cc9f0, 0xf7b267, 0x9d7bf5, 0x5ddb9a, 0xf76c8f, 0xffd94a, 0x69a4ff,
  0xff9e6d, 0x63d9d0, 0xd48cff, 0xa8e05f, 0xff7bb0, 0x8fd4ff, 0xe0c46c,
];

const SS_COLORS: Record<number, number> = {
  [SS.Coil]: 0x9aa5b5,
  [SS.Helix]: 0xf4576c,
  [SS.Sheet]: 0xf7c948,
  [SS.Turn]: 0x64d2a0,
};

const RESIDUE_COLORS: Record<string, number> = {
  ALA: 0x8ccf6f, GLY: 0xd9d9d9, VAL: 0x8ccf6f, LEU: 0x8ccf6f, ILE: 0x8ccf6f,
  MET: 0xffe14d, PRO: 0xc0a06c, PHE: 0x6fa8dc, TRP: 0x6fa8dc, TYR: 0x6fa8dc,
  SER: 0x66d9c8, THR: 0x66d9c8, CYS: 0xffe14d, ASN: 0x66d9c8, GLN: 0x66d9c8,
  ASP: 0xf4576c, GLU: 0xf4576c, LYS: 0x5b8def, ARG: 0x5b8def, HIS: 0x9d7bf5,
  DA: 0x5ddb9a, DT: 0xf76c8f, DG: 0xffd94a, DC: 0x69a4ff, DU: 0xf76c8f,
  A: 0x5ddb9a, U: 0xf76c8f, G: 0xffd94a, C: 0x69a4ff,
  HOH: 0x3f7fbf,
};

const KIND_FALLBACK: Record<number, number> = {
  [MolKind.Protein]: 0x8fa3bf,
  [MolKind.Nucleic]: 0xc9a26d,
  [MolKind.Ligand]: 0x66d9a0,
  [MolKind.Water]: 0x3f7fbf,
  [MolKind.Ion]: 0xd48cff,
};

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Blue → cyan → green → yellow → red. */
function rainbow(t: number): number {
  const stops = [0x3b4cc0, 0x39b8d8, 0x5ddb6f, 0xf5d13a, 0xe8483c];
  const clamped = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(clamped), stops.length - 2);
  return lerpColor(stops[i], stops[i + 1], clamped - i);
}

export interface ColorProvider {
  /** Packed 0xRRGGBB. */
  residue(residueIndex: number): number;
  atom(atomIndex: number): number;
}

export interface ColorOptions {
  scheme: ColorScheme;
  uniformColor: number;
  /** Chain palette offset so stacked structures do not all start on cyan. */
  paletteOffset: number;
}

export function makeColorProvider(s: Structure, options: ColorOptions): ColorProvider {
  const { scheme, uniformColor, paletteOffset } = options;

  // Precomputed per-residue table; per-atom lookups then cost one indirection.
  const table = new Uint32Array(s.residueCount);

  // Entity colouring keys off label_entity_id, which is per chain.
  const entityIds = new Map<string, number>();
  for (let c = 0; c < s.chainCount; c++) {
    const key = s.chainEntity[c] || s.chainLabelId[c];
    if (!entityIds.has(key)) entityIds.set(key, entityIds.size);
  }

  // Rainbow runs along each polymer chain independently.
  const chainSpan = new Float32Array(s.chainCount);
  for (let c = 0; c < s.chainCount; c++) {
    chainSpan[c] = Math.max(1, s.chainResStart[c + 1] - s.chainResStart[c] - 1);
  }

  const bRange = Math.max(1e-3, s.bMax - s.bMin);

  for (let r = 0; r < s.residueCount; r++) {
    const chain = s.resChain[r];
    const comp = resNameOf(s, r);
    let color: number;

    switch (scheme) {
      case 'chain':
        color = CHAIN_PALETTE[(chain + paletteOffset) % CHAIN_PALETTE.length];
        break;
      case 'entity': {
        const key = s.chainEntity[chain] || s.chainLabelId[chain];
        const idx = entityIds.get(key) ?? 0;
        color = CHAIN_PALETTE[(idx + paletteOffset) % CHAIN_PALETTE.length];
        break;
      }
      case 'secondary':
        color = s.resKind[r] === MolKind.Protein
          ? SS_COLORS[s.resSS[r]]
          : KIND_FALLBACK[s.resKind[r]];
        break;
      case 'residue':
        color = RESIDUE_COLORS[comp] ?? KIND_FALLBACK[s.resKind[r]];
        break;
      case 'hydrophobicity': {
        const h = HYDROPATHY[comp];
        color = h === undefined ? 0x808a99 : rainbow((h + 4.5) / 9);
        break;
      }
      case 'rainbow':
        color = rainbow((r - s.chainResStart[chain]) / chainSpan[chain]);
        break;
      case 'bfactor': {
        // Mid-point of the residue's atoms reads better than any single atom.
        let sum = 0;
        const start = s.resAtomStart[r];
        const end = s.resAtomStart[r + 1];
        for (let a = start; a < end; a++) sum += s.bFactor[a];
        const mean = end > start ? sum / (end - start) : 0;
        color = rainbow(1 - (mean - s.bMin) / bRange);
        break;
      }
      case 'base':
        color = BASE_COLORS[comp] ?? KIND_FALLBACK[s.resKind[r]];
        break;
      case 'uniform':
      default:
        color = uniformColor;
        break;
    }
    table[r] = color;
  }

  const byElement = scheme === 'element';

  return {
    residue: (r) => table[r],
    atom: (a) => (byElement ? ELEMENT_COLORS[s.element[a]] : table[s.atomResidue[a]]),
  };
}

export { unpackColor };
