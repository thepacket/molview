/** Representation, colouring and shading controls for the active pane. */

import { Crosshair, Eye, EyeOff } from 'lucide-react';
import { COLOR_SCHEME_LABELS, CHAIN_PALETTE, type ColorScheme } from '../../mol/coloring';
import { MolKind } from '../../mol/structure';
import type { LigandStyle, PolymerStyle } from '../../gfx/geometry';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Field, Select, Slider, Toggle, Tip } from '../controls';

const POLYMER_STYLES: { value: PolymerStyle; label: string }[] = [
  { value: 'cartoon', label: 'Cartoon' },
  { value: 'backbone', label: 'Backbone trace' },
  { value: 'ball-stick', label: 'Ball and stick' },
  { value: 'licorice', label: 'Licorice' },
  { value: 'spacefill', label: 'Spacefill' },
  { value: 'none', label: 'Hidden' },
];

const LIGAND_STYLES: { value: LigandStyle; label: string }[] = [
  { value: 'ball-stick', label: 'Ball and stick' },
  { value: 'licorice', label: 'Licorice' },
  { value: 'spacefill', label: 'Spacefill' },
  { value: 'none', label: 'Hidden' },
];

const COLOR_SCHEMES = (Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[])
  .map((value) => ({ value, label: COLOR_SCHEME_LABELS[value] }));

const BACKGROUNDS: { label: string; value: [number, number, number] }[] = [
  { label: 'Void', value: [0.043, 0.051, 0.071] },
  { label: 'Slate', value: [0.11, 0.13, 0.16] },
  { label: 'Ink', value: [0.02, 0.02, 0.03] },
  { label: 'Bone', value: [0.87, 0.88, 0.9] },
];

