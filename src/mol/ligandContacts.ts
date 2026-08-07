/**
 * What a bound ligand actually touches.
 *
 * The first question anyone asks of a complex, and the one MolView could only
 * answer with "there are hydrogen bonds somewhere in the pane". This groups the
 * contacts by the residue making them and says what kind each is, so the answer
 * is a short list of residues rather than a cloud of dashes.
 *
 * Every criterion here is geometric. A contact is two atoms close enough and,
 * where it matters, oriented plausibly — it is not an interaction energy, and a
 * long list does not mean tight binding. That distinction is the same one the
 * pocket finder makes about concavity and affinity, and for the same reason.
 */

import { computeBonds } from './bonds';
import { MolKind, atomNameOf, resNameOf, type Structure } from './structure';

export type ContactKind = 'hbond' | 'ionic' | 'hydrophobic' | 'stacking';

export interface LigandContact {
  /** Residue of the partner, in the protein or nucleic acid. */
  residue: number;
  /** Kinds seen between this residue and the ligand, strongest first. */
  kinds: ContactKind[];
  /** Closest heavy-atom approach, Å. */
  closest: number;
  /** Number of atom pairs inside the generous cutoff. */
  pairs: number;
}

export interface LigandReport {
  /** The ligand residue this describes. */
  residue: number;
  name: string;
  contacts: LigandContact[];
  /** Residues bonded to it — a modified residue rather than a bound ligand. */
  covalent: number[];
  /** Buried-ness proxy: partners within 4.5 Å. Not an area. */
  partnerCount: number;
}

/** Hydrogen bond: two polar heavy atoms close enough, no hydrogen required. */
const HBOND_MAX = 3.5;
/** Charged group to charged group. */
const IONIC_MAX = 4.0;
/** Carbon to carbon, the usual van der Waals contact. */
const HYDROPHOBIC_MAX = 4.5;
/** Aromatic ring centroids, parallel or T-shaped. */
const STACKING_MAX = 5.5;
/**
 * Below this two atoms are bonded. A partner residue with any such pair is
 * covalently attached to the ligand and is excluded entirely — see the note
 * where `linked` is built.
 */
const COVALENT_MAX = 1.9;

const POLAR = new Set([7, 8, 16]);

/** Side-chain atoms that carry formal charge at neutral pH. */
const ANIONIC: Record<string, string[]> = {
  ASP: ['OD1', 'OD2'], GLU: ['OE1', 'OE2'],
};
// Histidine is deliberately absent. Its imidazole is cationic only when
// protonated, and the protonation state is not in the file — 101M's proximal
// His93 was being reported as an ionic contact with the haem when what it
// makes is a coordination bond to the iron. Naming that "ionic" is a claim the
// coordinates do not support.
const CATIONIC: Record<string, string[]> = {
  LYS: ['NZ'], ARG: ['NE', 'NH1', 'NH2'],
};

/**
 * Rings of five or six atoms, from the bond graph, that are flat enough to
 * stack.
 *
 * Aromaticity is not read from a chemical component dictionary — MolView has
 * none — but planarity is measurable, and a flat six-ring is what stacks
 * whatever a dictionary would call it. The test is that every ring atom sits
 * within 0.25 Å of the ring's best-fit plane.
 */
export function planarRings(s: Structure, atoms: Uint8Array): number[][] {
  const bonds = computeBonds(s, atoms);
  const neighbours = new Map<number, number[]>();
  for (let i = 0; i < bonds.count; i++) {
    const a = bonds.indices[i * 2], b = bonds.indices[i * 2 + 1];
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a);
  }

  const seen = new Set<string>();
  const rings: number[][] = [];
  // Depth-limited walk from each atom looking for a way back to the start.
  const walk = (start: number, current: number, path: number[]) => {
    if (path.length > 6) return;
    for (const next of neighbours.get(current) ?? []) {
      if (next === start && path.length >= 5) {
        const key = [...path].sort((x, y) => x - y).join(',');
        if (!seen.has(key)) { seen.add(key); rings.push([...path]); }
        continue;
      }
      if (path.includes(next)) continue;
      walk(start, next, [...path, next]);
    }
  };
  for (const a of neighbours.keys()) walk(a, a, [a]);

  return rings.filter((ring) => planeOf(s, ring) !== null);
}

