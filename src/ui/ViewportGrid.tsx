/**
 * The stage: one WebGPU canvas underneath, one HTML overlay pane per viewport
 * on top. The canvas never moves or resizes per pane — the engine just scissors
 * into the rectangles these panes report.
 */

import { useEffect, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  Camera, Crosshair, Loader2, Maximize2, RotateCw, Trash2, Upload,
} from 'lucide-react';
import { LAYOUT_SLOT_COUNT, useStore, type SlotState } from '../state/store';
import { viewer } from '../viewer/ViewerController';
import { Tip } from './controls';

export function ViewportGrid() {
  const layout = useStore((s) => s.layout);
  const slots = useStore((s) => s.slots);
  const activeSlot = useStore((s) => s.activeSlot);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const count = LAYOUT_SLOT_COUNT[layout];

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || viewer.isReady) return;

    viewer.init(canvas, container).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setBootError(message);
      useStore.getState().setGpuInfo('', message);
    });
  }, []);

  // Pointer handling lives on the window so a drag that leaves the pane (or
  // the browser) still tracks and still ends cleanly.
  useEffect(() => {
    const down = (e: PointerEvent) => viewer.onPointerDown(e);
    const move = (e: PointerEvent) => viewer.onPointerMove(e);
    const up = (e: PointerEvent) => viewer.onPointerUp(e);
    const wheel = (e: WheelEvent) => viewer.onWheel(e);
    const dbl = (e: MouseEvent) => viewer.onDoubleClick(e);

    const el = containerRef.current;
    if (!el) return;

    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', dbl);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', dbl);
    };
  }, []);

  // Representation, colour and shading edits are reconciled once per change.
  useEffect(() => useStore.subscribe(() => viewer.syncSettings()), []);

  return (
    <div className="stage" ref={containerRef}>
      <canvas ref={canvasRef} className="stage-canvas" />

      {bootError && (
        <div className="boot" style={{ position: 'absolute' }}>
          <h1>WebGPU unavailable</h1>
          <p>{bootError}</p>
          <p>
            This viewer renders entirely on the GPU through WebGPU. Try a recent
            Chrome, Edge, or Safari&nbsp;18+, and make sure hardware acceleration
            is enabled.
          </p>
        </div>
      )}

      <div className={`pane-grid ${layout}`}>
        {Array.from({ length: count }, (_, i) => (
          <Pane
            key={i}
            index={i}
            slot={slots[i]}
            active={i === activeSlot}
            dropping={dropTarget === i}
            onDropTarget={setDropTarget}
          />
        ))}
      </div>
    </div>
  );
}

