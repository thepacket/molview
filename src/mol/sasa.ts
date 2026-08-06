/**
 * Solvent-accessible surface area, by Shrake and Rupley.
 *
 * Points are scattered evenly over a sphere of van der Waals radius plus a
 * probe around each atom, and the fraction that no other atom's sphere covers
 * is the accessible fraction. It is the 1973 method and it is still what
 * everyone means by SASA; the alternative — Lee and Richards' slicing — costs
 * more and agrees to within a per cent.
 *
 * The number this exists to produce is the *change* in it. An interface's area
 * is what stops being solvent-accessible when two chains come together, which
 * is the quantity papers quote and which a contact count only approximates: two
 * pairs with the same number of close contacts can bury areas that differ
 * threefold, because one is a flat patch and the other is a knob in a socket.
 */

import { VDW_RADII } from './elements';
import { MolKind, type Structure } from './structure';

/** A water molecule, and the conventional probe. */
export const PROBE_RADIUS = 1.4;

/**
 * Points per atom. Shrake and Rupley used 92; the error against a dense
 * reference falls roughly as 1/sqrt(n), and 200 puts it well under a per cent
 * without making an interface calculation something you wait for.
 */
const DEFAULT_POINTS = 200;

/** Evenly spread points on a unit sphere — the Fibonacci spiral. */
function spherePoints(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * i) / (count - 1);
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out[i * 3] = Math.cos(theta) * radius;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(theta) * radius;
  }
  return out;
}

/**
 * Occluding spheres that are not atoms of the structure.
 *
 * A crystal contact has one side that exists only as a matrix: the partner is
 * the deposited chain moved by a symmetry operator, and nothing in the file
 * holds those coordinates. They block the probe exactly as atoms do, and they
 * are never measured themselves.
 */
export interface OccluderSpheres {
  /** x, y, z triples. */
  xyz: Float32Array;
  /** Van der Waals radius per sphere; the probe is added here, not by caller. */
  radius: Float32Array;
}

export interface SasaOptions {
  /** Atoms to compute an area for. Others get 0. */
  atoms: Uint8Array;
  /**
   * Atoms that block the probe. Usually the same set, or a larger one: the
   * difference between the two is exactly how an interface is measured — the
   * same chain, alone and then in company.
   */
  occluders?: Uint8Array;
  /** Extra blockers with no atom number — see OccluderSpheres. */
  extra?: OccluderSpheres | null;
  probe?: number;
  points?: number;
}

/**
 * Per-atom accessible area in Å². Atoms outside `atoms` come back as zero, so
 * the caller can sum the whole array.
 */
