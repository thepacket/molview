/** Element data: symbols, van der Waals / covalent radii, and CPK colours. */

export const ELEMENT_SYMBOLS = [
  'X', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
  'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
  'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
  'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb',
  'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th',
  'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm',
] as const;

const SYMBOL_TO_INDEX = new Map<string, number>();
ELEMENT_SYMBOLS.forEach((s, i) => SYMBOL_TO_INDEX.set(s.toUpperCase(), i));

export function elementIndex(symbol: string): number {
  if (!symbol) return 0;
  return SYMBOL_TO_INDEX.get(symbol.toUpperCase()) ?? 0;
}

/** Van der Waals radii in Ångström, indexed by element number. */
export const VDW_RADII = new Float32Array(ELEMENT_SYMBOLS.length).fill(1.8);
{
  const r: Record<string, number> = {
    H: 1.1, He: 1.4, Li: 1.81, Be: 1.53, B: 1.92, C: 1.7, N: 1.55, O: 1.52,
    F: 1.47, Ne: 1.54, Na: 2.27, Mg: 1.73, Al: 1.84, Si: 2.1, P: 1.8, S: 1.8,
    Cl: 1.75, Ar: 1.88, K: 2.75, Ca: 2.31, Fe: 2.05, Co: 2.0, Ni: 2.0,
    Cu: 2.0, Zn: 2.1, Se: 1.9, Br: 1.83, I: 1.98, Mn: 2.05, Mo: 2.1,
    Cd: 2.18, Pt: 2.13, Au: 2.14, Hg: 2.23,
  };
  for (const [sym, radius] of Object.entries(r)) VDW_RADII[elementIndex(sym)] = radius;
}

/** Covalent radii in Ångström — used for distance-based bond perception. */
export const COVALENT_RADII = new Float32Array(ELEMENT_SYMBOLS.length).fill(1.6);
{
  const r: Record<string, number> = {
    H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66,
    F: 0.57, Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05,
    Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76, Sc: 1.7, Ti: 1.6, V: 1.53, Cr: 1.39,
    Mn: 1.39, Fe: 1.32, Co: 1.26, Ni: 1.24, Cu: 1.32, Zn: 1.22, Se: 1.2,
    Br: 1.2, Mo: 1.54, I: 1.39, Pt: 1.36, Au: 1.36, Hg: 1.32,
  };
  for (const [sym, radius] of Object.entries(r)) COVALENT_RADII[elementIndex(sym)] = radius;
}

/** CPK colours as packed 0xRRGGBB, indexed by element number. */
export const ELEMENT_COLORS = new Uint32Array(ELEMENT_SYMBOLS.length).fill(0xff1493);
{
  const c: Record<string, number> = {
    X: 0xbfbfbf, H: 0xf0f0f0, He: 0xd9ffff, Li: 0xcc80ff, Be: 0xc2ff00,
    B: 0xffb5b5, C: 0x9aa4b2, N: 0x4f7fff, O: 0xf4453c, F: 0x90e050,
    Ne: 0xb3e3f5, Na: 0xab5cf2, Mg: 0x8aff00, Al: 0xbfa6a6, Si: 0xf0c8a0,
    P: 0xff9036, S: 0xffe14d, Cl: 0x39d939, Ar: 0x80d1e3, K: 0x8f40d4,
    Ca: 0x3dff00, Ti: 0xbfc2c7, Cr: 0x8a99c7, Mn: 0x9c7ac7, Fe: 0xe06633,
    Co: 0xf090a0, Ni: 0x50d050, Cu: 0xc88033, Zn: 0x7d80b0, Se: 0xffa100,
    Br: 0xa62929, Mo: 0x54b5b5, I: 0x940094, Pt: 0xd0d0e0, Au: 0xffd123,
    Hg: 0xb8b8d0,
  };
  for (const [sym, color] of Object.entries(c)) ELEMENT_COLORS[elementIndex(sym)] = color;
}

export function unpackColor(rgb: number): [number, number, number] {
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255];
}

/** Kyte–Doolittle hydropathy, used by the hydrophobicity colour scheme. */
export const HYDROPATHY: Record<string, number> = {
  ILE: 4.5, VAL: 4.2, LEU: 3.8, PHE: 2.8, CYS: 2.5, MET: 1.9, ALA: 1.8,
  GLY: -0.4, THR: -0.7, SER: -0.8, TRP: -0.9, TYR: -1.3, PRO: -1.6,
  HIS: -3.2, GLU: -3.5, GLN: -3.5, ASP: -3.5, ASN: -3.5, LYS: -3.9, ARG: -4.5,
};

const AMINO_ACIDS = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  'MSE', 'SEC', 'PYL', 'ASX', 'GLX', 'UNK', 'HYP', 'CSO', 'PTR', 'SEP', 'TPO',
]);

const NUCLEOTIDES = new Set([
  'A', 'C', 'G', 'U', 'I', 'DA', 'DC', 'DG', 'DT', 'DU', 'DI', 'N',
  '5MC', '7MG', 'PSU', '1MA', 'H2U', 'OMC', 'OMG',
]);

const WATER = new Set(['HOH', 'DOD', 'WAT', 'H2O', 'TIP', 'SOL']);

export const ONE_LETTER: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E',
  GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F',
  PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', MSE: 'M',
  SEC: 'U', PYL: 'O', DA: 'A', DC: 'C', DG: 'G', DT: 'T', DU: 'U',
  A: 'A', C: 'C', G: 'G', U: 'U', I: 'I',
};

export function isAminoAcid(comp: string): boolean {
  return AMINO_ACIDS.has(comp);
}

export function isNucleotide(comp: string): boolean {
  return NUCLEOTIDES.has(comp);
}

export function isWater(comp: string): boolean {
  return WATER.has(comp);
}