function Pane({ index, slot, active, dropping, onDropTarget }: {
  index: number;
  slot: SlotState;
  active: boolean;
  dropping: boolean;
  onDropTarget: (slot: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const patchSlot = useStore((s) => s.patchSlot);
  const setActiveSlot = useStore((s) => s.setActiveSlot);

  useEffect(() => {
    viewer.registerPane(index, ref.current);
    return () => viewer.registerPane(index, null);
  }, [index]);

  const saveImage = async () => {
    const blob = await viewer.screenshot(index);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slot.entryId ?? 'molview'}-pane${index + 1}.png`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const progress = slot.progressTotal > 0
    ? Math.round((slot.progressLoaded / slot.progressTotal) * 100)
    : null;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          ref={ref}
          className="pane"
          data-active={active}
          onPointerDown={() => setActiveSlot(index)}
          onDragOver={(e) => { e.preventDefault(); onDropTarget(index); }}
          onDragLeave={() => onDropTarget(null)}
          onDrop={(e) => {
            e.preventDefault();
            onDropTarget(null);
            const file = e.dataTransfer.files?.[0];
            if (file) {
              void viewer.load(index, file.name.replace(/\.[^.]+$/, ''), file);
            }
          }}
        >
          <div className="pane-header">
            <div>
              <div className="pane-id">
                <span className="pane-index">{index + 1}</span>
                {slot.entryId && <span className="pdb-id">{slot.entryId}</span>}
              </div>
              {slot.detail && <div className="pane-title">{slot.detail.title}</div>}
            </div>

            {slot.status === 'ready' && (
              <div className="pane-actions">
                <Tip label="Auto-rotate">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    data-active={slot.spinning}
                    aria-label="Toggle auto-rotate"
                    onClick={() => patchSlot(index, { spinning: !slot.spinning })}
                  >
                    <RotateCw size={12} />
                  </button>
                </Tip>
                <Tip label="Reset view" shortcut="dbl-click">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    aria-label="Reset view"
                    onClick={() => viewer.resetView(index)}
                  >
                    <Maximize2 size={12} />
                  </button>
                </Tip>
                <Tip label="Save PNG">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    aria-label="Save image"
                    onClick={() => void saveImage()}
                  >
                    <Camera size={12} />
                  </button>
                </Tip>
                <Tip label="Clear pane">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    aria-label="Clear pane"
                    onClick={() => viewer.unload(index)}
                  >
                    <Trash2 size={12} />
                  </button>
                </Tip>
              </div>
            )}
          </div>

          {slot.status === 'empty' && (
            <div className="pane-empty">
              <Crosshair size={22} opacity={0.35} />
              <div className="pane-empty-hint">
                Pane {index + 1} is empty. Pick a structure from the browser, or
                drop an mmCIF file here.
              </div>
            </div>
          )}

          {slot.status === 'loading' && (
            <div className="pane-loading">
              <Loader2 size={18} className="spin" />
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--text-dim)' }}>
                {slot.progressStage}
                {progress !== null && ` · ${progress}%`}
                {progress === null && slot.progressLoaded > 0
                  && ` · ${(slot.progressLoaded / 1e6).toFixed(1)} MB`}
              </div>
              <div className="progress-track">
                <div
                  className={progress === null ? 'progress-fill indeterminate' : 'progress-fill'}
                  style={progress === null ? undefined : { width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {slot.status === 'error' && (
            <div className="pane-error">
              <div>Could not load {slot.entryId}</div>
              <div style={{ color: 'var(--text-faint)', fontSize: 10.5 }}>{slot.error}</div>
              <button
                type="button"
                className="btn small"
                onClick={() => slot.entryId && void viewer.load(index, slot.entryId)}
              >
                Retry
              </button>
            </div>
          )}

          <div className="pane-footer">
            <div className="readout">
              {slot.selectionLabel && (
                <span className="readout-hit">◆ {slot.selectionLabel}</span>
              )}
              {slot.hoverLabel && <span>{slot.hoverLabel}</span>}
            </div>
            {slot.stats && (
              <div style={{ textAlign: 'right' }}>
                <div>{slot.stats.atoms.toLocaleString()} atoms · {slot.stats.chains} chains</div>
                <div style={{ opacity: 0.7 }}>
                  {slot.stats.instances > 0
                    && `${slot.stats.instances.toLocaleString()} impostors`}
                  {slot.stats.instances > 0 && slot.stats.triangles > 0 && ' · '}
                  {slot.stats.triangles > 0
                    && `${slot.stats.triangles.toLocaleString()} tris`}
                </div>
              </div>
            )}
          </div>

          {dropping && (
            <div className="drop-overlay">
              <Upload size={20} />
              Drop mmCIF or BinaryCIF to load into pane {index + 1}
            </div>
          )}
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content">
          <ContextMenu.Label className="menu-label">Pane {index + 1}</ContextMenu.Label>
          <ContextMenu.Item
            className="menu-item"
            disabled={slot.status !== 'ready'}
            onSelect={() => viewer.resetView(index)}
          >
            Reset view
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            disabled={slot.status !== 'ready'}
            onSelect={() => patchSlot(index, { spinning: !slot.spinning })}
          >
            {slot.spinning ? 'Stop auto-rotate' : 'Auto-rotate'}
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            disabled={slot.status !== 'ready'}
            onSelect={() => viewer.syncCameras(index)}
          >
            Match other panes to this one
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item
            className="menu-item"
            disabled={!slot.entryId}
            onSelect={() => slot.entryId && void navigator.clipboard.writeText(slot.entryId)}
          >
            Copy PDB ID
          </ContextMenu.Item>
          <ContextMenu.Item
            className="menu-item"
            disabled={slot.status !== 'ready'}
            onSelect={() => void saveImage()}
          >
            Save pane as PNG
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item
            className="menu-item"
            disabled={!slot.entryId}
            onSelect={() => viewer.unload(index)}
          >
            Clear pane
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
