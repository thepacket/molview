/**
 * The molecular surface for the active pane.
 *
 * Generating one is seconds of blocking work on a large structure, so the
 * panel is honest about that rather than pretending it is a toggle: the button
 * says what it will do, the controls that force a rebuild are separated from
 * the ones that only change how it looks, and the readout afterwards reports
 * the grid spacing that was actually used, which is not always the one asked
 * for.
 */

import { useState } from 'react';
import { Blend } from 'lucide-react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Field, Slider, Toggle } from '../controls';

export function SurfaceSection() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const updateSurface = useStore((s) => s.updateSurface);
  const s = slot.surface;
  const [selection, setSelection] = useState(s.selection);

  if (slot.status !== 'ready') return null;

  /** Changes the mesh: regenerate. */
  const rebuild = (key: 'probeRadius' | 'resolution') => (value: number) => {
    updateSurface(activeSlot, { [key]: value });
    viewer.showSurface(activeSlot);
  };
  /** Changes only the appearance: reuse the cached mesh. */
  const restyle = (patch: Parameters<typeof updateSurface>[1]) => {
    updateSurface(activeSlot, patch);
    viewer.refreshSurfaceStyle(activeSlot);
  };

  return (
    <div className="panel-section">
      <div className="section-label"><span>Molecular surface</span></div>

      {s.status !== 'ready' ? (
        <>
          <p className="panel-note">
            The envelope the molecule presents to the solvent, as a Gaussian
            surface over the atoms currently drawn. Building it blocks for a
            moment — longer on a large structure.
          </p>
          <button
            type="button"
            className="btn"
            style={{ width: '100%' }}
            onClick={() => viewer.showSurface(activeSlot)}
          >
            <Blend size={12} /> Build surface
          </button>
          {s.status === 'error' && s.error && (
            <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 7, lineHeight: 1.5 }}>
              {s.error}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="density-source">
            <span>{s.selection || 'everything drawn'}</span>
            <span>
              {s.triangles.toLocaleString()} triangles · {s.actualResolution.toFixed(2)} Å grid
            </span>
          </div>

          <Field label="Covering">
            <input
              className="text-input"
              value={selection}
              placeholder="everything drawn"
              aria-label="Surface selection"
              onChange={(e) => setSelection(e.target.value)}
              onBlur={() => {
                if (selection === s.selection) return;
                updateSurface(activeSlot, { selection });
                viewer.showSurface(activeSlot);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </Field>

          <SurfaceSlider
            label="Probe radius" value={s.probeRadius} min={0} max={3} step={0.1}
            format={(v) => `${v.toFixed(1)} Å`} onCommit={rebuild('probeRadius')}
          />
          <SurfaceSlider
            label="Grid" value={s.resolution} min={0.3} max={1.5} step={0.1}
            format={(v) => `${v.toFixed(1)} Å`} onCommit={rebuild('resolution')}
          />
          <SurfaceSlider
            label="Opacity" value={s.opacity} min={0.05} max={1} step={0.05}
            format={(v) => v.toFixed(2)} onCommit={(v) => restyle({ opacity: v })}
          />

          <Toggle
            label="Wireframe"
            checked={s.wireframe}
            onChange={(v) => restyle({ wireframe: v })}
          />
          <Toggle
            label="Colour by atom"
            checked={s.colorByAtom}
            onChange={(v) => {
              // The colour is baked into the mesh, so this one has to rebuild.
              updateSurface(activeSlot, { colorByAtom: v });
              viewer.showSurface(activeSlot);
            }}
            hint="Takes the pane's colour scheme through to the surface, rather than one flat colour"
          />

          <button
            type="button"
            className="btn ghost small"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => viewer.hideSurface(activeSlot)}
          >
            Remove surface
          </button>
        </>
      )}
    </div>
  );
}

/** Label follows the thumb; the rebuild waits for the drag to end. */
function SurfaceSlider({ label, value, min, max, step, format, onCommit }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onCommit: (value: number) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? value;
  return (
    <Field label={label} value={format(shown)}>
      <Slider
        value={shown}
        min={min}
        max={max}
        step={step}
        onChange={setDragging}
        onCommit={(v) => { setDragging(null); onCommit(v); }}
      />
    </Field>
  );
}
