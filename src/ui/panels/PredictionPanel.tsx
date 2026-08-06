/**
 * What a predicted structure is, and how far to believe it.
 *
 * This stands in for the Definition panel, because a prediction has no
 * deposition, no method, no resolution and no citation — the fields that panel
 * is built from are all absent, and showing them empty would suggest the model
 * merely lacks metadata rather than lacking an experiment.
 *
 * What it has instead is confidence, and the panel is organised around the two
 * kinds. pLDDT says how sure the model is of each residue's local geometry.
 * PAE says how sure it is of the *relationship* between two residues, and it
 * is the one people skip: two domains can each be at 95 pLDDT and be placed
 * relative to each other with no confidence whatsoever. The matrix is the only
 * thing that shows that, which is why it is here and not behind a menu.
 */

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Grid3x3, Activity } from 'lucide-react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { PLDDT_BANDS } from '../../rcsb/alphafold';
import { Chip } from '../controls';

export function PredictionPanel() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const patchSlot = useStore((s) => s.patchSlot);
  const p = slot.prediction;
  if (!p) return null;

  const band = PLDDT_BANDS.find((b) => p.meanPlddt >= b.min) ?? PLDDT_BANDS[3];

  return (
    <>
      <div className="panel-section">
        <div className="result-top">
          <span className="pdb-id" style={{ fontSize: 14 }}>{p.accession}</span>
          <a
            className="link"
            href={`https://alphafold.ebi.ac.uk/entry/${p.accession}`}
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: 'auto', fontSize: 10.5 }}
          >
            AlphaFold <ExternalLink size={9} style={{ verticalAlign: -1 }} />
          </a>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>{p.description}</div>
        <div className="chip-row">
          <Chip>Predicted</Chip>
          {p.gene && <Chip accent>{p.gene}</Chip>}
          {p.organism && <Chip>{p.organism}</Chip>}
          <Chip>v{p.version}</Chip>
        </div>
        <p className="panel-note" style={{ marginTop: 9, marginBottom: 0 }}>
          A model, not a measurement. Nothing here was observed; the confidence
          numbers below are the model&apos;s own estimate of how far it should be
          trusted.
        </p>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Confidence</span></div>
        <dl className="meta-grid">
          <dt>Mean pLDDT</dt>
          <dd className="vrpt-value">
            <i className="vrpt-dot" style={{ background: `#${band.color.toString(16)}` }} />
            {p.meanPlddt.toFixed(1)} · {band.label.toLowerCase()}
          </dd>
          <dt>UniProt</dt>
          <dd>{p.uniprotId || p.accession}</dd>
        </dl>
        <button
          type="button"
          className="btn small"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => patchSlot(activeSlot, { colorScheme: 'plddt' })}
        >
          <Activity size={11} /> Colour by pLDDT
        </button>
      </div>

      <PaeSection slot={activeSlot} />

      <div className="panel-section">
        <div className="section-label"><span>AlphaMissense</span></div>
        {p.missenseStatus === 'absent' ? (
          <p className="panel-note" style={{ marginBottom: 0 }}>
            No AlphaMissense annotation for this entry.
          </p>
        ) : (
          <>
            <p className="panel-note">
              A predicted pathogenicity for every possible substitution, averaged
              per residue. It says how constrained a position is — where a
              mutation would matter — which is a different question from where
              the model is confident.
            </p>
            <button
              type="button"
              className="btn small"
              style={{ width: '100%' }}
              disabled={p.missenseStatus === 'loading'}
              onClick={() => {
                void viewer.loadMissense(activeSlot).then((scores) => {
                  if (scores) patchSlot(activeSlot, { colorScheme: 'pathogenicity' });
                });
              }}
            >
              {p.missenseStatus === 'loading' ? 'Fetching…' : 'Colour by pathogenicity'}
            </button>
          </>
        )}
        {p.error && (
          <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 6 }}>{p.error}</p>
        )}
      </div>
    </>
  );
}

