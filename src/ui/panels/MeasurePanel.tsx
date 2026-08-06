/** Distances, angles, torsions and hydrogen bonds for the active pane. */

import { useState } from 'react';
import { Crosshair, Layers, Ruler, Trash2, Triangle, Waypoints } from 'lucide-react';
import { describeAtom, type MeasurementKind } from '../../mol/measure';
import { findInterfaces, interfaceSelection, type ChainInterface } from '../../mol/interfaces';
import { makeComponent, Style } from '../../mol/components';
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

      <InterfaceSection slot={activeSlot} />

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

/**
 * Which chains touch which. The obvious question about an assembly, and the one
 * the viewer could not answer — you can build a 900-chain capsid and still have
 * no way to ask what packs against what.
 */
function InterfaceSection({ slot }: { slot: number }) {
  const components = useStore((s) => s.slots[slot].components);
  const setComponents = useStore((s) => s.setComponents);
  const [list, setList] = useState<ChainInterface[] | null>(null);
  const [busy, setBusy] = useState(false);

  const structure = viewer.getStructure(slot);
  if (!structure) return null;

  const compute = () => {
    setBusy(true);
    // Yield first: on a large assembly this takes long enough to drop a frame,
    // and a button that looks stuck is worse than one that says it is working.
    window.setTimeout(() => {
      setList(findInterfaces(structure));
      setBusy(false);
    }, 0);
  };

  const show = (entry: ChainInterface) => {
    const name = `Interface ${entry.chainA}-${entry.chainB}`;
    const selection = interfaceSelection(entry);
    const existing = components.findIndex((c) => c.name === name);
    const next = existing >= 0
      ? components.map((c, i) => (i === existing ? { ...c, selection, visible: true } : c))
      : [...components, makeComponent({ name, selection, style: Style.BallStick })];
    setComponents(slot, next);
  };

  return (
    <div className="panel-section">
      <div className="section-label"><span>Interfaces</span></div>
      {list === null ? (
        <>
          <button
            type="button"
            className="btn small"
            style={{ width: '100%' }}
            disabled={busy}
            onClick={compute}
          >
            <Layers size={12} /> {busy ? 'Searching…' : 'Find chain contacts'}
          </button>
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
            Heavy atoms within 4 Å, grouped by chain pair. Proximity, not buried
            area — it says where to look, not how tightly anything binds.
          </p>
        </>
      ) : list.length === 0 ? (
        <p style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          No chain touches another. A single-chain structure, or an assembly
          whose copies are not built.
        </p>
      ) : (
        <>
          {list.slice(0, 12).map((entry) => (
            <div key={`${entry.chainA}-${entry.chainB}`} className="measurement">
              <div className="measurement-head">
                <span style={{ fontSize: 11.5, marginRight: 'auto' }}>
                  {entry.chainA} · {entry.chainB}
                </span>
                <Tip label="Frame this interface">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Focus interface ${entry.chainA} ${entry.chainB}`}
                    onClick={() => viewer.focusSelection(slot, interfaceSelection(entry))}
                  >
                    <Crosshair size={11} />
                  </button>
                </Tip>
                <Tip label="Draw it as a component">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Show interface ${entry.chainA} ${entry.chainB}`}
                    onClick={() => show(entry)}
                  >
                    <Layers size={11} />
                  </button>
                </Tip>
              </div>
              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
                {entry.contacts.toLocaleString()} contacts · {entry.polar} polar ·{' '}
                {entry.residuesA.length}+{entry.residuesB.length} residues
              </div>
            </div>
          ))}
          {list.length > 12 && (
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>
              {list.length - 12} weaker pair{list.length - 12 === 1 ? '' : 's'} not shown.
            </p>
          )}
          <button
            type="button"
            className="btn small"
            style={{ width: '100%', marginTop: 7 }}
            onClick={() => setList(null)}
          >
            Search again
          </button>
        </>
      )}
    </div>
  );
}
