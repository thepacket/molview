/**
 * Marching cubes over a sampled scalar field.
 *
 * The 256-case triangle table is *derived* at module load rather than
 * transcribed. Transcribing it is the traditional approach and it is 256 rows
 * of sixteen small integers, where a single typo produces a hole that only
 * shows up on some structures at some contour levels. Deriving it from the
 * cube's face connectivity is about eighty lines, is checkable by argument
 * rather than by proofreading, and the check `isosurfaceIsClosed` in the test
 * script confirms the mesh it produces is watertight.
 *
 * Two rules make the derivation sound:
 *
 * - **Ambiguous faces resolve the same way from both sides.** When a face has
 *   two diagonally opposite corners inside, the surface can either join them
 *   or separate them. The rule here is always to join — each segment on such a
 *   face cuts off one *outside* corner. It depends only on the in/out pattern
 *   of the four shared corners, so the two cubes meeting at that face always
 *   agree, and the mesh cannot crack.
 * - **The derivation never reasons about orientation.** Normals come from the
 *   field gradient, which is smoother than a face normal and independent of
 *   triangle order. Each triangle is then turned to agree with its own vertex
 *   normals as it is emitted, which is one dot product and gets consistent
 *   outward winding without the table having to encode it.
 */

import type { VolumeGrid } from '../rcsb/volume';

export interface IsoMesh {
  /** Interleaved position (3) + normal (3) + colour (3). */
  vertices: Float32Array;
  triangles: Uint32Array;
  /** Deduplicated triangle edges, for the wireframe presentation. */
  lines: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  /** True when generation stopped at the budget, so the surface is partial. */
  truncated: boolean;
}

/**
 * Position, normal, colour.
 *
 * A density contour is one colour throughout and carries white here, letting
 * the shader tint by the style uniform. A molecular surface is not: it has to
 * be coloured by the atom under it or it says nothing about the molecule, and
 * that colour cannot live in a uniform. Paying three floats a vertex on the
 * density path keeps one pipeline instead of two.
 */
export const ISOSURFACE_STRIDE = 9;

// Cube corners, in the conventional marching-cubes order.
const CORNER: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

// The twelve edges as corner pairs.
const EDGE: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Each edge belongs to one owner corner and one axis, so a cut edge has the
 * same identity in every cube that shares it and its vertex is computed once.
 */
const EDGE_OWNER: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0], [1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1],
  [0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 0], [0, 0, 1, 1],
  [0, 0, 0, 2], [1, 0, 0, 2], [1, 1, 0, 2], [0, 1, 0, 2],
];

// The six faces, corners in cyclic order and the edge joining each
// consecutive pair. Cyclic order is what makes "the next cut edge round the
// face" meaningful; which way round it goes does not matter.
const FACE: readonly { corners: readonly number[]; edges: readonly number[] }[] = [
  { corners: [0, 1, 2, 3], edges: [0, 1, 2, 3] },      // z = 0
  { corners: [4, 5, 6, 7], edges: [4, 5, 6, 7] },      // z = 1
  { corners: [0, 1, 5, 4], edges: [0, 9, 4, 8] },      // y = 0
  { corners: [3, 2, 6, 7], edges: [2, 10, 6, 11] },    // y = 1
  { corners: [0, 3, 7, 4], edges: [3, 11, 7, 8] },     // x = 0
  { corners: [1, 2, 6, 5], edges: [1, 10, 5, 9] },     // x = 1
];

/** triTable[config] is a flat list of edge indices, three per triangle. */
const TRI_TABLE: Int8Array[] = buildTriTable();

function buildTriTable(): Int8Array[] {
  const table: Int8Array[] = [];
  for (let config = 0; config < 256; config++) {
    table.push(new Int8Array(trianglesFor(config)));
  }
  return table;
}

function trianglesFor(config: number): number[] {
  const inside = (c: number) => (config & (1 << c)) !== 0;

  // Collect the segments each face contributes, as pairs of edge indices.
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a)!.push(b);
    links.get(b)!.push(a);
  };

  for (const face of FACE) {
    const cut: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = face.corners[i];
      const b = face.corners[(i + 1) % 4];
      if (inside(a) !== inside(b)) cut.push(i);
    }
    if (cut.length === 2) {
      link(face.edges[cut[0]], face.edges[cut[1]]);
    } else if (cut.length === 4) {
      // All four edges cut: the corners alternate in/out. Join the inside
      // corners through the face centre, which means each segment isolates
      // one outside corner — edges i-1 and i around that corner.
      for (let i = 0; i < 4; i++) {
        if (inside(face.corners[i])) continue;
        link(face.edges[(i + 3) % 4], face.edges[i]);
      }
    }
  }

  // Every cut edge lies on exactly two faces and is used once on each, so the
  // links form disjoint closed loops. Walk them and fan-triangulate.
  const out: number[] = [];
  const seen = new Set<number>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let current = start;
    let previous = -1;
    for (;;) {
      loop.push(current);
      seen.add(current);
      const next = links.get(current)!.find((e) => e !== previous && !seen.has(e));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    for (let i = 1; i + 1 < loop.length; i++) {
      out.push(loop[0], loop[i], loop[i + 1]);
    }
  }
  return out;
}

