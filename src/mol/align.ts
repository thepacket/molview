/**
 * Structural superposition.
 *
 * Sequence-guided, the way ChimeraX's matchmaker works: align the two chains'
 * sequences to decide which residues correspond, superpose the paired Cα atoms,
 * then iteratively drop the pairs that stayed far apart and superpose again.
 * The iteration matters — a raw sequence alignment includes loops and termini
 * that are genuinely in different places, and they otherwise dominate the fit.
 */

import { ONE_LETTER } from './elements';
import { MolKind, resNameOf, type Structure } from './structure';

// ---------------------------------------------------------------------------
// Chains and sequences
// ---------------------------------------------------------------------------

export interface AlignableChain {
  /** auth_asym_id, as shown everywhere in the UI. */
  authId: string;
  kind: number;
  /** One-letter sequence of the residues that have a backbone anchor. */
  sequence: string;
  /** Residue index in the structure for each sequence position. */
  residues: number[];
  /** Anchor atom index for each sequence position. */
  anchors: number[];
}

export function alignableChains(s: Structure): AlignableChain[] {
  const byId = new Map<string, AlignableChain>();
  const order: AlignableChain[] = [];

  for (let c = 0; c < s.chainCount; c++) {
    const kind = s.chainKind[c];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;

    const authId = s.chainAuthId[c];
    let chain = byId.get(authId);
    if (!chain) {
      chain = { authId, kind, sequence: '', residues: [], anchors: [] };
      byId.set(authId, chain);
      order.push(chain);
    }

    for (let r = s.chainResStart[c]; r < s.chainResStart[c + 1]; r++) {
      const anchor = s.resAnchor[r];
      if (anchor < 0) continue;
      const k = s.resKind[r];
      if (k !== MolKind.Protein && k !== MolKind.Nucleic) continue;
      chain.sequence += ONE_LETTER[resNameOf(s, r)] ?? 'X';
      chain.residues.push(r);
      chain.anchors.push(anchor);
    }
  }

  return order.filter((c) => c.residues.length >= 3);
}

// ---------------------------------------------------------------------------
// Sequence alignment (Gotoh, affine gaps)
// ---------------------------------------------------------------------------

const BLOSUM_ORDER = 'ARNDCQEGHILKMFPSTWYV';
/** BLOSUM62, row-major over BLOSUM_ORDER. */
const BLOSUM62 = [
  4, -1, -2, -2, 0, -1, -1, 0, -2, -1, -1, -1, -1, -2, -1, 1, 0, -3, -2, 0,
  -1, 5, 0, -2, -3, 1, 0, -2, 0, -3, -2, 2, -1, -3, -2, -1, -1, -3, -2, -3,
  -2, 0, 6, 1, -3, 0, 0, 0, 1, -3, -3, 0, -2, -3, -2, 1, 0, -4, -2, -3,
  -2, -2, 1, 6, -3, 0, 2, -1, -1, -3, -4, -1, -3, -3, -1, 0, -1, -4, -3, -3,
  0, -3, -3, -3, 9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2, -1,
  -1, 1, 0, 0, -3, 5, 2, -2, 0, -3, -2, 1, 0, -3, -1, 0, -1, -2, -1, -2,
  -1, 0, 0, 2, -4, 2, 5, -2, 0, -3, -3, 1, -2, -3, -1, 0, -1, -3, -2, -2,
  0, -2, 0, -1, -3, -2, -2, 6, -2, -4, -4, -2, -3, -3, -2, 0, -2, -2, -3, -3,
  -2, 0, 1, -1, -3, 0, 0, -2, 8, -3, -3, -1, -2, -1, -2, -1, -2, -2, 2, -3,
  -1, -3, -3, -3, -1, -3, -3, -4, -3, 4, 2, -3, 1, 0, -3, -2, -1, -3, -1, 3,
  -1, -2, -3, -4, -1, -2, -3, -4, -3, 2, 4, -2, 2, 0, -3, -2, -1, -2, -1, 1,
  -1, 2, 0, -1, -3, 1, 1, -2, -1, -3, -2, 5, -1, -3, -1, 0, -1, -3, -2, -2,
  -1, -1, -2, -3, -1, 0, -2, -3, -2, 1, 2, -1, 5, 0, -2, -1, -1, -1, -1, 1,
  -2, -3, -3, -3, -2, -3, -3, -3, -1, 0, 0, -3, 0, 6, -4, -2, -2, 1, 3, -1,
  -1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4, 7, -1, -1, -4, -3, -2,
  1, -1, 1, 0, -1, 0, 0, 0, -1, -2, -2, 0, -1, -2, -1, 4, 1, -3, -2, -2,
  0, -1, 0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1, 1, 5, -2, -2, 0,
  -3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1, 1, -4, -3, -2, 11, 2, -3,
  -2, -2, -2, -3, -2, -1, -2, -3, 2, -1, -1, -2, -1, 3, -3, -2, -2, 2, 7, -1,
  0, -3, -3, -3, -1, -2, -2, -3, -3, 3, 1, -2, 1, -1, -2, -2, 0, -3, -1, 4,
];

