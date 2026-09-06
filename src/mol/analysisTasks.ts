import { compareInterfaceSides } from './interfaceComparison';
import { findInterfaces, type ChainInterface } from './interfaces';
import { ligandContacts, type LigandReport } from './ligandContacts';
import {
  DEFAULT_SURFACE_OPTIONS,
  gaussianSurface,
  chargesOf,
  colorSurfaceByPotential,
} from '../gfx/surface';
import {
  isosurface,
  nearMask,
  levelWithinBudget,
  type IsoMesh,
} from '../gfx/isosurface';
import { VDW_RADII } from './elements';
import type { Structure } from './structure';
import type { SurfaceState, DensityState } from '../state/store';
import type { VolumeSet } from '../rcsb/volume';
import { residueNeighbours } from './investigation';

export type AnalysisTask =
  | {
      kind: 'interface-comparison';
      reference: Structure;
      mobile: Structure;
      referenceInterface: ChainInterface;
      mobileInterface: ChainInterface;
      reverse: boolean;
    }
  | {
      kind: 'surface';
      structure: Structure;
      atoms: Int32Array;
      colors: Uint32Array | null;
      settings: SurfaceState;
    }
  | {
      kind: 'density';
      set: VolumeSet;
      points: Float32Array | null;
      settings: DensityState;
      autoLevel: boolean;
    }
  | { kind: 'neighbours'; structure: Structure; residue: number }
  | {
      kind: 'context';
      structure: Structure;
      assemblyId: string;
      ligand: number | null;
    };
export interface DensityMesh {
  mesh: IsoMesh;
  color: [number, number, number];
}
export type AnalysisResult =
  | {
      kind: 'interface-comparison';
      sides: ReturnType<typeof compareInterfaceSides>;
    }
  | { kind: 'surface'; mesh: IsoMesh; resolution: number }
  | {
      kind: 'density';
      entries: DensityMesh[];
      level: number;
      triangles: number;
      truncated: boolean;
    }
  | { kind: 'neighbours'; neighbours: ReturnType<typeof residueNeighbours> }
  | {
      kind: 'context';
      interfaces: ChainInterface[];
      ligand: LigandReport | null;
    };

export function calculateAnalysis(task: AnalysisTask): AnalysisResult {
  if (task.kind === 'interface-comparison')
    return {
      kind: task.kind,
      sides: compareInterfaceSides(
        task.reference,
        task.mobile,
        task.referenceInterface,
        task.mobileInterface,
        task.reverse,
      ),
    };
  if (task.kind === 'context') {
    const assembly =
      task.structure.assemblies.find((a) => a.id === task.assemblyId) ?? null;
    const chains = assembly
      ? new Set(assembly.gens.flatMap((g) => g.asymIds))
      : null;
    const mask = chains
      ? Uint8Array.from(task.structure.atomResidue, (r) =>
          Number(
            chains.has(task.structure.chainLabelId[task.structure.resChain[r]]),
          ),
        )
      : null;
    return {
      kind: 'context',
      interfaces: findInterfaces(task.structure, {
        assembly,
        mask,
      }),
      ligand:
        task.ligand === null
          ? null
          : (ligandContacts(task.structure, { residues: [task.ligand] })[0] ??
            null),
    };
  }
  if (task.kind === 'neighbours')
    return {
      kind: 'neighbours',
      neighbours: residueNeighbours(task.structure, task.residue),
    };
  if (task.kind === 'surface') {
    const { structure: s, atoms, settings } = task;
    const radii = Float32Array.from(s.element, (e) => VDW_RADII[e]);
    const field = gaussianSurface(s.x, s.y, s.z, radii, atoms, {
      ...DEFAULT_SURFACE_OPTIONS,
      probeRadius: settings.probeRadius,
      resolution: settings.resolution,
      atomColors: task.colors,
    });
    const mesh = isosurface(field.grid, {
      sigma: field.level,
      owner: field.owner,
      colors: field.colors,
    });
    if (settings.coloring === 'coulombic')
      colorSurfaceByPotential(mesh.vertices, chargesOf(s, atoms));
    return { kind: 'surface', mesh, resolution: field.resolution };
  }
  const { set, settings: d, points } = task;
  const masks = set.maps.map((grid) =>
    points ? nearMask(grid, points, d.radius) : null,
  );
  const mainIndex = set.maps.findIndex((m) => !/^fo-fc$/i.test(m.name));
  const level =
    task.autoLevel && mainIndex >= 0
      ? levelWithinBudget(set.maps[mainIndex], d.level, masks[mainIndex])
      : d.level;
  const entries: DensityMesh[] = [];
  for (let i = 0; i < set.maps.length; i++) {
    const grid = set.maps[i];
    const difference = /^fo-fc$/i.test(grid.name);
    if (difference && !d.showDifference) continue;
    const contours: { sigma: number; color: [number, number, number] }[] =
      difference
        ? [
            { sigma: d.diffLevel, color: [0.3, 0.82, 0.45] },
            { sigma: -d.diffLevel, color: [0.95, 0.35, 0.35] },
          ]
        : [
            {
              sigma: level,
              color: set.kind === 'em' ? [0.62, 0.7, 0.82] : [0.42, 0.62, 0.95],
            },
          ];
    for (const { sigma, color } of contours)
      entries.push({
        mesh: isosurface(grid, { sigma, mask: masks[i] }),
        color,
      });
  }
  return {
    kind: 'density',
    entries,
    level,
    triangles: entries.reduce((n, e) => n + e.mesh.triangleCount, 0),
    truncated: entries.some((e) => e.mesh.truncated),
  };
}
