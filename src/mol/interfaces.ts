/**
 * Which chains touch which, and where.
 *
 * The obvious question about an assembly, and the one MolView could not answer:
 * you can build a 900-chain capsid from sixty matrices and still have no way to
 * ask what packs against what. This finds the contacts, groups them by chain
 * pair, and hands back a selection for each side so the answer can be drawn
 * rather than just counted.
 *
 * Contacts are geometric — heavy atoms within a cutoff — which is the same
 * standard the hydrogen-bond search uses and the same caveat applies: it is a
 * proximity criterion, not an energetic one. Buried area, which is the number
 * papers quote, is computed separately and on demand: it costs a SASA
 * calculation per pair, and a contact count is enough to rank them first.
 */

import type { Assembly } from './assembly';
import { MolKind, type Structure } from './structure';
import { chainAtoms, interfaceArea, symmetryInterfaceArea } from './sasa';
import { latticeOperators } from './spacegroup';

export interface ChainInterface {
  /** Auth chain ids, ordered so the pair reads the same way every time. */
  chainA: string;
  chainB: string;
  /**
   * Set when chainB belongs to a symmetry copy rather than to the deposited
   * coordinates — the operator index that produced it. Such an interface cannot
   * be written as a selection, because the second half is not in the file.
   */
  copyB?: number;
  /**
   * The operator that produced the copy, column-major 4x4. Carried rather than
   * looked up again from the generator index: with more than one generator the
   * copy number is ambiguous, and the matrix is what the area calculation
   * actually needs.
   */
  transformB?: Float32Array;
  /**
   * True when the copy came from the crystal lattice rather than the
   * biological assembly — the distinction the whole exercise is about, so it
   * travels with the interface rather than being inferred later.
   */
  latticeB?: boolean;
  /** Heavy-atom pairs within the cutoff. */
  contacts: number;
  /** Residues involved on each side, as sequence numbers. */
  residuesA: number[];
  residuesB: number[];
  /** Hydrogen-bond-range contacts, a crude polar/apolar hint. */
  polar: number;
  /**
   * Buried area in Å², computed on demand. Undefined until asked for; null if
   * it could not be computed, which now means only that the operator was not a
   * rigid motion.
   */
  area?: number | null;
}

export interface InterfaceOptions {
  /**
   * When present, contacts with symmetry copies are included. Only the copies
   * around the reference one are tested: in a symmetric assembly every distinct
   * interface appears in the neighbourhood of any single copy, so testing all
   * 60 against all 60 would return the same handful of answers 3,600 times.
   */
  assembly?: Assembly | null;
  /** Heavy-atom separation counted as a contact. 4 A is the usual choice. */
  cutoff?: number;
  /** Ignore pairs with fewer contacts than this — crystal grazes, mostly. */
  minContacts?: number;
  /** Only consider these atoms, so a hidden chain does not appear. */
  mask?: Uint8Array | null;
  /**
   * When true, the crystal lattice is generated and its packing contacts are
   * reported alongside. This is the set the assembly cannot give: a monomeric
   * entry has no assembly copies at all and is still surrounded in the crystal.
   * Ignored for anything without a usable cell, or in a space group the
   * operator table refuses.
   */
  lattice?: boolean;
}

/** One neighbouring copy to test: an operator and which chains it applies to. */
interface Copy {
  /** Column-major 4x4. */
  transform: Float32Array;
  /** label_asym_ids this operator replicates, or null for all of them. */
  asymIds: Set<string> | null;
  /** Stable number for display; distinguishes copies in the panel. */
  index: number;
  /** Set for lattice copies, so the panel can say which kind of neighbour. */
  lattice: boolean;
}

/**
 * Contacts between different auth chains, strongest pair first.
 *
 * Water is excluded: it bridges everything and would bury the result. So are
 * hydrogens, which are absent from most structures anyway and would only shift
 * the counts about.
 */
