/**
 * CPU-side geometry generation.
 *
 * Atoms and bonds become GPU instance data (impostor spheres, instanced
 * cylinders). Cartoons become a real triangle mesh, because a swept ribbon
 * with per-residue cross-sections has no impostor formulation.
 */

import type { BondList } from '../mol/bonds';
import { VDW_RADII } from '../mol/elements';
import { MolKind, SS, type Structure } from '../mol/structure';
import type { ColorProvider } from '../mol/coloring';

export type PolymerStyle = 'cartoon' | 'backbone' | 'ball-stick' | 'spacefill' | 'licorice' | 'none';
export type LigandStyle = 'ball-stick' | 'spacefill' | 'licorice' | 'none';

export interface Representation {
  polymer: PolymerStyle;
  ligand: LigandStyle;
  showWater: boolean;
  showIons: boolean;
  showHydrogens: boolean;
  /** 0.25 – 2.0; scales atom radii in ball-and-stick / licorice. */
  atomScale: number;
  bondRadius: number;
  /** Chains hidden by the user, by auth id. */
  hiddenChains: ReadonlySet<string>;
}

export const DEFAULT_REPRESENTATION: Representation = {
  polymer: 'cartoon',
  ligand: 'ball-stick',
  showWater: false,
  showIons: true,
  showHydrogens: false,
  atomScale: 1,
  bondRadius: 0.16,
  hiddenChains: new Set(),
};

export const SPHERE_STRIDE = 8; // pos(3) radius(1) color(3) pick(1)
export const CYLINDER_STRIDE = 12; // a(3) radius(1) b(3) pick(1) color(3) pad(1)
export const CARTOON_STRIDE = 9; // pos(3) normal(3) color(3)

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
}

export interface SceneGeometry {
  spheres: Float32Array;
  sphereCount: number;
  cylinders: Float32Array;
  cylinderCount: number;
  cartoon: MeshData | null;
  /** Bounds of everything actually drawn, for framing. */
  center: Float32Array;
  radius: number;
}

const HYDROGEN = 1;

function chainVisible(s: Structure, chain: number, rep: Representation): boolean {
  return !rep.hiddenChains.has(s.chainAuthId[chain]);
}

/** Which style applies to a residue, given its kind. */
function styleFor(kind: number, rep: Representation): PolymerStyle | LigandStyle | 'none' {
  switch (kind) {
    case MolKind.Protein:
    case MolKind.Nucleic:
      return rep.polymer;
    case MolKind.Water:
      return rep.showWater ? 'ball-stick' : 'none';
    case MolKind.Ion:
      return rep.showIons ? 'spacefill' : 'none';
    default:
      return rep.ligand;
  }
}

/**
 * A residue drawn as a cartoon still contributes no atoms — except that
 * nucleic bases read as bare tubes without them, so nucleic side atoms stay.
 */
function atomRadius(
  style: string, element: number, rep: Representation,
): number {
  switch (style) {
    case 'spacefill': return VDW_RADII[element];
    case 'ball-stick': return VDW_RADII[element] * 0.25 * rep.atomScale;
    case 'licorice': return rep.bondRadius * rep.atomScale;
    default: return 0;
  }
}

