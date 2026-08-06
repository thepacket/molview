/**
 * Where the cavities are, by the LIGSITE buriedness scan.
 *
 * The first question anyone asks of an unfamiliar structure with a
 * ligand-shaped hole in it, and one a viewer can answer geometrically without
 * any energetics at all. A grid point is *buried* when, along enough of the
 * seven axes through it, there is protein on both sides — the
 * protein-solvent-protein event of Hendlich, Rippmann and Barnickel. Group the
 * buried points and each group is a pocket.
 *
 * The method is honest about what it is: it finds concavity, not affinity. A
 * large pocket is not a druggable one and a small one is not unimportant. What
 * it does reliably is find the hole the ligand is already sitting in, which is
 * the check this implementation is validated against — the ligand is excluded
 * from the grid and then looked for in the answer.
 */

import { VDW_RADII } from './elements';
import { MolKind, type Structure } from './structure';

export interface Pocket {
  /** Grid points in the cluster. */
  points: number;
  /** Å³, the point count times the cell volume. */
  volume: number;
  center: [number, number, number];
  /** Residues within reach of the cavity, strongest lining first. */
  lining: { chain: string; seq: number; name: string }[];
  /** Ligands sitting in it. Their presence is the method checking itself. */
  ligands: string[];
}

export interface PocketOptions {
  /** Grid spacing in Å. 0.8 is LIGSITE's own, and the cost is cubic. */
  resolution?: number;
  /** Probe radius added to each van der Waals radius. */
  probe?: number;
  /** Of the seven axes, how many must show protein on both sides. */
  minBuried?: number;
  /** Clusters smaller than this are surface dimples, not pockets. */
  minVolume?: number;
  maxPockets?: number;
}

/**
 * The seven axes: three cardinal and four cubic diagonals. Each is scanned in
 * both senses, so seven lines give fourteen directions of enclosure — enough
 * to tell a pocket from a groove without the cost of a full sphere of rays.
 */
const AXES: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1],
];

