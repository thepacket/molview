import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseMmCif, STRUCTURE_CATEGORIES } from '../src/rcsb/mmcif';
import { buildStructure, resNameOf } from '../src/mol/structure';
import { alignableChains, superposeChains } from '../src/mol/align';
import {
  comparisonSummary,
  residueLabel,
  residueNeighbours,
  occupancySummary,
} from '../src/mol/investigation';
import { calculateAnalysis } from '../src/mol/analysisTasks';
import { DEFAULT_SURFACE, DEFAULT_DENSITY } from '../src/state/store';
import { gaussianSurface, DEFAULT_SURFACE_OPTIONS } from '../src/gfx/surface';
import { isosurface } from '../src/gfx/isosurface';
import { VDW_RADII } from '../src/mol/elements';
import { residueDensityFit } from '../src/mol/densityFit';
const cif = readFileSync('tests/fixtures/1CBS.cif', 'utf8');
const real = buildStructure(
  parseMmCif(cif, STRUCTURE_CATEGORIES),
  '1CBS',
  'Public RCSB fixture',
);

function mini(rows: string[]) {
  const fields = [
    'group_PDB',
    'id',
    'type_symbol',
    'label_atom_id',
    'label_alt_id',
    'label_comp_id',
    'label_asym_id',
    'label_entity_id',
    'label_seq_id',
    'pdbx_PDB_ins_code',
    'Cartn_x',
    'Cartn_y',
    'Cartn_z',
    'occupancy',
    'B_iso_or_equiv',
    'auth_seq_id',
    'auth_asym_id',
    'pdbx_PDB_model_num',
  ];
  return parseMmCif(
    'data_test\nloop_\n' +
      fields.map((f) => '_atom_site.' + f).join('\n') +
      '\n' +
      rows.join('\n') +
      '\n#\n',
    STRUCTURE_CATEGORIES,
  );
}
const alternatives = mini([
  'ATOM 1 C CA A ALA A 1 1 ? 0 0 0 0.2 10 100 A 1',
  'ATOM 2 C CA B ALA A 1 1 ? 1 0 0 0.8 10 100 A 1',
  'ATOM 3 C CA A GLY A 1 2 A 2 0 0 0.9 10 100 A 1',
  'ATOM 4 C CA B GLY A 1 2 A 3 0 0 0.1 10 100 A 1',
  'ATOM 5 C CA . SER A 1 3 ? 4 0 0 ? 10 101 A 1',
  'ATOM 6 C CA . THR A 1 4 ? 5 0 0 0 10 102 A 1',
]);
test('public 1CBS retains deposited atom and polymer counts and ligand identity', () => {
  assert.equal(real.atomCount, 1213);
  assert.equal(alignableChains(real)[0].residues.length, 137);
  const ligand = Array.from(real.resSeq).findIndex(
    (v, r) => v === 200 && resNameOf(real, r) === 'REA',
  );
  assert.ok(ligand >= 0);
  assert.equal(residueLabel(real, ligand), 'A:200 REA');
  const nearby = residueNeighbours(real, ligand);
  assert.ok(
    nearby.some(
      (n) =>
        real.resSeq[n.residue] === 132 && resNameOf(real, n.residue) === 'ARG',
    ),
  );
  assert.ok(
    nearby.some(
      (n) =>
        real.resSeq[n.residue] === 134 && resNameOf(real, n.residue) === 'TYR',
    ),
  );
  assert.ok(real.assemblies.length > 0);
});
test('occupancy choice is independent per residue; insertion codes and missing occupancy survive', () => {
  const s = buildStructure(alternatives, 'test', 'test');
  assert.equal(s.atomCount, 3);
  assert.deepEqual([...s.x], [1, 2, 4]);
  assert.deepEqual(s.resAltLoc, ['B', 'A', '']);
  assert.deepEqual(s.resInsCode, ['', 'A', '']);
  assert.equal(residueLabel(s, 1), 'A:100A GLY');
  assert.deepEqual([...s.resLabelSeq], [1, 2, 3]);
  assert.ok(Number.isNaN(s.occupancy[2]));
  assert.equal(occupancySummary(s, 2).unknown, 1);
  const explicit = buildStructure(alternatives, 'test', 'test', {
    altLoc: 'A',
  });
  assert.deepEqual([...explicit.x], [0, 2, 4]);
});
test('ensemble neighbours cannot cross model boundaries', () => {
  const s = buildStructure(
    mini([
      'ATOM 1 C CA . ALA A 1 1 ? 0 0 0 1 10 1 A 1',
      'ATOM 2 C CA . ALA A 1 1 ? 1 0 0 1 10 1 A 2',
    ]),
    'test',
    'test',
    { allModels: true },
  );
  assert.equal(s.chainCount, 2);
  assert.equal(residueNeighbours(s, 0).length, 0);
});
test('rigidly rotated and translated public structure aligns without losing coverage', () => {
  const moved = {
    ...real,
    x: Float32Array.from(real.y, (v) => -v + 17),
    y: Float32Array.from(real.x, (v) => v - 8),
    z: Float32Array.from(real.z, (v) => v + 2),
  };
  const refChain = alignableChains(real)[0],
    mobChain = alignableChains(moved)[0];
  const result = superposeChains(real, refChain, moved, mobChain);
  assert.ok(result.rmsd < 0.00001);
  assert.equal(result.pairsUsed, 137);
  const report = comparisonSummary(real, moved, 'A', 'A', result.alignment);
  assert.equal(report.identity, 1);
  assert.equal(report.referenceCoverage, 1);
  assert.equal(report.mobileCoverage, 1);
  assert.equal(report.substitutions.length, 0);
});
test('pruned pairs remain available in displacement evidence', () => {
  const pairs = [
    {
      referenceResidue: 0,
      mobileResidue: 0,
      referenceSeq: 1,
      mobileSeq: 1,
      referenceCode: 'A',
      mobileCode: 'V',
      distance: 7,
      used: false,
    },
  ];
  const report = comparisonSummary(real, real, 'A', 'A', pairs);
  assert.equal(report.fitted, 0);
  assert.equal(report.excluded, 1);
  assert.equal(report.largest[0].distance, 7);
  assert.equal(report.substitutions.length, 1);
});
test('worker surface calculation matches the established synchronous numerical path', () => {
  const atoms = Int32Array.from({ length: 30 }, (_, i) => i);
  const settings = { ...DEFAULT_SURFACE, resolution: 1.1 };
  const result = calculateAnalysis({
    kind: 'surface',
    structure: real,
    atoms,
    settings,
    colors: null,
  });
  assert.equal(result.kind, 'surface');
  if (result.kind !== 'surface') return;
  const field = gaussianSurface(
    real.x,
    real.y,
    real.z,
    Float32Array.from(real.element, (e) => VDW_RADII[e]),
    atoms,
    { ...DEFAULT_SURFACE_OPTIONS, resolution: 1.1, atomColors: null },
  );
  const mesh = isosurface(field.grid, {
    sigma: field.level,
    owner: field.owner,
    colors: field.colors,
  });
  assert.ok(result.mesh.triangleCount > 0);
  assert.deepEqual(result.mesh.vertices, mesh.vertices);
  assert.deepEqual(result.mesh.triangles, mesh.triangles);
});
test('density job preserves both signed difference contours and style-only settings', () => {
  const field = gaussianSurface(
    real.x,
    real.y,
    real.z,
    Float32Array.from(real.element, (e) => VDW_RADII[e]),
    Int32Array.from([0, 1, 2]),
    { ...DEFAULT_SURFACE_OPTIONS, resolution: 1 },
  );
  const grid = { ...field.grid, name: 'Fo-Fc' };
  const result = calculateAnalysis({
    kind: 'density',
    set: { kind: 'x-ray', source: 'fixture', maps: [grid], bytes: 0 },
    points: null,
    settings: { ...DEFAULT_DENSITY, showDifference: true },
    autoLevel: false,
  });
  assert.equal(result.kind, 'density');
  if (result.kind !== 'density') return;
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0].color, [0.3, 0.82, 0.45]);
  assert.deepEqual(result.entries[1].color, [0.95, 0.35, 0.35]);
});
test('density fit responds to relative atom occupancy, with unspecified occupancy treated as one', () => {
  const field = gaussianSurface(
    real.x,
    real.y,
    real.z,
    Float32Array.from(real.element, (e) => VDW_RADII[e]),
    Int32Array.from([0, 1, 2, 3, 4]),
    { ...DEFAULT_SURFACE_OPTIONS, resolution: 0.4 },
  );
  const original = residueDensityFit(real, field.grid, { minPoints: 5 })[0]
    .rscc;
  const occupancy = real.occupancy.slice();
  occupancy[0] = 0.05;
  const changed = residueDensityFit({ ...real, occupancy }, field.grid, {
    minPoints: 5,
  })[0].rscc;
  assert.ok(Number.isFinite(original) && Number.isFinite(changed));
  assert.ok(Math.abs(original - changed) > 1e-5);
  occupancy.fill(Number.NaN);
  const unknown = residueDensityFit({ ...real, occupancy }, field.grid, {
    minPoints: 5,
  })[0].rscc;
  assert.equal(unknown, original);
});

