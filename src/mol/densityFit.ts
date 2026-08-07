/**
 * How well each residue is supported by the density it was built into.
 *
 * MolView already fetches the map and holds the model in the same client, which
 * is the whole reason this can exist without a server. The number is the
 * real-space correlation coefficient: density calculated from the model,
 * correlated against density observed in the map, over the residue's own
 * envelope.
 *
 * It answers the question that decides whether a picture means anything —
 * *is this atom supported by the data, or by what the modeller hoped?* — and it
 * covers the case wwPDB's RSRZ does not. RSRZ is computed for polymer residues
 * only, so the ligand, which is the part anyone actually doubts, is exactly the
 * part with no published score.
 *
 * What this is not: a replacement for a refinement program's own statistics,
 * and the numbers are not on wwPDB's scale. Measured against wwPDB's own
 * per-residue RSCC across four entries, this agrees at r = 0.62 and runs about
 * 0.20 lower in absolute value — 0.70 where the report says 0.90. Three causes,
 * none fixable in a browser: the calculated density is one isotropic Gaussian
 * per atom rather than real scattering factors, occupancy is not yet carried on
 * the model so a half-occupied atom counts whole, and the map is what the
 * volume server sampled rather than one computed from structure factors to
 * match the model.
 *
 * So read it as a ranking within one structure, not against a published
 * threshold. "Which parts of this model are least supported" it answers well;
 * "is 0.75 good" it does not, because 0.75 here is not 0.75 there. The envelope
 * radius was chosen by sweeping it against wwPDB agreement, which peaked at
 * 1.8 Å (r = 0.62, against 0.57 at 2.5 Å and 0.51 at 3.0 Å).
 */

import { gridIndexOf, gridReach, type VolumeGrid } from '../rcsb/volume';
import { MolKind, type Structure } from './structure';

export interface ResidueFit {
  residue: number;
  /**
   * Pearson correlation between observed and calculated density, -1 to 1.
   *
   * Compare it to the other residues of the same structure, not to a published
   * threshold — see the note at the top of this file. Negative is the one
   * absolute statement worth making: the density is somewhere the model is not.
   */
  rscc: number;
  /** Mean observed density over the envelope, in sigma. */
  sigma: number;
  /** Grid points correlated. A handful of points is not a measurement. */
  points: number;
}

export interface DensityFitOptions {
  /** Restrict to these atoms; a residue with none is skipped. */
  mask?: Uint8Array | null;
  /**
   * Radius around each atom whose grid points join the correlation. The
   * default was calibrated rather than assumed — see DEFAULT_RADIUS.
   */
  radius?: number;
  /**
   * Nominal resolution in Å. Sets how wide a calculated atom is, together with
   * its B-factor. Only the ratio matters to a correlation, so a wrong value
   * shifts every residue rather than reordering them.
   */
  resolution?: number;
  /** Fewer points than this and the residue is reported with rscc NaN. */
  minPoints?: number;
}

// Swept against wwPDB's per-residue RSCC on 1UBQ, 1CBS, 3PTB and 2HHB: mean
// agreement peaks here. Tighter starves the correlation of points, wider lets
// solvent and neighbouring residues dominate a region meant to be this one.
const DEFAULT_RADIUS = 1.8;
const DEFAULT_RESOLUTION = 2.0;
const DEFAULT_MIN_POINTS = 30;

/**
 * Width of one atom's calculated density.
 *
 * B-factor contributes B/(8*pi^2), which is the mean-square displacement it
 * encodes. Resolution contributes a floor, because a map computed to 2 Å cannot
 * show an atom sharper than about that however still the atom is.
 */
function atomSigma(bFactor: number, resolution: number): number {
  const fromB = Math.max(bFactor, 0) / (8 * Math.PI * Math.PI);
  const fromRes = (resolution / 3) * (resolution / 3);
  return Math.sqrt(fromB + fromRes);
}

/**
 * Correlation per residue, in residue order. Residues outside the map, or with
 * too few grid points, come back with `rscc` NaN rather than being dropped, so
 * the caller can tell "poor fit" from "not measured".
 */
