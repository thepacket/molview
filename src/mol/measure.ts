/**
 * Measurements: distances, angles, torsions, and hydrogen bonds.
 *
 * Everything here is geometry over atom positions. The hydrogen-bond finder is
 * the only part with real chemistry in it, and it is deliberately a geometric
 * approximation — see the note on its criteria below.
 */

import { atomNameOf, resNameOf, MolKind, type Structure } from './structure';

export type MeasurementKind = 'distance' | 'angle' | 'torsion';

export interface Measurement {
  id: string;
  kind: MeasurementKind;
  /** Two atoms for a distance, three for an angle, four for a torsion. */
  atoms: number[];
  /** Ångström for distances, degrees for angles and torsions. */
  value: number;
  label: string;
}

let nextMeasurementId = 1;

export function atomsNeeded(kind: MeasurementKind): number {
  return kind === 'distance' ? 2 : kind === 'angle' ? 3 : 4;
}

export function describeAtom(s: Structure, atom: number): string {
  const r = s.atomResidue[atom];
  const chain = s.chainAuthId[s.resChain[r]];
  return `${resNameOf(s, r)}${s.resSeq[r]}.${chain}:${atomNameOf(s, atom)}`;
}

function vector(s: Structure, a: number, b: number): [number, number, number] {
  return [s.x[b] - s.x[a], s.y[b] - s.y[a], s.z[b] - s.z[a]];
}

function cross(u: number[], v: number[]): [number, number, number] {
  return [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
}

function dot(u: number[], v: number[]): number {
  return u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
}

function length(u: number[]): number {
  return Math.hypot(u[0], u[1], u[2]);
}

export function distanceBetween(s: Structure, a: number, b: number): number {
  return length(vector(s, a, b));
}

export function angleBetween(s: Structure, a: number, b: number, c: number): number {
  const u = vector(s, b, a);
  const v = vector(s, b, c);
  const denom = length(u) * length(v);
  if (denom < 1e-6) return 0;
  return (Math.acos(Math.min(Math.max(dot(u, v) / denom, -1), 1)) * 180) / Math.PI;
}

/** Signed dihedral about the b–c bond, in degrees. */
export function torsionBetween(
  s: Structure, a: number, b: number, c: number, d: number,
): number {
  const b1 = vector(s, a, b);
  const b2 = vector(s, b, c);
  const b3 = vector(s, c, d);

  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  const m = cross(n1, b2.map((v) => v / (length(b2) || 1)) as number[]);

  const x = dot(n1, n2);
  const y = dot(m, n2);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function createMeasurement(
  s: Structure, kind: MeasurementKind, atoms: number[],
): Measurement {
  let value: number;
  let label: string;

  if (kind === 'distance') {
    value = distanceBetween(s, atoms[0], atoms[1]);
    label = `${value.toFixed(2)} A`;
  } else if (kind === 'angle') {
    value = angleBetween(s, atoms[0], atoms[1], atoms[2]);
    label = `${value.toFixed(1)}°`;
  } else {
    value = torsionBetween(s, atoms[0], atoms[1], atoms[2], atoms[3]);
    label = `${value.toFixed(1)}°`;
  }

  return { id: `m${nextMeasurementId++}`, kind, atoms: [...atoms], value, label };
}

/** Midpoint of a measurement's atoms — where its label goes. */
export function measurementAnchor(
  s: Structure, m: Measurement,
): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const a of m.atoms) {
    x += s.x[a]; y += s.y[a]; z += s.z[a];
  }
  const n = m.atoms.length;
  return [x / n, y / n, z / n];
}

// ---------------------------------------------------------------------------
// Hydrogen bonds
// ---------------------------------------------------------------------------

/**
 * Most PDB structures carry no hydrogens, so this uses the heavy-atom
 * criterion: a donor–acceptor pair within `maxDistance`, with the angle at the
 * donor's antecedent wide enough to be plausible. That is a geometric
 * approximation, not an energetic one — it will accept some pairs a proper
 * H-bond analysis would reject.
 */
export interface HydrogenBond {
  donor: number;
  acceptor: number;
  distance: number;
}

const DONORS = new Set(['N', 'O', 'S']);
const ACCEPTORS = new Set(['O', 'N', 'S']);

export interface HydrogenBondOptions {
  maxDistance?: number;
  /** Restrict to atoms in this mask, if given. */
  mask?: Uint8Array | null;
  /** Skip pairs inside the same residue. */
  excludeSameResidue?: boolean;
  limit?: number;
}

export function findHydrogenBonds(
  s: Structure, options: HydrogenBondOptions = {},
): HydrogenBond[] {
  const maxDistance = options.maxDistance ?? 3.3;
  const mask = options.mask ?? null;
  const excludeSameResidue = options.excludeSameResidue ?? true;
  const limit = options.limit ?? 4000;

  // Collect candidate polar atoms first; a spatial hash over just these is far
  // smaller than one over every atom.
  const candidates: number[] = [];
  for (let a = 0; a < s.atomCount; a++) {
    if (mask && !mask[a]) continue;
    const element = s.element[a];
    // 7 = N, 8 = O, 16 = S
    if (element !== 7 && element !== 8 && element !== 16) continue;
    candidates.push(a);
  }
  if (candidates.length === 0) return [];

  const cell = maxDistance;
  const inv = 1 / cell;
  const buckets = new Map<number, number[]>();
  const key = (gx: number, gy: number, gz: number) =>
    (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);

  for (const a of candidates) {
    const gx = Math.floor(s.x[a] * inv);
    const gy = Math.floor(s.y[a] * inv);
    const gz = Math.floor(s.z[a] * inv);
    const k = key(gx, gy, gz);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(a);
    else buckets.set(k, [a]);
  }

  const out: HydrogenBond[] = [];
  const maxSq = maxDistance * maxDistance;

  for (const a of candidates) {
    const gx = Math.floor(s.x[a] * inv);
    const gy = Math.floor(s.y[a] * inv);
    const gz = Math.floor(s.z[a] * inv);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = buckets.get(key(gx + dx, gy + dy, gz + dz));
          if (!bucket) continue;
          for (const b of bucket) {
            if (b <= a) continue;
            if (excludeSameResidue && s.atomResidue[a] === s.atomResidue[b]) continue;

            const ddx = s.x[a] - s.x[b];
            const ddy = s.y[a] - s.y[b];
            const ddz = s.z[a] - s.z[b];
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 > maxSq || d2 < 4) continue; // < 2 A is a covalent bond

            const nameA = atomNameOf(s, a).charAt(0).toUpperCase();
            const nameB = atomNameOf(s, b).charAt(0).toUpperCase();
            // At least one side has to be a plausible donor and the other an
            // acceptor; carbon-only pairs are contacts, not H-bonds.
            const forward = DONORS.has(nameA) && ACCEPTORS.has(nameB);
            const backward = DONORS.has(nameB) && ACCEPTORS.has(nameA);
            if (!forward && !backward) continue;

            // Waters bridge everything; keeping them would bury the result.
            const kindA = s.resKind[s.atomResidue[a]];
            const kindB = s.resKind[s.atomResidue[b]];
            if (kindA === MolKind.Water && kindB === MolKind.Water) continue;

            out.push({ donor: a, acceptor: b, distance: Math.sqrt(d2) });
            if (out.length >= limit) return out;
          }
        }
      }
    }
  }

  return out;
}
