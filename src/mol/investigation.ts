/** Reproducible summaries of loaded public coordinates. No inference service. */
import type { AlignedPair } from './align';
import { alignableChains } from './align';
import { MolKind, resNameOf, type Structure } from './structure';

export function residueLabel(s: Structure, r: number): string {
  return `${s.chainAuthId[s.resChain[r]]}:${s.resSeq[r]}${s.resInsCode[r]} ${resNameOf(s, r)}`;
}

export function comparisonSummary(
  reference: Structure,
  mobile: Structure,
  referenceChain: string,
  mobileChain: string,
  pairs: AlignedPair[],
) {
  const rc = alignableChains(reference).find(
    (c) => c.authId === referenceChain,
  );
  const mc = alignableChains(mobile).find((c) => c.authId === mobileChain);
  const referenceMatched = new Set(pairs.map((p) => p.referenceResidue));
  const mobileMatched = new Set(pairs.map((p) => p.mobileResidue));
  const used = pairs.filter((p) => p.used);
  const identical = pairs.filter(
    (p) => p.referenceCode === p.mobileCode && p.referenceCode !== 'X',
  ).length;
  return {
    matched: pairs.length,
    fitted: used.length,
    excluded: pairs.length - used.length,
    identity: pairs.length ? identical / pairs.length : null,
    referenceCoverage: rc?.residues.length
      ? pairs.length / rc.residues.length
      : null,
    mobileCoverage: mc?.residues.length
      ? pairs.length / mc.residues.length
      : null,
    referenceUnmatched:
      rc?.residues.filter((r) => !referenceMatched.has(r)) ?? [],
    mobileUnmatched: mc?.residues.filter((r) => !mobileMatched.has(r)) ?? [],
    substitutions: pairs.filter((p) => p.referenceCode !== p.mobileCode),
    largest: [...pairs].sort((a, b) => b.distance - a.distance).slice(0, 12),
  };
}

export function ligandResidues(s: Structure): number[] {
  return Array.from({ length: s.residueCount }, (_, r) => r).filter(
    (r) => s.resKind[r] === MolKind.Ligand,
  );
}

/** A bounded heavy-atom distance query, not a chemical interaction classifier. */
export function residueNeighbours(s: Structure, residue: number, cutoff = 4.5) {
  const nearest = new Map<number, number>();
  for (let a = s.resAtomStart[residue]; a < s.resAtomStart[residue + 1]; a++) {
    if (s.element[a] <= 1) continue;
    for (let b = 0; b < s.atomCount; b++) {
      const r = s.atomResidue[b];
      if (r === residue || s.element[b] <= 1 || s.resKind[r] === MolKind.Water)
        continue;
      if (s.chainModel[s.resChain[r]] !== s.chainModel[s.resChain[residue]])
        continue;
      const dx = s.x[a] - s.x[b];
      if (Math.abs(dx) > cutoff) continue;
      const dy = s.y[a] - s.y[b];
      if (Math.abs(dy) > cutoff) continue;
      const dz = s.z[a] - s.z[b];
      if (Math.abs(dz) > cutoff) continue;
      const d = Math.hypot(dx, dy, dz);
      if (d <= cutoff && d < (nearest.get(r) ?? Infinity)) nearest.set(r, d);
    }
  }
  return [...nearest]
    .map(([residue, distance]) => ({ residue, distance }))
    .sort((a, b) => a.distance - b.distance);
}

export function occupancySummary(s: Structure, residue: number) {
  const values = Array.from(
    s.occupancy.slice(s.resAtomStart[residue], s.resAtomStart[residue + 1]),
  );
  const known = values.filter(Number.isFinite);
  return {
    min: known.length ? Math.min(...known) : null,
    max: known.length ? Math.max(...known) : null,
    unknown: values.length - known.length,
  };
}