export function atomSasa(s: Structure, options: SasaOptions): Float32Array {
  const probe = options.probe ?? PROBE_RADIUS;
  const occluders = options.occluders ?? options.atoms;
  const sphere = spherePoints(options.points ?? DEFAULT_POINTS);
  const pointCount = sphere.length / 3;
  const out = new Float32Array(s.atomCount);

  // One compact list of occluding spheres: the structure's own, then any
  // transformed copies. Compacting rather than indexing by atom number is what
  // lets the copies take part at all — they have no atom number to be indexed
  // by — and it keeps the inner loop dense as a side effect.
  const extra = options.extra ?? null;
  const extraCount = extra ? extra.radius.length : 0;
  let ownCount = 0;
  for (let a = 0; a < s.atomCount; a++) if (occluders[a]) ownCount++;

  const n = ownCount + extraCount;
  const ox = new Float32Array(n);
  const oy = new Float32Array(n);
  const oz = new Float32Array(n);
  const radii = new Float32Array(n);
  /** Atom behind each sphere, -1 for a copy. Only used to skip self. */
  const owner = new Int32Array(n).fill(-1);

  let maxRadius = 0;
  let w = 0;
  for (let a = 0; a < s.atomCount; a++) {
    if (!occluders[a]) continue;
    ox[w] = s.x[a]; oy[w] = s.y[a]; oz[w] = s.z[a];
    radii[w] = VDW_RADII[s.element[a]] + probe;
    owner[w] = a;
    if (radii[w] > maxRadius) maxRadius = radii[w];
    w++;
  }
  for (let i = 0; i < extraCount; i++) {
    ox[w] = extra!.xyz[i * 3];
    oy[w] = extra!.xyz[i * 3 + 1];
    oz[w] = extra!.xyz[i * 3 + 2];
    radii[w] = extra!.radius[i] + probe;
    if (radii[w] > maxRadius) maxRadius = radii[w];
    w++;
  }

  // Spatial hash over the occluders. The cell is the largest reach any pair can
  // have, so a neighbour that could possibly overlap is always within one cell.
  const cell = Math.max(maxRadius * 2, 1);
  const buckets = new Map<number, number[]>();
  const key = (gx: number, gy: number, gz: number) =>
    (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);

  for (let i = 0; i < n; i++) {
    const k = key(
      Math.floor(ox[i] / cell), Math.floor(oy[i] / cell), Math.floor(oz[i] / cell),
    );
    const bucket = buckets.get(k);
    if (bucket) bucket.push(i);
    else buckets.set(k, [i]);
  }

  const neighbours: number[] = [];
  for (let a = 0; a < s.atomCount; a++) {
    if (!options.atoms[a]) continue;
    const ra = VDW_RADII[s.element[a]] + probe;
    const ax = s.x[a], ay = s.y[a], az = s.z[a];

    neighbours.length = 0;
    const gx = Math.floor(ax / cell), gy = Math.floor(ay / cell), gz = Math.floor(az / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = buckets.get(key(gx + dx, gy + dy, gz + dz));
          if (!bucket) continue;
          for (const b of bucket) {
            if (owner[b] === a) continue;
            const reach = ra + radii[b];
            const ddx = ox[b] - ax, ddy = oy[b] - ay, ddz = oz[b] - az;
            if (ddx * ddx + ddy * ddy + ddz * ddz < reach * reach) neighbours.push(b);
          }
        }
      }
    }

    let accessible = 0;
    for (let p = 0; p < pointCount; p++) {
      const px = ax + sphere[p * 3] * ra;
      const py = ay + sphere[p * 3 + 1] * ra;
      const pz = az + sphere[p * 3 + 2] * ra;
      let covered = false;
      for (const b of neighbours) {
        const ddx = px - ox[b], ddy = py - oy[b], ddz = pz - oz[b];
        if (ddx * ddx + ddy * ddy + ddz * ddz < radii[b] * radii[b]) { covered = true; break; }
      }
      if (!covered) accessible++;
    }

    out[a] = 4 * Math.PI * ra * ra * (accessible / pointCount);
  }

  return out;
}

function total(values: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum;
}

/**
 * The area buried when two atom sets come together, in Å².
 *
 * Reported as the interface area — half the total change — which is the
 * convention PISA and most papers use: the two sides bury roughly the same
 * amount, and quoting the sum makes an interface sound twice its usual size.
 */
export function interfaceArea(
  s: Structure, a: Uint8Array, b: Uint8Array, points?: number,
): number {
  const both = new Uint8Array(s.atomCount);
  for (let i = 0; i < both.length; i++) both[i] = a[i] || b[i] ? 1 : 0;

  const aAlone = total(atomSasa(s, { atoms: a, occluders: a, points }));
  const bAlone = total(atomSasa(s, { atoms: b, occluders: b, points }));
  const aTogether = total(atomSasa(s, { atoms: a, occluders: both, points }));
  const bTogether = total(atomSasa(s, { atoms: b, occluders: both, points }));

  return Math.max(0, (aAlone - aTogether + bAlone - bTogether) / 2);
}

/**
 * A set of atoms moved by an assembly operator, as bare spheres.
 *
 * Column-major 4x4 at `offset`, the same layout the assembly generators and
 * the renderer's instance matrices use.
 */
