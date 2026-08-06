/**
 * Experimental density for the active pane.
 *
 * The point of the feature is to let someone check a model against the
 * evidence for it, so the panel is written to keep the evidence legible rather
 * than pretty: the contour is quoted in sigma because that is the unit the
 * literature argues in, the difference map is off by default because reading
 * it needs care, and both of its lobes appear together because looking only at
 * the green half is the classic way to talk yourself into a ligand that is not
 * there.
 */

import { useState } from 'react';
import { Layers } from 'lucide-react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Field, Slider, Toggle } from '../controls';

export function DensitySection() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const updateDensity = useStore((s) => s.updateDensity);
  const d = slot.density;

  if (slot.status !== 'ready') return null;

  const tune = (key: 'level' | 'diffLevel' | 'radius' | 'opacity') => (value: number) => {
    updateDensity(activeSlot, { [key]: value });
    viewer.rebuildDensity(activeSlot);
  };
  const recontour = () => viewer.rebuildDensity(activeSlot);

  return (
    <div className="panel-section">
      <div className="section-label"><span>Density map</span></div>

      {d.status === 'off' || d.status === 'error' ? (
        <>
          <p className="panel-note">
            Fetches the experimental density this model was built into — 2Fo-Fc
            for X-ray entries, the deposited map for cryo-EM. It is what turns
            a model from a picture into a claim you can check.
          </p>
          <button
            type="button"
            className="btn"
            style={{ width: '100%' }}
            onClick={() => void viewer.showDensity(activeSlot)}
          >
            <Layers size={12} /> Load map for {slot.entryId}
          </button>
          {d.status === 'error' && d.error && (
            <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 7, lineHeight: 1.5 }}>
              {d.error}
            </p>
          )}
        </>
      ) : d.status === 'loading' ? (
        <p className="panel-note">Fetching density…</p>
      ) : (
        <>
          <div className="density-source">
            <span>{d.source}</span>
            <span>{formatBytes(d.bytes)} · {d.triangles.toLocaleString()} triangles</span>
          </div>

          <TunedSlider
            label="Contour" value={d.level} min={0.5} max={5} step={0.1}
            format={(v) => `${v.toFixed(1)} σ`} onCommit={tune('level')}
          />

          <TunedSlider
            label="Around the model" value={d.radius} min={0} max={12} step={1}
            format={(v) => (v > 0 ? `${v.toFixed(0)} Å` : 'whole box')}
            onCommit={tune('radius')}
          />

          <Toggle
            label="Wireframe"
            checked={d.wireframe}
            onChange={(v) => { updateDensity(activeSlot, { wireframe: v }); recontour(); }}
            hint="Chicken wire shows the model through the map; a solid surface reads its shape better"
          />

          {!d.wireframe && (
            <TunedSlider
              label="Opacity" value={d.opacity} min={0.05} max={1} step={0.05}
              format={(v) => v.toFixed(2)} onCommit={tune('opacity')}
            />
          )}

          {d.kind === 'x-ray' && (
            <>
              <div style={{ marginTop: 6 }}>
                <Toggle
                  label="Difference map"
                  checked={d.showDifference}
                  onChange={(v) => {
                    updateDensity(activeSlot, { showDifference: v });
                    recontour();
                  }}
                  hint="Fo-Fc: green where the data want atoms the model lacks, red where the model has atoms the data do not support"
                />
              </div>
              {d.showDifference && (
                <TunedSlider
                  label="Difference contour" value={d.diffLevel} min={2} max={6} step={0.5}
                  format={(v) => `±${v.toFixed(1)} σ`} onCommit={tune('diffLevel')}
                />
              )}
            </>
          )}

          {d.truncated && (
            <p style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 7, lineHeight: 1.5 }}>
              The surface hit its triangle budget and is incomplete. Raise the
              contour or narrow the region around the model.
            </p>
          )}

          <button
            type="button"
            className="btn ghost small"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => viewer.hideDensity(activeSlot)}
          >
            Remove map
          </button>
        </>
      )}
    </div>
  );
}

/**
 * A slider whose label follows the thumb but whose work waits for the drag to
 * end. The dragged value is local only while the pointer is down; the moment
 * it is released the store owns it again, so a contour changed from the
 * assistant or a restored project still reads correctly here.
 */
function TunedSlider({ label, value, min, max, step, format, onCommit }: {
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

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}
