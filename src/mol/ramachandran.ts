/**
 * Backbone dihedrals, and the Ramachandran classification built on them.
 *
 * The angles themselves are the easy half and the exact half: phi is the
 * torsion C(i-1)-N-CA-C, psi is N-CA-C-N(i+1), four atoms and an arctangent
 * each, with no threshold to tune and no approximation anywhere. What makes a
 * Ramachandran plot a validation tool rather than a scatter chart is the
 * *background* — the favoured and allowed regions — and that is reference data,
 * not arithmetic. See `ramachandranData.ts` for where it comes from.
 *
 * Residues are judged against different distributions depending on what they
 * are, because glycine has no side chain and reaches places nothing else can,
 * proline's ring pins its phi, and the residue *before* a proline is squeezed
 * by that ring. Scoring all of them against one general distribution is the
 * classic way to produce outliers that are not outliers.
 */

import { isAminoAcid } from './elements';
import { torsionBetween } from './measure';
import { atomNameOf, MolKind, resNameOf, type Structure } from './structure';

export type RamaCategory =
  | 'general'
  | 'glycine'
  | 'proline'
  | 'preproline'
  | 'ilevaline';

export const RAMA_CATEGORIES: RamaCategory[] = [
  'general', 'glycine', 'proline', 'preproline', 'ilevaline',
];

/** Where a residue falls against its own category's reference distribution. */
export type RamaBand = 'favoured' | 'allowed' | 'outlier';

export interface RamaPoint {
  /** Residue index into the structure. */
  residue: number;
  phi: number;
  psi: number;
  category: RamaCategory;
}

/**
 * A peptide bond is 1.33 Å. This is loose enough to tolerate a poorly refined
 * model and tight enough that two residues either side of an unmodelled loop
 * are never joined — computing phi across a hole yields an angle that is
 * arithmetically fine and physically meaningless.
 */
const PEPTIDE_BOND_MAX = 2.0;

/** Backbone atom indices for one residue, or null if any is missing. */
interface Backbone { n: number; ca: number; c: number }

function backboneOf(s: Structure, r: number): Backbone | null {
  let n = -1, ca = -1, c = -1;
  for (let a = s.resAtomStart[r]; a < s.resAtomStart[r + 1]; a++) {
    const name = atomNameOf(s, a);
    if (name === 'N') { if (n < 0) n = a; }
    else if (name === 'CA') { if (ca < 0) ca = a; }
    else if (name === 'C') { if (c < 0) c = a; }
  }
  return n >= 0 && ca >= 0 && c >= 0 ? { n, ca, c } : null;
}

function bonded(s: Structure, a: number, b: number): boolean {
  const d = Math.hypot(s.x[b] - s.x[a], s.y[b] - s.y[a], s.z[b] - s.z[a]);
  return d <= PEPTIDE_BOND_MAX;
}

/**
 * Which reference distribution this residue is judged against.
 *
 * Order matters and is MolProbity's: glycine and proline win over the
 * pre-proline rule, so a glycine sitting before a proline is scored as a
 * glycine. A residue is pre-proline when the *next* one is a proline, which is
 * why `nextName` is passed in rather than looked up here.
 */
export function categoryFor(name: string, nextName: string | null): RamaCategory {
  if (name === 'GLY') return 'glycine';
  if (name === 'PRO') return 'proline';
  if (nextName === 'PRO') return 'preproline';
  if (name === 'ILE' || name === 'VAL') return 'ilevaline';
  return 'general';
}

/**
 * Signed dihedral about b–c, in degrees.
 *
 * One implementation, in `measure.ts`, shared rather than repeated — a second
 * copy is how the two would come to disagree about the sign, which is exactly
 * the bug this feature surfaced.
 */
export const torsionOf = torsionBetween;

/**
 * Every residue with a defined phi and psi.
 *
 * The first and last residue of every chain are absent by construction: phi
 * needs the preceding carbonyl and psi the following nitrogen, so a terminus
 * has one of them and not the other. That is a property of the molecule, not a
 * limitation — a Ramachandran plot has never included termini.
 */
export function computeRamachandran(s: Structure): RamaPoint[] {
  const points: RamaPoint[] = [];

  for (let c = 0; c < s.chainCount; c++) {
    if (s.chainKind[c] !== MolKind.Protein) continue;
    const start = s.chainResStart[c];
    const end = s.chainResStart[c + 1];

    for (let r = start + 1; r < end - 1; r++) {
      if (s.resKind[r] !== MolKind.Protein) continue;
      const name = resNameOf(s, r);
      if (!isAminoAcid(name)) continue;

      const prev = backboneOf(s, r - 1);
      const self = backboneOf(s, r);
      const next = backboneOf(s, r + 1);
      if (!prev || !self || !next) continue;

      // Both neighbours have to be genuinely bonded to this residue, or the
      // angle describes two unrelated fragments that happen to be adjacent in
      // the file.
      if (!bonded(s, prev.c, self.n)) continue;
      if (!bonded(s, self.c, next.n)) continue;

      points.push({
        residue: r,
        phi: torsionOf(s, prev.c, self.n, self.ca, self.c),
        psi: torsionOf(s, self.n, self.ca, self.c, next.n),
        category: categoryFor(name, resNameOf(s, r + 1)),
      });
    }
  }

  return points;
}
