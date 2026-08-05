/** Pane management: what is loaded where, and how the panes relate. */

import { useRef } from 'react';
import {
  Columns2, FolderOpen, Grid2x2, Link2, Link2Off, Rows2, Square, Trash2,
} from 'lucide-react';
import { LAYOUT_SLOT_COUNT, useStore, type LayoutMode } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Segmented, Tip, Toggle } from '../controls';

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
