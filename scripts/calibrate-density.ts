/** Reproducible public-data benchmark. Cache contains raw responses and hashes;
 * delete it to refresh, or set MOLVIEW_OFFLINE=1 to replay without networking. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseMmCif, STRUCTURE_CATEGORIES } from '../src/rcsb/mmcif';
import { buildStructure, MolKind } from '../src/mol/structure';
import { residueDensityFit } from '../src/mol/densityFit';
import { fetchVolumes, sampleSigma } from '../src/rcsb/volume';
import {
  fetchResidueValidation,
  residueMetrics,
} from '../src/rcsb/residueValidation';
import { fetchEntryDetail } from '../src/rcsb/api';
const cache = resolve(
  process.env.MOLVIEW_CALIBRATION_CACHE ?? '.cache/density-calibration',
);
const output = resolve(process.argv[2] ?? 'docs/density-calibration.json');
await mkdir(cache, { recursive: true });
const digest = (x: string | Uint8Array) =>
  createHash('sha256').update(x).digest('hex');
const nativeFetch = globalThis.fetch;
const sources: unknown[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input),
    body = String(init?.body ?? '');
  const key = digest(url + '\n' + body),
    path = resolve(cache, key);
  let bytes: Buffer, metadata: any;
  try {
    bytes = await readFile(path);
    metadata = JSON.parse(await readFile(path + '.json', 'utf8'));
    if (digest(bytes) !== metadata.sha256)
      throw new Error('Cache checksum mismatch');
  } catch (e) {
    if (process.env.MOLVIEW_OFFLINE === '1') throw e;
    const response = await nativeFetch(input, {
      ...init,
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    metadata = {
      url,
      body: body || undefined,
      fetchedAt: new Date().toISOString(),
      sha256: digest(bytes),
    };
    await writeFile(path, bytes);
    await writeFile(path + '.json', JSON.stringify(metadata, null, 2));
  }
  sources.push(metadata);
  return new Response(bytes);
};
function correlation(rows: number[][]) {
  const n = rows.length;
  if (n < 3) return null;
  const x = rows.reduce((v, r) => v + r[0], 0) / n,
    y = rows.reduce((v, r) => v + r[1], 0) / n;
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const [a, b] of rows) {
    xx += (a - x) ** 2;
    yy += (b - y) ** 2;
    xy += (a - x) * (b - y);
  }
  return xx && yy ? xy / Math.sqrt(xx * yy) : null;
}
function summarize(rows: number[][]) {
  return {
    n: rows.length,
    pearson: correlation(rows),
    bias: rows.length
      ? rows.reduce((v, r) => v + r[0] - r[1], 0) / rows.length
      : null,
    mae: rows.length
      ? rows.reduce((v, r) => v + Math.abs(r[0] - r[1]), 0) / rows.length
      : null,
  };
}
const training = ['1UBQ', '1CBS', '3PTB', '2HHB'];
const heldOut = ['1AKE', '1BRS', '1HEL', '1EJG', '2FR3', '3LZT'];
const radii = [1.4, 1.6, 1.8, 2, 2.5];
const entries: any[] = [];
const failures: { id: string; reason: string }[] = [];
for (const id of [...training, ...heldOut]) {
  console.log(`Benchmarking ${id}`);
  try {
    const [raw, validation, detail] = await Promise.all([
      fetch(`https://files.rcsb.org/download/${id}.cif`).then((r) => r.text()),
      fetchResidueValidation(id),
      fetchEntryDetail(id),
    ]);
    const s = buildStructure(parseMmCif(raw, STRUCTURE_CATEGORIES), id, id);
    const min: [number, number, number] = [Infinity, Infinity, Infinity],
      max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let a = 0; a < s.atomCount; a++)
      for (let k = 0; k < 3; k++) {
        const v = [s.x, s.y, s.z][k][a];
        min[k] = Math.min(min[k], v - 6);
        max[k] = Math.max(max[k], v + 6);
      }
    const maps = await fetchVolumes('x-ray', id, { min, max }, 4);
    const grid = maps.maps.find((m) => m.name.toUpperCase().includes('2FO'))!;
    if (!grid) throw new Error(`${id}: 2Fo-Fc map missing`);
    const atomSamples: number[] = [],
      shiftedSamples: number[] = [];
    for (let a = 0; a < s.atomCount; a++)
      if (s.element[a] > 1 && s.resKind[s.atomResidue[a]] === MolKind.Protein) {
        atomSamples.push(sampleSigma(grid, s.x[a], s.y[a], s.z[a]));
        shiftedSamples.push(
          sampleSigma(grid, s.x[a] + 7, s.y[a] + 7, s.z[a] + 7),
        );
      }
    const sampled = (values: number[]) => {
      const finite = values.filter(Number.isFinite);
      return {
        n: finite.length,
        meanSigma: finite.reduce((a, b) => a + b, 0) / finite.length,
        fractionAboveOne: finite.filter((v) => v > 1).length / finite.length,
      };
    };
    const unweighted = {
      ...s,
      occupancy: new Float32Array(s.atomCount).fill(1),
    };
    const runs: any[] = [];
    for (const radius of radii)
      for (const weighted of [true, false]) {
        const fits = residueDensityFit(weighted ? s : unweighted, grid, {
          radius,
          resolution: detail.resolution ?? 2,
        });
        const rows = fits.flatMap((f) => {
          const reference = residueMetrics(validation, s, f.residue)?.rscc;
          return s.resKind[f.residue] === MolKind.Protein &&
            Number.isFinite(f.rscc) &&
            reference != null &&
            Number.isFinite(reference)
            ? [[f.rscc, reference, f.residue, f.points]]
            : [];
        });
        runs.push({ radius, weighted, ...summarize(rows), rows });
      }
    entries.push({
      id,
      split: training.includes(id) ? 'training' : 'held-out',
      resolution: detail.resolution,
      atomDensity: sampled(atomSamples),
      shiftedControl: sampled(shiftedSamples),
      fractionalAtoms: Array.from(s.occupancy).filter((v) => v > 0 && v < 1)
        .length,
      grid: {
        counts: grid.counts,
        stepA: Array.from(grid.stepA),
        stepB: Array.from(grid.stepB),
        stepC: Array.from(grid.stepC),
      },
      runs,
    });
  } catch (e) {
    failures.push({ id, reason: e instanceof Error ? e.message : String(e) });
    console.log(`Unavailable: ${id}`);
  }
}
if (entries.filter(e=>e.split==='training').length !== training.length || entries.filter(e=>e.split==='held-out').length < 3) {
  throw new Error('Incomplete benchmark: all four calibration entries and at least three additional entries are required. Inspect cache/network failures before publishing results.');
}
const aggregate = (split: string, radius: number, weighted: boolean) => {
  const runs = entries
    .filter((e) => e.split === split)
    .map((e) =>
      e.runs.find((r: any) => r.radius === radius && r.weighted === weighted),
    );
  const valid = runs.filter((r) => r.pearson !== null);
  return {
    split,
    radius,
    weighted,
    meanEntryPearson: valid.reduce((v, r) => v + r.pearson, 0) / valid.length,
    pooled: summarize(runs.flatMap((r) => r.rows)),
  };
};
const summaries = ['training', 'held-out'].flatMap((split) =>
  radii.flatMap((radius) =>
    [true, false].map((weighted) => aggregate(split, radius, weighted)),
  ),
);
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 'molview-density-benchmark-1',
      generatedAt: new Date().toISOString(),
      protocol: {
        training,
        heldOut,
        radii,
        detail: 4,
        paddingAngstrom: 6,
        minPoints: 30,
        defaultRadius: 1.8,
        baseline:
          'Same selected coordinates with every atom occupancy set to one',
        limitations:
          'Small convenience sample; held-out entries assess transfer, not independent archive-wide validation. Gaussian density is not refinement RSCC.',
      },
      summaries,
      entries,
      failures,
      sources,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(summaries, null, 2));
