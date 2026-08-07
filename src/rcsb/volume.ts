/**
 * Experimental density maps from RCSB's VolumeServer.
 *
 * The maps arrive as BinaryCIF — the same MessagePack encoding the coordinate
 * files use — so `bcif.ts` reads them and no CCP4/MRC parser is needed. What
 * this module adds is the crystallographic part: a sampled grid lives in
 * fractional coordinates of a unit cell, and the viewer works in Ångströms.
 *
 * Two sources, and they behave differently:
 *
 * - **X-ray** (`/x-ray/{id}/box/...`) returns 2Fo-Fc and Fo-Fc over a
 *   Cartesian box you ask for. The server applies the spacegroup, so asking
 *   for the box around the molecule gives density around the molecule even
 *   when the deposited grid is one asymmetric unit somewhere else in the cell.
 *   It only exists when structure factors were deposited, which is also
 *   exactly when the validation summary can report a fit to density.
 * - **EM** (`/em/emd-{n}/cell`) returns the whole map, keyed by EMDB accession
 *   rather than by PDB id. Its "cell" is the map box and its spacegroup is P1.
 *
 * Both are big enough that the request is worth being deliberate about: a
 * 1 Å-detail box around a large complex is tens of megabytes.
 */

import { parseBinaryCifBlocks } from './bcif';
import type { CifBlock } from './cif';

const VOLUME_ENDPOINT = 'https://maps.rcsb.org';

export type MapKind = 'x-ray' | 'em';

/**
 * A sampled scalar field, already in Cartesian space.
 *
 * Sample `(i, j, k)` sits at `origin + i*stepA + j*stepB + k*stepC`, with `i`
 * varying fastest through `values`. Keeping the three step vectors rather than
 * a spacing triple means a non-orthogonal cell costs nothing extra when
 * *generating* geometry — the skew is baked in once, here. Going the other
 * way, from a point to a grid index, needs `toGrid` and is where a skewed cell
 * does cost something.
 */
export interface VolumeGrid {
  /** '2Fo-Fc', 'Fo-Fc' or 'em', as the server names it. */
  name: string;
  values: Float32Array;
  counts: [number, number, number];
  origin: Float32Array;
  stepA: Float32Array;
  stepB: Float32Array;
  stepC: Float32Array;
  /**
   * World displacement to fractional grid index, row-major 3x3 — the inverse
   * of the matrix whose columns are the three step vectors.
   *
   * Needed because those vectors are not perpendicular in general. Projecting
   * onto each one separately is the same thing only for a cubic, tetragonal or
   * orthorhombic cell; a hexagonal cell has gamma = 120 degrees and a
   * monoclinic one has beta != 90, and for those the projection lands in the
   * wrong voxel. It reads as a map that is displaced rather than absent, which
   * is the failure that looks most like working software.
   */
  toGrid: Float32Array;
  mean: number;
  sigma: number;
  min: number;
  max: number;
}

export interface VolumeSet {
  kind: MapKind;
  /** PDB id for X-ray, EMDB accession for EM — what was actually fetched. */
  source: string;
  maps: VolumeGrid[];
  /** Transferred size, so the UI can say what a refetch will cost. */
  bytes: number;
}

/** Ångström bounding box, as the box query wants it. */
export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export function volumeUrl(kind: MapKind, source: string, box: Box | null, detail: number): string {
  const id = kind === 'em' ? source.toLowerCase() : source.toLowerCase();
  const query = box
    ? `box/${box.min.map(round3).join(',')}/${box.max.map(round3).join(',')}`
    : 'cell';
  return `${VOLUME_ENDPOINT}/${kind}/${id}/${query}?detail=${detail}&encoding=bcif`;
}

function round3(v: number): string {
  return (Math.round(v * 1000) / 1000).toString();
}

export class NoVolumeError extends Error {}

export async function fetchVolumes(
  kind: MapKind,
  source: string,
  box: Box | null,
  detail: number,
  signal?: AbortSignal,
): Promise<VolumeSet> {
  // A 404 from the volume server carries no CORS headers, so the browser
  // rejects the fetch outright rather than handing back a readable status.
  // "Failed to fetch" is true and useless; for this endpoint it almost always
  // means the map does not exist.
  const res = await fetch(volumeUrl(kind, source, box, detail), { signal })
    .catch((err: unknown) => {
      if (signal?.aborted) throw err;
      throw new NoVolumeError(
        `No map was returned for ${source}. Either none is deposited, or the `
        + 'density server could not be reached.',
      );
    });
  if (res.status === 404) {
    throw new NoVolumeError(
      kind === 'x-ray'
        ? 'No density map is available for this entry — structure factors were '
          + 'not deposited, so there is nothing to compare the model against.'
        : `No map is available for ${source}.`,
    );
  }
  if (!res.ok) throw new Error(`VolumeServer ${res.status} ${res.statusText}`);

  const buffer = await res.arrayBuffer();
  const maps = parseVolumes(buffer);
  if (maps.length === 0) {
    throw new NoVolumeError('The server returned no density for that region.');
  }
  return { kind, source, maps, bytes: buffer.byteLength };
}

