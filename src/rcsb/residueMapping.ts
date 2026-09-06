import type { Structure } from '../mol/structure';

/** Archive identity is label_asym_id + entity sequence position. Model copies
 * share an annotation; they are not conflicting author-number mappings. */
export interface MappedResidue {
  chain: string;
  seq: number;
  insertionCode: string;
  labelChain: string;
  labelSeq: number;
}
export function parseAuthorPosition(
  value: unknown,
): { seq: number; insertionCode: string } | null {
  const match = /^(-?\d+)([A-Za-z]*)$/.exec(String(value ?? ''));
  return match ? { seq: Number(match[1]), insertionCode: match[2] } : null;
}
export function archiveResidueKey(chain: string, seq: number): string {
  return JSON.stringify([chain, seq]);
}
export function mappedResidueMatches(
  s: Structure,
  r: number,
  p: MappedResidue,
): boolean {
  return (
    s.chainLabelId[s.resChain[r]] === p.labelChain &&
    s.resLabelSeq[r] === p.labelSeq
  );
}