export function transformedSpheres(
  s: Structure, atoms: Uint8Array, m: Float32Array, offset: number,
): OccluderSpheres {
  let count = 0;
  for (let a = 0; a < s.atomCount; a++) if (atoms[a]) count++;

  const xyz = new Float32Array(count * 3);
  const radius = new Float32Array(count);
  const o = offset;
  let w = 0;
  for (let a = 0; a < s.atomCount; a++) {
    if (!atoms[a]) continue;
    const x = s.x[a], y = s.y[a], z = s.z[a];
    xyz[w * 3] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
    xyz[w * 3 + 1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
    xyz[w * 3 + 2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
    radius[w] = VDW_RADII[s.element[a]];
    w++;
  }
  return { xyz, radius };
}

/**
 * The inverse of a rigid operator, or null if it is not rigid.
 *
 * Needed because a crystal contact has to be measured from both sides and only
 * one of them is in the file. Chain A meets a copy T(B); the same lattice also
 * puts a copy T⁻¹(A) against the deposited B, and that arrangement is congruent
 * to the first, so the far half of the area can be measured on real
 * coordinates instead of transformed ones.
 *
 * Assembly operators are rotations and translations, so transposing the
 * rotation is the whole inverse. The check is not ceremony: a generator that
 * carried a scale or a shear would make the transpose silently wrong, and the
 * area would come back plausible rather than absent.
 */
export function invertRigid(m: Float32Array, offset: number): Float32Array | null {
  const o = offset;
  const col = (j: number): [number, number, number] => [m[o + j * 4], m[o + j * 4 + 1], m[o + j * 4 + 2]];
  const dot = (a: [number, number, number], b: [number, number, number]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const c0 = col(0), c1 = col(1), c2 = col(2);
  const orthonormal = Math.abs(dot(c0, c0) - 1) < 1e-3
    && Math.abs(dot(c1, c1) - 1) < 1e-3
    && Math.abs(dot(c2, c2) - 1) < 1e-3
    && Math.abs(dot(c0, c1)) < 1e-3
    && Math.abs(dot(c0, c2)) < 1e-3
    && Math.abs(dot(c1, c2)) < 1e-3;
  if (!orthonormal) return null;

  const out = new Float32Array(16);
  // Transposing the rotation in place: element (i,j) of the inverse is element
  // (j,i) of the original, and the layout is the same on both sides.
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[j * 4 + i] = m[o + i * 4 + j];
  }
  const t0 = m[o + 12], t1 = m[o + 13], t2 = m[o + 14];
  out[12] = -dot(c0, [t0, t1, t2]);
  out[13] = -dot(c1, [t0, t1, t2]);
  out[14] = -dot(c2, [t0, t1, t2]);
  out[15] = 1;
  return out;
}

/**
 * The area buried between a deposited chain and a symmetry copy of another, in
 * Å², or null if the operator is not rigid.
 *
 * The near half is direct: chain A alone, then A with the copy's spheres in the
 * way. The far half cannot be — the copy is not in the file and has no atoms to
 * measure — so it is measured on its congruent twin instead, chain B against a
 * copy of A moved by the inverse operator. Halved like any interface, for the
 * same reason.
 *
 * `a` alone and `b` alone need no operator at all: SASA is invariant under a
 * rigid motion, so a chain buries the same area whichever copy of it you ask.
 */
export function symmetryInterfaceArea(
  s: Structure, a: Uint8Array, b: Uint8Array,
  m: Float32Array, offset: number, points?: number,
): number | null {
  const inverse = invertRigid(m, offset);
  if (!inverse) return null;

  const copyOfB = transformedSpheres(s, b, m, offset);
  const copyOfA = transformedSpheres(s, a, inverse, 0);

  const aAlone = total(atomSasa(s, { atoms: a, occluders: a, points }));
  const bAlone = total(atomSasa(s, { atoms: b, occluders: b, points }));
  const aTogether = total(atomSasa(s, { atoms: a, occluders: a, extra: copyOfB, points }));
  const bTogether = total(atomSasa(s, { atoms: b, occluders: b, extra: copyOfA, points }));

  return Math.max(0, (aAlone - aTogether + bAlone - bTogether) / 2);
}

/** Heavy, non-water atoms of a chain — what an area calculation should see. */
export function chainAtoms(s: Structure, authId: string, mask?: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(s.atomCount);
  for (let a = 0; a < s.atomCount; a++) {
    if (mask && !mask[a]) continue;
    if (s.element[a] === 1) continue;
    const residue = s.atomResidue[a];
    // Water is not part of a chain's surface in any sense that helps here; it
    // would sit in the interface and pretend to be buried by it.
    if (s.resKind[residue] === MolKind.Water) continue;
    if (s.chainAuthId[s.resChain[residue]] !== authId) continue;
    out[a] = 1;
  }
  return out;
}