test('worker cancellation terminates computation and ignores a late result', async () => {
  const { runAnalysis } = await import('../src/mol/analysis');
  const previous = globalThis.Worker;
  class WorkerStub {
    static latest: WorkerStub;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: unknown;
    onmessageerror: unknown;
    terminated = false;
    constructor() {
      WorkerStub.latest = this;
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = WorkerStub as unknown as typeof Worker;
  try {
    const task = runAnalysis({
      kind: 'neighbours',
      structure: real,
      residue: 0,
    });
    const rejection = assert.rejects(task.promise, { name: 'AbortError' });
    task.cancel();
    assert.equal(WorkerStub.latest.terminated, true);
    WorkerStub.latest.onmessage?.({
      data: { result: { kind: 'neighbours', neighbours: [] } },
    });
    await rejection;
    task.cancel();
  } finally {
    globalThis.Worker = previous;
  }
});

import { parseAnnotations } from '../src/rcsb/annotations';
import {
  parseResidueValidation,
  residueMetrics,
} from '../src/rcsb/residueValidation';
import { mappedResidueMatches } from '../src/rcsb/residueMapping';
import { parseSelection, evaluateSelection } from '../src/mol/selection';
import { findInterfaces } from '../src/mol/interfaces';
import { compareInterfaceSides } from '../src/mol/interfaceComparison';
import { searchBySequence } from '../src/rcsb/api';
const instance = (
  asym: string,
  auth: string,
  mapping: string[],
  values: number[],
) => ({
  rcsb_polymer_entity_instance_container_identifiers: {
    asym_id: asym,
    auth_asym_id: auth,
    auth_to_entity_poly_seq_mapping: mapping,
  },
  rcsb_polymer_instance_feature: [
    { type: 'RSCC', feature_positions: [{ beg_seq_id: 1, values }] },
  ],
});
test('validation preserves insertion codes and duplicate author numbers across archive instances', () => {
  const s = buildStructure(alternatives, 'EDGE', '');
  const v = parseResidueValidation({
    data: {
      entry: {
        polymer_entities: [
          {
            polymer_entity_instances: [
              instance('A', 'A', ['100', '100A', '101'], [0.1, 0.9, 0.5]),
              instance('B', 'A', ['100'], [0.7]),
            ],
          },
        ],
      },
    },
  });
  assert.equal(residueMetrics(v, s, 0)?.rscc, 0.1);
  assert.equal(residueMetrics(v, s, 1)?.rscc, 0.9);
  assert.equal(v.byResidue.has('A:100'), false);
  assert.equal(v.hasDensityFit, true);
  const copy = { ...s, chainModel: s.chainModel.map(() => 2) };
  assert.equal(residueMetrics(v, copy, 1)?.rscc, 0.9);
});
test('annotations use the matching UniProt accession and lossless archive selections', () => {
  const aligns = ['P11111', 'P22222'].map((id, i) => ({
    reference_database_name: 'UniProt',
    reference_database_accession: id,
    aligned_regions: [
      { entity_beg_seq_id: i + 1, ref_beg_seq_id: 10, length: 1 },
    ],
  }));
  const uniprots = ['P11111', 'P22222'].map((rcsb_id) => ({
    rcsb_id,
    rcsb_uniprot_feature: [
      {
        type: 'BINDING_SITE',
        name: 'same name',
        feature_positions: [{ beg_seq_id: 10 }],
      },
    ],
  }));
  const a = parseAnnotations({
    data: {
      entry: {
        polymer_entities: [
          {
            rcsb_polymer_entity_align: aligns,
            uniprots,
            polymer_entity_instances: [
              instance('A', 'A', ['100', '100A', '101'], []),
            ],
          },
        ],
      },
    },
  });
  assert.equal(a.length, 2);
  const inserted = a.find((x) => x.accession === 'P22222')!;
  assert.equal(inserted.residues[0].insertionCode, 'A');
  const s = buildStructure(alternatives, 'EDGE', '');
  assert.ok(mappedResidueMatches(s, 1, inserted.residues[0]));
  assert.ok(!mappedResidueMatches(s, 0, inserted.residues[0]));
  const selected = evaluateSelection(parseSelection(inserted.selection), s);
  assert.equal(
    selected.reduce((a, b) => a + b, 0),
    1,
  );
  assert.equal(selected[s.resAtomStart[1]], 1);
});
test('sequence pagination advances by raw entity hits, including duplicate entries', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.request_options.paginate, { start: 24, rows: 24 });
      return new Response(
        JSON.stringify({
          total_count: 100,
          result_set: [
            { identifier: '1CBS_1', score: 1 },
            { identifier: '1CBS_2', score: 0.9 },
            { identifier: '2FR3_1', score: 0.8 },
          ],
        }),
      );
    };
    const result = await searchBySequence('AAAA', 0.9, 24, undefined, 24);
    assert.equal(result.nextStart, 27);
    assert.equal(result.total, 100);
    assert.equal(result.hits.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});
