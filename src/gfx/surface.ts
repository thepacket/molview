/**
 * Molecular surfaces, as a Gaussian density field the marching cubes already
 * knows how to contour.
 *
 * The field is Blinn's sum of atom-centred Gaussians, in the form Mol* uses:
 * each atom contributes `exp(-smoothness * d² / r²)`, so at exactly one radius
 * from a lone atom the field equals `exp(-smoothness)`. Contour there and an
 * isolated atom comes out as a sphere of exactly its radius, while overlapping
 * atoms merge into the smooth envelope that reads as a surface. One number,
 * `smoothness`, then controls how far apart two atoms have to be before the
 * surface pinches between them.
 *
 * This is a Gaussian surface, not a solvent-excluded one. It has no rolling
 * probe, so it does not reproduce the re-entrant saddles of a true SES; adding
 * the probe radius to every atom gives the same overall envelope and the same
 * answer to the question people actually ask a surface, which is what shape
 * this molecule presents to the world.
 *
 * The output is a `VolumeGrid` with mean 0 and sigma 1, so a "sigma" contour
 * passed to `isosurface` is an absolute field value. That is a small abuse of
 * a type meant for experimental maps, and it buys the entire contouring,
 * wireframe, transparency and colour path for nothing.
 */

import type { VolumeGrid } from '../rcsb/volume';
import { ISOSURFACE_STRIDE } from './isosurface';
import { MolKind, type Structure } from '../mol/structure';

export interface SurfaceOptions {
  /** Added to every van der Waals radius; 1.4 Å is a water molecule. */
  probeRadius: number;
  /** Higher pinches the surface between atoms; lower inflates and merges it. */
  smoothness: number;
  /** Å between samples. Raised automatically when the grid would be too large. */
  resolution: number;
  /** Packed 0xRRGGBB per atom, or null for an untinted surface. */
  atomColors?: Uint32Array | null;
}

export const DEFAULT_SURFACE_OPTIONS: SurfaceOptions = {
  probeRadius: 1.4,
  smoothness: 1.5,
  resolution: 0.6,
};

export interface SurfaceField {
  grid: VolumeGrid;
  /** Contour here for a surface at the requested radii. */
  level: number;
  /** Atom dominating the field at each sample, or -1 where nothing reaches. */
  owner: Int32Array;
  /** Three floats per atom, indexed by `owner`. Null when no colours were given. */
  colors: Float32Array | null;
  /** The spacing actually used, which may be coarser than asked for. */
  resolution: number;
}

/**
 * Sampling a 900 Å capsid at 0.6 Å would be three billion points. The budget
 * is what turns "too big" into "coarser" rather than into a crash, and the
 * panel reports the spacing that came out.
 */
const MAX_SAMPLES = 24_000_000;

/**
 * Beyond this many radii the Gaussian is under a thousandth of the contour
 * level and cannot move it. Truncating there is what makes the accumulation
 * linear in atoms rather than in atoms times grid points.
 */
const CUTOFF_SIGMAS = 2.5;

