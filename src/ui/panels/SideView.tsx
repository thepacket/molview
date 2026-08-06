/**
 * The scene seen from the side, with the clipping planes drawn edge-on and
 * draggable.
 *
 * Two sliders can set the same two numbers, and did. What they cannot do is
 * show you where the planes are *relative to the molecule*, which is the only
 * thing you actually want to know while clipping into something: whether the
 * slab has reached the interior yet, how thick it is, and how much is left
 * behind it. A slider labelled "18 Å" answers none of that.
 *
 * The view is schematic rather than a second render. Drawing the real geometry
 * from the side would cost a whole extra pass over every pane, and the honest
 * information here — where the structure begins and ends along the view axis,
 * and where the two planes sit between them — is three numbers.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';

const WIDTH = 208;
const HEIGHT = 84;
/** Room at each end for the camera marker and the labels. */
const MARGIN = 26;

export function SideView({ slot, radius }: { slot: number; radius: number }) {
  const visual = useStore((s) => s.slots[slot].visual);
  const updateVisual = useStore((s) => s.updateVisual);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<'near' | 'far' | null>(null);

  const span = radius * 2;
  const toX = (depth: number) => MARGIN + (depth / span) * (WIDTH - MARGIN * 2);
  const fromX = (x: number) => ((x - MARGIN) / (WIDTH - MARGIN * 2)) * span;

  const nearX = toX(visual.clipNear);
  const farX = toX(span - visual.clipFar);

  const onMove = useCallback((event: PointerEvent) => {
    const svg = svgRef.current;
    if (!svg || !dragging.current) return;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const depth = Math.max(0, Math.min(span, fromX(x)));

    if (dragging.current === 'near') {
      // The planes cannot cross: a slab of negative thickness would blank the
      // pane, and a blank pane looks like a bug rather than like a setting.
      updateVisual(slot, { clipNear: Math.min(depth, span - visual.clipFar - 1) });
    } else {
      updateVisual(slot, { clipFar: Math.min(span - depth, span - visual.clipNear - 1) });
    }
    viewer.syncSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, span, visual.clipNear, visual.clipFar, updateVisual]);

  useEffect(() => {
    const stop = () => { dragging.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
    };
  }, [onMove]);

  const grab = (which: 'near' | 'far') => (event: React.PointerEvent) => {
    event.preventDefault();
    dragging.current = which;
  };

  const midY = HEIGHT / 2;

  return (
    <div className="side-view">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label="Side view of the clipping planes"
      >
        {/* The camera, off to the left, looking right. */}
        <path
          d={`M 4 ${midY} L 16 ${midY - 9} L 16 ${midY + 9} Z`}
          fill="var(--text-faint)"
          opacity="0.7"
        />
        <line
          x1="16" y1={midY} x2={WIDTH - 4} y2={midY}
          stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="2 3"
        />

        {/* The structure's extent along the view axis. */}
        <ellipse
          cx={(toX(0) + toX(span)) / 2}
          cy={midY}
          rx={(toX(span) - toX(0)) / 2}
          ry={HEIGHT / 2 - 12}
          fill="var(--accent-dim)"
          opacity="0.22"
        />

        {/* What survives the slab, drawn solid over the ghost. */}
        <clipPath id={`slab-${slot}`}>
          <rect x={nearX} y="0" width={Math.max(0, farX - nearX)} height={HEIGHT} />
        </clipPath>
        <ellipse
          cx={(toX(0) + toX(span)) / 2}
          cy={midY}
          rx={(toX(span) - toX(0)) / 2}
          ry={HEIGHT / 2 - 12}
          fill="var(--accent)"
          opacity="0.4"
          clipPath={`url(#slab-${slot})`}
        />

        <Plane x={nearX} height={HEIGHT} label="front" onGrab={grab('near')} />
        <Plane x={farX} height={HEIGHT} label="back" onGrab={grab('far')} />
      </svg>

      <div className="side-view-readout">
        <span>{visual.clipNear > 0 ? `front ${visual.clipNear.toFixed(0)} Å` : 'front open'}</span>
        <span>{`slab ${Math.max(0, span - visual.clipNear - visual.clipFar).toFixed(0)} Å`}</span>
        <span>{visual.clipFar > 0 ? `back ${visual.clipFar.toFixed(0)} Å` : 'back open'}</span>
      </div>

      {(visual.clipNear > 0 || visual.clipFar > 0) && (
        <button
          type="button"
          className="btn ghost small"
          style={{ width: '100%', marginTop: 6 }}
          onClick={() => {
            updateVisual(slot, { clipNear: 0, clipFar: 0 });
            viewer.syncSettings();
          }}
        >
          Clear clipping
        </button>
      )}
    </div>
  );
}

function Plane({ x, height, label, onGrab }: {
  x: number;
  height: number;
  label: string;
  onGrab: (event: React.PointerEvent) => void;
}) {
  return (
    <g className="side-view-plane" onPointerDown={onGrab} aria-label={`${label} clipping plane`}>
      <line x1={x} y1="6" x2={x} y2={height - 6} stroke="var(--accent)" strokeWidth="1.5" />
      <rect x={x - 4} y={height - 14} width="8" height="10" rx="2" fill="var(--accent)" />
      {/* A wide invisible target: the visible handle is too thin to hit. */}
      <rect x={x - 9} y="0" width="18" height={height} fill="transparent" />
    </g>
  );
}