function twoChains() {
  const rows: string[] = [];
  let id = 1;
  for (const [chain, y] of [
    ['A', 0],
    ['B', 3],
  ] as const)
    for (let r = 0; r < 3; r++)
      rows.push(
        `ATOM ${id++} C CA . ${['ALA', 'GLY', 'SER'][r]} ${chain} 1 ${r + 1} ${r === 1 ? 'A' : '?'} ${r * 3.8} ${y} 0 1 10 ${r === 1 ? 100 : 100 + r} ${chain} 1`,
      );
  return buildStructure(mini(rows), 'PAIR', '');
}
test('interface reports retain both exact residue sets and compare user-paired sides', () => {
  const s = twoChains();
  const iface = findInterfaces(s, { minContacts: 1 })[0];
  assert.deepEqual(iface.residueIndicesA, [0, 1, 2]);
  assert.deepEqual(iface.residueIndicesB, [3, 4, 5]);
  const same = compareInterfaceSides(s, s, iface, iface, false);
  assert.equal(same[0].conserved, 3);
  assert.equal(same[1].conserved, 3);
  assert.equal(same[0].identity, 1);
  const changed = { ...iface, residueIndicesA: [0, 2] };
  const comparison = compareInterfaceSides(s, s, iface, changed, false);
  assert.equal(comparison[0].lost, 1);
  assert.equal(
    comparison[0].contacts.find((p) => p.referenceResidue === 1)?.mobileContact,
    false,
  );
  const reverse = compareInterfaceSides(s, s, iface, iface, true);
  assert.equal(reverse[0].mobileChain, 1);
  assert.equal(reverse[0].conserved, 3);
});
test('symmetry interface retains the source indices of the far side', () => {
  const s = twoChains();
  const transform = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1,
  ]);
  const assembly = {
    id: 'test',
    details: '',
    oligomericDetails: '',
    oligomericCount: 2,
    totalCopies: 1,
    gens: [{ asymIds: ['A'], count: 1, transforms: transform }],
  };
  // Use the assembly's actual matrix field below, matching the public parser.
  const result = findInterfaces(s, { minContacts: 1, assembly });
  const copy = result.find((v) => v.copyB !== undefined && v.chainA === 'A')!;
  assert.ok(copy);
  assert.deepEqual(copy.residueIndicesA, [0, 1, 2]);
  assert.deepEqual(copy.residueIndicesB, [0, 1, 2]);
});
