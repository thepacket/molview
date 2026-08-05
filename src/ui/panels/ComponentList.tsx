/**
 * The component editor: the pane's draw layers, in order.
 *
 * Each row is a selection plus how to draw it. Later rows win where selections
 * overlap, which is what makes "cartoon everywhere, sticks at the active site"
 * a two-row scene rather than a special case.
 */

import { useEffect, useState } from 'react';
import { Eye, EyeOff, GripVertical, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  STYLE_LABELS, STYLE_ORDER, Style, makeComponent, type Component,
} from '../../mol/components';
import { COLOR_SCHEME_LABELS, type ColorScheme } from '../../mol/coloring';
import { SELECTION_EXAMPLES, selectionError } from '../../mol/selection';
import { useStore } from '../../state/store';
import { Select, Tip } from '../controls';

const STYLE_OPTIONS = STYLE_ORDER.map((s) => ({ value: String(s), label: STYLE_LABELS[s] }));

const COLOR_OPTIONS = [
  { value: '', label: 'Inherit pane colour' },
  ...(Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[])
    .map((value) => ({ value, label: COLOR_SCHEME_LABELS[value] })),
];

export function ComponentList({ slot }: { slot: number }) {
  const components = useStore((s) => s.slots[slot].components);
  const counts = useStore((s) => s.slots[slot].componentCounts);
  const errors = useStore((s) => s.slots[slot].componentErrors);
  const setComponents = useStore((s) => s.setComponents);
  const updateComponent = useStore((s) => s.updateComponent);
  const removeComponent = useStore((s) => s.removeComponent);
  const [adding, setAdding] = useState(false);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= components.length) return;
    const next = components.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setComponents(slot, next);
  };

  return (
    <div className="panel-section">
      <div className="section-label">
        <span>Components ({components.length})</span>
        <button type="button" className="btn ghost small" onClick={() => setAdding((v) => !v)}>
          <Plus size={11} /> Add
        </button>
      </div>

      {adding && (
        <div className="add-component">
          <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 5 }}>
            Start from a selection
          </div>
          <div className="chip-row">
            {SELECTION_EXAMPLES.map((example) => (
              <button
                key={example.value}
                type="button"
                className="chip"
                title={example.value}
                onClick={() => {
                  setComponents(slot, [
                    ...components,
                    makeComponent({
                      name: example.label,
                      selection: example.value,
                      style: Style.BallStick,
                    }),
                  ]);
                  setAdding(false);
                }}
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {components.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '6px 0' }}>
          No components. Add one to draw something.
        </div>
      )}

      {components.map((component, index) => (
        <ComponentRow
          key={component.id}
          slot={slot}
          component={component}
          index={index}
          total={components.length}
          count={counts.get(component.id) ?? 0}
          error={errors.get(component.id)}
          onUpdate={(patch) => updateComponent(slot, component.id, patch)}
          onRemove={() => removeComponent(slot, component.id)}
          onMove={(to) => move(index, to)}
        />
      ))}
    </div>
  );
}

function ComponentRow({
  component, index, total, count, error, onUpdate, onRemove, onMove,
}: {
  slot: number;
  component: Component;
  index: number;
  total: number;
  count: number;
  error?: string;
  onUpdate: (patch: Partial<Component>) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  // Keep a local draft so an expression stays editable while it is incomplete.
  const [draft, setDraft] = useState(component.selection);
  useEffect(() => setDraft(component.selection), [component.selection]);

  const draftError = selectionError(draft);
  const problem = error ?? (draft === component.selection ? undefined : draftError ?? undefined);

  return (
    <div className="component" data-hidden={!component.visible}>
      <div className="component-head">
        <Tip label={index === 0 ? 'Drawn first' : 'Drawn over the layers above'}>
          <span className="component-order">
            <GripVertical size={10} />
            {index + 1}
          </span>
        </Tip>

        <input
          className="component-name"
          value={component.name}
          spellCheck={false}
          aria-label="Component name"
          onChange={(e) => onUpdate({ name: e.target.value })}
        />

        <span className="component-count">
          {problem ? '—' : `${count.toLocaleString()} atoms`}
        </span>

        <Tip label={component.visible ? 'Hide layer' : 'Show layer'}>
          <button
            type="button"
            className="pane-icon-btn"
            style={{ width: 20, height: 20 }}
            aria-label={component.visible ? 'Hide component' : 'Show component'}
            onClick={() => onUpdate({ visible: !component.visible })}
          >
            {component.visible ? <Eye size={11} /> : <EyeOff size={11} />}
          </button>
        </Tip>
        <Tip label="Remove layer">
          <button
            type="button"
            className="pane-icon-btn"
            style={{ width: 20, height: 20 }}
            aria-label="Remove component"
            onClick={onRemove}
          >
            <Trash2 size={11} />
          </button>
        </Tip>
      </div>

      <input
        className="text-input selection-input"
        value={draft}
        spellCheck={false}
        aria-label="Selection expression"
        data-invalid={!!problem}
        placeholder="e.g. /A:1-140 and not water"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (!draftError) onUpdate({ selection: draft.trim() || 'none' }); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !draftError) onUpdate({ selection: draft.trim() || 'none' });
          if (e.key === 'Escape') setDraft(component.selection);
        }}
      />
      {problem && (
        <div className="selection-error">
          <TriangleAlert size={10} /> {problem}
        </div>
      )}

      <div className="component-controls">
        <Select
          ariaLabel="Component style"
          value={String(component.style)}
          options={STYLE_OPTIONS}
          onChange={(v) => onUpdate({ style: Number(v) as Style })}
        />
        <Select
          ariaLabel="Component colour"
          value={component.colorScheme ?? ''}
          options={COLOR_OPTIONS}
          onChange={(v) => onUpdate({ colorScheme: (v || null) as ColorScheme | null })}
        />
      </div>

      {total > 1 && (
        <div className="component-reorder">
          <button type="button" disabled={index === 0} onClick={() => onMove(index - 1)}>
            Move up
          </button>
          <button
            type="button"
            disabled={index === total - 1}
            onClick={() => onMove(index + 1)}
          >
            Move down
          </button>
        </div>
      )}
    </div>
  );
}