export function gaussianSurface(
  x: Float32Array,
  y: Float32Array,
  z: Float32Array,
  radii: Float32Array,
  atoms: Int32Array,
  options: SurfaceOptions,
): SurfaceField {
  const { probeRadius, smoothness } = options;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let maxRadius = 0;
  for (const a of atoms) {
    if (x[a] < minX) minX = x[a];
    if (x[a] > maxX) maxX = x[a];
    if (y[a] < minY) minY = y[a];
    if (y[a] > maxY) maxY = y[a];
    if (z[a] < minZ) minZ = z[a];
    if (z[a] > maxZ) maxZ = z[a];
    const r = radii[a] + probeRadius;
    if (r > maxRadius) maxRadius = r;
  }
  if (!Number.isFinite(minX)) {
    throw new Error('No atoms to build a surface from.');
  }

  // Pad by the reach of the widest atom so the surface closes rather than
  // being cut off flat against the edge of the grid.
  const pad = maxRadius * CUTOFF_SIGMAS + 1;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const spanX = maxX - minX, spanY = maxY - minY, spanZ = maxZ - minZ;
  let step = options.resolution;
  const wanted = (spanX / step) * (spanY / step) * (spanZ / step);
  if (wanted > MAX_SAMPLES) step *= Math.cbrt(wanted / MAX_SAMPLES);

  const nx = Math.max(2, Math.ceil(spanX / step) + 1);
  const ny = Math.max(2, Math.ceil(spanY / step) + 1);
  const nz = Math.max(2, Math.ceil(spanZ / step) + 1);
  const total = nx * ny * nz;

  const values = new Float32Array(total);
  const owner = new Int32Array(total).fill(-1);
  // The strongest contribution so far at each point, so `owner` ends up naming
  // the atom the surface there actually belongs to rather than the last one
  // that happened to touch it.
  const best = new Float32Array(total);

  for (const a of atoms) {
    const radius = radii[a] + probeRadius;
    const alpha = smoothness / (radius * radius);
    const cutoff = radius * CUTOFF_SIGMAS;
    const cutoffSq = cutoff * cutoff;

    const i0 = Math.max(0, Math.floor((x[a] - cutoff - minX) / step));
    const i1 = Math.min(nx - 1, Math.ceil((x[a] + cutoff - minX) / step));
    const j0 = Math.max(0, Math.floor((y[a] - cutoff - minY) / step));
    const j1 = Math.min(ny - 1, Math.ceil((y[a] + cutoff - minY) / step));
    const k0 = Math.max(0, Math.floor((z[a] - cutoff - minZ) / step));
    const k1 = Math.min(nz - 1, Math.ceil((z[a] + cutoff - minZ) / step));

    for (let k = k0; k <= k1; k++) {
      const dz = minZ + k * step - z[a];
      const dz2 = dz * dz;
      if (dz2 > cutoffSq) continue;
      for (let j = j0; j <= j1; j++) {
        const dy = minY + j * step - y[a];
        const dyz2 = dz2 + dy * dy;
        if (dyz2 > cutoffSq) continue;
        const row = nx * (j + ny * k);
        for (let i = i0; i <= i1; i++) {
          const dx = minX + i * step - x[a];
          const d2 = dyz2 + dx * dx;
          if (d2 > cutoffSq) continue;
          const contribution = Math.exp(-alpha * d2);
          const index = i + row;
          values[index] += contribution;
          if (contribution > best[index]) {
            best[index] = contribution;
            owner[index] = a;
          }
        }
      }
    }
  }

  const grid: VolumeGrid = {
    name: 'surface',
    values,
    counts: [nx, ny, nz],
    origin: Float32Array.from([minX, minY, minZ]),
    stepA: Float32Array.from([step, 0, 0]),
    stepB: Float32Array.from([0, step, 0]),
    stepC: Float32Array.from([0, 0, step]),
    // Field values are absolute, so a caller's "sigma" is the level itself.
    mean: 0,
    sigma: 1,
    min: 0,
    max: 1,
  };

  return {
    grid,
    level: Math.exp(-smoothness),
    owner,
    colors: options.atomColors ? unpackColors(options.atomColors) : null,
    resolution: step,
  };
}