/**
 * The PAE matrix, and dragging a block out of it into a selection.
 *
 * Drawn on a canvas rather than as elements: a 2,000-residue protein is four
 * million cells, and the useful reading is the block structure, not any one
 * cell. Dragging is what makes it more than a picture — a dark square on the
 * diagonal is a rigid unit, and being able to pull that square straight into
 * the 3D view is the whole point of having the matrix beside the structure
 * rather than on a separate website.
 */
function PaeSection({ slot }: { slot: number }) {
  const prediction = useStore((s) => s.slots[slot].prediction);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  const status = prediction?.paeStatus ?? 'absent';
  const size = prediction?.paeSize ?? 0;

  useEffect(() => {
    if (status !== 'ready') return;
    const pae = viewer.getPae(slot);
    const canvas = canvasRef.current;
    if (!pae || !canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = pae.size;
    canvas.height = pae.size;
    const image = ctx.createImageData(pae.size, pae.size);

    for (let i = 0; i < pae.values.length; i++) {
      // Green for confident, white for hopeless — AlphaFold's own convention,
      // and the inverse of every other ramp in the app because here low is
      // good.
      const t = Math.min(pae.values[i] / pae.max, 1);
      const o = i * 4;
      image.data[o] = Math.round(20 + t * 235);
      image.data[o + 1] = Math.round(80 + t * 175);
      image.data[o + 2] = Math.round(60 + t * 195);
      image.data[o + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [status, slot, size]);

  if (!prediction || status === 'absent') return null;

  const residueAt = (event: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    return Math.max(1, Math.min(size, Math.floor(x * size) + 1));
  };

  return (
    <div className="panel-section">
      <div className="section-label"><span>Predicted aligned error</span></div>

      {status === 'idle' || status === 'loading' ? (
        <>
          <p className="panel-note">
            How confident the model is in the position of each residue
            <em> relative to </em>
            each other one. Two domains can both be well folded and still be
            placed with no confidence at all; pLDDT cannot show that and this
            can.
          </p>
          <button
            type="button"
            className="btn small"
            style={{ width: '100%' }}
            disabled={status === 'loading'}
            onClick={() => void viewer.loadPae(slot)}
          >
            <Grid3x3 size={11} /> {status === 'loading' ? 'Fetching…' : 'Load the PAE matrix'}
          </button>
        </>
      ) : status === 'error' ? (
        <p style={{ fontSize: 10.5, color: 'var(--error)' }}>{prediction.error}</p>
      ) : (
        <>
          <div className="pae-wrap">
            <canvas
              ref={canvasRef}
              className="pae-canvas"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const at = residueAt(e);
                setDrag({ from: at, to: at });
              }}
              onPointerMove={(e) => {
                if (!drag) return;
                setDrag({ from: drag.from, to: residueAt(e) });
              }}
              onPointerUp={(e) => {
                if (!drag) return;
                e.currentTarget.releasePointerCapture(e.pointerId);
                const lo = Math.min(drag.from, drag.to);
                const hi = Math.max(drag.from, drag.to);
                setDrag(null);
                // A click rather than a drag would select one residue, which is
                // never what someone reading a block structure meant.
                if (hi - lo >= 1) viewer.focusSelection(slot, `:${lo}-${hi}`);
              }}
            />
            {drag && (
              <div
                className="pae-band"
                style={{
                  left: `${((Math.min(drag.from, drag.to) - 1) / size) * 100}%`,
                  width: `${((Math.abs(drag.to - drag.from) + 1) / size) * 100}%`,
                }}
              />
            )}
          </div>
          <div className="legend-scale" style={{ marginTop: 4 }}>
            <span>residue 1</span>
            <span>{drag
              ? `${Math.min(drag.from, drag.to)}–${Math.max(drag.from, drag.to)}`
              : `${size} residues`}</span>
            <span>{size}</span>
          </div>
          <p className="panel-note" style={{ marginTop: 7, marginBottom: 0 }}>
            Dark is confident, pale is not. Drag across a block on the diagonal
            to focus those residues in the pane — a dark square is a unit the
            model places as one rigid piece.
          </p>
        </>
      )}
    </div>
  );
}
