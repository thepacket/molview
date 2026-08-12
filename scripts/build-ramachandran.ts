/**
 * Builds the Ramachandran reference contours from the PDB itself.
 *
 * The favoured and allowed regions of a Ramachandran plot are not computed
 * from anything — they are an empirical distribution, measured once over a set
 * of structures good enough to be taken as ground truth. MolProbity's come
 * from the Richardson lab's filtered Top8000. Rather than transcribe numbers
 * whose provenance would then live in a comment, this derives them the same
 * way, from structures fetched here, so the sample and the filters are visible
 * and the whole thing can be rebuilt.
 *
 * The output is a coarse classification grid per residue category, run-length
 * encoded into `src/mol/ramachandranData.ts`.
 *
 * Run:
 *   npm run build:rama
 *
 * It fetches a few hundred structures, so it takes a few minutes and is not
 * part of the ordinary build. The generated file is committed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseBinaryCif } from '../src/rcsb/bcif';
import { buildStructure } from '../src/mol/structure';
import { computeRamachandran, RAMA_CATEGORIES, type RamaCategory } from '../src/mol/ramachandran';

// --- parameters -------------------------------------------------------------

/** Degrees per grid bin. 180x180 over the full -180..180 square. */
const BIN = 2;
const N = 360 / BIN;

/**
 * Resolution cutoff for the reference set. Tighter than "good": these
 * structures define what a correct backbone looks like, so a mediocre one
 * contributes noise to the very thing being measured.
 */
const MAX_RESOLUTION = 1.5;
const WANTED_STRUCTURES = 900;
const CONCURRENCY = 12;

/**
 * Residues above this B-factor are dropped. A poorly ordered residue has a
 * poorly determined dihedral, and including it widens the contours with
 * exactly the uncertainty the contours are supposed to exclude.
 */
const MAX_B_FACTOR = 30;

/** Contour levels, as the fraction of reference residues enclosed. */
const FAVOURED_FRACTION = 0.98;
const ALLOWED_FRACTION = 0.9995;

/** Gaussian smoothing width, in bins. */
const SMOOTH_SIGMA = 3;

// --- fetching ---------------------------------------------------------------

async function highResolutionEntries(): Promise<string[]> {
  const query = {
    query: {
      type: 'group',
      logical_operator: 'and',
      nodes: [
        {
          type: 'terminal', service: 'text',
          parameters: {
            attribute: 'exptl.method', operator: 'exact_match',
            value: 'X-RAY DIFFRACTION',
          },
        },
        {
          type: 'terminal', service: 'text',
          parameters: {
            attribute: 'rcsb_entry_info.resolution_combined',
            operator: 'less_or_equal', value: MAX_RESOLUTION,
          },
        },
        {
          type: 'terminal', service: 'text',
          parameters: {
            attribute: 'rcsb_entry_info.polymer_entity_count_protein',
            operator: 'greater', value: 0,
          },
        },
      ],
    },
    return_type: 'entry',
    request_options: {
      paginate: { start: 0, rows: WANTED_STRUCTURES },
      sort: [{ sort_by: 'rcsb_entry_info.resolution_combined', direction: 'asc' }],
    },
  };

  const res = await fetch('https://search.rcsb.org/rcsbsearch/v2/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { result_set: { identifier: string }[] };
  return json.result_set.map((r) => r.identifier);
}

/**
 * Coordinates are cached on disk, because the expensive part of rebuilding
 * these contours is the download and the reason to rebuild them is usually a
 * change to the filters or the smoothing.
 */
const CACHE = new URL('../node_modules/.cache/rama-bcif/', import.meta.url);

async function cachedFetch(id: string): Promise<ArrayBuffer | null> {
  mkdirSync(CACHE, { recursive: true });
  const path = new URL(`${id.toUpperCase()}.bcif`, CACHE);
  if (existsSync(path)) {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  const res = await fetch(`https://models.rcsb.org/${id.toLowerCase()}.bcif`);
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  writeFileSync(path, Buffer.from(buffer));
  return buffer;
}

// --- accumulation -----------------------------------------------------------

const grids = new Map<RamaCategory, Float64Array>();
const counts = new Map<RamaCategory, number>();
for (const c of RAMA_CATEGORIES) {
  grids.set(c, new Float64Array(N * N));
  counts.set(c, 0);
}

function binOf(angle: number): number {
  // -180..180 -> 0..N-1, wrapping so that +180 and -180 are the same bin.
  let i = Math.floor((angle + 180) / BIN);
  if (i < 0) i += N;
  if (i >= N) i -= N;
  return i;
}

function accumulate(id: string, buffer: ArrayBuffer): number {
  const block = parseBinaryCif(buffer);
  const s = buildStructure(block, id, id, {});
  let used = 0;

  for (const p of computeRamachandran(s)) {
    const r = p.residue;
    // Ambiguous backbones are excluded rather than resolved: a residue with
    // alternate conformations has more than one phi, and the reference should
    // not be asked to guess which.
    if (s.resAltCount[r] > 0) continue;

    let bSum = 0, bN = 0;
    for (let a = s.resAtomStart[r]; a < s.resAtomStart[r + 1]; a++) {
      bSum += s.bFactor[a]; bN++;
    }
    if (bN === 0 || bSum / bN > MAX_B_FACTOR) continue;

    const g = grids.get(p.category)!;
    g[binOf(p.psi) * N + binOf(p.phi)] += 1;
    counts.set(p.category, counts.get(p.category)! + 1);
    used++;
  }
  return used;
}

// --- smoothing and contouring ----------------------------------------------

/**
 * Separable Gaussian blur that wraps at the edges. Wrapping matters: phi/psi
 * space is a torus, and a helix sitting near -180 psi is continuous with the
 * density at +180. Treating the edges as walls carves a false cliff straight
 * through the beta region.
 */
function smooth(src: Float64Array): Float64Array {
  const radius = Math.ceil(SMOOTH_SIGMA * 3);
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * SMOOTH_SIGMA * SMOOTH_SIGMA));
    kernel.push(w); sum += w;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += src[y * N + ((x + k + N * 2) % N)] * kernel[k + radius];
      }
      tmp[y * N + x] = acc;
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        acc += tmp[((y + k + N * 2) % N) * N + x] * kernel[k + radius];
      }
      out[y * N + x] = acc;
    }
  }
  return out;
}