export function buildGeometry(
  s: Structure,
  colors: ColorProvider,
  rep: Representation,
  ligandBonds: BondList,
  allBonds: BondList | null,
): SceneGeometry {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const grow = (x: number, y: number, z: number, r: number) => {
    if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
    if (z - r < minZ) minZ = z - r; if (z + r > maxZ) maxZ = z + r;
  };

  // Pass 1: decide what is drawn and how big the buffers need to be. A
  // spacefill capsid is 2.4 million atoms; growing a JS array to hold that
  // costs more than the rest of the build put together.
  const drawAtom = new Uint8Array(s.atomCount);
  const atomRadii = new Float32Array(s.atomCount);
  let sphereCount = 0;

  for (let r = 0; r < s.residueCount; r++) {
    if (!chainVisible(s, s.resChain[r], rep)) continue;

    const kind = s.resKind[r];
    const style = styleFor(kind, rep);
    if (style === 'none') continue;

    const isPolymer = kind === MolKind.Protein || kind === MolKind.Nucleic;
    // Cartoon and backbone replace the atoms entirely.
    if (isPolymer && (style === 'cartoon' || style === 'backbone')) continue;

    for (let a = s.resAtomStart[r], end = s.resAtomStart[r + 1]; a < end; a++) {
      if (!rep.showHydrogens && s.element[a] === HYDROGEN) continue;
      drawAtom[a] = 1;
      const radius = atomRadius(style, s.element[a], rep);
      atomRadii[a] = radius;
      if (radius > 0) sphereCount++;
    }
  }

  const spheres = new Float32Array(sphereCount * SPHERE_STRIDE);
  let so = 0;
  for (let a = 0; a < s.atomCount; a++) {
    const radius = atomRadii[a];
    if (!drawAtom[a] || radius <= 0) continue;
    const c = colors.atom(a);
    const x = s.x[a], y = s.y[a], z = s.z[a];
    spheres[so] = x; spheres[so + 1] = y; spheres[so + 2] = z; spheres[so + 3] = radius;
    spheres[so + 4] = ((c >> 16) & 0xff) / 255;
    spheres[so + 5] = ((c >> 8) & 0xff) / 255;
    spheres[so + 6] = (c & 0xff) / 255;
    spheres[so + 7] = s.atomResidue[a];
    so += SPHERE_STRIDE;
    grow(x, y, z, radius);
  }

  // ---- bonds ----
  const wantsSticks = rep.polymer === 'ball-stick' || rep.polymer === 'licorice'
    || rep.ligand === 'ball-stick' || rep.ligand === 'licorice' || rep.showWater;
  const bondSource = allBonds ?? ligandBonds;

  let bondCount = 0;
  if (wantsSticks) {
    for (let i = 0; i < bondSource.count; i++) {
      if (drawAtom[bondSource.indices[i * 2]] && drawAtom[bondSource.indices[i * 2 + 1]]) {
        bondCount++;
      }
    }
  }

  // Two half-cylinders per bond, so each half can carry its atom's colour.
  const cylinders = new Float32Array(bondCount * 2 * CYLINDER_STRIDE);
  let co = 0;
  if (bondCount > 0) {
    const radius = rep.bondRadius * rep.atomScale;
    for (let i = 0; i < bondSource.count; i++) {
      const a = bondSource.indices[i * 2];
      const b = bondSource.indices[i * 2 + 1];
      if (!drawAtom[a] || !drawAtom[b]) continue;

      const ax = s.x[a], ay = s.y[a], az = s.z[a];
      const bx = s.x[b], by = s.y[b], bz = s.z[b];
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;

      const ca = colors.atom(a);
      cylinders[co] = ax; cylinders[co + 1] = ay; cylinders[co + 2] = az;
      cylinders[co + 3] = radius;
      cylinders[co + 4] = mx; cylinders[co + 5] = my; cylinders[co + 6] = mz;
      cylinders[co + 7] = s.atomResidue[a];
      cylinders[co + 8] = ((ca >> 16) & 0xff) / 255;
      cylinders[co + 9] = ((ca >> 8) & 0xff) / 255;
      cylinders[co + 10] = (ca & 0xff) / 255;
      co += CYLINDER_STRIDE;

      const cb = colors.atom(b);
      cylinders[co] = bx; cylinders[co + 1] = by; cylinders[co + 2] = bz;
      cylinders[co + 3] = radius;
      cylinders[co + 4] = mx; cylinders[co + 5] = my; cylinders[co + 6] = mz;
      cylinders[co + 7] = s.atomResidue[b];
      cylinders[co + 8] = ((cb >> 16) & 0xff) / 255;
      cylinders[co + 9] = ((cb >> 8) & 0xff) / 255;
      cylinders[co + 10] = (cb & 0xff) / 255;
      co += CYLINDER_STRIDE;

      grow(ax, ay, az, radius);
      grow(bx, by, bz, radius);
    }
  }

  // ---- cartoon ----
  let cartoon: MeshData | null = null;
  if (rep.polymer === 'cartoon' || rep.polymer === 'backbone') {
    cartoon = buildCartoon(s, colors, rep, rep.polymer === 'backbone');
    if (cartoon) {
      const v = cartoon.vertices;
      for (let i = 0; i < v.length; i += CARTOON_STRIDE) grow(v[i], v[i + 1], v[i + 2], 0);
    }
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = -1; maxX = maxY = maxZ = 1;
  }

  return {
    spheres,
    sphereCount,
    cylinders,
    cylinderCount: bondCount * 2,
    cartoon,
    center: Float32Array.from([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]),
    radius: Math.max(0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ), 1),
  };
}

