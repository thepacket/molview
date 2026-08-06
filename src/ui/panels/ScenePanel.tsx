/** Pane management: what is loaded where, and how the panes relate. */

import { useRef, useState } from 'react';
import {
  Columns2, Eye, EyeOff, FolderOpen, Grid2x2, Link2, Link2Off, Rows2, Square,
  Trash2,
} from 'lucide-react';
import { LAYOUT_SLOT_COUNT, useStore, type LayoutMode } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Field, Segmented, Select, Tip, Toggle } from '../controls';
import { DensitySection } from './DensitySection';
import { SurfaceSection } from './SurfaceSection';
import { RecordSection } from './RecordSection';

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

      <MoveModelSection />

      <RecordSection />

      <SurfaceSection />

      <DensitySection />

      <SuperposeSection />

      <OverlaySection />

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

/**
 * Moving one structure by hand.
 *
 * Superposition computes a placement; this is for when you want to judge one —
 * pushing two structures together to see whether a proposed contact is even
 * geometrically possible, or separating an overlay that has landed on top of
 * itself. The same drags do the same things, they just act on the model.
 */
function MoveModelSection() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const patchSlot = useStore((s) => s.patchSlot);

  if (slot.status !== 'ready') return null;

  return (
    <div className="panel-section">
      <div className="section-label"><span>Move pane {activeSlot + 1}</span></div>
      <Toggle
        label="Drag moves the structure"
        checked={slot.moveModel}
        onChange={(v) => patchSlot(activeSlot, { moveModel: v })}
        hint="Drag rotates, shift-drag shifts, and the camera stays where it is"
      />
      <p className="panel-note" style={{ marginTop: 7, marginBottom: 0 }}>
        Places this pane&apos;s structure relative to anything overlaid on it.
        Superposition computes a placement; this is for judging one by eye.
      </p>
      {(slot.moveModel || slot.superposedOnto !== null) && (
        <button
          type="button"
          className="btn ghost small"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => viewer.clearSuperposition(activeSlot)}
        >
          Reset to the original frame
        </button>
      )}
    </div>
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
  const [mobileChain, setMobileChain] = useState('');
  const [referenceChain, setReferenceChain] = useState('');
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

  // "Longest" is the default because it is almost always the chain of interest,
  // but a hetero-oligomer needs the pairing spelled out.
  const chainOptions = (slot: number) => [
    { value: '', label: 'Longest chain' },
    ...viewer.alignableChains(slot).map((c) => ({
      value: c.authId,
      label: `Chain ${c.authId} — ${c.residues.length} residues`,
    })),
  ];

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
            onChange={(v) => { setReference(Number(v)); setReferenceChain(''); }}
          />

          <div className="chain-pair">
            <Field label={`Pane ${activeSlot + 1} chain`}>
              <Select
                ariaLabel="Mobile chain"
                value={mobileChain}
                options={chainOptions(activeSlot)}
                onChange={setMobileChain}
              />
            </Field>
            <Field label={`Pane ${referenceSlot + 1} chain`}>
              <Select
                ariaLabel="Reference chain"
                value={referenceChain}
                options={chainOptions(referenceSlot)}
                onChange={setReferenceChain}
              />
            </Field>
          </div>

          <button
            type="button"
            className="btn primary small"
            style={{ width: '100%', marginTop: 7 }}
            onClick={() => {
              const result = viewer.superpose(
                activeSlot, referenceSlot,
                mobileChain || undefined, referenceChain || undefined,
              );
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

/**
 * Overlay: draw another pane's structure inside this one. Combined with
 * superposition this turns a side-by-side comparison into a direct one.
 */
function OverlaySection() {
  const slots = useStore((s) => s.slots);
  const activeSlot = useStore((s) => s.activeSlot);

  // Deliberately not limited to the visible layout: overlaying is how you
  // collapse several panes into one, so the sources are often off-screen.
  const candidates = slots
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot, index }) => index !== activeSlot && slot.status === 'ready');

  if (slots[activeSlot].status !== 'ready' || candidates.length === 0) return null;

  const active = slots[activeSlot].overlaySlots;

  return (
    <div className="panel-section">
      <div className="section-label">
        <span>Overlay in pane {activeSlot + 1}</span>
        {active.length > 0 && (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => viewer.setOverlaySlots(activeSlot, [])}
          >
            Clear
          </button>
        )}
      </div>

      {candidates.map(({ slot, index }) => {
        const on = active.includes(index);
        return (
          <div key={index} className="chain-toggle" data-hidden={!on}>
            <span className="pane-index">{index + 1}</span>
            <span className="chain-name">{slot.entryId}</span>
            <Tip label={on ? 'Stop drawing here' : 'Draw inside this pane'}>
              <button
                type="button"
                className="pane-icon-btn"
                data-active={on}
                style={{ width: 20, height: 20 }}
                aria-label={`${on ? 'Remove' : 'Add'} pane ${index + 1} overlay`}
                onClick={() => viewer.setOverlaySlots(
                  activeSlot,
                  on ? active.filter((s) => s !== index) : [...active, index],
                )}
              >
                {on ? <Eye size={11} /> : <EyeOff size={11} />}
              </button>
            </Tip>
          </div>
        );
      })}

      <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
        Each overlaid structure keeps its own superposition, so align first and
        the two land on top of each other. Clicking still picks atoms from this
        pane\u2019s own structure.
      </p>
    </div>
  );
}