/**
 * The density level enclosing a given fraction of the distribution — the
 * highest-density-region definition, which is what "98% of residues fall
 * inside the favoured contour" actually means. Cells are ranked by density and
 * taken until the requested mass is covered; the density of the last one taken
 * is the level.
 */
function levelFor(density: Float64Array, fraction: number): number {
  const sorted = Array.from(density).sort((a, b) => b - a);
  let total = 0;
  for (const v of sorted) total += v;
  const target = total * fraction;
  let acc = 0;
  for (const v of sorted) {
    acc += v;
    if (acc >= target) return v;
  }
  return 0;
}

/** 0 outlier, 1 allowed, 2 favoured. */
function classify(density: Float64Array): Uint8Array {
  const favoured = levelFor(density, FAVOURED_FRACTION);
  const allowed = levelFor(density, ALLOWED_FRACTION);
  const out = new Uint8Array(N * N);
  for (let i = 0; i < out.length; i++) {
    out[i] = density[i] >= favoured ? 2 : density[i] >= allowed ? 1 : 0;
  }
  return out;
}

/** Run-length encode as "value:count" pairs; the grid is mostly flat. */
function rle(grid: Uint8Array): string {
  const parts: string[] = [];
  let value = grid[0], run = 0;
  for (const v of grid) {
    if (v === value) run++;
    else { parts.push(`${value}:${run}`); value = v; run = 1; }
  }
  parts.push(`${value}:${run}`);
  return parts.join(',');
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write(`Searching for X-ray entries at ${MAX_RESOLUTION} A or better...\n`);
  const ids = await highResolutionEntries();
  process.stdout.write(`  ${ids.length} entries\n`);

  let done = 0, failed = 0, residues = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= ids.length) return;
      const id = ids[i];
      try {
        const buffer = await cachedFetch(id);
        if (!buffer) { failed++; continue; }
        // Deliberately its own statement. Written as `residues += accumulate(
        // ..., await ...)` the read of `residues` happens before the await and
        // the write after it, so twelve concurrent workers lose updates — the
        // first run of this script reported 65,371 residues against a true
        // 156,015.
        const used = accumulate(id, buffer);
        residues += used;
      } catch {
        failed++;
      }
      done++;
      if (done % 25 === 0) {
        process.stdout.write(`  ${done}/${ids.length} structures, ${residues} residues\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write(`Done: ${done} structures (${failed} failed), ${residues} residues\n\n`);

  const lines: string[] = [];
  const summary: string[] = [];
  for (const c of RAMA_CATEGORIES) {
    const n = counts.get(c)!;
    const density = smooth(grids.get(c)!);
    const encoded = rle(classify(density));
    lines.push(`  ${c}: '${encoded}',`);
    summary.push(`${c} ${n}`);
    process.stdout.write(`  ${c}: ${n} residues, ${encoded.length} chars encoded\n`);
  }

  const source = `/**
 * Ramachandran reference contours, generated by \`scripts/build-ramachandran.ts\`.
 *
 * DO NOT EDIT. Run \`npm run build:rama\` to rebuild.
 *
 * Derived from ${done} X-ray structures at ${MAX_RESOLUTION} A or better, taking
 * residues with mean B-factor at or below ${MAX_B_FACTOR} and no alternate
 * conformation: ${summary.join(', ')}.
 *
 * Each grid is ${N}x${N} bins of ${BIN} degrees over phi and psi, indexed
 * [psiBin * ${N} + phiBin], run-length encoded as "value:count" pairs where the
 * value is 0 for outlier, 1 for allowed and 2 for favoured. The contours are
 * highest-density regions enclosing ${FAVOURED_FRACTION * 100}% and
 * ${ALLOWED_FRACTION * 100}% of the reference residues, after a Gaussian blur of
 * ${SMOOTH_SIGMA} bins that wraps at the edges — phi/psi space is a torus, and
 * treating its edges as walls cuts a false cliff through the beta region.
 */

export const RAMA_BIN = ${BIN};
export const RAMA_GRID = ${N};

export const RAMA_CONTOURS: Record<string, string> = {
${lines.join('\n')}
};
`;

  // Relative to the working directory, not to import.meta.url: the script is
  // bundled into node_modules/.cache before it runs, so a URL relative to the
  // module resolves inside node_modules.
  writeFileSync('src/mol/ramachandranData.ts', source);
  process.stdout.write('\nWrote src/mol/ramachandranData.ts\n');
}

void main();