const BLOSUM_INDEX = new Map<string, number>();
for (let i = 0; i < BLOSUM_ORDER.length; i++) BLOSUM_INDEX.set(BLOSUM_ORDER[i], i);

function substitutionScore(a: string, b: string, nucleic: boolean): number {
  if (nucleic) return a === b ? 5 : -4;
  const ia = BLOSUM_INDEX.get(a);
  const ib = BLOSUM_INDEX.get(b);
  if (ia === undefined || ib === undefined) return a === b ? 1 : -1;
  return BLOSUM62[ia * 20 + ib];
}

const GAP_OPEN = -12;
const GAP_EXTEND = -1;

const enum Trace {
  Diagonal = 0,
  Up = 1,
  Left = 2,
}

/** Global alignment; returns index pairs into the two sequences. */
export function alignSequences(
  a: string, b: string, nucleic: boolean,
): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  const width = m + 1;
  const NEG = -1e9;

  let prevM = new Float64Array(width);
  let prevIx = new Float64Array(width);
  let currM = new Float64Array(width);
  let currIx = new Float64Array(width);

  // Traceback for each state, one byte per cell.
  const traceM = new Uint8Array((n + 1) * width);
  const traceIx = new Uint8Array((n + 1) * width);
  const traceIy = new Uint8Array((n + 1) * width);

  prevM[0] = 0;
  prevIx[0] = NEG;
  for (let j = 1; j <= m; j++) {
    prevM[j] = NEG;
    prevIx[j] = NEG;
    traceM[j] = Trace.Left;
  }

  let iyPrevRow = NEG;

  for (let i = 1; i <= n; i++) {
    currM[0] = NEG;
    currIx[0] = GAP_OPEN + (i - 1) * GAP_EXTEND;
    let iy = NEG;
    const rowOffset = i * width;
    traceIx[rowOffset] = Trace.Up;

    for (let j = 1; j <= m; j++) {
      // Ix: gap in b (moving down), Iy: gap in a (moving right).
      const openIx = prevM[j] + GAP_OPEN;
      const extendIx = prevIx[j] + GAP_EXTEND;
      if (openIx >= extendIx) {
        currIx[j] = openIx;
        traceIx[rowOffset + j] = Trace.Diagonal;
      } else {
        currIx[j] = extendIx;
        traceIx[rowOffset + j] = Trace.Up;
      }

      const openIy = currM[j - 1] + GAP_OPEN;
      const extendIy = iy + GAP_EXTEND;
      if (openIy >= extendIy) {
        iy = openIy;
        traceIy[rowOffset + j] = Trace.Diagonal;
      } else {
        iy = extendIy;
        traceIy[rowOffset + j] = Trace.Left;
      }

      const diag = prevM[j - 1] + substitutionScore(a[i - 1], b[j - 1], nucleic);
      let best = diag;
      let state = Trace.Diagonal;
      if (currIx[j] > best) { best = currIx[j]; state = Trace.Up; }
      if (iy > best) { best = iy; state = Trace.Left; }
      currM[j] = best;
      traceM[rowOffset + j] = state;
    }

    iyPrevRow = iy;
    const swapM = prevM; prevM = currM; currM = swapM;
    const swapIx = prevIx; prevIx = currIx; currIx = swapIx;
  }
  void iyPrevRow;

  // Walk back from the corner through whichever state was best there.
  const pairs: [number, number][] = [];
  let i = n;
  let j = m;
  let state: Trace = Trace.Diagonal;

  while (i > 0 && j > 0) {
    const cell = i * width + j;
    if (state === Trace.Diagonal) {
      const next = traceM[cell] as Trace;
      if (next === Trace.Diagonal) {
        pairs.push([i - 1, j - 1]);
        i--; j--;
      } else {
        state = next;
      }
    } else if (state === Trace.Up) {
      const next = traceIx[cell] as Trace;
      i--;
      state = next === Trace.Up ? Trace.Up : Trace.Diagonal;
    } else {
      const next = traceIy[cell] as Trace;
      j--;
      state = next === Trace.Left ? Trace.Left : Trace.Diagonal;
    }
  }

  pairs.reverse();
  return pairs;
}

