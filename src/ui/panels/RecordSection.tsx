/**
 * Recording the active pane as a turntable clip.
 *
 * Deliberately not a "record what I do" button. Capturing the screen in real
 * time records the stutter along with the molecule, and on a large assembly
 * the turn comes out visibly uneven. A turntable is also what these clips are
 * almost always for — a figure that rotates once — so the export drives the
 * camera itself and a slow structure costs a slow export rather than a bad
 * video.
 */

import { useState } from 'react';
import { Video } from 'lucide-react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Field, Slider } from '../controls';

const SIZES = [640, 960, 1280, 1920];

export function RecordSection() {
  const activeSlot = useStore((s) => s.activeSlot);
  const status = useStore((s) => s.slots[s.activeSlot].status);
  const entryId = useStore((s) => s.slots[s.activeSlot].entryId);

  const [seconds, setSeconds] = useState(6);
  const [turns, setTurns] = useState(1);
  const [size, setSize] = useState(1280);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status !== 'ready') return null;

  const record = async () => {
    setError(null);
    setProgress(0);
    try {
      const blob = await viewer.recordTurntable(
        activeSlot, { seconds, fps: 30, turns, maxSize: size }, setProgress,
      );
      if (!blob) throw new Error('Nothing was recorded.');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `molview-${(entryId ?? 'pane').toLowerCase()}-turntable.webm`;
      a.click();
      // Revoking immediately can beat the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="panel-section">
      <div className="section-label"><span>Record</span></div>

      <Field label="Length" value={`${seconds} s`}>
        <Slider value={seconds} min={2} max={20} step={1} onChange={setSeconds} />
      </Field>
      <Field label="Turns" value={turns === 1 ? 'one full turn' : `${turns} turns`}>
        <Slider value={turns} min={1} max={4} step={1} onChange={setTurns} />
      </Field>
      <Field label="Size" value={`${size}px`}>
        <div className="chip-row">
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              className={size === s ? 'chip accent' : 'chip'}
              onClick={() => setSize(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </Field>

      <button
        type="button"
        className="btn"
        style={{ width: '100%', marginTop: 8 }}
        disabled={progress !== null}
        onClick={() => void record()}
      >
        <Video size={12} />
        {progress === null
          ? `Record pane ${activeSlot + 1}`
          : `Recording… ${Math.round(progress * 100)}%`}
      </button>

      <p className="panel-note" style={{ marginTop: 7, marginBottom: 0 }}>
        Saves a WebM file. The pane keeps rendering while it records, so leave
        it visible; the camera returns to where it was afterwards.
      </p>

      {error && (
        <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 6 }}>{error}</p>
      )}
    </div>
  );
}
