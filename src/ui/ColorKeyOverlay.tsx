/**
 * The colour key drawn over a pane.
 *
 * HTML rather than GPU geometry: it is text and small rectangles that never
 * move with the camera, and putting it in the DOM means it inherits the app's
 * typography for free. The cost is that it does not exist inside the WebGPU
 * canvas, so screenshots and recordings paint their own copy from the same
 * model — see `paintColorKey`.
 */

import { useStore } from '../state/store';
import { viewer } from '../viewer/ViewerController';
import { colorKeyFor } from '../mol/colorKey';

function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function ColorKeyOverlay({ slot }: { slot: number }) {
  const state = useStore((s) => s.slots[slot]);
  const structure = viewer.getStructure(slot);
  if (!state.showColorKey || !structure || state.status !== 'ready') return null;

  const key = colorKeyFor(structure, state.colorScheme, {
    paletteOffset: slot * 3,
    uniformColor: state.uniformColor,
    saturation: state.visual.saturation,
    intensity: state.visual.intensity,
  });
  if (!key) return null;

  return (
    <div className="color-key">
      <div className="color-key-title">{key.title}</div>
      {key.kind === 'swatches' ? (
        <div className="color-key-items">
          {key.items.map((item) => (
            <div key={item.label} className="color-key-item">
              <span className="color-key-swatch" style={{ background: css(item.color) }} />
              {item.label}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div
            className="color-key-ramp"
            style={{
              background: `linear-gradient(to right, ${key.stops.map(css).join(', ')})`,
            }}
          />
          <div className="color-key-scale">
            {key.labels.map((label, i) => <span key={i}>{label}</span>)}
          </div>
        </>
      )}
    </div>
  );
}
