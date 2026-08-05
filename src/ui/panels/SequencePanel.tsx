/**
 * Sequence track built from the coordinates actually loaded, not from the
 * deposited sequence — so gaps in the model show up as gaps here, and clicking
 * a residue always lands on something that exists in the scene.
 */

import { useMemo } from 'react';
import { CHAIN_PALETTE } from '../../mol/coloring';
import { ONE_LETTER } from '../../mol/elements';
import { MolKind, resNameOf, type Structure } from '../../mol/structure';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';

interface ChainTrack {
  authId: string;
  colorIndex: number;
  residues: { index: number; letter: string; ss: number; seq: number; name: string }[];
}

function buildTracks(structure: Structure): ChainTrack[] {
  const tracks: ChainTrack[] = [];
  const byId = new Map<string, ChainTrack>();

  for (let c = 0; c < structure.chainCount; c++) {
    const kind = structure.chainKind[c];
    if (kind !== MolKind.Protein && kind !== MolKind.Nucleic) continue;

    const authId = structure.chainAuthId[c];
    let track = byId.get(authId);
    if (!track) {
      track = { authId, colorIndex: tracks.length, residues: [] };
      byId.set(authId, track);
      tracks.push(track);
    }

    for (let r = structure.chainResStart[c]; r < structure.chainResStart[c + 1]; r++) {
      const k = structure.resKind[r];
      if (k !== MolKind.Protein && k !== MolKind.Nucleic) continue;
      const name = resNameOf(structure, r);
      track.residues.push({
        index: r,
        letter: ONE_LETTER[name] ?? 'X',
        ss: structure.resSS[r],
        seq: structure.resSeq[r],
        name,
      });
    }
  }

  return tracks.filter((t) => t.residues.length > 0);
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
                background: `#${CHAIN_PALETTE[(track.colorIndex + activeSlot * 3)
                  % CHAIN_PALETTE.length].toString(16).padStart(6, '0')}`,
              }}
            />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
              Chain {track.authId}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto' }}>
              {track.residues.length} residues
            </span>
          </div>
          <div className="seq-grid">
            {track.residues.map((r) => (
              <button
                key={r.index}
                type="button"
                className="seq-res"
                data-ss={r.ss}
                data-selected={slot.selectedResidue === r.index}
                title={`${r.name} ${r.seq} · chain ${track.authId}`}
                onClick={() => {
                  patchSlot(activeSlot, {
                    selectedResidue: r.index,
                    selectionLabel: `${r.name} ${r.seq} · ${track.authId}`,
                  });
                  viewer.focusResidue(activeSlot, r.index);
                }}
              >
                {r.letter}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