export function parseVolumes(buffer: ArrayBuffer): VolumeGrid[] {
  const grids: VolumeGrid[] = [];
  for (const block of parseBinaryCifBlocks(buffer)) {
    // The first block is a server status report, not a map.
    if (!block.hasCategory('volume_data_3d_info')) continue;
    const grid = readGrid(block);
    if (grid) grids.push(grid);
  }
  return grids;
}

function readGrid(block: CifBlock): VolumeGrid | null {
  const info = block.category('volume_data_3d_info');
  if (info.rowCount === 0) return null;
  const n = (f: string) => info.field(f).num(0);

  // `axis_order[k]` names the fractional axis that grid axis k runs along, and
  // origin/dimensions/sample_count are all given in grid-axis order. Reading
  // them as fractional-axis order instead produces a grid that is subtly the
  // wrong shape, which is invisible until the density sits beside the model
  // rather than on it.
  const order = [n('axis_order[0]'), n('axis_order[1]'), n('axis_order[2]')];
  const counts: [number, number, number] = [
    n('sample_count[0]'), n('sample_count[1]'), n('sample_count[2]'),
  ];
  const fracOrigin = [n('origin[0]'), n('origin[1]'), n('origin[2]')];
  const fracSize = [n('dimensions[0]'), n('dimensions[1]'), n('dimensions[2]')];

  const cell = fracToCart(
    [n('spacegroup_cell_size[0]'), n('spacegroup_cell_size[1]'), n('spacegroup_cell_size[2]')],
    [n('spacegroup_cell_angles[0]'), n('spacegroup_cell_angles[1]'), n('spacegroup_cell_angles[2]')],
  );

  const origin = new Float32Array(3);
  const steps: Float32Array[] = [];
  for (let k = 0; k < 3; k++) {
    const axis = cell[order[k]];
    for (let c = 0; c < 3; c++) origin[c] += axis[c] * fracOrigin[k];
    // The grid is periodic over `dimensions`, so sample `counts[k]` coincides
    // with sample 0 and the spacing divides by the count, not by count - 1.
    const scale = fracSize[k] / counts[k];
    steps.push(Float32Array.from([axis[0] * scale, axis[1] * scale, axis[2] * scale]));
  }

  const column = block.category('volume_data_3d').field('values');
  const raw = column.raw?.() as ArrayLike<number> | undefined;
  const total = counts[0] * counts[1] * counts[2];
  const values = new Float32Array(total);
  if (raw && raw.length >= total) {
    for (let i = 0; i < total; i++) values[i] = raw[i];
  } else {
    for (let i = 0; i < total; i++) values[i] = column.num(i);
  }

  // Contour levels are quoted in sigma, so a wrong sigma moves every surface
  // the app draws. The header value is normally right and is the conventional
  // one — computed by the server over its own sampling — so it stays the
  // default. But it has been seen to arrive as another map's sigma: twice in a
  // few dozen requests, a block named 2Fo-Fc carried the Fo-Fc value, which
  // would put every contour at 2.5x its intended level. Rather than trust it
  // blindly or discard it for a slightly different local number, check it
  // against the data and fall back only when it is not credible.
  const headerMean = n('mean_sampled');
  const headerSigma = n('sigma_sampled');
  const { mean, sigma } = checkedStats(values, headerMean, headerSigma);

  return {
    name: info.field('name').str(0) || 'map',
    values,
    counts,
    origin,
    stepA: steps[0],
    stepB: steps[1],
    stepC: steps[2],
    toGrid: invertSteps(steps[0], steps[1], steps[2]),
    mean,
    sigma,
    min: n('min_sampled'),
    max: n('max_sampled'),
  };
}

/**
 * The header's mean and sigma, or the ones the samples actually have when the
 * header is not credible.
 *
 * "Not credible" is deliberately loose — a factor of two either way. The server
 * computes sigma over its own sampled region, which legitimately differs from
 * the returned box by ten per cent or so (1AKE: header 0.2465, samples 0.2219),
 * and second-guessing that would replace a convention with a private one. Only
 * a value that cannot be a rounding of the same quantity is rejected.
 */
function checkedStats(
  values: Float32Array, headerMean: number, headerSigma: number,
): { mean: number; sigma: number } {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;
  let sq = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  const sigma = Math.sqrt(sq / values.length);

  const credible = Number.isFinite(headerSigma) && headerSigma > 0
    && sigma > 0 && headerSigma / sigma > 0.5 && headerSigma / sigma < 2;
  if (credible) return { mean: headerMean, sigma: headerSigma };
  if (import.meta.env?.DEV) {
    console.warn(
      `Map header sigma ${headerSigma} disagrees with the samples (${sigma.toFixed(4)}); `
      + 'using the samples. Contour levels would otherwise be wrong.',
    );
  }
  return { mean, sigma };
}