// ---------------------------------------------------------------------------
// Cartoon / ribbon
// ---------------------------------------------------------------------------

interface Profile {
  halfWidth: number;
  halfThickness: number;
  /** Superellipse exponent: 2 = ellipse, higher = flatter ribbon edges. */
  exponent: number;
}

const PROFILE_HELIX: Profile = { halfWidth: 1.1, halfThickness: 0.22, exponent: 2 };
const PROFILE_SHEET: Profile = { halfWidth: 1.05, halfThickness: 0.19, exponent: 6 };
const PROFILE_ARROW: Profile = { halfWidth: 1.8, halfThickness: 0.19, exponent: 6 };
const PROFILE_TIP: Profile = { halfWidth: 0.1, halfThickness: 0.19, exponent: 6 };
const PROFILE_COIL: Profile = { halfWidth: 0.27, halfThickness: 0.27, exponent: 2 };
const PROFILE_NUCLEIC: Profile = { halfWidth: 0.62, halfThickness: 0.62, exponent: 2 };
const PROFILE_TRACE: Profile = { halfWidth: 0.35, halfThickness: 0.35, exponent: 2 };

/** Detail drops on huge assemblies; a capsid does not need 12-gon rings. */
function quality(residueCount: number): { subdiv: number; sides: number } {
  if (residueCount > 60000) return { subdiv: 2, sides: 5 };
  if (residueCount > 20000) return { subdiv: 3, sides: 7 };
  if (residueCount > 6000) return { subdiv: 5, sides: 9 };
  return { subdiv: 7, sides: 12 };
}

