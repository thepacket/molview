/**
 * Biological assemblies.
 *
 * What a depositor puts in the file is the asymmetric unit, which is often not
 * the biological molecule: a viral capsid may be deposited as one of sixty
 * copies. `pdbx_struct_assembly_gen` says which chains to replicate and which
 * of the `pdbx_struct_oper_list` transforms to apply, and the operator
 * expression is a product of operator sets — `(1-60)(61-88)` means every
 * combination of the two, 1680 copies in total.
 */

import type { CifBlock } from '../rcsb/cif';

export interface AssemblyGen {
  /** label_asym_id values this generator replicates. */
  asymIds: string[];
  /** Column-major 4x4 matrices, 16 floats per copy. */
  transforms: Float32Array;
  count: number;
}

export interface Assembly {
  id: string;
  details: string;
  oligomericDetails: string;
  /** Chain count the depositor states for this assembly; used as a checksum. */
  oligomericCount: number;
  gens: AssemblyGen[];
  /** Copies summed across generators — what the renderer actually instances. */
  totalCopies: number;
}

/**
 * Splits an operator expression into its groups.
 * `"1"` → `[["1"]]`, `"1,2"` → `[["1","2"]]`, `"(1-60)(61-88)"` → two groups.
 */
export function parseOperExpression(expression: string): string[][] {
  const groups: string[][] = [];
  const parenthesised = expression.match(/\(([^)]*)\)/g);

  const expandList = (list: string): string[] => {
    const out: string[] = [];
    for (const token of list.split(',')) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      // Ranges are numeric only; ids like "X0" or "P" are literals.
      const range = /^(\d+)-(\d+)$/.exec(trimmed);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        for (let i = from; i <= to; i++) out.push(String(i));
      } else {
        out.push(trimmed);
      }
    }
    return out;
  };

  if (parenthesised) {
    for (const group of parenthesised) {
      groups.push(expandList(group.slice(1, -1)));
    }
  } else {
    groups.push(expandList(expression));
  }

  return groups.filter((g) => g.length > 0);
}

/** Cartesian product of the operator groups, outermost group first. */
export function expandOperExpression(expression: string): string[][] {
  const groups = parseOperExpression(expression);
  if (groups.length === 0) return [];

  let combinations: string[][] = [[]];
  for (const group of groups) {
    const next: string[][] = [];
    for (const prefix of combinations) {
      for (const id of group) next.push([...prefix, id]);
    }
    combinations = next;
  }
  return combinations;
}

/** Reads the 3x3 rotation and translation into a column-major 4x4. */
function readOperator(
  cat: ReturnType<CifBlock['category']>, row: number, out: Float32Array, offset: number,
): void {
  for (let col = 0; col < 3; col++) {
    for (let r = 0; r < 3; r++) {
      // mmCIF stores matrix[row][col]; column-major wants column-major.
      out[offset + col * 4 + r] = cat.field(`matrix[${r + 1}][${col + 1}]`).num(row);
    }
    out[offset + col * 4 + 3] = 0;
  }
  out[offset + 12] = cat.field('vector[1]').num(row);
  out[offset + 13] = cat.field('vector[2]').num(row);
  out[offset + 14] = cat.field('vector[3]').num(row);
  out[offset + 15] = 1;
}

/** out = a * b, both column-major 4x4 at the given offsets. */
function multiplyInto(
  out: Float32Array, outOffset: number,
  a: Float32Array, aOffset: number,
  b: Float32Array, bOffset: number,
): void {
  for (let col = 0; col < 4; col++) {
    const b0 = b[bOffset + col * 4];
    const b1 = b[bOffset + col * 4 + 1];
    const b2 = b[bOffset + col * 4 + 2];
    const b3 = b[bOffset + col * 4 + 3];
    for (let r = 0; r < 4; r++) {
      out[outOffset + col * 4 + r] =
        a[aOffset + r] * b0
        + a[aOffset + 4 + r] * b1
        + a[aOffset + 8 + r] * b2
        + a[aOffset + 12 + r] * b3;
    }
  }
}

const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function identityTransform(): Float32Array {
  return IDENTITY.slice();
}

export function parseAssemblies(block: CifBlock): Assembly[] {
  const asmCat = block.category('pdbx_struct_assembly');
  const genCat = block.category('pdbx_struct_assembly_gen');
  const operCat = block.category('pdbx_struct_oper_list');
  if (genCat.rowCount === 0 || operCat.rowCount === 0) return [];

  // Operator id → its 4x4, packed into one array.
  const operIndex = new Map<string, number>();
  const operMatrices = new Float32Array(operCat.rowCount * 16);
  for (let i = 0; i < operCat.rowCount; i++) {
    operIndex.set(operCat.field('id').str(i), i);
    readOperator(operCat, i, operMatrices, i * 16);
  }

  const byAssembly = new Map<string, AssemblyGen[]>();

  for (let g = 0; g < genCat.rowCount; g++) {
    const assemblyId = genCat.field('assembly_id').str(g);
    const asymIds = genCat.field('asym_id_list').str(g)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const combinations = expandOperExpression(genCat.field('oper_expression').str(g));
    if (combinations.length === 0 || asymIds.length === 0) continue;

    const transforms = new Float32Array(combinations.length * 16);
    const scratch = new Float32Array(16);
    let written = 0;

    for (const combination of combinations) {
      // Rightmost operator applies first, so compose left-to-right.
      let current = IDENTITY;
      let currentOffset = 0;
      let first = true;
      let ok = true;

      for (const id of combination) {
        const index = operIndex.get(id);
        if (index === undefined) { ok = false; break; }
        if (first) {
          current = operMatrices;
          currentOffset = index * 16;
          first = false;
        } else {
          multiplyInto(scratch, 0, current, currentOffset, operMatrices, index * 16);
          current = scratch;
          currentOffset = 0;
        }
      }
      if (!ok) continue;

      transforms.set(current.subarray(currentOffset, currentOffset + 16), written * 16);
      written++;
    }

    if (written === 0) continue;

    const list = byAssembly.get(assemblyId) ?? [];
    list.push({
      asymIds,
      transforms: written === combinations.length
        ? transforms
        : transforms.slice(0, written * 16),
      count: written,
    });
    byAssembly.set(assemblyId, list);
  }

  const details = new Map<string, { details: string; oligo: string; count: number }>();
  for (let i = 0; i < asmCat.rowCount; i++) {
    details.set(asmCat.field('id').str(i), {
      details: asmCat.field('details').str(i),
      oligo: asmCat.field('oligomeric_details').str(i),
      count: asmCat.field('oligomeric_count').num(i),
    });
  }

  const assemblies: Assembly[] = [];
  for (const [id, gens] of byAssembly) {
    const meta = details.get(id);
    assemblies.push({
      id,
      details: meta?.details ?? '',
      oligomericDetails: meta?.oligo ?? '',
      oligomericCount: Number.isFinite(meta?.count) ? (meta?.count as number) : 0,
      gens,
      totalCopies: gens.reduce((sum, g) => sum + g.count, 0),
    });
  }

  assemblies.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return assemblies;
}

/** Total chain copies an assembly produces, for checking against the file. */
export function assemblyChainCount(assembly: Assembly): number {
  return assembly.gens.reduce((sum, g) => sum + g.count * g.asymIds.length, 0);
}
