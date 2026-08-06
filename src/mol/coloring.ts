/** Colour schemes. Each returns packed 0xRRGGBB for an atom or a residue. */

import {
  ELEMENT_COLORS, HYDROPATHY, unpackColor,
} from './elements';
import { MolKind, SS, resNameOf, type Structure } from './structure';
import type { ResidueValidation } from '../rcsb/residueValidation';
import { plddtColor } from '../rcsb/alphafold';

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
  | 'rsrz'
  | 'outliers'
  | 'plddt'
  | 'pathogenicity'
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
  rsrz: 'Fit to density (RSRZ)',
  outliers: 'Geometry outliers',
  plddt: 'Confidence (pLDDT)',
  pathogenicity: 'AlphaMissense',
  uniform: 'Uniform',
};

/** Schemes that need per-residue validation fetched before they mean anything. */
export const VALIDATION_SCHEMES: ReadonlySet<ColorScheme> = new Set(['rsrz', 'outliers']);

/** Schemes that only mean anything on a predicted structure. */
export const PREDICTION_SCHEMES: ReadonlySet<ColorScheme> = new Set(['plddt', 'pathogenicity']);

/** Residues the validation report says nothing about — ligands, waters, gaps. */
const UNMEASURED = 0x5b6472;

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
const DEFAULT_CHAIN_PALETTE = [
  0x4cc9f0, 0xf7b267, 0x9d7bf5, 0x5ddb9a, 0xf76c8f, 0xffd94a, 0x69a4ff,
  0xff9e6d, 0x63d9d0, 0xd48cff, 0xa8e05f, 0xff7bb0, 0x8fd4ff, 0xe0c46c,
];

/**
 * Okabe and Ito's palette, which stays distinguishable under the common forms
 * of colour-vision deficiency.
 *
 * Eight colours instead of fourteen, and that is the honest cost: a fifteen-
 * chain structure will repeat sooner. The default palette runs cyan, orange,
 * purple, green, pink — the green/pink pair is the classic deuteranopia
 * collision, and a per-chain figure that reads as one colour to eight per cent
 * of men is a figure that failed. Black is dropped because the background is
 * nearly black; a light neutral takes its place.
 */
const SAFE_CHAIN_PALETTE = [
  0x56b4e9, 0xe69f00, 0x009e73, 0xf0e442, 0x0072b2, 0xd55e00, 0xcc79a7, 0xe8e8e8,
];

const PALETTE_STORAGE = 'molview-colorblind-palette';

/**
 * Persisted, and in localStorage rather than sessionStorage: an accessibility
 * setting that has to be found again every session is one the person it exists
 * for will stop using.
 */
function storedPreference(): boolean {
  try {
    return localStorage.getItem(PALETTE_STORAGE) === '1';
  } catch {
    return false;
  }
}

let activePalette = storedPreference() ? SAFE_CHAIN_PALETTE : DEFAULT_CHAIN_PALETTE;

/**
 * A function rather than a constant, because every consumer — the geometry
 * builder, the colour key, the chain list in the panel — has to agree, and one
 * of them holding the old array is a legend that contradicts the picture.
 */
export function chainPalette(): readonly number[] {
  return activePalette;
}

export function setColorBlindSafe(enabled: boolean): void {
  activePalette = enabled ? SAFE_CHAIN_PALETTE : DEFAULT_CHAIN_PALETTE;
  try {
    if (enabled) localStorage.setItem(PALETTE_STORAGE, '1');
    else localStorage.removeItem(PALETTE_STORAGE);
  } catch {
    // Storage disabled: the setting still works, just not across reloads.
  }
}

export function isColorBlindSafe(): boolean {
  return activePalette === SAFE_CHAIN_PALETTE;
}

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
  /** Needed by the validation schemes; they fall back to grey without it. */
  residueValidation?: ResidueValidation | null;
  /** Per-residue AlphaMissense means, indexed by residue number. */
  missense?: Float32Array | null;
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
        color = activePalette[(chain + paletteOffset) % activePalette.length];
        break;
      case 'entity': {
        const key = s.chainEntity[chain] || s.chainLabelId[chain];
        const idx = entityIds.get(key) ?? 0;
        color = activePalette[(idx + paletteOffset) % activePalette.length];
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
      case 'plddt': {
        // AlphaFold's own four bands and its own colours. A continuous ramp
        // would be prettier and would misread the model: pLDDT is used as a
        // threshold — above 90 trust the side chain, below 50 trust nothing,
        // and a smooth gradient hides exactly those two lines.
        let sum = 0;
        const start = s.resAtomStart[r];
        const end = s.resAtomStart[r + 1];
        for (let a = start; a < end; a++) sum += s.bFactor[a];
        color = plddtColor(end > start ? sum / (end - start) : 0);
        break;
      }
      case 'pathogenicity': {
        const scores = options.missense;
        const value = scores && s.resSeq[r] < scores.length ? scores[s.resSeq[r]] : Number.NaN;
        // 0.34 and 0.564 are AlphaMissense's own likely-benign and
        // likely-pathogenic cut-offs, so the ramp turns where the paper does.
        color = Number.isNaN(value)
          ? UNMEASURED
          : rainbow(Math.min(Math.max((value - 0.2) / 0.55, 0), 1));
        break;
      }
      case 'rsrz': {
        const m = metricsFor(s, r, options.residueValidation);
        // 2 sigma is the conventional outlier threshold and 4 is bad by any
        // reading, so the ramp is anchored there rather than to the entry's
        // own range: the same colour then means the same thing between two
        // structures, which is the point of a standardised score.
        color = m?.rsrz == null ? UNMEASURED : rainbow(Math.min(Math.max(m.rsrz, 0), 4) / 4);
        break;
      }
      case 'outliers': {
        const m = metricsFor(s, r, options.residueValidation);
        if (!m) color = UNMEASURED;
        else if (m.outliers === 0) color = 0x4a7fb5;
        else color = rainbow(0.45 + Math.min(m.outliers, 6) / 12);
        break;
      }
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

/**
 * The report's row for a residue, keyed the way a user names it. Insertion
 * codes are not part of the key: RCSB reports against the entity sequence, and
 * the auth mapping it publishes carries the number without the code.
 */
function metricsFor(
  s: Structure, residue: number, validation: ResidueValidation | null | undefined,
) {
  if (!validation) return null;
  const chain = s.chainAuthId[s.resChain[residue]];
  return validation.byResidue.get(`${chain}:${s.resSeq[residue]}`) ?? null;
}

export { unpackColor };