export function residueDensityFit(
  s: Structure, grid: VolumeGrid, options: DensityFitOptions = {},
): ResidueFit[] {
  const radius = options.radius ?? DEFAULT_RADIUS;
  const resolution = options.resolution ?? DEFAULT_RESOLUTION;
  const minPoints = options.minPoints ?? DEFAULT_MIN_POINTS;
  const mask = options.mask ?? null;

  const { counts, origin, stepA, stepB, stepC, values, mean, sigma } = grid;
  const reach = gridReach(grid);
  // How many indices `radius` spans along each grid axis. The reach already
  // accounts for a non-orthogonal cell, so this is a box in index space that
  // certainly contains the sphere.
  const span: [number, number, number] = [
    Math.ceil(radius * reach[0]), Math.ceil(radius * reach[1]), Math.ceil(radius * reach[2]),
  ];

  const index = new Float32Array(3);
  const out: ResidueFit[] = [];
  const radiusSq = radius * radius;

  for (let r = 0; r < s.residueCount; r++) {
    const start = s.resAtomStart[r];
    const end = s.resAtomStart[r + 1];

    // Heavy atoms only. Hydrogens carry one electron and are absent from most
    // X-ray models anyway; including them would add noise, not signal.
    const atoms: number[] = [];
    for (let a = start; a < end; a++) {
      if (s.element[a] <= 1) continue;
      if (mask && !mask[a]) continue;
      atoms.push(a);
    }
    if (atoms.length === 0) {
      out.push({ residue: r, rscc: Number.NaN, sigma: Number.NaN, points: 0 });
      continue;
    }

    // Index-space box covering every atom's sphere.
    let i0 = Infinity, j0 = Infinity, k0 = Infinity;
    let i1 = -Infinity, j1 = -Infinity, k1 = -Infinity;
    for (const a of atoms) {
      gridIndexOf(grid, s.x[a], s.y[a], s.z[a], index);
      i0 = Math.min(i0, Math.floor(index[0]) - span[0]);
      j0 = Math.min(j0, Math.floor(index[1]) - span[1]);
      k0 = Math.min(k0, Math.floor(index[2]) - span[2]);
      i1 = Math.max(i1, Math.ceil(index[0]) + span[0]);
      j1 = Math.max(j1, Math.ceil(index[1]) + span[1]);
      k1 = Math.max(k1, Math.ceil(index[2]) + span[2]);
    }
    i0 = Math.max(i0, 0); j0 = Math.max(j0, 0); k0 = Math.max(k0, 0);
    i1 = Math.min(i1, counts[0] - 1);
    j1 = Math.min(j1, counts[1] - 1);
    k1 = Math.min(k1, counts[2] - 1);

    // Per-atom weight and width, computed once for the residue.
    const weight = new Float64Array(atoms.length);
    const inv2SigmaSq = new Float64Array(atoms.length);
    for (let n = 0; n < atoms.length; n++) {
      const a = atoms[n];
      // The element index is the atomic number, so it is the electron count.
      weight[n] = s.element[a];
      const w = atomSigma(s.bFactor[a], resolution);
      inv2SigmaSq[n] = 1 / (2 * w * w);
    }

    let n = 0;
    let sumO = 0, sumC = 0, sumOO = 0, sumCC = 0, sumOC = 0;

    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = origin[0] + stepA[0] * i + stepB[0] * j + stepC[0] * k;
          const py = origin[1] + stepA[1] * i + stepB[1] * j + stepC[1] * k;
          const pz = origin[2] + stepA[2] * i + stepB[2] * j + stepC[2] * k;

          // Inside the envelope, and the calculated density, in one pass.
          let calc = 0;
          let inside = false;
          for (let m = 0; m < atoms.length; m++) {
            const a = atoms[m];
            const dx = px - s.x[a], dy = py - s.y[a], dz = pz - s.z[a];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= radiusSq) inside = true;
            calc += weight[m] * Math.exp(-d2 * inv2SigmaSq[m]);
          }
          if (!inside) continue;

          const obs = (values[i + counts[0] * (j + counts[1] * k)] - mean) / sigma;
          sumO += obs; sumC += calc;
          sumOO += obs * obs; sumCC += calc * calc; sumOC += obs * calc;
          n++;
        }
      }
    }

    if (n < minPoints) {
      out.push({ residue: r, rscc: Number.NaN, sigma: n > 0 ? sumO / n : Number.NaN, points: n });
      continue;
    }

    const covariance = sumOC / n - (sumO / n) * (sumC / n);
    const varO = sumOO / n - (sumO / n) * (sumO / n);
    const varC = sumCC / n - (sumC / n) * (sumC / n);
    const denom = Math.sqrt(Math.max(varO, 0) * Math.max(varC, 0));
    out.push({
      residue: r,
      rscc: denom > 1e-12 ? covariance / denom : Number.NaN,
      sigma: sumO / n,
      points: n,
    });
  }

  return out;
}

/** A residue's kind, for grouping a fit report. */
export function fitCategory(s: Structure, residue: number): MolKind {
  return s.resKind[residue] as MolKind;
}

/**
 * The worst-fitting residues, ignoring water.
 *
 * Water is excluded because a single oxygen in a 2.5 Å envelope correlates
 * badly almost by construction, and a list of a hundred waters buries the
 * ligand that is the reason to look.
 */
export function worstFits(
  s: Structure, fits: ResidueFit[], limit = 12,
): ResidueFit[] {
  return fits
    .filter((f) => Number.isFinite(f.rscc) && s.resKind[f.residue] !== MolKind.Water)
    .sort((a, b) => a.rscc - b.rscc)
    .slice(0, limit);
}
