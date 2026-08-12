/**
 * Chain discontinuities — the places where the model stops and the molecule
 * does not.
 *
 * A deposited file is not a molecule; it is the part of a molecule somebody
 * could see. A disordered loop is simply absent, and anything that runs from
 * one residue to the next will run across the hole unless told where the holes
 * are. This module answers that question once, so the sequence track and the
 * ribbon cannot disagree about where a chain breaks.
 *
 * Two signals are available and neither is sufficient alone:
 *
 *   - **Numbering.** A jump in `auth_seq_id` usually means residues were not
 *     modelled — but not always, because author numbering is a convention and
 *     some conventions skip. Trypsin is numbered by chymotrypsinogen alignment
 *     and jumps 34->37, 67->69, 125->127, 130->132, 204->209 and 217->219 with
 *     nothing missing at any of them.
 *   - **Distance.** Anchors too far apart cannot be bonded, whatever the
 *     numbering says — but a chain that folds back can put two ends of a real
 *     hole within bonding range by coincidence.
 *
 * So both are measured, and the thresholds come from the files rather than
 * from a textbook: over 49,852 consecutively numbered protein residues the
 * CA-CA separation has median 3.80 A, 99.9th percentile 3.99 A and maximum
 * 4.27 A, so 4.2 A admits all but 0.014% of certainly-real peptide bonds. The
 * 314 nucleic C4'-C4' steps measured run 4.71 to 6.64 A, so 7.0 A admits all
 * of them.
 */

import { MolKind, type Structure } from './structure';

/**
 * Beyond this, two anchors cannot be bonded however the file numbers them.
 * Deliberately loose — it is the "certainly broken" line, not the "certainly
 * bonded" one, and the cartoon has used these two values since it first drew
 * a ribbon.
 */
export const MAX_ANCHOR_GAP_PROTEIN = 5.2;
export const MAX_ANCHOR_GAP_NUCLEIC = 9;

/**
 * Within this, two anchors are bonded, so a numbering jump across them is a
 * renumbering rather than a hole. Measured; see the module header.
 */
export const BONDED_ANCHOR_PROTEIN = 4.2;
export const BONDED_ANCHOR_NUCLEIC = 7;

export function maxAnchorGap(kind: number): number {
  return kind === MolKind.Nucleic ? MAX_ANCHOR_GAP_NUCLEIC : MAX_ANCHOR_GAP_PROTEIN;
}

export function bondedAnchorGap(kind: number): number {
  return kind === MolKind.Nucleic ? BONDED_ANCHOR_NUCLEIC : BONDED_ANCHOR_PROTEIN;
}

/**
 * What kind of discontinuity this is. The distinction is the point: only two
 * of the three mean atoms are missing, and drawing all three the same way
 * asserts absence where there is none.
 */
export type GapKind =
  /** Numbering skips and the ends are not bonded: residues were not modelled. */
  | 'unmodelled'
  /** Numbering is consecutive and the ends are far apart: the model is broken. */
  | 'break'
  /** Numbering skips but the ends are bonded: a numbering convention, not a hole. */
  | 'renumbered';

export interface ChainGap {
  /** Chain index the discontinuity sits inside. */
  chain: number;
  /** Residue indices either side of it. */
  before: number;
  after: number;
  /** Author numbering either side, which is what a reader quotes. */
  fromSeq: number;
  toSeq: number;
  /**
   * Residues the numbering implies are absent. Zero for a `break`, where the
   * numbering claims nothing is missing and the geometry disagrees.
   */
  missing: number;
  /** Anchor separation across the discontinuity, A. */
  distance: number;
  kind: GapKind;
}

/** True where the chain really is interrupted, so a ribbon must not run through. */
export function isAbsence(kind: GapKind): boolean {
  return kind !== 'renumbered';
}

/**
 * Classify the step between two adjacent polymer residues, or null when the
 * chain simply continues.
 *
 * Shared with the cartoon builder so that a dash is drawn exactly where the
 * sequence track shows a break.
 */
export function classifyStep(
  seqStep: number, distance: number, chainKind: number,
): GapKind | null {
  // A step of 0 is an insertion code — 100, 100A and 100B carry one author
  // number — and a negative step is a chain whose numbering restarts. Neither
  // implies a missing residue.
  const skipped = seqStep > 1;
  if (skipped) {
    return distance <= bondedAnchorGap(chainKind) ? 'renumbered' : 'unmodelled';
  }
  return distance > maxAnchorGap(chainKind) ? 'break' : null;
}

/**
 * Every discontinuity in every polymer chain.
 *
 * Residues with no anchor — a polymer residue whose CA was never modelled, so
 * there is nothing to measure from — end the run rather than producing a gap
 * against a coordinate that does not exist.
 */
export function findChainGaps(s: Structure): ChainGap[] {
  const gaps: ChainGap[] = [];

  for (let c = 0; c < s.chainCount; c++) {
    const kind = s.chainKind[c];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;

    let prev = -1;
    for (let r = s.chainResStart[c]; r < s.chainResStart[c + 1]; r++) {
      const k = s.resKind[r];
      const anchor = s.resAnchor[r];
      // A component sitting inside a polymer chain that is not recognised as
      // polymer — a fused chromophore, an unusual modified residue — ends the
      // run instead of being stepped over. GFP numbers Thr65-Tyr66-Gly67 as
      // one CRO residue at position 66, and skipping past it reported three
      // residues missing from a chain that is continuous. We cannot tell
      // whether such a component bridges the positions it spans, so the honest
      // answer is to make no claim rather than to claim absence.
      if (k !== MolKind.Protein && k !== MolKind.Nucleic) { prev = -1; continue; }
      if (anchor < 0) { prev = -1; continue; }

      if (prev >= 0) {
        const pa = s.resAnchor[prev];
        const step = s.resSeq[r] - s.resSeq[prev];
        const distance = Math.hypot(
          s.x[anchor] - s.x[pa], s.y[anchor] - s.y[pa], s.z[anchor] - s.z[pa],
        );
        const gapKind = classifyStep(step, distance, kind);
        if (gapKind) {
          gaps.push({
            chain: c, before: prev, after: r,
            fromSeq: s.resSeq[prev], toSeq: s.resSeq[r],
            missing: gapKind === 'break' ? 0 : step - 1,
            distance, kind: gapKind,
          });
        }
      }
      prev = r;
    }
  }

  return gaps;
}

/** Residues implied absent, over the gaps that actually mean absence. */
export function unmodelledResidueCount(gaps: readonly ChainGap[]): number {
  let n = 0;
  for (const g of gaps) if (g.kind === 'unmodelled') n += g.missing;
  return n;
}

/** How a discontinuity reads in a tooltip or a panel line. */
export function describeGap(g: ChainGap): string {
  const span = `${g.fromSeq}–${g.toSeq}`;
  if (g.kind === 'unmodelled') {
    return `${g.missing} residue${g.missing === 1 ? '' : 's'} not modelled `
      + `(${span}, ends ${g.distance.toFixed(1)} Å apart)`;
  }
  if (g.kind === 'break') {
    return `chain break at ${span}: numbering is consecutive but the ends are `
      + `${g.distance.toFixed(1)} Å apart`;
  }
  return `numbering skips ${g.missing} position${g.missing === 1 ? '' : 's'} at `
    + `${span}; the chain is continuous (${g.distance.toFixed(1)} Å)`;
}