export interface IsoOptions {
  /** Contour, in sigma above the map mean. Negative for a difference map lobe. */
  sigma: number;
  /**
   * Cells to consider, usually `nearMask` around the drawn atoms. An X-ray box
   * query returns density for the symmetry mates packed around the molecule
   * too, and without a mask the model disappears inside its neighbours'.
   */
  mask?: Uint8Array | null;
  /** Stop after this many triangles rather than exhaust memory. */
  maxTriangles?: number;
  /**
   * Which atom dominates the field at each grid point, and the colour table it
   * indexes (three floats per atom). Given together or not at all; without them
   * the surface comes out white and is tinted by the style uniform.
   */
  owner?: Int32Array | null;
  colors?: Float32Array | null;
}

export const DEFAULT_MAX_TRIANGLES = 900_000;

/**
 * Cells the surface would pass through, without building it.
 *
 * Roughly two and a half triangles come out of each, which is enough to decide
 * whether a contour is affordable before spending a second finding out. The
 * loop is the marching-cubes loop with the geometry removed.
 */
export function surfaceCellCount(
  grid: VolumeGrid, sigma: number, mask?: Uint8Array | null,
): number {
  const level = grid.mean + sigma * grid.sigma;
  const [nx, ny, nz] = grid.counts;
  const v = grid.values;
  let count = 0;

  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      const base = nx * (j + ny * k);
      for (let i = 0; i + 1 < nx; i++) {
        if (mask && !mask[i + base]) continue;
        let above = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNER[c];
          if (v[(i + dx) + nx * ((j + dy) + ny * (k + dz))] >= level) above++;
        }
        if (above > 0 && above < 8) count++;
      }
    }
  }
  return count;
}

/** About how many triangles one surface cell yields, measured on real maps. */
const TRIANGLES_PER_CELL = 2.5;

/**
 * The contour to open a map at: the one asked for, raised until the surface
 * fits the triangle budget.
 *
 * A cryo-EM map at a level that suits one entry buries another, and arriving
 * at a half-drawn surface with a warning is a worse first impression than
 * arriving at a slightly tighter contour the panel then reports honestly.
 * Only ever raises — a contour lower than requested would show noise no one
 * asked to see.
 */
export function levelWithinBudget(
  grid: VolumeGrid,
  sigma: number,
  mask?: Uint8Array | null,
  maxTriangles = DEFAULT_MAX_TRIANGLES,
): number {
  let level = sigma;
  for (let attempt = 0; attempt < 6; attempt++) {
    const cells = surfaceCellCount(grid, level, mask);
    if (cells * TRIANGLES_PER_CELL <= maxTriangles) return level;
    level += 0.5;
  }
  return level;
}

