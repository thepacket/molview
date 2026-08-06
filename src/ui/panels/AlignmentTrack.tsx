/**
 * Where a superposition agrees, and where it does not.
 *
 * A superposition already computes a residue-by-residue alignment and then
 * reports one number from it. That number is an average, and an average of a
 * bimodal distribution is a lie about both halves: 0.9 Å over a two-domain
 * protein routinely means 0.4 Å through each domain and 4 Å across the hinge
 * that moved, which is the entire finding and is exactly what the average
 * hides.
 *
 * So: one cell per aligned residue, coloured by how far apart the pair ended
 * up, in sequence order. The shape of the strip is the answer — a uniform
 * colour means a rigid match, and a block of red in an ocean of blue is the
 * part that moved. Clicking a cell flies both panes to that pair.
 */

import { useState } from 'react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import type { AlignedPair } from '../../mol/align';

/** Å between the fitted anchors at which a cell reaches full red. */
const SCALE = 4;

function cellColor(distance: number): string {
  const t = Math.min(distance / SCALE, 1);
  // Blue through white to red: a diverging ramp, because the question is
  // "how far from zero", not "where on a range".
  const r = Math.round(60 + t * 195);
  const g = Math.round(140 - t * 90);
  const b = Math.round(230 - t * 175);
  return `rgb(${r}, ${g}, ${b})`;
}

export function AlignmentTrack({ slot }: { slot: number }) {
  const rmsd = useStore((s) => s.slots[slot].superposeRmsd);
  const [hover, setHover] = useState<AlignedPair | null>(null);
  const alignment = viewer.getAlignment(slot);

  if (rmsd === null || !alignment || alignment.pairs.length === 0) return null;

  const { pairs } = alignment;
  const used = pairs.filter((p) => p.used);
  const worst = pairs.reduce((a, b) => (b.distance > a.distance ? b : a));
  const identical = pairs.filter((p) => p.referenceCode === p.mobileCode).length;

  return (
    <>
      <div className="section-label" style={{ marginTop: 10 }}>
        <span>Residue by residue</span>
      </div>

      <div className="alignment-track">
        {pairs.map((pair) => (
          <button
            key={`${pair.referenceResidue}-${pair.mobileResidue}`}
            type="button"
            className="alignment-cell"
            data-dropped={!pair.used}
            style={{ background: cellColor(pair.distance) }}
            aria-label={`${pair.mobileCode}${pair.mobileSeq} to `
              + `${pair.referenceCode}${pair.referenceSeq}, ${pair.distance.toFixed(1)} Å`}
            onPointerEnter={() => setHover(pair)}
            onPointerLeave={() => setHover((h) => (h === pair ? null : h))}
            onClick={() => viewer.focusAlignedPair(slot, pair)}
          />
        ))}
      </div>

      <div className="legend-scale">
        <span>0 Å</span>
        <span>
          {hover
            ? `${hover.mobileCode}${hover.mobileSeq} · ${hover.referenceCode}${hover.referenceSeq}`
              + ` · ${hover.distance.toFixed(2)} Å${hover.used ? '' : ' · pruned'}`
            : `${pairs.length} aligned, ${used.length} fitted`}
        </span>
        <span>{SCALE}+ Å</span>
      </div>

      <p className="panel-note" style={{ marginTop: 7, marginBottom: 0 }}>
        {identical} of {pairs.length} positions are the same residue. The worst
        pair is {worst.mobileCode}{worst.mobileSeq} against{' '}
        {worst.referenceCode}{worst.referenceSeq} at {worst.distance.toFixed(1)} Å,
        against an RMSD of {rmsd.toFixed(2)} Å — which is the reason to look at
        the strip rather than the number.
        {used.length < pairs.length && ' Hatched cells were pruned before the '
          + 'final fit and are not in the RMSD at all.'}
      </p>
    </>
  );
}