/** The three cell edge vectors in Cartesian space, standard CIF convention. */
function fracToCart(size: number[], angles: number[]): number[][] {
  const [A, B, C] = size;
  const rad = Math.PI / 180;
  const cosA = Math.cos(angles[0] * rad);
  const cosB = Math.cos(angles[1] * rad);
  const cosG = Math.cos(angles[2] * rad);
  const sinG = Math.sin(angles[2] * rad) || 1;
  const v = Math.sqrt(
    Math.max(0, 1 - cosA * cosA - cosB * cosB - cosG * cosG + 2 * cosA * cosB * cosG),
  );
  return [
    [A, 0, 0],
    [B * cosG, B * sinG, 0],
    [C * cosB, (C * (cosA - cosB * cosG)) / sinG, (C * v) / sinG],
  ];
}

/**
 * The three inverse-matrix rows, as the columns of the step matrix inverted.
 *
 * Written out rather than pulled from a library because it is one 3x3 and the
 * whole correctness of every lookup into the grid rests on it.
 */
function invertSteps(a: Float32Array, b: Float32Array, c: Float32Array): Float32Array {
  const m = [
    a[0], b[0], c[0],
    a[1], b[1], c[1],
    a[2], b[2], c[2],
  ];
  const det = m[0] * (m[4] * m[8] - m[5] * m[7])
    - m[1] * (m[3] * m[8] - m[5] * m[6])
    + m[2] * (m[3] * m[7] - m[4] * m[6]);
  // A degenerate cell would make every lookup NaN; an identity at least keeps
  // the failure local and visible rather than blanking the pane.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    return Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }
  return Float32Array.from([
    (m[4] * m[8] - m[5] * m[7]) / det,
    (m[2] * m[7] - m[1] * m[8]) / det,
    (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det,
    (m[0] * m[8] - m[2] * m[6]) / det,
    (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det,
    (m[1] * m[6] - m[0] * m[7]) / det,
    (m[0] * m[4] - m[1] * m[3]) / det,
  ]);
}

/** Fractional grid index of a Cartesian point. Writes `out` and returns it. */
export function gridIndexOf(
  grid: VolumeGrid, x: number, y: number, z: number, out: Float32Array,
): Float32Array {
  const { origin, toGrid } = grid;
  const dx = x - origin[0], dy = y - origin[1], dz = z - origin[2];
  out[0] = toGrid[0] * dx + toGrid[1] * dy + toGrid[2] * dz;
  out[1] = toGrid[3] * dx + toGrid[4] * dy + toGrid[5] * dz;
  out[2] = toGrid[6] * dx + toGrid[7] * dy + toGrid[8] * dz;
  return out;
}

/**
 * How far one index can move for a world displacement of unit length, per
 * axis — the row norms of the inverse. A caller rasterising a sphere of radius
 * r needs `ceil(r * reach)` cells along each axis, which in a skewed cell is
 * more than `r / spacing`.
 */
export function gridReach(grid: VolumeGrid): [number, number, number] {
  const m = grid.toGrid;
  return [
    Math.hypot(m[0], m[1], m[2]),
    Math.hypot(m[3], m[4], m[5]),
    Math.hypot(m[6], m[7], m[8]),
  ];
}

const SCRATCH_INDEX = new Float32Array(3);

/**
 * Trilinear sample at a Cartesian point, in units of sigma above the mean.
 *
 * Goes through the inverse step matrix rather than projecting onto each step
 * vector, because those vectors are only mutually perpendicular in a cubic,
 * tetragonal or orthorhombic cell. Hexagonal, trigonal, monoclinic and
 * triclinic cells are a large part of the archive, and for those the two
 * differ: 101M is P6, and the projection reads 0.06 sigma at its own atoms
 * where the inverse reads 2.85.
 */
export function sampleSigma(grid: VolumeGrid, x: number, y: number, z: number): number {
  const { counts } = grid;
  const index = gridIndexOf(grid, x, y, z, SCRATCH_INDEX);
  const fi = index[0], fj = index[1], fk = index[2];
  if (fi < 0 || fj < 0 || fk < 0
    || fi > counts[0] - 1 || fj > counts[1] - 1 || fk > counts[2] - 1) return Number.NaN;

  const i0 = Math.floor(fi), j0 = Math.floor(fj), k0 = Math.floor(fk);
  const ti = fi - i0, tj = fj - j0, tk = fk - k0;
  const at = (i: number, j: number, k: number) =>
    grid.values[i + counts[0] * (j + counts[1] * k)];
  const i1 = Math.min(i0 + 1, counts[0] - 1);
  const j1 = Math.min(j0 + 1, counts[1] - 1);
  const k1 = Math.min(k0 + 1, counts[2] - 1);

  const c00 = at(i0, j0, k0) * (1 - ti) + at(i1, j0, k0) * ti;
  const c10 = at(i0, j1, k0) * (1 - ti) + at(i1, j1, k0) * ti;
  const c01 = at(i0, j0, k1) * (1 - ti) + at(i1, j0, k1) * ti;
  const c11 = at(i0, j1, k1) * (1 - ti) + at(i1, j1, k1) * ti;
  const c0 = c00 * (1 - tj) + c10 * tj;
  const c1 = c01 * (1 - tj) + c11 * tj;
  const value = c0 * (1 - tk) + c1 * tk;

  return (value - grid.mean) / (grid.sigma || 1);
}