export function StylePanel() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const updateRepresentation = useStore((s) => s.updateRepresentation);
  const updateVisual = useStore((s) => s.updateVisual);
  const patchSlot = useStore((s) => s.patchSlot);

  const structure = viewer.getStructure(activeSlot);

  if (slot.status !== 'ready' || !structure) {
    return (
      <div className="empty-state">
        Load a structure into pane {activeSlot + 1} to adjust its appearance.
      </div>
    );
  }

  const rep = slot.representation;

  const setChainHidden = (authId: string, hidden: boolean) => {
    const next = new Set(rep.hiddenChains);
    if (hidden) next.add(authId);
    else next.delete(authId);
    updateRepresentation(activeSlot, { hiddenChains: next });
  };

  // One entry per distinct auth chain, in file order.
  const chains: { authId: string; kind: number; residues: number }[] = [];
  const seen = new Map<string, number>();
  for (let c = 0; c < structure.chainCount; c++) {
    const id = structure.chainAuthId[c];
    const residues = structure.chainResStart[c + 1] - structure.chainResStart[c];
    const existing = seen.get(id);
    if (existing !== undefined) {
      chains[existing].residues += residues;
    } else {
      seen.set(id, chains.length);
      chains.push({ authId: id, kind: structure.chainKind[c], residues });
    }
  }

  return (
    <>
      <div className="panel-section">
        <div className="section-label"><span>Representation</span></div>
        <Field label="Polymer">
          <Select
            ariaLabel="Polymer representation"
            value={rep.polymer}
            options={POLYMER_STYLES}
            onChange={(v) => updateRepresentation(activeSlot, { polymer: v })}
          />
        </Field>
        <Field label="Ligands and cofactors">
          <Select
            ariaLabel="Ligand representation"
            value={rep.ligand}
            options={LIGAND_STYLES}
            onChange={(v) => updateRepresentation(activeSlot, { ligand: v })}
          />
        </Field>
        <Field label="Atom scale" value={`${rep.atomScale.toFixed(2)}×`}>
          <Slider
            value={rep.atomScale}
            min={0.25}
            max={2}
            step={0.05}
            onChange={(v) => updateRepresentation(activeSlot, { atomScale: v })}
          />
        </Field>
        <Field label="Bond radius" value={`${rep.bondRadius.toFixed(2)} Å`}>
          <Slider
            value={rep.bondRadius}
            min={0.04}
            max={0.4}
            step={0.01}
            onChange={(v) => updateRepresentation(activeSlot, { bondRadius: v })}
          />
        </Field>
        <Toggle
          label="Waters"
          checked={rep.showWater}
          onChange={(v) => updateRepresentation(activeSlot, { showWater: v })}
          hint="Crystallographic waters; usually thousands of them"
        />
        <Toggle
          label="Ions"
          checked={rep.showIons}
          onChange={(v) => updateRepresentation(activeSlot, { showIons: v })}
        />
        <Toggle
          label="Hydrogens"
          checked={rep.showHydrogens}
          onChange={(v) => updateRepresentation(activeSlot, { showHydrogens: v })}
          hint="Only present in neutron and very high resolution structures"
        />
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Colour</span></div>
        <Field label="Scheme">
          <Select
            ariaLabel="Colour scheme"
            value={slot.colorScheme}
            options={COLOR_SCHEMES}
            onChange={(v) => patchSlot(activeSlot, { colorScheme: v })}
          />
        </Field>
        {slot.colorScheme === 'uniform' && (
          <Field label="Colour">
            <div className="chip-row">
              {CHAIN_PALETTE.slice(0, 8).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c.toString(16)}`}
                  onClick={() => patchSlot(activeSlot, { uniformColor: c })}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 3,
                    background: `#${c.toString(16).padStart(6, '0')}`,
                    border: slot.uniformColor === c
                      ? '2px solid var(--text)'
                      : '1px solid var(--line-strong)',
                  }}
                />
              ))}
            </div>
          </Field>
        )}
      </div>

      <div className="panel-section">
        <div className="section-label">
          <span>Chains ({chains.length})</span>
          {rep.hiddenChains.size > 0 && (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => updateRepresentation(activeSlot, { hiddenChains: new Set() })}
            >
              Show all
            </button>
          )}
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', margin: '0 -6px' }}>
          {chains.map((c, i) => {
            const hidden = rep.hiddenChains.has(c.authId);
            return (
              <div key={c.authId} className="chain-toggle" data-hidden={hidden}>
                <span
                  className="seq-swatch"
                  style={{
                    background: `#${CHAIN_PALETTE[(i + activeSlot * 3) % CHAIN_PALETTE.length]
                      .toString(16).padStart(6, '0')}`,
                  }}
                />
                <span className="chain-name">
                  {c.authId} · {kindLabel(c.kind)} · {c.residues}
                </span>
                <Tip label="Focus this chain">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    onClick={() => viewer.focusChain(activeSlot, c.authId)}
                    aria-label={`Focus chain ${c.authId}`}
                  >
                    <Crosshair size={11} />
                  </button>
                </Tip>
                <Tip label={hidden ? 'Show chain' : 'Hide chain'}>
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    onClick={() => setChainHidden(c.authId, !hidden)}
                    aria-label={`${hidden ? 'Show' : 'Hide'} chain ${c.authId}`}
                  >
                    {hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                </Tip>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Shading</span></div>
        <Field label="Ambient occlusion" value={slot.visual.aoIntensity.toFixed(2)}>
          <Slider
            value={slot.visual.aoIntensity}
            min={0}
            max={1.6}
            step={0.05}
            onChange={(v) => updateVisual(activeSlot, { aoIntensity: v })}
          />
        </Field>
        <Field label="Occlusion radius" value={`${slot.visual.aoRadius.toFixed(1)} Å`}>
          <Slider
            value={slot.visual.aoRadius}
            min={0}
            max={14}
            step={0.5}
            onChange={(v) => updateVisual(activeSlot, { aoRadius: v })}
          />
        </Field>
        <Field label="Outline" value={slot.visual.outline.toFixed(2)}>
          <Slider
            value={slot.visual.outline}
            min={0}
            max={1.5}
            step={0.05}
            onChange={(v) => updateVisual(activeSlot, { outline: v })}
          />
        </Field>
        <Field label="Depth fog" value={slot.visual.fogDensity.toFixed(3)}>
          <Slider
            value={slot.visual.fogDensity}
            min={0}
            max={0.03}
            step={0.001}
            onChange={(v) => updateVisual(activeSlot, { fogDensity: v })}
          />
        </Field>
        <Field
          label="Front clipping"
          value={slot.visual.clipNear > 0 ? `${slot.visual.clipNear.toFixed(0)} Å` : 'off'}
        >
          <Slider
            value={slot.visual.clipNear}
            min={0}
            max={Math.max(20, Math.round(structure.radius * 2))}
            step={1}
            onChange={(v) => updateVisual(activeSlot, { clipNear: v })}
          />
        </Field>
        <Toggle
          label="Orthographic camera"
          checked={slot.visual.orthographic}
          onChange={(v) => updateVisual(activeSlot, { orthographic: v })}
          hint="Removes perspective; useful for comparing sizes between panes"
        />
        <Field label="Background">
          <div className="chip-row">
            {BACKGROUNDS.map((b) => {
              const active = b.value.every((v, i) => Math.abs(v - slot.visual.background[i]) < 1e-3);
              return (
                <button
                  key={b.label}
                  type="button"
                  className={active ? 'chip accent' : 'chip'}
                  onClick={() => updateVisual(activeSlot, { background: b.value })}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </>
  );
}

function kindLabel(kind: number): string {
  switch (kind) {
    case MolKind.Protein: return 'protein';
    case MolKind.Nucleic: return 'nucleic';
    case MolKind.Water: return 'water';
    case MolKind.Ion: return 'ions';
    default: return 'ligand';
  }
}
