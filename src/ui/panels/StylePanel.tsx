/** Representation, colouring and shading controls for the active pane. */

import { Crosshair, Eye, EyeOff } from 'lucide-react';
import type { Assembly } from '../../mol/assembly';
import type { NucleotideStyle } from '../../gfx/geometry';
import {
  COLOR_SCHEME_LABELS, CHAIN_PALETTE, VALIDATION_SCHEMES, type ColorScheme,
} from '../../mol/coloring';
import { MolKind } from '../../mol/structure';

import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Field, Segmented, Select, Slider, Toggle, Tip } from '../controls';
import { ComponentList } from './ComponentList';
import { SideView } from './SideView';
import { ValidationLegend } from './ValidationLegend';

const COLOR_SCHEMES = (Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[])
  .map((value) => ({ value, label: COLOR_SCHEME_LABELS[value] }));

const NUCLEOTIDE_STYLES: { value: NucleotideStyle; label: string }[] = [
  { value: 'slab', label: 'Slab' },
  { value: 'ladder', label: 'Ladder' },
  { value: 'stubs', label: 'Stubs' },
  { value: 'none', label: 'None' },
];

/** Named shading looks; the sliders below stay available for fine control. */
const LIGHTING_PRESETS: {
  name: string;
  values: {
    aoIntensity: number; aoRadius: number; outline: number; fogDensity: number;
    shadow: number;
  };
}[] = [
  { name: 'Studio', values: { aoIntensity: 1, aoRadius: 4.5, outline: 0.85, fogDensity: 0.006, shadow: 0.55 } },
  { name: 'Soft', values: { aoIntensity: 1.45, aoRadius: 8, outline: 0, fogDensity: 0.004, shadow: 0.35 } },
  { name: 'Flat', values: { aoIntensity: 0, aoRadius: 0, outline: 1.2, fogDensity: 0, shadow: 0 } },
  { name: 'Plain', values: { aoIntensity: 0, aoRadius: 0, outline: 0, fogDensity: 0, shadow: 0 } },
];