export function findInterfaces(
  s: Structure, options: InterfaceOptions = {},
): ChainInterface[] {
  const cutoff = options.cutoff ?? 4;
  const minContacts = options.minContacts ?? 8;
  const mask = options.mask ?? null;

  const candidates: number[] = [];
  for (let a = 0; a < s.atomCount; a++) {
    if (mask && !mask[a]) continue;
    if (s.element[a] === 1) continue;
    if (s.resKind[s.atomResidue[a]] === MolKind.Water) continue;
    candidates.push(a);
  }
  if (candidates.length === 0) return [];

  const inv = 1 / cutoff;
  const buckets = new Map<number, number[]>();
  const key = (gx: number, gy: number, gz: number) =>
    (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);

  for (const a of candidates) {
    const k = key(
      Math.floor(s.x[a] * inv), Math.floor(s.y[a] * inv), Math.floor(s.z[a] * inv),
    );
    const bucket = buckets.get(k);
    if (bucket) bucket.push(a);
    else buckets.set(k, [a]);
  }

  interface Pending {
    contacts: number;
    polar: number;
    residuesA: Set<number>;
    residuesB: Set<number>;
  }
  const pairs = new Map<string, Pending>();
  const maxSq = cutoff * cutoff;
  const polarSq = 3.5 * 3.5;

  for (const a of candidates) {
    const chainAIdx = s.resChain[s.atomResidue[a]];
    const gx = Math.floor(s.x[a] * inv);
    const gy = Math.floor(s.y[a] * inv);
    const gz = Math.floor(s.z[a] * inv);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = buckets.get(key(gx + dx, gy + dy, gz + dz));
          if (!bucket) continue;
          for (const b of bucket) {
            if (b <= a) continue;
            const chainBIdx = s.resChain[s.atomResidue[b]];
            if (chainAIdx === chainBIdx) continue;

            const idA = s.chainAuthId[chainAIdx];
            const idB = s.chainAuthId[chainBIdx];
            // An NMR ensemble or a multi-model file repeats auth ids; those are
            // the same chain seen twice, not two chains in contact.
            if (idA === idB) continue;

            const ddx = s.x[a] - s.x[b];
            const ddy = s.y[a] - s.y[b];
            const ddz = s.z[a] - s.z[b];
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 > maxSq) continue;

            const flip = idA > idB;
            const first = flip ? idB : idA;
            const second = flip ? idA : idB;
            const pairKey = `${first}|${second}`;
            let entry = pairs.get(pairKey);
            if (!entry) {
              entry = { contacts: 0, polar: 0, residuesA: new Set(), residuesB: new Set() };
              pairs.set(pairKey, entry);
            }
            entry.contacts++;
            if (d2 <= polarSq) {
              const elA = s.element[a], elB = s.element[b];
              const polarA = elA === 7 || elA === 8 || elA === 16;
              const polarB = elB === 7 || elB === 8 || elB === 16;
              if (polarA && polarB) entry.polar++;
            }
            const resA = s.resSeq[s.atomResidue[a]];
            const resB = s.resSeq[s.atomResidue[b]];
            if (flip) {
              entry.residuesA.add(resB);
              entry.residuesB.add(resA);
            } else {
              entry.residuesA.add(resA);
              entry.residuesB.add(resB);
            }
          }
        }
      }
    }
  }

  const out: ChainInterface[] = [];
  for (const [pairKey, entry] of pairs) {
    if (entry.contacts < minContacts) continue;
    const [chainA, chainB] = pairKey.split('|');
    out.push({
      chainA,
      chainB,
      contacts: entry.contacts,
      polar: entry.polar,
      residuesA: [...entry.residuesA].sort((x, y) => x - y),
      residuesB: [...entry.residuesB].sort((x, y) => x - y),
    });
  }
  const copies: Copy[] = [];
  if (options.assembly) {
    let index = 0;
    for (const gen of options.assembly.gens) {
      const asymIds = new Set(gen.asymIds);
      for (let t = 0; t < gen.count; t++) {
        copies.push({
          transform: gen.transforms.slice(t * 16, t * 16 + 16),
          asymIds, index: ++index, lattice: false,
        });
      }
    }
  }
  if (options.lattice && s.crystal) {
    const ops = latticeOperators(s.crystal.spaceGroupName, s.crystal.cell);
    if (ops) {
      let index = 0;
      for (const transform of ops) {
        copies.push({ transform, asymIds: null, index: ++index, lattice: true });
      }
    }
  }
  if (copies.length > 0) {
    out.push(...copyContacts(s, candidates, copies, cutoff, minContacts));
  }

  out.sort((p, q) => q.contacts - p.contacts);
  return out;
}