export function isosurface(grid: VolumeGrid, options: IsoOptions): IsoMesh {
  const level = grid.mean + options.sigma * grid.sigma;
  const [nx, ny, nz] = grid.counts;
  const values = grid.values;
  const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  const mask = options.mask ?? null;
  const owner = options.owner ?? null;
  const colors = options.colors ?? null;

  // Vertex per cut edge, shared between the cubes that meet on it. Without
  // this the wireframe draws every interior edge four times and the buffers
  // are several times larger than the surface needs.
  const total = nx * ny * nz;
  const edgeVertex = new Int32Array(total * 3).fill(-1);

  const positions: number[] = [];
  const tris: number[] = [];
  let truncated = false;

  const at = (i: number, j: number, k: number) => values[i + nx * (j + ny * k)];

  // Central-difference gradient at a grid point, one-sided at the boundary.
  const gradient = (i: number, j: number, k: number, out: Float32Array) => {
    const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, nx - 1);
    const j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, ny - 1);
    const k0 = Math.max(k - 1, 0), k1 = Math.min(k + 1, nz - 1);
    out[0] = (at(i1, j, k) - at(i0, j, k)) / (i1 - i0 || 1);
    out[1] = (at(i, j1, k) - at(i, j0, k)) / (j1 - j0 || 1);
    out[2] = (at(i, j, k1) - at(i, j, k0)) / (k1 - k0 || 1);
  };

  const gA = new Float32Array(3);
  const gB = new Float32Array(3);
  const { origin, stepA, stepB, stepC } = grid;

  /** Interpolates along a cut edge, returning the shared vertex index. */
  const vertexFor = (
    ci: number, cj: number, ck: number, edge: number,
  ): number => {
    const [ox, oy, oz, axis] = EDGE_OWNER[edge];
    const oi = ci + ox, oj = cj + oy, ok = ck + oz;
    const key = (oi + nx * (oj + ny * ok)) * 3 + axis;
    const existing = edgeVertex[key];
    if (existing >= 0) return existing;

    const [ca, cb] = EDGE[edge];
    const ai = ci + CORNER[ca][0], aj = cj + CORNER[ca][1], ak = ck + CORNER[ca][2];
    const bi = ci + CORNER[cb][0], bj = cj + CORNER[cb][1], bk = ck + CORNER[cb][2];
    const va = at(ai, aj, ak);
    const vb = at(bi, bj, bk);
    const denom = vb - va;
    const t = Math.abs(denom) < 1e-9 ? 0.5 : (level - va) / denom;

    const fi = ai + (bi - ai) * t;
    const fj = aj + (bj - aj) * t;
    const fk = ak + (bk - ak) * t;

    gradient(ai, aj, ak, gA);
    gradient(bi, bj, bk, gB);
    // Density rises inward, so the outward normal is the negated gradient,
    // expressed in world space through the (possibly skewed) step vectors.
    const du = -(gA[0] + (gB[0] - gA[0]) * t);
    const dv = -(gA[1] + (gB[1] - gA[1]) * t);
    const dw = -(gA[2] + (gB[2] - gA[2]) * t);

    // Colour comes from the atom dominating the field at each end, blended
    // along the edge, so a chain boundary crossing the surface fades rather
    // than staircases along the grid.
    let cr = 1, cg = 1, cb2 = 1;
    if (owner && colors) {
      const oa = owner[ai + nx * (aj + ny * ak)];
      const ob = owner[bi + nx * (bj + ny * bk)];
      if (oa >= 0 && ob >= 0) {
        cr = colors[oa * 3] + (colors[ob * 3] - colors[oa * 3]) * t;
        cg = colors[oa * 3 + 1] + (colors[ob * 3 + 1] - colors[oa * 3 + 1]) * t;
        cb2 = colors[oa * 3 + 2] + (colors[ob * 3 + 2] - colors[oa * 3 + 2]) * t;
      } else if (oa >= 0 || ob >= 0) {
        const o = oa >= 0 ? oa : ob;
        cr = colors[o * 3]; cg = colors[o * 3 + 1]; cb2 = colors[o * 3 + 2];
      }
    }

    const index = positions.length / ISOSURFACE_STRIDE;
    positions.push(
      origin[0] + stepA[0] * fi + stepB[0] * fj + stepC[0] * fk,
      origin[1] + stepA[1] * fi + stepB[1] * fj + stepC[1] * fk,
      origin[2] + stepA[2] * fi + stepB[2] * fj + stepC[2] * fk,
      stepA[0] * du + stepB[0] * dv + stepC[0] * dw,
      stepA[1] * du + stepB[1] * dv + stepC[1] * dw,
      stepA[2] * du + stepB[2] * dv + stepC[2] * dw,
      cr, cg, cb2,
    );
    edgeVertex[key] = index;
    return index;
  };

  outer:
  for (let k = 0; k + 1 < nz; k++) {
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        let config = 0;
        for (let c = 0; c < 8; c++) {
          const [dx, dy, dz] = CORNER[c];
          if (at(i + dx, j + dy, k + dz) >= level) config |= 1 << c;
        }
        if (config === 0 || config === 255) continue;
        if (mask && !mask[i + nx * (j + ny * k)]) continue;

        const list = TRI_TABLE[config];
        for (let t = 0; t < list.length; t += 3) {
          const a = vertexFor(i, j, k, list[t]);
          const b = vertexFor(i, j, k, list[t + 1]);
          const c = vertexFor(i, j, k, list[t + 2]);
          // The derived table says nothing about orientation, so each triangle
          // is turned to face the way its vertex normals do. Shading never
          // needed this — the gradient normal is independent of winding — but
          // drawing a transparent surface back-faces-first does, and so would
          // any later pass that culls.
          tris.push(...(facesOutward(positions, a, b, c) ? [a, b, c] : [a, c, b]));
        }
        if (tris.length >= maxTriangles * 3) {
          truncated = true;
          break outer;
        }
      }
    }
  }

  const vertices = new Float32Array(positions.length);
  for (let v = 0; v < positions.length; v += ISOSURFACE_STRIDE) {
    vertices[v] = positions[v];
    vertices[v + 1] = positions[v + 1];
    vertices[v + 2] = positions[v + 2];
    const nxv = positions[v + 3], nyv = positions[v + 4], nzv = positions[v + 5];
    const len = Math.hypot(nxv, nyv, nzv) || 1;
    vertices[v + 3] = nxv / len;
    vertices[v + 4] = nyv / len;
    vertices[v + 5] = nzv / len;
    vertices[v + 6] = positions[v + 6];
    vertices[v + 7] = positions[v + 7];
    vertices[v + 8] = positions[v + 8];
  }

  return {
    vertices,
    triangles: Uint32Array.from(tris),
    lines: wireframe(tris),
    vertexCount: vertices.length / ISOSURFACE_STRIDE,
    triangleCount: tris.length / 3,
    truncated,
  };
}