export function findPockets(s: Structure, options: PocketOptions = {}): Pocket[] {
  const step = options.resolution ?? 0.8;
  const probe = options.probe ?? 1.4;
  // 4 of 7 rather than LIGSITE's 5: at 5 only the single deepest cavity
  // survives on most structures, which answers "where is the site" but not
  // "where are the cavities". At 4 the ligand pocket still ranks first
  // everywhere it was checked, and the secondary sites appear behind it.
  const minBuried = options.minBuried ?? 4;
  const minVolume = options.minVolume ?? 40;
  const maxPockets = options.maxPockets ?? 8;

  // Only the macromolecule forms the cavity. Ligands and waters are what sits
  // in one, and leaving them in fills the pocket that should be found.
  const atoms: number[] = [];
  for (let a = 0; a < s.atomCount; a++) {
    if (s.element[a] === 1) continue;
    const kind = s.resKind[s.atomResidue[a]];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;
    atoms.push(a);
  }
  if (atoms.length < 50) return [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const a of atoms) {
    if (s.x[a] < minX) minX = s.x[a];
    if (s.x[a] > maxX) maxX = s.x[a];
    if (s.y[a] < minY) minY = s.y[a];
    if (s.y[a] > maxY) maxY = s.y[a];
    if (s.z[a] < minZ) minZ = s.z[a];
    if (s.z[a] > maxZ) maxZ = s.z[a];
  }
  const pad = 4;
  minX -= pad; minY -= pad; minZ -= pad;
  maxX += pad; maxY += pad; maxZ += pad;

  const nx = Math.ceil((maxX - minX) / step) + 1;
  const ny = Math.ceil((maxY - minY) / step) + 1;
  const nz = Math.ceil((maxZ - minZ) / step) + 1;
  const total = nx * ny * nz;
  // A grid this size is the whole cost of the method; refuse rather than hang.
  if (total > 40_000_000) return [];

  const occupied = new Uint8Array(total);
  const index = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  for (const a of atoms) {
    const r = VDW_RADII[s.element[a]] + probe;
    const rr = r * r;
    const span = Math.ceil(r / step);
    const ci = Math.round((s.x[a] - minX) / step);
    const cj = Math.round((s.y[a] - minY) / step);
    const ck = Math.round((s.z[a] - minZ) / step);
    for (let k = Math.max(ck - span, 0); k <= Math.min(ck + span, nz - 1); k++) {
      const dz = minZ + k * step - s.z[a];
      const dz2 = dz * dz;
      if (dz2 > rr) continue;
      for (let j = Math.max(cj - span, 0); j <= Math.min(cj + span, ny - 1); j++) {
        const dy = minY + j * step - s.y[a];
        const dyz = dz2 + dy * dy;
        if (dyz > rr) continue;
        for (let i = Math.max(ci - span, 0); i <= Math.min(ci + span, nx - 1); i++) {
          const dx = minX + i * step - s.x[a];
          if (dyz + dx * dx <= rr) occupied[index(i, j, k)] = 1;
        }
      }
    }
  }

  // Per free point, how many of the seven axes have protein on both sides.
  const buriedCount = new Uint8Array(total);
  const before = new Uint8Array(total);

  for (const [dx, dy, dz] of AXES) {
    before.fill(0);
    // Walk every line in this direction once forward and once backward. A
    // point is enclosed along the axis when protein was seen in both passes,
    // which is exactly the protein-solvent-protein event.
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          // Only start where stepping back would leave the grid.
          if (i - dx >= 0 && i - dx < nx && j - dy >= 0 && j - dy < ny
            && k - dz >= 0 && k - dz < nz) continue;

          let seen = false;
          let ii = i, jj = j, kk = k;
          while (ii >= 0 && ii < nx && jj >= 0 && jj < ny && kk >= 0 && kk < nz) {
            const at = index(ii, jj, kk);
            if (occupied[at]) seen = true;
            else if (seen) before[at] = 1;
            ii += dx; jj += dy; kk += dz;
          }

          // Back down the same line.
          ii -= dx; jj -= dy; kk -= dz;
          seen = false;
          while (ii >= 0 && ii < nx && jj >= 0 && jj < ny && kk >= 0 && kk < nz) {
            const at = index(ii, jj, kk);
            if (occupied[at]) seen = true;
            else if (seen && before[at]) buriedCount[at]++;
            ii -= dx; jj -= dy; kk -= dz;
          }
        }
      }
    }
  }

  // Flood fill the buried points into clusters.
  const cellVolume = step * step * step;
  const visited = new Uint8Array(total);
  const clusters: number[][] = [];
  const queue: number[] = [];

  for (let start = 0; start < total; start++) {
    if (visited[start] || occupied[start] || buriedCount[start] < minBuried) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    const cluster: number[] = [];

    while (queue.length > 0) {
      const at = queue.pop()!;
      cluster.push(at);
      const i = at % nx;
      const j = Math.floor(at / nx) % ny;
      const k = Math.floor(at / (nx * ny));
      for (let d = 0; d < 6; d++) {
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
        const nk = k + (d === 4 ? 1 : d === 5 ? -1 : 0);
        if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
        const next = index(ni, nj, nk);
        if (visited[next] || occupied[next] || buriedCount[next] < minBuried) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    if (cluster.length * cellVolume >= minVolume) clusters.push(cluster);
  }

  clusters.sort((a, b) => b.length - a.length);

  return clusters.slice(0, maxPockets).map((cluster) => {
    let cx = 0, cy = 0, cz = 0;
    for (const at of cluster) {
      cx += minX + (at % nx) * step;
      cy += minY + (Math.floor(at / nx) % ny) * step;
      cz += minZ + Math.floor(at / (nx * ny)) * step;
    }
    const center: [number, number, number] = [
      cx / cluster.length, cy / cluster.length, cz / cluster.length,
    ];
    return {
      points: cluster.length,
      volume: cluster.length * cellVolume,
      center,
      ...describe(s, cluster, { minX, minY, minZ, step, nx, ny }),
    };
  });
}

/**
 * What lines a cavity and what is sitting in it.
 *
 * The ligand check is the useful half: a pocket-finder that cannot find the
 * pocket the ligand occupies is not working, and this is where that shows.
 */
function describe(
  s: Structure,
  cluster: number[],
  grid: { minX: number; minY: number; minZ: number; step: number; nx: number; ny: number },
): { lining: Pocket['lining']; ligands: string[] } {
  const { minX, minY, minZ, step, nx, ny } = grid;
  const points = new Float32Array(cluster.length * 3);
  for (let i = 0; i < cluster.length; i++) {
    const at = cluster[i];
    points[i * 3] = minX + (at % nx) * step;
    points[i * 3 + 1] = minY + (Math.floor(at / nx) % ny) * step;
    points[i * 3 + 2] = minZ + Math.floor(at / (nx * ny)) * step;
  }

  // Hash the cavity points so each atom is tested against its neighbourhood
  // rather than against the whole cluster.
  const cell = 5;
  const buckets = new Map<number, number[]>();
  const key = (i: number, j: number, k: number) =>
    (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let i = 0; i < cluster.length; i++) {
    const k = key(
      Math.floor(points[i * 3] / cell),
      Math.floor(points[i * 3 + 1] / cell),
      Math.floor(points[i * 3 + 2] / cell),
    );
    const bucket = buckets.get(k);
    if (bucket) bucket.push(i);
    else buckets.set(k, [i]);
  }

  const reach = 4.5;
  const reachSq = reach * reach;
  const counts = new Map<number, number>();
  const ligands = new Set<string>();

  for (let a = 0; a < s.atomCount; a++) {
    if (s.element[a] === 1) continue;
    const residue = s.atomResidue[a];
    const kind = s.resKind[residue];
    if (kind === MolKind.Water) continue;

    const gi = Math.floor(s.x[a] / cell);
    const gj = Math.floor(s.y[a] / cell);
    const gk = Math.floor(s.z[a] / cell);
    let near = false;
    for (let di = -1; di <= 1 && !near; di++) {
      for (let dj = -1; dj <= 1 && !near; dj++) {
        for (let dk = -1; dk <= 1 && !near; dk++) {
          const bucket = buckets.get(key(gi + di, gj + dj, gk + dk));
          if (!bucket) continue;
          for (const p of bucket) {
            const dx = points[p * 3] - s.x[a];
            const dy = points[p * 3 + 1] - s.y[a];
            const dz = points[p * 3 + 2] - s.z[a];
            if (dx * dx + dy * dy + dz * dz <= reachSq) { near = true; break; }
          }
        }
      }
    }
    if (!near) continue;

    if (kind === MolKind.Ligand || kind === MolKind.Ion) {
      ligands.add(s.nameTable[s.resNameId[residue]]);
    } else {
      counts.set(residue, (counts.get(residue) ?? 0) + 1);
    }
  }

  const lining = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([residue]) => ({
      chain: s.chainAuthId[s.resChain[residue]],
      seq: s.resSeq[residue],
      name: s.nameTable[s.resNameId[residue]],
    }));

  return { lining, ligands: [...ligands] };
}

/** A selection covering a pocket's lining residues. */
export function pocketSelection(pocket: Pocket): string {
  const byChain = new Map<string, number[]>();
  for (const r of pocket.lining) {
    const list = byChain.get(r.chain);
    if (list) list.push(r.seq);
    else byChain.set(r.chain, [r.seq]);
  }
  return [...byChain]
    .map(([chain, seqs]) => `(/${chain}:${[...seqs].sort((a, b) => a - b).join(',')})`)
    .join(' or ');
}
