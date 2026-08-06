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

export interface SasaOptions {
  /** Atoms to compute an area for. Others get 0. */
  atoms: Uint8Array;
  /**
   * Atoms that block the probe. Usually the same set, or a larger one: the
   * difference between the two is exactly how an interface is measured — the
   * same chain, alone and then in company.
   */
  occluders?: Uint8Array;
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

  const radii = new Float32Array(s.atomCount);
  let maxRadius = 0;
  for (let a = 0; a < s.atomCount; a++) {
    if (!occluders[a]) continue;
    radii[a] = VDW_RADII[s.element[a]] + probe;
    if (radii[a] > maxRadius) maxRadius = radii[a];
  }

  // Spatial hash over the occluders. The cell is the largest reach any pair can
  // have, so a neighbour that could possibly overlap is always within one cell.
  const cell = Math.max(maxRadius * 2, 1);
  const buckets = new Map<number, number[]>();
  const key = (gx: number, gy: number, gz: number) =>
    (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);

  for (let a = 0; a < s.atomCount; a++) {
    if (!occluders[a]) continue;
    const k = key(
      Math.floor(s.x[a] / cell), Math.floor(s.y[a] / cell), Math.floor(s.z[a] / cell),
    );
    const bucket = buckets.get(k);
    if (bucket) bucket.push(a);
    else buckets.set(k, [a]);
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
            if (b === a) continue;
            const reach = ra + radii[b];
            const ddx = s.x[b] - ax, ddy = s.y[b] - ay, ddz = s.z[b] - az;
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
        const ddx = px - s.x[b], ddy = py - s.y[b], ddz = pz - s.z[b];
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
