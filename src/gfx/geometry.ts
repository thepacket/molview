/**
 * CPU-side geometry generation.
 *
 * Atoms and bonds become GPU instance data (impostor spheres, instanced
 * cylinders). Cartoons become a real triangle mesh, because a swept ribbon
 * with per-residue cross-sections has no impostor formulation.
 */

import type { BondList } from '../mol/bonds';
import { identityTransform, type Assembly } from '../mol/assembly';
import { Style, type ResolvedScene } from '../mol/components';
import { VDW_RADII } from '../mol/elements';
import { MolKind, SS, atomNameOf, type Structure } from '../mol/structure';

/**
 * Settings that apply to the whole pane rather than to one component. Which
 * atoms get which style now comes from the component list — see
 * `mol/components.ts` — so what is left here is sizing and global filters.
 */
export interface Representation {
  showHydrogens: boolean;
  /** 0.25 – 2.0; scales atom radii in ball-and-stick / licorice. */
  atomScale: number;
  bondRadius: number;
  /** Chains hidden by the user, by auth id. */
  hiddenChains: ReadonlySet<string>;
}

export const DEFAULT_REPRESENTATION: Representation = {
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

/**
 * One buildable unit of the scene: geometry for a set of chains, plus the
 * transforms it is replicated by. An asymmetric unit is a single group with one
 * identity transform; an icosahedral assembly is a group with sixty.
 */
export interface GeometryGroup {
  spheres: Float32Array;
  sphereCount: number;
  cylinders: Float32Array;
  cylinderCount: number;
  cartoon: MeshData | null;
  /** Column-major 4x4 matrices, 16 floats per copy. */
  transforms: Float32Array;
  transformCount: number;
  /** Untransformed bounds, used for framing and for culling picks. */
  localMin: Float32Array;
  localMax: Float32Array;
  /** Atoms belonging to this group's chains; null means every atom. */
  atomMask: Uint8Array | null;
  /** Atoms and chains this group covers, before transforms. */
  atomCount: number;
  chainCount: number;
}

export interface SceneGeometry {
  groups: GeometryGroup[];
  /** Bounds of everything actually drawn, transforms included. */
  center: Float32Array;
  radius: number;
  totalSpheres: number;
  totalCylinders: number;
  totalTriangles: number;
  /** Atoms and chains present in the scene once transforms are applied. */
  totalAtoms: number;
  totalChains: number;
}

/** Assembly generators name the chains they replicate by label_asym_id. */
function chainVisible(
  s: Structure, chain: number, allowedAsyms: ReadonlySet<string> | null,
): boolean {
  return !allowedAsyms || allowedAsyms.has(s.chainLabelId[chain]);
}

function atomRadius(style: number, element: number, rep: Representation): number {
  switch (style) {
    case Style.Spacefill: return VDW_RADII[element];
    case Style.BallStick: return VDW_RADII[element] * 0.25 * rep.atomScale;
    case Style.Licorice: return rep.bondRadius * rep.atomScale;
    default: return 0;
  }
}

export function buildGeometry(
  s: Structure,
  resolved: ResolvedScene,
  rep: Representation,
  ligandBonds: BondList,
  allBonds: BondList | null,
  assembly: Assembly | null,
): SceneGeometry {
  const groups: GeometryGroup[] = [];

  if (!assembly) {
    groups.push(buildGroup(s, resolved, rep, ligandBonds, allBonds, null, identityTransform(), 1));
  } else {
    for (const gen of assembly.gens) {
      const group = buildGroup(
        s, resolved, rep, ligandBonds, allBonds,
        new Set(gen.asymIds), gen.transforms, gen.count,
      );
      if (group.sphereCount > 0 || group.cylinderCount > 0 || group.cartoon) {
        groups.push(group);
      }
    }
  }

  // Global bounds: every group's local box, pushed through every transform.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const group of groups) {
    const { localMin: lo, localMax: hi, transforms } = group;
    if (!Number.isFinite(lo[0])) continue;
    for (let t = 0; t < group.transformCount; t++) {
      const o = t * 16;
      for (let corner = 0; corner < 8; corner++) {
        const cx = (corner & 1) ? hi[0] : lo[0];
        const cy = (corner & 2) ? hi[1] : lo[1];
        const cz = (corner & 4) ? hi[2] : lo[2];
        const x = transforms[o] * cx + transforms[o + 4] * cy + transforms[o + 8] * cz + transforms[o + 12];
        const y = transforms[o + 1] * cx + transforms[o + 5] * cy + transforms[o + 9] * cz + transforms[o + 13];
        const z = transforms[o + 2] * cx + transforms[o + 6] * cy + transforms[o + 10] * cz + transforms[o + 14];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }
  }

  if (!Number.isFinite(minX)) {
    minX = minY = minZ = -1; maxX = maxY = maxZ = 1;
  }

  let totalSpheres = 0;
  let totalCylinders = 0;
  let totalTriangles = 0;
  let totalAtoms = 0;
  let totalChains = 0;
  for (const g of groups) {
    totalSpheres += g.sphereCount * g.transformCount;
    totalCylinders += g.cylinderCount * g.transformCount;
    totalTriangles += (g.cartoon ? g.cartoon.indices.length / 3 : 0) * g.transformCount;
    totalAtoms += g.atomCount * g.transformCount;
    totalChains += g.chainCount * g.transformCount;
  }

  return {
    groups,
    center: Float32Array.from([(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]),
    radius: Math.max(0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ), 1),
    totalSpheres,
    totalCylinders,
    totalTriangles,
    totalAtoms,
    totalChains,
  };
}

function buildGroup(
  s: Structure,
  resolved: ResolvedScene,
  rep: Representation,
  ligandBonds: BondList,
  allBonds: BondList | null,
  allowedAsyms: ReadonlySet<string> | null,
  transforms: Float32Array,
  transformCount: number,
): GeometryGroup {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const grow = (x: number, y: number, z: number, r: number) => {
    if (x - r < minX) minX = x - r; if (x + r > maxX) maxX = x + r;
    if (y - r < minY) minY = y - r; if (y + r > maxY) maxY = y + r;
    if (z - r < minZ) minZ = z - r; if (z + r > maxZ) maxZ = z + r;
  };

  const coverage = chainCoverage(s, allowedAsyms);
  const { atomStyle, atomColor } = resolved;

  // Pass 1: decide what is drawn and how big the buffers need to be. A
  // spacefill capsid is 2.4 million atoms; growing a JS array to hold that
  // costs more than the rest of the build put together.
  const drawAtom = new Uint8Array(s.atomCount);
  const atomRadii = new Float32Array(s.atomCount);
  let sphereCount = 0;
  let wantsSticks = false;

  for (let r = 0; r < s.residueCount; r++) {
    if (!chainVisible(s, s.resChain[r], allowedAsyms)) continue;

    for (let a = s.resAtomStart[r], end = s.resAtomStart[r + 1]; a < end; a++) {
      const style = atomStyle[a];
      // Cartoon and backbone replace their atoms with a ribbon.
      if (style === Style.None || style === Style.Cartoon || style === Style.Backbone) continue;
      if (style === Style.BallStick || style === Style.Licorice) wantsSticks = true;

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
    const c = atomColor[a];
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
  // `wantsSticks` was set during pass 1 by whichever component asked for them.
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

      const ca = atomColor[a];
      cylinders[co] = ax; cylinders[co + 1] = ay; cylinders[co + 2] = az;
      cylinders[co + 3] = radius;
      cylinders[co + 4] = mx; cylinders[co + 5] = my; cylinders[co + 6] = mz;
      cylinders[co + 7] = s.atomResidue[a];
      cylinders[co + 8] = ((ca >> 16) & 0xff) / 255;
      cylinders[co + 9] = ((ca >> 8) & 0xff) / 255;
      cylinders[co + 10] = (ca & 0xff) / 255;
      co += CYLINDER_STRIDE;

      const cb = atomColor[b];
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
  let cartoon: MeshData | null = buildCartoon(s, resolved, allowedAsyms);
  {
    if (cartoon) {
      const v = cartoon.vertices;
      for (let i = 0; i < v.length; i += CARTOON_STRIDE) grow(v[i], v[i + 1], v[i + 2], 0);
    }
  }

  return {
    spheres,
    sphereCount,
    cylinders,
    cylinderCount: bondCount * 2,
    cartoon,
    transforms,
    transformCount,
    localMin: Float32Array.from([minX, minY, minZ]),
    localMax: Float32Array.from([maxX, maxY, maxZ]),
    // Picking needs every atom of the group's chains, including ones the
    // cartoon replaced — you should still be able to click a ribbon.
    atomMask: coverage.mask,
    atomCount: coverage.atoms,
    chainCount: coverage.chains,
  };
}

/** Atoms and chains a group covers, plus the pick mask when it is a subset. */
function chainCoverage(
  s: Structure, allowedAsyms: ReadonlySet<string> | null,
): { mask: Uint8Array | null; atoms: number; chains: number } {
  const mask = allowedAsyms ? new Uint8Array(s.atomCount) : null;
  let atoms = 0;
  let chains = 0;

  for (let c = 0; c < s.chainCount; c++) {
    if (!chainVisible(s, c, allowedAsyms)) continue;
    chains++;
    const rStart = s.chainResStart[c];
    const rEnd = s.chainResStart[c + 1];
    if (rEnd <= rStart) continue;
    const aStart = s.resAtomStart[rStart];
    const aEnd = s.resAtomStart[rEnd];
    atoms += aEnd - aStart;
    if (mask) mask.fill(1, aStart, aEnd);
  }

  return { mask, atoms, chains };
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
  s: Structure, resolved: ResolvedScene, allowedAsyms: ReadonlySet<string> | null,
): MeshData | null {
  const { residueStyle, atomColor } = resolved;
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
    if (!chainVisible(s, c, allowedAsyms)) continue;

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
        colorList.push(atomColor[a]);

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

        profiles.push(profileFor(s, r, kind, i, n, residues,
          residueStyle[r] === Style.Backbone));
      }

      sweep(vertices, indices, pos, widthDir, profiles, colorList, subdiv, sides);
    };

    let prevAnchor = -1;
    let prevStyle = 0;
    for (let r = start; r < end; r++) {
      const anchor = s.resAnchor[r];
      const k = s.resKind[r];
      const style = residueStyle[r];
      // A ribbon breaks where the style changes, so a component covering part
      // of a chain produces its own segment rather than bleeding into the rest.
      if (anchor < 0 || style === 0 || (k !== MolKind.Protein && k !== MolKind.Nucleic)) {
        flush();
        prevAnchor = -1;
        prevStyle = 0;
        continue;
      }
      if (prevStyle !== 0 && style !== prevStyle) {
        flush();
        prevAnchor = -1;
      }
      prevStyle = style;
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

  // Nucleic acids read as featureless tubes without their bases; the slab is
  // what makes a double helix look like one. Backbone-trace style stays bare.
  {
    for (let r = 0; r < s.residueCount; r++) {
      if (residueStyle[r] !== Style.Cartoon) continue;
      if (s.resKind[r] !== MolKind.Nucleic) continue;
      if (!chainVisible(s, s.resChain[r], allowedAsyms)) continue;
      addBaseSlab(vertices, indices, s, r, atomColor);
    }
  }

  if (indices.length === 0) return null;
  return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

const PURINE_RING = ['N9', 'C8', 'N7', 'C5', 'C6', 'N1', 'C2', 'N3', 'C4'];
const PYRIMIDINE_RING = ['N1', 'C2', 'N3', 'C4', 'C5', 'C6'];
const SLAB_HALF_THICKNESS = 0.2;

/**
 * A flat box covering the base ring, plus a stub joining it to the sugar.
 * The box is fitted in the ring's own plane rather than assumed, so modified
 * and non-planar bases still get a sensible slab.
 */
function addBaseSlab(
  vertices: number[], indices: number[],
  s: Structure, residue: number, atomColor: Uint32Array,
): void {
  const start = s.resAtomStart[residue];
  const end = s.resAtomStart[residue + 1];

  const byName = new Map<string, number>();
  for (let a = start; a < end; a++) byName.set(atomNameOf(s, a).toUpperCase(), a);

  const purine = byName.has('N9');
  const ringNames = purine ? PURINE_RING : PYRIMIDINE_RING;
  const ring: number[] = [];
  for (const name of ringNames) {
    const a = byName.get(name);
    if (a !== undefined) ring.push(a);
  }
  if (ring.length < 4) return;

  // Newell's method: a plane normal that tolerates a slightly puckered ring.
  let nx = 0, ny = 0, nz = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    nx += (s.y[a] - s.y[b]) * (s.z[a] + s.z[b]);
    ny += (s.z[a] - s.z[b]) * (s.x[a] + s.x[b]);
    nz += (s.x[a] - s.x[b]) * (s.y[a] + s.y[b]);
    cx += s.x[a]; cy += s.y[a]; cz += s.z[a];
  }
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-5) return;
  nx /= nlen; ny /= nlen; nz /= nlen;
  cx /= ring.length; cy /= ring.length; cz /= ring.length;

  // In-plane frame, seeded from the first ring bond.
  let ux = s.x[ring[1]] - s.x[ring[0]];
  let uy = s.y[ring[1]] - s.y[ring[0]];
  let uz = s.z[ring[1]] - s.z[ring[0]];
  const dotU = ux * nx + uy * ny + uz * nz;
  ux -= nx * dotU; uy -= ny * dotU; uz -= nz * dotU;
  const ulen = Math.hypot(ux, uy, uz);
  if (ulen < 1e-5) return;
  ux /= ulen; uy /= ulen; uz /= ulen;

  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  // Fit the box to the ring's extent in that frame.
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const anchorName = purine ? 'N9' : 'N1';
  const attach = byName.get(anchorName) ?? ring[0];
  const consider = (a: number) => {
    const dx = s.x[a] - cx, dy = s.y[a] - cy, dz = s.z[a] - cz;
    const du = dx * ux + dy * uy + dz * uz;
    const dv = dx * vx + dy * vy + dz * vz;
    if (du < minU) minU = du; if (du > maxU) maxU = du;
    if (dv < minV) minV = dv; if (dv > maxV) maxV = dv;
  };
  for (const a of ring) consider(a);
  consider(attach);

  const pad = 0.35;
  minU -= pad; maxU += pad; minV -= pad; maxV += pad;

  const color = atomColor[attach] || atomColor[ring[0]];
  const cr = ((color >> 16) & 0xff) / 255;
  const cg = ((color >> 8) & 0xff) / 255;
  const cb = (color & 0xff) / 255;

  const corner = (u: number, v: number, w: number, out: number[]) => {
    out[0] = cx + ux * u + vx * v + nx * w;
    out[1] = cy + uy * u + vy * v + ny * w;
    out[2] = cz + uz * u + vz * v + nz * w;
  };

  const p = [0, 0, 0];
  const base = vertices.length / CARTOON_STRIDE;

  // Six faces, each with its own normal, so the slab has crisp edges.
  const faces: [number, number, number][][] = [];
  const signs = [-1, 1];
  for (const w of signs) {
    faces.push([
      [minU, minV, w * SLAB_HALF_THICKNESS], [maxU, minV, w * SLAB_HALF_THICKNESS],
      [maxU, maxV, w * SLAB_HALF_THICKNESS], [minU, maxV, w * SLAB_HALF_THICKNESS],
    ]);
  }
  for (const u of [minU, maxU]) {
    faces.push([
      [u, minV, -SLAB_HALF_THICKNESS], [u, maxV, -SLAB_HALF_THICKNESS],
      [u, maxV, SLAB_HALF_THICKNESS], [u, minV, SLAB_HALF_THICKNESS],
    ]);
  }
  for (const v of [minV, maxV]) {
    faces.push([
      [minU, v, -SLAB_HALF_THICKNESS], [maxU, v, -SLAB_HALF_THICKNESS],
      [maxU, v, SLAB_HALF_THICKNESS], [minU, v, SLAB_HALF_THICKNESS],
    ]);
  }

  let emitted = 0;
  for (const face of faces) {
    const quad: number[][] = [];
    for (const [u, v, w] of face) {
      corner(u, v, w, p);
      quad.push([p[0], p[1], p[2]]);
    }
    // Face normal from the quad itself; direction is fixed up below.
    const e1 = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1], quad[1][2] - quad[0][2]];
    const e2 = [quad[2][0] - quad[0][0], quad[2][1] - quad[0][1], quad[2][2] - quad[0][2]];
    let fnx = e1[1] * e2[2] - e1[2] * e2[1];
    let fny = e1[2] * e2[0] - e1[0] * e2[2];
    let fnz = e1[0] * e2[1] - e1[1] * e2[0];
    const flen = Math.hypot(fnx, fny, fnz) || 1;
    fnx /= flen; fny /= flen; fnz /= flen;

    // Point normals outward from the slab centre.
    const mx = (quad[0][0] + quad[2][0]) / 2 - cx;
    const my = (quad[0][1] + quad[2][1]) / 2 - cy;
    const mz = (quad[0][2] + quad[2][2]) / 2 - cz;
    if (fnx * mx + fny * my + fnz * mz < 0) { fnx = -fnx; fny = -fny; fnz = -fnz; }

    for (const vert of quad) {
      vertices.push(vert[0], vert[1], vert[2], fnx, fny, fnz, cr, cg, cb);
    }
    const o = base + emitted * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
    emitted++;
  }
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