/** True when the winding a-b-c already agrees with the vertex normals. */
function facesOutward(p: number[], a: number, b: number, c: number): boolean {
  const ia = a * ISOSURFACE_STRIDE, ib = b * ISOSURFACE_STRIDE, ic = c * ISOSURFACE_STRIDE;
  const ux = p[ib] - p[ia], uy = p[ib + 1] - p[ia + 1], uz = p[ib + 2] - p[ia + 2];
  const vx = p[ic] - p[ia], vy = p[ic + 1] - p[ia + 1], vz = p[ic + 2] - p[ia + 2];
  const gx = uy * vz - uz * vy;
  const gy = uz * vx - ux * vz;
  const gz = ux * vy - uy * vx;
  const nx = p[ia + 3] + p[ib + 3] + p[ic + 3];
  const ny = p[ia + 4] + p[ib + 4] + p[ic + 4];
  const nz = p[ia + 5] + p[ib + 5] + p[ic + 5];
  return gx * nx + gy * ny + gz * nz >= 0;
}

/**
 * Triangle edges, each drawn once.
 *
 * Chicken wire is the presentation crystallographers read maps in, and it is
 * also the only see-through one that a deferred opaque pipeline can draw
 * without any blending at all. Interior edges are shared by two triangles, so
 * deduplicating halves the buffer and removes the double-drawn lines that
 * otherwise read as uneven weight.
 */
function wireframe(tris: number[]): Uint32Array {
  const seen = new Set<number>();
  const out: number[] = [];
  const add = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    // Vertex counts stay well inside 2^26, so this packs without collision
    // while remaining an exact double.
    const key = lo * 67_108_864 + hi;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a, b);
  };
  for (let t = 0; t < tris.length; t += 3) {
    add(tris[t], tris[t + 1]);
    add(tris[t + 1], tris[t + 2]);
    add(tris[t + 2], tris[t]);
  }
  return Uint32Array.from(out);
}

/**
 * Cells within `radius` of a point, rasterised straight into a byte grid.
 *
 * Marking every cell in a sphere around every atom is the obvious way and it
 * is quadratic in the wrong variable: at 0.6 Å sampling and a 3 Å radius that
 * is a thousand cells per atom, which is fine for a protein and hopeless for a
 * capsid. The caller decides whether to ask; this only guards the arithmetic.
 */
export function nearMask(grid: VolumeGrid, points: Float32Array, radius: number): Uint8Array {
  const [nx, ny, nz] = grid.counts;
  const mask = new Uint8Array(nx * ny * nz);
  const { origin, stepA, stepB, stepC } = grid;
  const sa = Math.hypot(stepA[0], stepA[1], stepA[2]) || 1;
  const sb = Math.hypot(stepB[0], stepB[1], stepB[2]) || 1;
  const sc = Math.hypot(stepC[0], stepC[1], stepC[2]) || 1;
  const ra = Math.ceil(radius / sa), rb = Math.ceil(radius / sb), rc = Math.ceil(radius / sc);

  for (let p = 0; p + 2 < points.length; p += 3) {
    const dx = points[p] - origin[0];
    const dy = points[p + 1] - origin[1];
    const dz = points[p + 2] - origin[2];
    const ci = Math.round((dx * stepA[0] + dy * stepA[1] + dz * stepA[2]) / (sa * sa));
    const cj = Math.round((dx * stepB[0] + dy * stepB[1] + dz * stepB[2]) / (sb * sb));
    const ck = Math.round((dx * stepC[0] + dy * stepC[1] + dz * stepC[2]) / (sc * sc));

    for (let k = Math.max(ck - rc, 0); k <= Math.min(ck + rc, nz - 1); k++) {
      for (let j = Math.max(cj - rb, 0); j <= Math.min(cj + rb, ny - 1); j++) {
        const row = nx * (j + ny * k);
        for (let i = Math.max(ci - ra, 0); i <= Math.min(ci + ra, nx - 1); i++) {
          mask[i + row] = 1;
        }
      }
    }
  }
  return mask;
}
