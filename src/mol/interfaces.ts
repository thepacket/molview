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
 * proximity criterion, not an energetic one, and it does not compute buried
 * surface area. It tells you where to look.
 */

import { MolKind, type Structure } from './structure';

export interface ChainInterface {
  /** Auth chain ids, ordered so the pair reads the same way every time. */
  chainA: string;
  chainB: string;
  /** Heavy-atom pairs within the cutoff. */
  contacts: number;
  /** Residues involved on each side, as sequence numbers. */
  residuesA: number[];
  residuesB: number[];
  /** Hydrogen-bond-range contacts, a crude polar/apolar hint. */
  polar: number;
}

export interface InterfaceOptions {
  /** Heavy-atom separation counted as a contact. 4 A is the usual choice. */
  cutoff?: number;
  /** Ignore pairs with fewer contacts than this — crystal grazes, mostly. */
  minContacts?: number;
  /** Only consider these atoms, so a hidden chain does not appear. */
  mask?: Uint8Array | null;
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
  out.sort((p, q) => q.contacts - p.contacts);
  return out;
}

/**
 * A selection covering both sides of an interface.
 *
 * Runs of consecutive residues collapse to ranges, because an interface is
 * usually a few loops and the expanded form would be a hundred numbers long.
 */
export function interfaceSelection(entry: ChainInterface): string {
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
