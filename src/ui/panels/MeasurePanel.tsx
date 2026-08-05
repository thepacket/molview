/** Distances, angles, torsions and hydrogen bonds for the active pane. */

import { Ruler, Trash2, Triangle, Waypoints } from 'lucide-react';
import { describeAtom, type MeasurementKind } from '../../mol/measure';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Segmented, Toggle, Tip } from '../controls';

const MODES: { value: string; label: React.ReactNode; title: string }[] = [
  { value: 'off', label: 'Off', title: 'Clicking selects residues' },
  { value: 'distance', label: <Ruler size={12} />, title: 'Distance between two atoms' },
  { value: 'angle', label: <Triangle size={12} />, title: 'Angle across three atoms' },
  { value: 'torsion', label: <Waypoints size={12} />, title: 'Torsion across four atoms' },
];

const NEEDED: Record<MeasurementKind, number> = { distance: 2, angle: 3, torsion: 4 };

export function MeasurePanel() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const patchSlot = useStore((s) => s.patchSlot);

  const structure = viewer.getStructure(activeSlot);
  if (slot.status !== 'ready' || !structure) {
    return (
      <div className="empty-state">
        Load a structure into pane {activeSlot + 1} to take measurements.
      </div>
    );
  }

  const mode = slot.measureMode;
  const needed = mode ? NEEDED[mode] : 0;

  return (
    <>
      <div className="panel-section">
        <div className="section-label"><span>Mode</span></div>
        <Segmented
          value={mode ?? 'off'}
          options={MODES}
          onChange={(v) => viewer.setMeasureMode(
            activeSlot, v === 'off' ? null : (v as MeasurementKind),
          )}
        />
        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
          {mode
            ? `Click ${needed} atoms. ${slot.pendingAtoms.length} of ${needed} picked — `
              + 'click a picked atom again to drop it.'
            : 'Clicking a pane selects a residue. Pick a mode to measure instead.'}
        </p>

        {slot.pendingAtoms.length > 0 && (
          <div className="chip-row" style={{ marginTop: 6 }}>
            {slot.pendingAtoms.map((a) => (
              <span key={a} className="chip accent">{describeAtom(structure, a)}</span>
            ))}
          </div>
        )}
      </div>

      <div className="panel-section">
        <div className="section-label">
          <span>Measurements ({slot.measurements.length})</span>
          {slot.measurements.length > 0 && (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => viewer.clearMeasurements(activeSlot)}
            >
              Clear
            </button>
          )}
        </div>

        {slot.measurements.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            Nothing measured yet.
          </div>
        )}

        {slot.measurements.map((m) => (
          <div key={m.id} className="measurement">
            <div className="measurement-head">
              <span className="measurement-value">{m.label}</span>
              <span className="measurement-kind">{m.kind}</span>
              <Tip label="Remove">
                <button
                  type="button"
                  className="pane-icon-btn"
                  style={{ width: 20, height: 20 }}
                  aria-label="Remove measurement"
                  onClick={() => viewer.removeMeasurement(activeSlot, m.id)}
                >
                  <Trash2 size={11} />
                </button>
              </Tip>
            </div>
            <div className="measurement-atoms">
              {m.atoms.map((a) => describeAtom(structure, a)).join('  →  ')}
            </div>
          </div>
        ))}
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Contacts</span></div>
        <Toggle
          label="Hydrogen bonds"
          checked={slot.showHydrogenBonds}
          onChange={(v) => viewer.toggleHydrogenBonds(activeSlot, v)}
          hint="Geometric heavy-atom criterion, not an energetic one"
        />
        {slot.showHydrogenBonds && (
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
            {slot.hydrogenBondCount.toLocaleString()} donor–acceptor pairs within 3.3 Å.
            Most PDB entries carry no hydrogens, so these are inferred from heavy-atom
            geometry and will include some pairs a full analysis would reject.
          </p>
        )}
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Display</span></div>
        <Toggle
          label="Labels in the viewport"
          checked={slot.showLabels}
          onChange={(v) => {
            patchSlot(activeSlot, { showLabels: v });
            viewer.refreshOverlay(activeSlot);
          }}
        />
      </div>
    </>
  );
}