// ---------------------------------------------------------------------------
// Kabsch superposition
// ---------------------------------------------------------------------------

/** Jacobi eigen-decomposition of a symmetric 4x4; returns the top eigenvector. */
function largestEigenvector(matrix: Float64Array): [number, number, number, number] {
  const a = Float64Array.from(matrix);
  const v = new Float64Array(16);
  for (let i = 0; i < 4; i++) v[i * 4 + i] = 1;

  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) off += a[p * 4 + q] * a[p * 4 + q];
    }
    if (off < 1e-18) break;

    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q];
        if (Math.abs(apq) < 1e-18) continue;
        const theta = (a[q * 4 + q] - a[p * 4 + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p];
          const akq = a[k * 4 + q];
          a[k * 4 + p] = c * akp - s * akq;
          a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k];
          const aqk = a[q * 4 + k];
          a[p * 4 + k] = c * apk - s * aqk;
          a[q * 4 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p];
          const vkq = v[k * 4 + q];
          v[k * 4 + p] = c * vkp - s * vkq;
          v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i * 4 + i] > a[best * 4 + best]) best = i;
  return [v[best], v[4 + best], v[8 + best], v[12 + best]];
}

export interface Superposition {
  /** Column-major 4x4 mapping mobile coordinates onto the reference. */
  transform: Float32Array;
  rmsd: number;
  pairsUsed: number;
  pairsConsidered: number;
}

/**
 * Optimal rigid transform taking `mobile` onto `reference`, via Horn's
 * quaternion method — no SVD, and reflections cannot sneak in.
 */
export function kabsch(
  reference: Float64Array, mobile: Float64Array, count: number,
): { transform: Float32Array; rmsd: number } {
  const transform = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  if (count < 3) return { transform, rmsd: Number.NaN };

  let rx = 0, ry = 0, rz = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < count; i++) {
    rx += reference[i * 3]; ry += reference[i * 3 + 1]; rz += reference[i * 3 + 2];
    mx += mobile[i * 3]; my += mobile[i * 3 + 1]; mz += mobile[i * 3 + 2];
  }
  rx /= count; ry /= count; rz /= count;
  mx /= count; my /= count; mz /= count;

  // Correlation matrix of the centred point sets.
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let i = 0; i < count; i++) {
    const ax = mobile[i * 3] - mx, ay = mobile[i * 3 + 1] - my, az = mobile[i * 3 + 2] - mz;
    const bx = reference[i * 3] - rx, by = reference[i * 3 + 1] - ry, bz = reference[i * 3 + 2] - rz;
    sxx += ax * bx; sxy += ax * by; sxz += ax * bz;
    syx += ay * bx; syy += ay * by; syz += ay * bz;
    szx += az * bx; szy += az * by; szz += az * bz;
  }

  const n = new Float64Array([
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ]);

  const [qw, qx, qy, qz] = largestEigenvector(n);
  const len = Math.hypot(qw, qx, qy, qz) || 1;
  const w = qw / len, x = qx / len, y = qy / len, z = qz / len;

  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - w * z);
  const r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);

  // Column-major: translation puts the rotated mobile centroid on the reference.
  transform[0] = r00; transform[1] = r10; transform[2] = r20; transform[3] = 0;
  transform[4] = r01; transform[5] = r11; transform[6] = r21; transform[7] = 0;
  transform[8] = r02; transform[9] = r12; transform[10] = r22; transform[11] = 0;
  transform[12] = rx - (r00 * mx + r01 * my + r02 * mz);
  transform[13] = ry - (r10 * mx + r11 * my + r12 * mz);
  transform[14] = rz - (r20 * mx + r21 * my + r22 * mz);
  transform[15] = 1;

  let sum = 0;
  for (let i = 0; i < count; i++) {
    const px = mobile[i * 3], py = mobile[i * 3 + 1], pz = mobile[i * 3 + 2];
    const tx = transform[0] * px + transform[4] * py + transform[8] * pz + transform[12];
    const ty = transform[1] * px + transform[5] * py + transform[9] * pz + transform[13];
    const tz = transform[2] * px + transform[6] * py + transform[10] * pz + transform[14];
    const dx = tx - reference[i * 3];
    const dy = ty - reference[i * 3 + 1];
    const dz = tz - reference[i * 3 + 2];
    sum += dx * dx + dy * dy + dz * dz;
  }

  return { transform, rmsd: Math.sqrt(sum / count) };
}