function catmullRom(
  out: Float32Array, p0: number, p1: number, p2: number, p3: number, t: number, i: number,
): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[i] = 0.5 * (
    2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function buildCartoon(
  s: Structure, colors: ColorProvider, rep: Representation, traceOnly: boolean,
): MeshData | null {
  const { subdiv, sides } = quality(s.residueCount);

  const vertices: number[] = [];
  const indices: number[] = [];

  // Reusable scratch for one residue's frame.
  const pos: number[] = [];
  const widthDir: number[] = [];
  const profiles: Profile[] = [];
  const colorList: number[] = [];

  for (let c = 0; c < s.chainCount; c++) {
    const kind = s.chainKind[c];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;
    if (!chainVisible(s, c, rep)) continue;

    const maxGap = kind === MolKind.Nucleic ? 9 : 5.2;
    const start = s.chainResStart[c];
    const end = s.chainResStart[c + 1];

    let segment: number[] = [];
    const flush = () => {
      if (segment.length >= 2) {
        emitSegment(segment);
      }
      segment = [];
    };

    const emitSegment = (residues: number[]) => {
      pos.length = 0;
      widthDir.length = 0;
      profiles.length = 0;
      colorList.length = 0;

      const n = residues.length;
      const prevDir = new Float32Array(3);

      for (let i = 0; i < n; i++) {
        const r = residues[i];
        const a = s.resAnchor[r];
        pos.push(s.x[a], s.y[a], s.z[a]);
        colorList.push(colors.residue(r));

        // Carson–Bugg frame: the peptide plane fixes the ribbon's flat face.
        const next = i + 1 < n ? s.resAnchor[residues[i + 1]] : -1;
        const prev = i > 0 ? s.resAnchor[residues[i - 1]] : -1;
        const o = s.resOrient[r];

        let tx: number, ty: number, tz: number;
        if (next >= 0) {
          tx = s.x[next] - s.x[a]; ty = s.y[next] - s.y[a]; tz = s.z[next] - s.z[a];
        } else {
          tx = s.x[a] - s.x[prev]; ty = s.y[a] - s.y[prev]; tz = s.z[a] - s.z[prev];
        }

        let dx = 0, dy = 0, dz = 0;
        if (o >= 0) {
          const bx = s.x[o] - s.x[a], by = s.y[o] - s.y[a], bz = s.z[o] - s.z[a];
          // c = t × b (peptide plane normal), d = c × t (in-plane, sideways)
          const cx = ty * bz - tz * by;
          const cy = tz * bx - tx * bz;
          const cz = tx * by - ty * bx;
          dx = cy * tz - cz * ty;
          dy = cz * tx - cx * tz;
          dz = cx * ty - cy * tx;
        }
        let len = Math.hypot(dx, dy, dz);
        if (len < 1e-4) {
          // No carbonyl (nucleic, or a stripped model): fall back to curvature.
          const px = prev >= 0 ? s.x[a] - s.x[prev] : tx;
          const py = prev >= 0 ? s.y[a] - s.y[prev] : ty;
          const pz = prev >= 0 ? s.z[a] - s.z[prev] : tz;
          dx = py * tz - pz * ty;
          dy = pz * tx - px * tz;
          dz = px * ty - py * tx;
          len = Math.hypot(dx, dy, dz);
          if (len < 1e-4) {
            dx = Math.abs(tx) < 0.9 ? 1 : 0;
            dy = Math.abs(tx) < 0.9 ? 0 : 1;
            dz = 0;
            len = 1;
          }
        }
        dx /= len; dy /= len; dz /= len;

        // Strands alternate their carbonyl direction; without this flip the
        // ribbon twists 180° at every residue.
        if (i > 0 && dx * prevDir[0] + dy * prevDir[1] + dz * prevDir[2] < 0) {
          dx = -dx; dy = -dy; dz = -dz;
        }
        prevDir[0] = dx; prevDir[1] = dy; prevDir[2] = dz;
        widthDir.push(dx, dy, dz);

        profiles.push(profileFor(s, r, kind, i, n, residues, traceOnly));
      }

      sweep(vertices, indices, pos, widthDir, profiles, colorList, subdiv, sides);
    };

    let prevAnchor = -1;
    for (let r = start; r < end; r++) {
      const anchor = s.resAnchor[r];
      const k = s.resKind[r];
      if (anchor < 0 || (k !== MolKind.Protein && k !== MolKind.Nucleic)) {
        flush();
        prevAnchor = -1;
        continue;
      }
      if (prevAnchor >= 0) {
        const d = Math.hypot(
          s.x[anchor] - s.x[prevAnchor],
          s.y[anchor] - s.y[prevAnchor],
          s.z[anchor] - s.z[prevAnchor],
        );
        if (d > maxGap) flush();
      }
      segment.push(r);
      prevAnchor = anchor;
    }
    flush();
  }

  if (indices.length === 0) return null;
  return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

function profileFor(
  s: Structure, r: number, kind: number, i: number, n: number,
  residues: number[], traceOnly: boolean,
): Profile {
  if (traceOnly) return PROFILE_TRACE;
  if (kind === MolKind.Nucleic) return PROFILE_NUCLEIC;

  const ss = s.resSS[r];
  if (ss === SS.Helix) return PROFILE_HELIX;
  if (ss === SS.Sheet) {
    // Widen into an arrowhead on the last residue of the strand.
    const isLast = i + 1 >= n || s.resSS[residues[i + 1]] !== SS.Sheet;
    return isLast ? PROFILE_ARROW : PROFILE_SHEET;
  }
  // The residue right after a strand becomes the arrow's point.
  if (i > 0 && s.resSS[residues[i - 1]] === SS.Sheet) return PROFILE_TIP;
  return PROFILE_COIL;
}

function lerpProfile(out: Profile, a: Profile, b: Profile, t: number): Profile {
  out.halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t;
  out.halfThickness = a.halfThickness + (b.halfThickness - a.halfThickness) * t;
  out.exponent = a.exponent + (b.exponent - a.exponent) * t;
  return out;
}

/** Sweeps the cross-section along the spline and triangulates the tube. */
function sweep(
  vertices: number[], indices: number[],
  pos: number[], widthDir: number[], profiles: Profile[], colorList: number[],
  subdiv: number, sides: number,
): void {
  const n = profiles.length;
  const baseVertex = vertices.length / CARTOON_STRIDE;

  const p = new Float32Array(3);
  const pNext = new Float32Array(3);
  const w = new Float32Array(3);
  const prof: Profile = { halfWidth: 0, halfThickness: 0, exponent: 2 };

  const ringCount = (n - 1) * subdiv + 1;
  const ringPos = new Float32Array(ringCount * 3);
  const ringW = new Float32Array(ringCount * 3);
  const ringT = new Float32Array(ringCount * 3);
  const ringProfile: Profile[] = new Array(ringCount);
  const ringColor = new Float32Array(ringCount * 3);

  const at = (i: number, k: number) => {
    const c = Math.min(Math.max(i, 0), n - 1);
    return pos[c * 3 + k];
  };
  const wAt = (i: number, k: number) => {
    const c = Math.min(Math.max(i, 0), n - 1);
    return widthDir[c * 3 + k];
  };

  for (let ring = 0; ring < ringCount; ring++) {
    const i = Math.min(Math.floor(ring / subdiv), n - 2);
    const t = ring / subdiv - i;

    for (let k = 0; k < 3; k++) {
      catmullRom(p, at(i - 1, k), at(i, k), at(i + 1, k), at(i + 2, k), t, k);
      catmullRom(pNext, at(i - 1, k), at(i, k), at(i + 1, k), at(i + 2, k), t + 0.02, k);
      // Direction vectors interpolate linearly; splining them can invert the
      // frame at sharp turns.
      w[k] = wAt(i, k) * (1 - t) + wAt(i + 1, k) * t;
    }

    let tx = pNext[0] - p[0], ty = pNext[1] - p[1], tz = pNext[2] - p[2];
    let len = Math.hypot(tx, ty, tz);
    if (len < 1e-6) { tx = 0; ty = 0; tz = 1; len = 1; }
    tx /= len; ty /= len; tz /= len;

    // Orthogonalise the width direction against the tangent (Gram-Schmidt).
    const dot = w[0] * tx + w[1] * ty + w[2] * tz;
    let wx = w[0] - tx * dot, wy = w[1] - ty * dot, wz = w[2] - tz * dot;
    let wl = Math.hypot(wx, wy, wz);
    if (wl < 1e-6) { wx = 1; wy = 0; wz = 0; wl = 1; }
    wx /= wl; wy /= wl; wz /= wl;

    ringPos[ring * 3] = p[0]; ringPos[ring * 3 + 1] = p[1]; ringPos[ring * 3 + 2] = p[2];
    ringW[ring * 3] = wx; ringW[ring * 3 + 1] = wy; ringW[ring * 3 + 2] = wz;
    ringT[ring * 3] = tx; ringT[ring * 3 + 1] = ty; ringT[ring * 3 + 2] = tz;

    const a = profiles[i];
    const b = profiles[Math.min(i + 1, n - 1)];
    ringProfile[ring] = { ...lerpProfile(prof, a, b, t) };

    const ca = colorList[i];
    const cb = colorList[Math.min(i + 1, n - 1)];
    ringColor[ring * 3] = (((ca >> 16) & 0xff) * (1 - t) + ((cb >> 16) & 0xff) * t) / 255;
    ringColor[ring * 3 + 1] = (((ca >> 8) & 0xff) * (1 - t) + ((cb >> 8) & 0xff) * t) / 255;
    ringColor[ring * 3 + 2] = ((ca & 0xff) * (1 - t) + (cb & 0xff) * t) / 255;
  }

  // Superellipse radius at angle θ: flattens the ribbon edges for strands.
  const shapeRadius = (theta: number, exponent: number) => {
    if (exponent <= 2.01) return 1;
    const ct = Math.abs(Math.cos(theta));
    const st = Math.abs(Math.sin(theta));
    return 1 / Math.pow(Math.pow(ct, exponent) + Math.pow(st, exponent), 1 / exponent);
  };

  for (let ring = 0; ring < ringCount; ring++) {
    const px = ringPos[ring * 3], py = ringPos[ring * 3 + 1], pz = ringPos[ring * 3 + 2];
    const wx = ringW[ring * 3], wy = ringW[ring * 3 + 1], wz = ringW[ring * 3 + 2];
    const tx = ringT[ring * 3], ty = ringT[ring * 3 + 1], tz = ringT[ring * 3 + 2];
    // Thickness direction completes the frame.
    const bx = ty * wz - tz * wy;
    const by = tz * wx - tx * wz;
    const bz = tx * wy - ty * wx;

    const pr = ringProfile[ring];
    const cr = ringColor[ring * 3], cg = ringColor[ring * 3 + 1], cb = ringColor[ring * 3 + 2];

    for (let k = 0; k < sides; k++) {
      const theta = (k / sides) * Math.PI * 2;
      const shape = shapeRadius(theta, pr.exponent);
      const u = Math.cos(theta) * shape * pr.halfWidth;
      const v = Math.sin(theta) * shape * pr.halfThickness;

      const vx = px + wx * u + bx * v;
      const vy = py + wy * u + by * v;
      const vz = pz + wz * u + bz * v;

      // Surface normal points outward in the cross-section plane, weighted by
      // the profile so flat ribbons get flat faces.
      let nx = wx * (u / (pr.halfWidth * pr.halfWidth))
        + bx * (v / (pr.halfThickness * pr.halfThickness));
      let ny = wy * (u / (pr.halfWidth * pr.halfWidth))
        + by * (v / (pr.halfThickness * pr.halfThickness));
      let nz = wz * (u / (pr.halfWidth * pr.halfWidth))
        + bz * (v / (pr.halfThickness * pr.halfThickness));
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;

      vertices.push(vx, vy, vz, nx, ny, nz, cr, cg, cb);
    }
  }

  for (let ring = 0; ring < ringCount - 1; ring++) {
    const a = baseVertex + ring * sides;
    const b = baseVertex + (ring + 1) * sides;
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides;
      indices.push(a + k, b + k, a + k1);
      indices.push(a + k1, b + k, b + k1);
    }
  }

  // Flat caps so the ribbon does not look hollow at chain termini.
  addCap(vertices, indices, ringPos, ringT, ringProfile, ringColor, baseVertex, 0, sides, true);
  addCap(
    vertices, indices, ringPos, ringT, ringProfile, ringColor,
    baseVertex, ringCount - 1, sides, false,
  );
}

function addCap(
  vertices: number[], indices: number[],
  ringPos: Float32Array, ringT: Float32Array, ringProfile: Profile[], ringColor: Float32Array,
  baseVertex: number, ring: number, sides: number, front: boolean,
): void {
  if (ringProfile[ring].halfWidth < 0.12) return;

  const center = vertices.length / CARTOON_STRIDE;
  const sign = front ? -1 : 1;
  vertices.push(
    ringPos[ring * 3], ringPos[ring * 3 + 1], ringPos[ring * 3 + 2],
    ringT[ring * 3] * sign, ringT[ring * 3 + 1] * sign, ringT[ring * 3 + 2] * sign,
    ringColor[ring * 3], ringColor[ring * 3 + 1], ringColor[ring * 3 + 2],
  );

  const first = baseVertex + ring * sides;
  for (let k = 0; k < sides; k++) {
    const k1 = (k + 1) % sides;
    if (front) indices.push(center, first + k1, first + k);
    else indices.push(center, first + k, first + k1);
  }
}