function matchPreset(visual: {
  aoIntensity: number; outline: number; fogDensity: number; shadow: number;
}): string {
  const hit = LIGHTING_PRESETS.find((p) =>
    Math.abs(p.values.aoIntensity - visual.aoIntensity) < 1e-3
    && Math.abs(p.values.outline - visual.outline) < 1e-3
    && Math.abs(p.values.shadow - visual.shadow) < 1e-3
    && Math.abs(p.values.fogDensity - visual.fogDensity) < 1e-4);
  return hit ? hit.name : 'Custom';
}

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
  // Not memoised: this sits after an early return, so a hook here would change
  // the hook order between an empty pane and a loaded one.
  let hasNucleic = false;
  for (let c = 0; c < structure.chainCount; c++) {
    if (structure.chainKind[c] === MolKind.Nucleic) { hasNucleic = true; break; }
  }

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

  // The deposited coordinates are one option among the file's assemblies.
  const assemblyOptions = [
    { value: '', label: `Asymmetric unit (${structure.chainCount} chains)` },
    ...structure.assemblies.map((a) => ({
      value: a.id,
      label: `Assembly ${a.id} — ${describeAssembly(a)}`,
    })),
  ];
  const activeAssembly = structure.assemblies.find((a) => a.id === slot.assemblyId);

  return (
    <>
      {structure.assemblies.length > 0 && (
        <div className="panel-section">
          <div className="section-label"><span>Biological assembly</span></div>
          <Select
            ariaLabel="Biological assembly"
            value={slot.assemblyId}
            options={assemblyOptions}
            onChange={(v) => patchSlot(activeSlot, { assemblyId: v })}
          />
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
            {activeAssembly
              ? `${activeAssembly.totalCopies} cop${activeAssembly.totalCopies === 1 ? 'y' : 'ies'} `
                + `of the asymmetric unit, generated on the GPU — no extra atoms are stored.`
              : 'The coordinates as deposited. This is often not the biological molecule.'}
          </p>
          {activeAssembly && activeAssembly.totalCopies > 1 && (
            <div style={{ marginTop: 8 }}>
              <Toggle
                label="Colour copies by symmetry"
                checked={slot.visual.colorBySymmetry}
                onChange={(v) => updateVisual(activeSlot, { colorBySymmetry: v })}
                hint="Tints each operator differently so symmetry mates are distinguishable"
              />
            </div>
          )}
          {activeAssembly && (
            <button
              type="button"
              className="btn small"
              style={{ width: '100%', marginTop: 7 }}
              onClick={() => viewer.frameSlot(activeSlot, true)}
            >
              Fit assembly in view
            </button>
          )}
        </div>
      )}

      {structure.modelCount > 1 && (
        <div className="panel-section">
          <div className="section-label"><span>Ensemble</span></div>
          <Toggle
            label={`Show all ${structure.modelCount} models`}
            checked={structure.modelNum === 0}
            onChange={(v) => void viewer.setEnsembleOverlay(activeSlot, v)}
            hint="Draws every model at once, as backbone traces"
          />
          {structure.modelNum !== 0 && (
            <div style={{ marginTop: 9 }}>
              <Field
                label="Model"
                value={`${structure.modelNum} of ${structure.modelCount}`}
              >
                <Slider
                  value={structure.modelNum}
                  min={1}
                  max={structure.modelCount}
                  step={1}
                  onChange={(v) => void viewer.setModel(activeSlot, v)}
                />
              </Field>
            </div>
          )}
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.5, marginTop: 7 }}>
            {structure.modelNum === 0
              ? 'Every model is drawn as a separate chain, so "model 3" selects one '
                + 'of them and the spread between them is visible directly.'
              : 'NMR depositions contain several models of the same molecule. The '
                + 'camera stays put as you step through them.'}
          </p>
        </div>
      )}

      <ComponentList slot={activeSlot} />

      <div className="panel-section">
        <div className="section-label"><span>Sizing</span></div>
        <Field label="Atom scale" value={`${rep.atomScale.toFixed(2)}x`}>
          <Slider
            value={rep.atomScale}
            min={0.25}
            max={2}
            step={0.05}
            onChange={(v) => updateRepresentation(activeSlot, { atomScale: v })}
          />
        </Field>
        <Field label="Bond radius" value={`${rep.bondRadius.toFixed(2)} A`}>
          <Slider
            value={rep.bondRadius}
            min={0.04}
            max={0.4}
            step={0.01}
            onChange={(v) => updateRepresentation(activeSlot, { bondRadius: v })}
          />
        </Field>
        <Toggle
          label="Hydrogens"
          checked={rep.showHydrogens}
          onChange={(v) => updateRepresentation(activeSlot, { showHydrogens: v })}
          hint="Only present in neutron and very high resolution structures"
        />
        {/* Only shown when there is nucleic acid to apply it to — the control
            is meaningless on a protein-only structure. */}
        {hasNucleic && (
          <Field label="Nucleotide bases">
            <Select
              ariaLabel="Nucleotide base style"
              value={rep.nucleotideStyle}
              options={NUCLEOTIDE_STYLES}
              onChange={(v) => updateRepresentation(activeSlot, { nucleotideStyle: v })}
            />
          </Field>
        )}
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Colour</span></div>
        <Field label="Default scheme">
          <Select
            ariaLabel="Colour scheme"
            value={slot.colorScheme}
            options={COLOR_SCHEMES}
            onChange={(v) => patchSlot(activeSlot, { colorScheme: v })}
          />
        </Field>
        <Toggle
          label="Show colour key"
          checked={slot.showColorKey}
          onChange={(v) => patchSlot(activeSlot, { showColorKey: v })}
          hint="A legend over the pane, included in screenshots and recordings"
        />
        {VALIDATION_SCHEMES.has(slot.colorScheme) && (
          <ValidationLegend scheme={slot.colorScheme} slot={activeSlot} />
        )}
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
        <Field label="Preset">
          <Segmented
            value={matchPreset(slot.visual)}
            options={LIGHTING_PRESETS.map((p) => ({ value: p.name, label: p.name }))}
            onChange={(name) => {
              const preset = LIGHTING_PRESETS.find((p) => p.name === name);
              if (preset) updateVisual(activeSlot, preset.values);
            }}
          />
        </Field>
        <Field label="Ambient occlusion" value={slot.visual.aoIntensity.toFixed(2)}>
          <Slider
            value={slot.visual.aoIntensity}
            min={0}
            max={1.6}
            step={0.05}
            onChange={(v) => updateVisual(activeSlot, { aoIntensity: v })}
          />
        </Field>
        <Field label="Shadows" value={slot.visual.shadow.toFixed(2)}>
          <Slider
            value={slot.visual.shadow}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => updateVisual(activeSlot, { shadow: v })}
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
        <Field label="Clipping">
          <SideView slot={activeSlot} radius={Math.max(structure.radius, 1)} />
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

function describeAssembly(a: Assembly): string {
  // Depositors write either a machine tag or a human phrase; prefer the phrase.
  const detail = a.details && !a.details.includes('_defined_assembly')
    ? a.details
    : a.oligomericDetails;
  const chains = a.oligomericCount > 0 ? `${a.oligomericCount} chains` : `${a.totalCopies}x`;
  return detail ? `${detail}, ${chains}` : chains;
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