/**
 * Contacts between the deposited chains and the symmetry copies around them.
 *
 * Only the copies neighbouring the reference are tested. In a symmetric
 * assembly every distinct interface already appears there, so comparing all
 * sixty copies against all sixty would rediscover the same handful of answers
 * 3,600 times over. Copy pairs whose bounding spheres cannot reach each other
 * are rejected before any atom is transformed, which is what keeps a capsid
 * affordable.
 */
function copyContacts(
  s: Structure, candidates: number[], copies: Copy[],
  cutoff: number, minContacts: number,
): ChainInterface[] {
  // Bounding sphere of the reference coordinates, to reject distant copies.
  let cx = 0, cy = 0, cz = 0;
  for (const a of candidates) { cx += s.x[a]; cy += s.y[a]; cz += s.z[a]; }
  cx /= candidates.length; cy /= candidates.length; cz /= candidates.length;
  let radius = 0;
  for (const a of candidates) {
    radius = Math.max(radius, Math.hypot(s.x[a] - cx, s.y[a] - cy, s.z[a] - cz));
  }

  const inv = 1 / cutoff;
  const key = (gx: number, gy: number, gz: number) =>
    (gx * 73856093) ^ (gy * 19349663) ^ (gz * 83492791);

  // Hash the reference atoms once; every copy is queried against it.
  const buckets = new Map<number, number[]>();
  for (const a of candidates) {
    const k = key(
      Math.floor(s.x[a] * inv), Math.floor(s.y[a] * inv), Math.floor(s.z[a] * inv),
    );
    const bucket = buckets.get(k);
    if (bucket) bucket.push(a);
    else buckets.set(k, [a]);
  }

  const maxSq = cutoff * cutoff;
  const polarSq = 3.5 * 3.5;
  const reach = 2 * radius + cutoff;
  const found = new Map<string, {
    contacts: number; polar: number; residuesA: Set<number>; copy: number;
    chainA: string; chainB: string; transform: Float32Array; lattice: boolean;
  }>();

  {
    for (const copy of copies) {
      const allowed = copy.asymIds;
      const t = copy.index;
      const o = 0;
      const m = copy.transform;

      // Where this copy's centre lands, and whether it can reach at all.
      const tx = m[o] * cx + m[o + 4] * cy + m[o + 8] * cz + m[o + 12];
      const ty = m[o + 1] * cx + m[o + 5] * cy + m[o + 9] * cz + m[o + 13];
      const tz = m[o + 2] * cx + m[o + 6] * cy + m[o + 10] * cz + m[o + 14];
      const shift = Math.hypot(tx - cx, ty - cy, tz - cz);
      // The identity operator reproduces the deposited chains, already done.
      if (shift < 1e-3) continue;
      if (shift > reach) continue;

      for (const b of candidates) {
        const chainB = s.resChain[s.atomResidue[b]];
        if (allowed && !allowed.has(s.chainLabelId[chainB])) continue;

        const bx = m[o] * s.x[b] + m[o + 4] * s.y[b] + m[o + 8] * s.z[b] + m[o + 12];
        const by = m[o + 1] * s.x[b] + m[o + 5] * s.y[b] + m[o + 9] * s.z[b] + m[o + 13];
        const bz = m[o + 2] * s.x[b] + m[o + 6] * s.y[b] + m[o + 10] * s.z[b] + m[o + 14];

        const gx = Math.floor(bx * inv);
        const gy = Math.floor(by * inv);
        const gz = Math.floor(bz * inv);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const bucket = buckets.get(key(gx + dx, gy + dy, gz + dz));
              if (!bucket) continue;
              for (const a of bucket) {
                const ddx = s.x[a] - bx, ddy = s.y[a] - by, ddz = s.z[a] - bz;
                const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
                if (d2 > maxSq) continue;

                const chainA = s.chainAuthId[s.resChain[s.atomResidue[a]]];
                const partner = s.chainAuthId[chainB];
                const k = `${chainA}|${partner}|${t}`;
                let entry = found.get(k);
                if (!entry) {
                  entry = {
                    contacts: 0, polar: 0, residuesA: new Set(), copy: t,
                    chainA, chainB: partner,
                    transform: m, lattice: copy.lattice,
                  };
                  found.set(k, entry);
                }
                entry.contacts++;
                entry.residuesA.add(s.resSeq[s.atomResidue[a]]);
                if (d2 <= polarSq) {
                  const elA = s.element[a], elB = s.element[b];
                  if ((elA === 7 || elA === 8 || elA === 16)
                    && (elB === 7 || elB === 8 || elB === 16)) entry.polar++;
                }
              }
            }
          }
        }
      }
    }
  }

  // A 2-fold relates two neighbours that present the identical interface, so
  // the same answer arrives under two operator numbers. Same chains, same
  // contact count, same residues on our side means the same interface type,
  // and listing it twice only makes the panel longer.
  const seen = new Set<string>();
  const out: ChainInterface[] = [];
  for (const entry of found.values()) {
    if (entry.contacts < minContacts) continue;
    const residues = [...entry.residuesA].sort((x, y) => x - y);
    const signature = `${entry.chainA}|${entry.chainB}|${entry.contacts}|${residues.join(',')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({
      chainA: entry.chainA,
      chainB: entry.chainB,
      copyB: entry.copy,
      transformB: entry.transform,
      latticeB: entry.lattice,
      contacts: entry.contacts,
      polar: entry.polar,
      residuesA: residues,
      // The far side lives in a copy that is not in the file, so there are no
      // residues of it to select. Reporting the near side is the honest half.
      residuesB: [],
    });
  }
  return out;
}

/**
 * A selection covering both sides of an interface.
 *
 * Runs of consecutive residues collapse to ranges, because an interface is
 * usually a few loops and the expanded form would be a hundred numbers long.
 */
/**
 * Fills in the buried area for interfaces that have one, in place.
 *
 * Separate from finding them because it is the expensive half: four SASA
 * passes per pair, against a contact count that is a single neighbour sweep
 * for all pairs at once. Ranking by contacts and then measuring the ones you
 * are going to look at is the right order.
 */
export function measureInterfaceAreas(
  s: Structure, entries: ChainInterface[], mask?: Uint8Array | null,
): void {
  const chains = new Map<string, Uint8Array>();
  const atomsOf = (id: string) => {
    let set = chains.get(id);
    if (!set) {
      set = chainAtoms(s, id, mask);
      chains.set(id, set);
    }
    return set;
  };

  for (const entry of entries) {
    if (entry.transformB) {
      entry.area = symmetryInterfaceArea(
        s, atomsOf(entry.chainA), atomsOf(entry.chainB), entry.transformB, 0,
      );
    } else if (entry.copyB !== undefined) {
      entry.area = null;
    } else {
      entry.area = interfaceArea(s, atomsOf(entry.chainA), atomsOf(entry.chainB));
    }
  }
}

export function interfaceSelection(entry: ChainInterface): string {
  // Only the deposited side of a symmetry interface exists to be selected.
  if (entry.copyB !== undefined) return side(entry.chainA, entry.residuesA);
  return `(${side(entry.chainA, entry.residuesA)}) or (${side(entry.chainB, entry.residuesB)})`;
}

function side(chain: string, residues: number[]): string {
  return `/${chain}:${ranges(residues)}`;
}

function ranges(values: number[]): string {
  const parts: string[] = [];
  let start = 0;
  while (start < values.length) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) end++;
    parts.push(end > start ? `${values[start]}-${values[end]}` : `${values[start]}`);
    start = end + 1;
  }
  return parts.join(',');
}