function unpackColors(packed: Uint32Array): Float32Array {
  const out = new Float32Array(packed.length * 3);
  for (let i = 0; i < packed.length; i++) {
    const c = packed[i];
    out[i * 3] = ((c >> 16) & 0xff) / 255;
    out[i * 3 + 1] = ((c >> 8) & 0xff) / 255;
    out[i * 3 + 2] = (c & 0xff) / 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coulombic potential
// ---------------------------------------------------------------------------

/**
 * A deliberately small charge model: the ionisable groups, the termini, the
 * nucleic acid phosphates and the ions.
 *
 * Not Amber, not any published force field, and the naming says Coulombic
 * everywhere rather than "electrostatics" for that reason. A full partial-charge
 * set would put a tenth of an electron on every backbone carbonyl and change
 * the picture very little: what a Coulombic surface is read for is the gross
 * character — which face is acidic, which groove is positive, whether a
 * DNA-binding surface looks like one — and that is carried almost entirely by
 * the formal charges below.
 *
 * A Poisson-Boltzmann solve is a different thing and is not attempted. It
 * would account for solvent screening and ionic strength, which this does not.
 */
const SIDE_CHAIN_CHARGES: Record<string, Record<string, number>> = {
  ASP: { OD1: -0.5, OD2: -0.5 },
  GLU: { OE1: -0.5, OE2: -0.5 },
  LYS: { NZ: 1 },
  ARG: { NH1: 0.5, NH2: 0.5 },
  // Mostly neutral at pH 7, but not nothing, and it matters at an active site.
  HIS: { ND1: 0.1, NE2: 0.1 },
  // Phosphate backbone: the dominant charge in any nucleic acid, and leaving
  // it out makes DNA look uncharged, which is the opposite of the truth.
  A: PHOSPHATE(), C: PHOSPHATE(), G: PHOSPHATE(), U: PHOSPHATE(),
  DA: PHOSPHATE(), DC: PHOSPHATE(), DG: PHOSPHATE(), DT: PHOSPHATE(),
};

function PHOSPHATE(): Record<string, number> {
  return { OP1: -0.5, OP2: -0.5, 'O1P': -0.5, 'O2P': -0.5 };
}

/** Formal charges of the ions that turn up as single-atom residues. */
const ION_CHARGES: Record<string, number> = {
  NA: 1, K: 1, LI: 1, CS: 1, RB: 1,
  MG: 2, CA: 2, ZN: 2, MN: 2, NI: 2, CO: 2, CU: 2, CD: 2, SR: 2, BA: 2,
  FE: 2, FE2: 2, FE3: 3, AL: 3,
  CL: -1, BR: -1, IOD: -1, F: -1,
};

export interface PointCharges {
  positions: Float32Array;
  values: Float32Array;
}

export function chargesOf(
  s: Structure, atoms: Int32Array,
): PointCharges {
  const positions: number[] = [];
  const values: number[] = [];
  const included = new Uint8Array(s.atomCount);
  for (const a of atoms) included[a] = 1;

  // Termini need the first and last modelled residue of each chain, which is
  // not the same as the first and last atom of the structure.
  const chainEnds = new Set<number>();
  for (let c = 0; c < s.chainCount; c++) {
    chainEnds.add(s.chainResStart[c]);
    chainEnds.add(s.chainResStart[c + 1] - 1);
  }

  for (let r = 0; r < s.residueCount; r++) {
    const name = s.nameTable[s.resNameId[r]];
    const table = SIDE_CHAIN_CHARGES[name];
    const kind = s.resKind[r];
    const isTerminus = chainEnds.has(r)
      && (kind === MolKind.Protein || kind === MolKind.Nucleic);

    for (let a = s.resAtomStart[r]; a < s.resAtomStart[r + 1]; a++) {
      if (!included[a]) continue;
      const atomName = s.nameTable[s.atomNameId[a]];
      let q = table?.[atomName] ?? 0;

      if (kind === MolKind.Ion) q += ION_CHARGES[name.toUpperCase()] ?? 0;
      if (isTerminus && kind === MolKind.Protein) {
        if (atomName === 'N' && r === s.chainResStart[s.resChain[r]]) q += 1;
        if (atomName === 'OXT') q -= 0.5;
        if (atomName === 'O' && r === s.chainResStart[s.resChain[r] + 1] - 1) q -= 0.5;
      }

      if (q === 0) continue;
      positions.push(s.x[a], s.y[a], s.z[a]);
      values.push(q);
    }
  }

  return { positions: Float32Array.from(positions), values: Float32Array.from(values) };
}

/** Beyond this a charge contributes under a per cent of the strongest term. */
const CHARGE_CUTOFF = 20;

/**
 * Recolours a surface mesh by the Coulombic potential at each vertex.
 *
 * Distance-dependent dielectric, ε(r) = 4r, which is the usual cheap stand-in
 * for solvent screening and is what makes the falloff 1/r² rather than 1/r.
 * The scale is symmetric about zero and fixed rather than normalised per
 * structure, so blue means the same thing on two proteins — the same argument
 * as every other ramp here.
 */
export function colorSurfaceByPotential(
  vertices: Float32Array,
  charges: PointCharges,
  scale = 8,
): void {
  const count = charges.values.length;
  if (count === 0) return;

  // Hash the charges: a protein has a few hundred, a nucleosome a few thousand,
  // and a surface has hundreds of thousands of vertices.
  const cell = CHARGE_CUTOFF;
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number, k: number) =>
    (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let i = 0; i < count; i++) {
    const k = key(
      Math.floor(charges.positions[i * 3] / cell),
      Math.floor(charges.positions[i * 3 + 1] / cell),
      Math.floor(charges.positions[i * 3 + 2] / cell),
    );
    const bucket = buckets.get(k);
    if (bucket) bucket.push(i);
    else buckets.set(k, [i]);
  }

  const cutoffSq = CHARGE_CUTOFF * CHARGE_CUTOFF;
  for (let v = 0; v < vertices.length; v += ISOSURFACE_STRIDE) {
    const x = vertices[v], y = vertices[v + 1], z = vertices[v + 2];
    let potential = 0;

    const gi = Math.floor(x / cell), gj = Math.floor(y / cell), gk = Math.floor(z / cell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          const bucket = buckets.get(key(gi + di, gj + dj, gk + dk));
          if (!bucket) continue;
          for (const i of bucket) {
            const dx = charges.positions[i * 3] - x;
            const dy = charges.positions[i * 3 + 1] - y;
            const dz = charges.positions[i * 3 + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > cutoffSq) continue;
            // 332 converts e²/Å to kcal/mol; the 4r dielectric makes it 1/r².
            potential += (332 * charges.values[i]) / (4 * Math.max(d2, 1));
          }
        }
      }
    }

    const t = Math.min(Math.max(potential / scale, -1), 1);
    // Red negative, white neutral, blue positive — the convention everywhere,
    // and reversing it would be actively misleading.
    const [r, g, b] = t < 0
      ? [1, 1 + t * 0.75, 1 + t * 0.85]
      : [1 - t * 0.85, 1 - t * 0.55, 1];
    vertices[v + 6] = r;
    vertices[v + 7] = g;
    vertices[v + 8] = b;
  }
}
