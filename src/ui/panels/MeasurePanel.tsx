/** Distances, angles, torsions and hydrogen bonds for the active pane. */

import { useState } from 'react';
import { Crosshair, Layers, Ruler, Trash2, Triangle, Waypoints } from 'lucide-react';
import { describeAtom, type MeasurementKind } from '../../mol/measure';
import {
  findInterfaces, interfaceSelection, measureInterfaceAreas, type ChainInterface,
} from '../../mol/interfaces';
import { findPockets, pocketSelection, type Pocket } from '../../mol/pockets';
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

      <PocketSection slot={activeSlot} />

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
  const assemblyId = useStore((s) => s.slots[slot].assemblyId);
  const setComponents = useStore((s) => s.setComponents);
  const [list, setList] = useState<ChainInterface[] | null>(null);
  const [busy, setBusy] = useState(false);

  const structure = viewer.getStructure(slot);
  if (!structure) return null;

  // With an assembly selected, the interesting contacts are usually the ones
  // between symmetry copies: a ferritin asymmetric unit is a single chain and
  // touches nothing at all until its 24-mer is built.
  const assembly = structure.assemblies.find((a) => a.id === assemblyId) ?? null;

  const compute = () => {
    setBusy(true);
    // Yield first: on a large assembly this takes long enough to drop a frame,
    // and a button that looks stuck is worse than one that says it is working.
    window.setTimeout(() => {
      const found = findInterfaces(structure, { assembly });
      // Areas for the ones that will actually be shown. Measuring all of them
      // on a capsid would be a hundred SASA passes for a list nobody reads
      // past the top of.
      measureInterfaceAreas(structure, found.slice(0, 12));
      setList(found);
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
            Heavy atoms within 4 Å, grouped by chain pair, with the area each
            one buries. Contacts rank them; the area is what a paper quotes,
            and the two disagree more often than you would think — a flat patch
            and a knob in a socket can touch equally and bury three times as
            differently.
            {assembly
              ? ' Contacts with symmetry copies are included; only the deposited'
                + ' side of those can be selected, since the other side is a matrix.'
              : ''}
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
            <div
              key={`${entry.chainA}-${entry.chainB}-${entry.copyB ?? 0}`}
              className="measurement"
            >
              <div className="measurement-head">
                <span style={{ fontSize: 11.5, marginRight: 'auto' }}>
                  {entry.chainA} · {entry.chainB}
                  {entry.copyB !== undefined && (
                    <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>
                      {' '}copy {entry.copyB}
                    </span>
                  )}
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
                {entry.area != null && `${Math.round(entry.area).toLocaleString()} Å² · `}
                {entry.contacts.toLocaleString()} contacts · {entry.polar} polar ·{' '}
                {entry.copyB === undefined
                  ? `${entry.residuesA.length}+${entry.residuesB.length} residues`
                  : `${entry.residuesA.length} residues facing it`}
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

/**
 * Cavities, ranked by volume.
 *
 * The first question about an unfamiliar structure with a hole in it. What
 * makes the list trustworthy is the ligand column: a pocket-finder that cannot
 * find the pocket the ligand is already in is not working, and the ligands are
 * excluded from the grid before the search, so seeing one named beside the top
 * pocket is the method reporting on itself rather than a restatement of the
 * input.
 */
function PocketSection({ slot }: { slot: number }) {
  const components = useStore((s) => s.slots[slot].components);
  const setComponents = useStore((s) => s.setComponents);
  const [list, setList] = useState<Pocket[] | null>(null);
  const [busy, setBusy] = useState(false);

  const structure = viewer.getStructure(slot);
  if (!structure) return null;

  const compute = () => {
    setBusy(true);
    window.setTimeout(() => {
      setList(findPockets(structure));
      setBusy(false);
    }, 0);
  };

  const draw = (pocket: Pocket, index: number) => {
    const name = `Pocket ${index + 1}`;
    const selection = pocketSelection(pocket);
    const existing = components.findIndex((c) => c.name === name);
    const next = existing >= 0
      ? components.map((c, i) => (i === existing ? { ...c, selection, visible: true } : c))
      : [...components, makeComponent({ name, selection, style: Style.Licorice })];
    setComponents(slot, next);
  };

  return (
    <div className="panel-section">
      <div className="section-label"><span>Pockets</span></div>
      {list === null ? (
        <>
          <button
            type="button"
            className="btn small"
            style={{ width: '100%' }}
            disabled={busy}
            onClick={compute}
          >
            <Layers size={12} /> {busy ? 'Scanning…' : 'Find cavities'}
          </button>
          <p className="panel-note" style={{ marginTop: 7, marginBottom: 0 }}>
            Grid points enclosed by protein along at least four of seven axes,
            clustered. It finds concavity, not affinity — a large pocket is not
            a druggable one. Ligands are left out of the scan, so any named
            beside a pocket were found rather than assumed.
          </p>
        </>
      ) : list.length === 0 ? (
        <p style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          No enclosed cavity above 40 Å³. A small or very open structure.
        </p>
      ) : (
        <>
          {list.map((pocket, index) => (
            <div key={index} className="measurement">
              <div className="measurement-head">
                <span style={{ fontSize: 11.5, marginRight: 'auto' }}>
                  {Math.round(pocket.volume).toLocaleString()} Å³
                  {pocket.ligands.length > 0 && (
                    <span style={{ color: 'var(--accent)', fontSize: 10 }}>
                      {' '}· {pocket.ligands.join(', ')}
                    </span>
                  )}
                </span>
                <Tip label="Frame this pocket">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Focus pocket ${index + 1}`}
                    onClick={() => viewer.focusSelection(slot, pocketSelection(pocket))}
                  >
                    <Crosshair size={11} />
                  </button>
                </Tip>
                <Tip label="Draw its lining">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Show pocket ${index + 1}`}
                    onClick={() => draw(pocket, index)}
                  >
                    <Layers size={11} />
                  </button>
                </Tip>
              </div>
              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
                {pocket.lining.slice(0, 6).map((r) => `${r.name}${r.seq}`).join(' ')}
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn small"
            style={{ width: '100%', marginTop: 7 }}
            onClick={() => setList(null)}
          >
            Scan again
          </button>
        </>
      )}
    </div>
  );
}
