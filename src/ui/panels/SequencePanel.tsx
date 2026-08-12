/**
 * Sequence track built from the coordinates actually loaded, not from the
 * deposited sequence — so clicking a residue always lands on something that
 * exists in the scene.
 *
 * That also means absence has to be drawn rather than left out. Residues that
 * were never modelled have no cell to occupy, so without a marker the track
 * runs 34, 37, 69 with nothing to say a loop is missing, which reads as a
 * continuous chain. The marker between two cells is the hole; what kind of
 * hole comes from `mol/gaps.ts`, which is the same judgement the ribbon uses.
 */

import { useMemo } from 'react';
import { chainPalette } from '../../mol/coloring';
import { ONE_LETTER } from '../../mol/elements';
import { describeGap, findChainGaps, type GapKind } from '../../mol/gaps';
import { MolKind, resNameOf, type Structure } from '../../mol/structure';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';

interface TrackResidue {
  index: number;
  letter: string;
  ss: number;
  seq: number;
  name: string;
  /** Alternate conformations this residue carries, beyond the one drawn. */
  altCount: number;
  /** Discontinuity between this residue and the one before it, if any. */
  gapBefore: { kind: GapKind; missing: number; title: string } | null;
}

interface ChainTrack {
  authId: string;
  colorIndex: number;
  residues: TrackResidue[];
  /** Residues numbered but absent, summed over this chain's real holes. */
  missing: number;
}

function buildTracks(structure: Structure): ChainTrack[] {
  const tracks: ChainTrack[] = [];
  const byId = new Map<string, ChainTrack>();

  // Keyed by the residue the discontinuity sits before, so the marker can be
  // emitted while walking residues in order.
  const gapAt = new Map<number, { kind: GapKind; missing: number; title: string }>();
  for (const g of findChainGaps(structure)) {
    gapAt.set(g.after, { kind: g.kind, missing: g.missing, title: describeGap(g) });
  }

  for (let c = 0; c < structure.chainCount; c++) {
    const kind = structure.chainKind[c];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;

    const authId = structure.chainAuthId[c];
    let track = byId.get(authId);
    if (!track) {
      track = { authId, colorIndex: tracks.length, residues: [], missing: 0 };
      byId.set(authId, track);
      tracks.push(track);
    }

    for (let r = structure.chainResStart[c]; r < structure.chainResStart[c + 1]; r++) {
      const k = structure.resKind[r];
      if (k !== MolKind.Protein && k !== MolKind.Nucleic) continue;
      const name = resNameOf(structure, r);
      const gapBefore = gapAt.get(r) ?? null;
      // Only a real hole counts as missing; a renumbering skips numbers
      // without skipping residues.
      if (gapBefore && gapBefore.kind === 'unmodelled') track.missing += gapBefore.missing;
      track.residues.push({
        index: r,
        letter: ONE_LETTER[name] ?? 'X',
        ss: structure.resSS[r],
        seq: structure.resSeq[r],
        name,
        altCount: structure.resAltCount[r],
        gapBefore,
      });
    }
  }

  return tracks.filter((t) => t.residues.length > 0);
}

/**
 * A renumbering is not a hole, so it does not get the dashed marker the other
 * two do — it gets a hairline, because the numbering really does jump and a
 * reader comparing the track against a paper's residue numbers needs to know
 * why. Absence and bookkeeping should not look the same.
 */
function gapLabel(kind: GapKind, missing: number): string {
  if (kind === 'break') return '⁄⁄';
  if (kind === 'renumbered') return '·';
  return missing > 9 ? '⋯' : `${missing}`;
}

export function SequencePanel() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const patchSlot = useStore((s) => s.patchSlot);

  const structure = viewer.getStructure(activeSlot);
  // Rebuild only when the pane actually changes structure.
  const tracks = useMemo(
    () => (structure ? buildTracks(structure) : []),
    [structure],
  );

  if (!structure || slot.status !== 'ready') {
    return <div className="empty-state">No polymer loaded in pane {activeSlot + 1}.</div>;
  }
  if (tracks.length === 0) {
    return <div className="empty-state">This entry contains no polymer chains.</div>;
  }

  return (
    <>
      {tracks.map((track) => (
        <div key={track.authId} className="seq-chain">
          <div className="seq-chain-head">
            <span
              className="seq-swatch"
              style={{
                background: `#${chainPalette()[(track.colorIndex + activeSlot * 3)
                  % chainPalette().length].toString(16).padStart(6, '0')}`,
              }}
            />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
              Chain {track.authId}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto' }}>
              {track.residues.length} residues
              {track.missing > 0 && (
                // Stated rather than left to the markers: a reader counting
                // cells to judge coverage should not have to find every gap.
                <span className="seq-missing" title={
                  `${track.missing} residue${track.missing === 1 ? '' : 's'} in this chain `
                  + 'are numbered but absent from the coordinates'
                }>
                  {' · '}{track.missing} missing
                </span>
              )}
            </span>
          </div>
          <div className="seq-grid">
            {track.residues.map((r) => [
              r.gapBefore ? (
                <span
                  key={`gap-${r.index}`}
                  className="seq-gap"
                  data-kind={r.gapBefore.kind}
                  title={`Chain ${track.authId}: ${r.gapBefore.title}`}
                >
                  {gapLabel(r.gapBefore.kind, r.gapBefore.missing)}
                </span>
              ) : null,
              <button
                key={r.index}
                type="button"
                className="seq-res"
                data-ss={r.ss}
                data-alt={r.altCount > 0 || undefined}
                data-selected={slot.selectedResidue === r.index}
                title={`${r.name} ${r.seq} · chain ${track.authId}`
                  + (r.altCount > 0
                    ? ` · ${r.altCount + 1} alternate conformations`
                    : '')}
                onClick={() => {
                  patchSlot(activeSlot, {
                    selectedResidue: r.index,
                    selectionLabel: `${r.name} ${r.seq} · ${track.authId}`,
                  });
                  // The store holds the selection; the overlay draws it, and
                  // nothing rebuilds itself. Without this the camera flew to a
                  // residue that was never marked — which is exactly what a
                  // click here does, and why it looked like the highlight did
                  // not exist rather than like it was never asked for.
                  viewer.refreshOverlay(activeSlot);
                  viewer.focusResidue(activeSlot, r.index);
                }}
              >
                {r.letter}
              </button>,
            ])}
          </div>
        </div>
      ))}
    </>
  );
}
