/**
 * Distance-based bond perception over a uniform spatial hash.
 *
 * mmCIF gives us connectivity only for chemical components, not between them,
 * so we derive bonds geometrically: O(n) with a grid whose cell size matches
 * the longest bond we will accept.
 */

import type { Structure } from './structure';
import { COVALENT_RADII } from './elements';
import { MolKind as Kind } from './structure';

export interface BondList {
  /** Flat pairs: [a0, b0, a1, b1, ...] */
  readonly indices: Uint32Array;
  readonly count: number;
}

const TOLERANCE = 0.45;
const MAX_BOND = 2.2;

export function computeBonds(s: Structure, atomFilter?: Uint8Array): BondList {
  const { x, y, z, element, atomCount, atomResidue, resKind } = s;

  const cell = MAX_BOND;
  const inv = 1 / cell;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let active = 0;
  for (let i = 0; i < atomCount; i++) {
    if (atomFilter && !atomFilter[i]) continue;
    active++;
    if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
    if (z[i] < minZ) minZ = z[i]; if (z[i] > maxZ) maxZ = z[i];
  }
  if (active === 0) return { indices: new Uint32Array(0), count: 0 };

  const nx = Math.max(1, Math.ceil((maxX - minX) * inv) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) * inv) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) * inv) + 1);
  const cellCount = nx * ny * nz;

  // Counting sort into buckets: two passes, no per-cell arrays.
  const cellOf = new Int32Array(atomCount).fill(-1);
  const counts = new Uint32Array(cellCount + 1);
  for (let i = 0; i < atomCount; i++) {
    if (atomFilter && !atomFilter[i]) continue;
    const gx = Math.min(nx - 1, ((x[i] - minX) * inv) | 0);
    const gy = Math.min(ny - 1, ((y[i] - minY) * inv) | 0);
    const gz = Math.min(nz - 1, ((z[i] - minZ) * inv) | 0);
    const c = (gz * ny + gy) * nx + gx;
    cellOf[i] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];

  const cursor = counts.slice(0, cellCount);
  const bucket = new Uint32Array(active);
  for (let i = 0; i < atomCount; i++) {
    const c = cellOf[i];
    if (c >= 0) bucket[cursor[c]++] = i;
  }

  const out: number[] = [];
  const maxCovalent = new Float32Array(atomCount);
  for (let i = 0; i < atomCount; i++) maxCovalent[i] = COVALENT_RADII[element[i]];

  for (let i = 0; i < atomCount; i++) {
    const c = cellOf[i];
    if (c < 0) continue;
    const gx = c % nx;
    const gy = ((c / nx) | 0) % ny;
    const gz = (c / (nx * ny)) | 0;
    const ri = maxCovalent[i];
    const isWaterI = resKind[atomResidue[i]] === Kind.Water;

    for (let dz = -1; dz <= 1; dz++) {
      const zz = gz + dz;
      if (zz < 0 || zz >= nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = gy + dy;
        if (yy < 0 || yy >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx;
          if (xx < 0 || xx >= nx) continue;
          const nc = (zz * ny + yy) * nx + xx;
          for (let k = counts[nc], kEnd = counts[nc + 1]; k < kEnd; k++) {
            const j = bucket[k];
            if (j <= i) continue;

            // Waters bond to nothing here; hydrogen bonds are not covalent.
            if (isWaterI || resKind[atomResidue[j]] === Kind.Water) continue;

            const dxp = x[i] - x[j];
            const dyp = y[i] - y[j];
            const dzp = z[i] - z[j];
            const d2 = dxp * dxp + dyp * dyp + dzp * dzp;
            const limit = ri + maxCovalent[j] + TOLERANCE;
            if (d2 > limit * limit || d2 < 0.16) continue;
            out.push(i, j);
          }
        }
      }
    }
  }

  return { indices: Uint32Array.from(out), count: out.length / 2 };
}

/** Atom mask selecting only non-polymer residues (ligands, ions, cofactors). */
export function nonPolymerMask(s: Structure, includeWater: boolean): Uint8Array {
  const mask = new Uint8Array(s.atomCount);
  for (let r = 0; r < s.residueCount; r++) {
    const kind = s.resKind[r];
    const keep = kind === Kind.Ligand || kind === Kind.Ion
      || (includeWater && kind === Kind.Water);
    if (!keep) continue;
    for (let a = s.resAtomStart[r], e = s.resAtomStart[r + 1]; a < e; a++) mask[a] = 1;
  }
  return mask;
}