/** Centroid and unit normal of a ring, or null when it is not flat. */
export function planeOf(
  s: Structure, ring: number[],
): { centroid: [number, number, number]; normal: [number, number, number] } | null {
  let cx = 0, cy = 0, cz = 0;
  for (const a of ring) { cx += s.x[a]; cy += s.y[a]; cz += s.z[a]; }
  cx /= ring.length; cy /= ring.length; cz /= ring.length;

  // Newell's method: robust for a polygon, and it is the polygon normal that
  // matters rather than an eigenvector of the covariance.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    nx += (s.y[a] - s.y[b]) * (s.z[a] + s.z[b]);
    ny += (s.z[a] - s.z[b]) * (s.x[a] + s.x[b]);
    nz += (s.x[a] - s.x[b]) * (s.y[a] + s.y[b]);
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-6) return null;
  nx /= len; ny /= len; nz /= len;

  for (const a of ring) {
    const d = Math.abs((s.x[a] - cx) * nx + (s.y[a] - cy) * ny + (s.z[a] - cz) * nz);
    if (d > 0.25) return null;
  }
  return { centroid: [cx, cy, cz], normal: [nx, ny, nz] };
}

function isCharged(s: Structure, atom: number): number {
  const res = s.atomResidue[atom];
  const name = resNameOf(s, res);
  const atomName = atomNameOf(s, atom);
  if (ANIONIC[name]?.includes(atomName)) return -1;
  if (CATIONIC[name]?.includes(atomName)) return 1;
  // Nucleic acid phosphates.
  if (s.resKind[res] === MolKind.Nucleic && /^(OP1|OP2|O1P|O2P)$/.test(atomName)) return -1;
  return 0;
}

export interface LigandContactOptions {
  /** Only consider these atoms as partners, so a hidden chain is not reported. */
  mask?: Uint8Array | null;
  /** Ligand residues to describe; by default every ligand in the structure. */
  residues?: number[];
}

/**
 * Contacts for each ligand, grouped by the residue making them.
 *
 * Water is excluded as a partner: it bridges everything, and a list of eleven
 * waters buries the two residues that actually read the ligand.
 */