// ---------------------------------------------------------------------------
// Matchmaker
// ---------------------------------------------------------------------------

export interface SuperposeOptions {
  /** Pairs further apart than this are dropped between iterations. */
  cutoff?: number;
  iterations?: number;
}

export class AlignmentError extends Error {}

/**
 * Aligns two chains by sequence, then superposes and prunes until the fit
 * settles. Pruning is what separates "the two structures share a fold" from
 * "the loops dragged the answer sideways".
 */
export function superposeChains(
  referenceStructure: Structure, referenceChain: AlignableChain,
  mobileStructure: Structure, mobileChain: AlignableChain,
  options: SuperposeOptions = {},
): Superposition {
  const cutoff = options.cutoff ?? 2;
  const iterations = options.iterations ?? 5;

  const nucleic = referenceChain.kind === MolKind.Nucleic;
  const pairs = alignSequences(referenceChain.sequence, mobileChain.sequence, nucleic);
  if (pairs.length < 3) {
    throw new AlignmentError('The two chains have no usable sequence alignment');
  }

  let active = pairs;
  let result: { transform: Float32Array; rmsd: number } = {
    transform: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    rmsd: Number.NaN,
  };

  for (let iteration = 0; iteration < iterations; iteration++) {
    const count = active.length;
    if (count < 3) break;

    const ref = new Float64Array(count * 3);
    const mob = new Float64Array(count * 3);
    for (let i = 0; i < count; i++) {
      const ra = referenceChain.anchors[active[i][0]];
      const ma = mobileChain.anchors[active[i][1]];
      ref[i * 3] = referenceStructure.x[ra];
      ref[i * 3 + 1] = referenceStructure.y[ra];
      ref[i * 3 + 2] = referenceStructure.z[ra];
      mob[i * 3] = mobileStructure.x[ma];
      mob[i * 3 + 1] = mobileStructure.y[ma];
      mob[i * 3 + 2] = mobileStructure.z[ma];
    }

    result = kabsch(ref, mob, count);
    if (iteration === iterations - 1) break;

    // Prune the pairs that stayed far apart, but never below a usable core.
    const t = result.transform;
    const kept: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const px = mob[i * 3], py = mob[i * 3 + 1], pz = mob[i * 3 + 2];
      const tx = t[0] * px + t[4] * py + t[8] * pz + t[12];
      const ty = t[1] * px + t[5] * py + t[9] * pz + t[13];
      const tz = t[2] * px + t[6] * py + t[10] * pz + t[14];
      const d = Math.hypot(tx - ref[i * 3], ty - ref[i * 3 + 1], tz - ref[i * 3 + 2]);
      if (d <= cutoff) kept.push(active[i]);
    }

    if (kept.length < Math.max(3, active.length * 0.25) || kept.length === active.length) break;
    active = kept;
  }

  return {
    transform: result.transform,
    rmsd: result.rmsd,
    pairsUsed: active.length,
    pairsConsidered: pairs.length,
  };
}
