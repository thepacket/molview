/** Pane management: what is loaded where, and how the panes relate. */

import { useRef, useState } from 'react';
import {
  Columns2, FolderOpen, Grid2x2, Link2, Link2Off, Rows2, Square, Trash2,
} from 'lucide-react';
import { LAYOUT_SLOT_COUNT, useStore, type LayoutMode } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Segmented, Select, Tip, Toggle } from '../controls';

const LAYOUTS: { value: LayoutMode; label: React.ReactNode; title: string }[] = [
  { value: 'single', label: <Square size={12} />, title: 'Single pane' },
  { value: 'columns', label: <Columns2 size={12} />, title: 'Two panes, side by side' },
  { value: 'rows', label: <Rows2 size={12} />, title: 'Two panes, stacked' },
  { value: 'quad', label: <Grid2x2 size={12} />, title: 'Four panes' },
];

export function ScenePanel() {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const slots = useStore((s) => s.slots);
  const activeSlot = useStore((s) => s.activeSlot);
  const setActiveSlot = useStore((s) => s.setActiveSlot);
  const linked = useStore((s) => s.linkedCameras);
  const setLinked = useStore((s) => s.setLinkedCameras);
  const fileRef = useRef<HTMLInputElement>(null);

  const count = LAYOUT_SLOT_COUNT[layout];

  return (
    <>
      <div className="panel-section">
        <div className="section-label"><span>Layout</span></div>
        <Segmented value={layout} options={LAYOUTS} onChange={setLayout} />
        <div style={{ marginTop: 10 }}>
          <Toggle
            label="Link camera orientation"
            checked={linked}
            onChange={setLinked}
            hint="Rotating one pane rotates the others — the way to compare two structures"
          />
        </div>
        <button
          type="button"
          className="btn"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => viewer.syncCameras(activeSlot)}
        >
          {linked ? <Link2 size={12} /> : <Link2Off size={12} />}
          Match all panes to pane {activeSlot + 1}
        </button>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Panes</span></div>
        {Array.from({ length: count }, (_, i) => {
          const slot = slots[i];
          return (
            <div
              key={i}
              className="chain-toggle"
              data-hidden={slot.status === 'empty'}
              style={{
                border: '1px solid',
                borderColor: i === activeSlot ? 'var(--accent-dim)' : 'transparent',
                marginBottom: 4,
              }}
              onClick={() => setActiveSlot(i)}
            >
              <span className="pane-index">{i + 1}</span>
              <span className="chain-name">
                {slot.entryId
                  ? `${slot.entryId} · ${statusLabel(slot.status)}`
                  : 'empty'}
              </span>
              {slot.entryId && (
                <Tip label="Clear pane">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Clear pane ${i + 1}`}
                    onClick={(e) => { e.stopPropagation(); viewer.unload(i); }}
                  >
                    <Trash2 size={11} />
                  </button>
                </Tip>
              )}
            </div>
          );
        })}
      </div>

      <SuperposeSection />

      <div className="panel-section">
        <div className="section-label"><span>Local file</span></div>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 8, lineHeight: 1.5 }}>
          Open an mmCIF or BinaryCIF file from disk. Nothing is uploaded — parsing
          and rendering happen entirely in this browser.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".cif,.bcif,.mmcif"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void viewer.load(activeSlot, file.name.replace(/\.[^.]+$/, ''), file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn"
          style={{ width: '100%' }}
          onClick={() => fileRef.current?.click()}
        >
          <FolderOpen size={12} /> Open file into pane {activeSlot + 1}
        </button>
      </div>
    </>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'loading': return 'loading…';
    case 'error': return 'failed';
    case 'ready': return 'ready';
    default: return 'empty';
  }
}

/**
 * Superposition: align one pane's structure onto another's frame. This is what
 * makes multi-pane comparison quantitative rather than just visual.
 */
function SuperposeSection() {
  const slots = useStore((s) => s.slots);
  const activeSlot = useStore((s) => s.activeSlot);
  const layout = useStore((s) => s.layout);
  const [reference, setReference] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const count = LAYOUT_SLOT_COUNT[layout];
  const loaded = Array.from({ length: count }, (_, i) => i)
    .filter((i) => slots[i].status === 'ready');

  if (loaded.length < 2) {
    return (
      <div className="panel-section">
        <div className="section-label"><span>Superposition</span></div>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Load structures into two panes to align them.
        </p>
      </div>
    );
  }

  const mobile = slots[activeSlot];
  const options = loaded
    .filter((i) => i !== activeSlot)
    .map((i) => ({ value: String(i), label: `Pane ${i + 1} — ${slots[i].entryId}` }));
  const referenceSlot = options.some((o) => o.value === String(reference))
    ? reference
    : Number(options[0].value);

  return (
    <div className="panel-section">
      <div className="section-label"><span>Superposition</span></div>

      {mobile.status !== 'ready' ? (
        <p style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          Pane {activeSlot + 1} is empty.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 7, lineHeight: 1.5 }}>
            Aligns pane {activeSlot + 1} ({mobile.entryId}) onto a reference by sequence,
            then fits the matched Cα atoms.
          </p>
          <Select
            ariaLabel="Superposition reference"
            value={String(referenceSlot)}
            options={options}
            onChange={(v) => setReference(Number(v))}
          />
          <button
            type="button"
            className="btn primary small"
            style={{ width: '100%', marginTop: 7 }}
            onClick={() => {
              const result = viewer.superpose(activeSlot, referenceSlot);
              setError(typeof result === 'string' ? result : null);
            }}
          >
            Align pane {activeSlot + 1} to pane {referenceSlot + 1}
          </button>

          {error && (
            <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 6 }}>{error}</p>
          )}

          {mobile.superposedOnto !== null && mobile.superposeRmsd !== null && (
            <div className="measurement" style={{ marginTop: 8 }}>
              <div className="measurement-head">
                <span className="measurement-value">{mobile.superposeRmsd.toFixed(2)} A</span>
                <span className="measurement-kind">rmsd</span>
              </div>
              <div className="measurement-atoms">
                {mobile.superposePairs} matched Ca, aligned to pane {mobile.superposedOnto + 1}
              </div>
              <button
                type="button"
                className="btn ghost small"
                style={{ width: '100%', marginTop: 6 }}
                onClick={() => viewer.clearSuperposition(activeSlot)}
              >
                Reset to original frame
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