export function ligandContacts(
  s: Structure, options: LigandContactOptions = {},
): LigandReport[] {
  const mask = options.mask ?? null;
  const ligands = options.residues ?? defaultLigands(s);
  if (ligands.length === 0) return [];

  // Partner atoms: heavy, not water, not a ligand itself.
  const partners: number[] = [];
  for (let a = 0; a < s.atomCount; a++) {
    if (s.element[a] <= 1) continue;
    if (mask && !mask[a]) continue;
    const kind = s.resKind[s.atomResidue[a]];
    if (kind === MolKind.Water || kind === MolKind.Ligand) continue;
    partners.push(a);
  }

  const cell = HYDROPHOBIC_MAX + 1;
  const key = (x: number, y: number, z: number) =>
    (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const buckets = new Map<number, number[]>();
  for (const a of partners) {
    const k = key(
      Math.floor(s.x[a] / cell), Math.floor(s.y[a] / cell), Math.floor(s.z[a] / cell),
    );
    const b = buckets.get(k);
    if (b) b.push(a); else buckets.set(k, [a]);
  }

  const reports: LigandReport[] = [];
  for (const lig of ligands) {
    const ligAtoms: number[] = [];
    for (let a = s.resAtomStart[lig]; a < s.resAtomStart[lig + 1]; a++) {
      if (s.element[a] > 1 && (!mask || mask[a])) ligAtoms.push(a);
    }
    if (ligAtoms.length === 0) continue;

    // Residues covalently attached to the "ligand" are part of the same
    // molecule, not partners binding it. GFP's chromophore is made from
    // residues 65-67 and stays in the chain, so Phe64 and Val68 flank it
    // through peptide bonds; rejecting only the bonds themselves still left
    // their 1-3 neighbours looking like impossibly short hydrogen bonds.
    const linked = new Set<number>();
    for (const la of ligAtoms) {
      for (const pa of partners) {
        const dx = s.x[pa] - s.x[la], dy = s.y[pa] - s.y[la], dz = s.z[pa] - s.z[la];
        if (dx * dx + dy * dy + dz * dz < COVALENT_MAX * COVALENT_MAX) {
          linked.add(s.atomResidue[pa]);
        }
      }
    }

    const byResidue = new Map<number, { kinds: Set<ContactKind>; closest: number; pairs: number }>();
    const note = (res: number, kind: ContactKind | null, d: number) => {
      let e = byResidue.get(res);
      if (!e) { e = { kinds: new Set(), closest: Infinity, pairs: 0 }; byResidue.set(res, e); }
      if (kind) e.kinds.add(kind);
      e.closest = Math.min(e.closest, d);
      e.pairs++;
    };

    for (const la of ligAtoms) {
      const gx = Math.floor(s.x[la] / cell);
      const gy = Math.floor(s.y[la] / cell);
      const gz = Math.floor(s.z[la] / cell);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const pa of buckets.get(key(gx + dx, gy + dy, gz + dz)) ?? []) {
              const d = Math.hypot(s.x[pa] - s.x[la], s.y[pa] - s.y[la], s.z[pa] - s.z[la]);
              if (d > HYDROPHOBIC_MAX) continue;
              // Covalently attached, not in contact. GFP's chromophore is made
              // from residues 65-67 and stays part of the chain, so Phe64 and
              // Val68 came back at 1.33 A — a peptide bond reported as a
              // hydrogen bond. Anything this close is a bond whatever the file
              // calls the residue.
              const res = s.atomResidue[pa];
              if (linked.has(res)) continue;

              const bothPolar = POLAR.has(s.element[la]) && POLAR.has(s.element[pa]);
              const charge = isCharged(s, pa);
              if (bothPolar && charge !== 0 && d <= IONIC_MAX) note(res, 'ionic', d);
              else if (bothPolar && d <= HBOND_MAX) note(res, 'hbond', d);
              else if (s.element[la] === 6 && s.element[pa] === 6) note(res, 'hydrophobic', d);
              else note(res, null, d);
            }
          }
        }
      }
    }

    // Stacking, ring against ring. Both parallel and T-shaped count: an edge-on
    // ring is a real aromatic contact and calling only the parallel case
    // stacking would miss half of them.
    const ligMask = new Uint8Array(s.atomCount);
    for (const a of ligAtoms) ligMask[a] = 1;
    const ligRings = planarRings(s, ligMask).map((r) => planeOf(s, r)!).filter(Boolean);
    if (ligRings.length > 0) {
      for (const res of [...byResidue.keys()]) {
        const resMask = new Uint8Array(s.atomCount);
        for (let a = s.resAtomStart[res]; a < s.resAtomStart[res + 1]; a++) {
          if (s.element[a] > 1) resMask[a] = 1;
        }
        for (const ring of planarRings(s, resMask)) {
          const plane = planeOf(s, ring);
          if (!plane) continue;
          for (const lr of ligRings) {
            const d = Math.hypot(
              plane.centroid[0] - lr.centroid[0],
              plane.centroid[1] - lr.centroid[1],
              plane.centroid[2] - lr.centroid[2],
            );
            if (d > STACKING_MAX) continue;
            const cos = Math.abs(
              plane.normal[0] * lr.normal[0]
              + plane.normal[1] * lr.normal[1]
              + plane.normal[2] * lr.normal[2],
            );
            const angle = Math.acos(Math.min(1, cos)) * 180 / Math.PI;
            if (angle < 30 || angle > 60) byResidue.get(res)!.kinds.add('stacking');
          }
        }
      }
    }

    const order: ContactKind[] = ['ionic', 'hbond', 'stacking', 'hydrophobic'];
    const contacts: LigandContact[] = [...byResidue.entries()]
      .map(([residue, e]) => ({
        residue,
        kinds: order.filter((k) => e.kinds.has(k)),
        closest: e.closest,
        pairs: e.pairs,
      }))
      .sort((a, b) => a.closest - b.closest);

    reports.push({
      residue: lig,
      name: resNameOf(s, lig),
      contacts,
      covalent: [...linked].sort((a, b) => a - b),
      partnerCount: contacts.length,
    });
  }

  return reports.sort((a, b) => b.partnerCount - a.partnerCount);
}

/** Ligand residues worth a report: not water, not a lone ion. */
function defaultLigands(s: Structure): number[] {
  const out: number[] = [];
  for (let r = 0; r < s.residueCount; r++) {
    if (s.resKind[r] !== MolKind.Ligand) continue;
    if (s.resAtomStart[r + 1] - s.resAtomStart[r] < 3) continue;
    out.push(r);
  }
  return out;
}

/** A selection covering a ligand and everything it touches. */
export function contactSelection(s: Structure, report: LigandReport): string {
  const parts = [`/${s.chainAuthId[s.resChain[report.residue]]}:${s.resSeq[report.residue]}`];
  for (const c of report.contacts) {
    parts.push(`/${s.chainAuthId[s.resChain[c.residue]]}:${s.resSeq[c.residue]}`);
  }
  return parts.join(' or ');
}
