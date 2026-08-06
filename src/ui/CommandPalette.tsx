/**
 * ⌘K command surface. Also doubles as a quick loader: typing a four-character
 * PDB ID offers to open it directly in the active pane.
 */

import { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { COLOR_SCHEME_LABELS, type ColorScheme } from '../mol/coloring';
import {
  STYLE_LABELS, STYLE_ORDER, Style, makeComponent,
} from '../mol/components';
import { SELECTION_EXAMPLES } from '../mol/selection';
import { LAYOUT_SLOT_COUNT, useStore, type LayoutMode } from '../state/store';
import { viewer } from '../viewer/ViewerController';

const LAYOUTS: { value: LayoutMode; label: string }[] = [
  { value: 'single', label: 'Single pane' },
  { value: 'columns', label: 'Two panes, side by side' },
  { value: 'rows', label: 'Two panes, stacked' },
  { value: 'quad', label: 'Four panes' },
];

export function CommandPalette() {
  const open = useStore((s) => s.commandPaletteOpen);
  const setOpen = useStore((s) => s.setCommandPaletteOpen);
  const activeSlot = useStore((s) => s.activeSlot);
  const layout = useStore((s) => s.layout);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  if (!open) return null;

  const store = useStore.getState();
  const close = () => setOpen(false);
  const run = (fn: () => void) => { fn(); close(); };

  const idCandidate = /^[0-9][a-z0-9]{3}$/i.test(query.trim()) ? query.trim().toUpperCase() : null;

  return (
    <>
      <div className="palette-overlay" onClick={close} />
      <Command className="palette" label="Command palette" loop>
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Run a command, or type a PDB ID…"
          onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
        />
        <Command.List>
          <Command.Empty>No matching command.</Command.Empty>

          {idCandidate && (
            <Command.Group heading="Load">
              <Command.Item
                value={`load ${idCandidate}`}
                onSelect={() => run(() => void viewer.load(activeSlot, idCandidate))}
              >
                Load {idCandidate} into pane {activeSlot + 1}
              </Command.Item>
              {Array.from({ length: LAYOUT_SLOT_COUNT[layout] }, (_, i) => i)
                .filter((i) => i !== activeSlot)
                .map((i) => (
                  <Command.Item
                    key={i}
                    value={`load ${idCandidate} pane ${i + 1}`}
                    onSelect={() => run(() => void viewer.load(i, idCandidate))}
                  >
                    Load {idCandidate} into pane {i + 1}
                  </Command.Item>
                ))}
            </Command.Group>
          )}

          <Command.Group heading="View">
            <Command.Item value="reset view" onSelect={() => run(() => viewer.resetView(activeSlot))}>
              Reset view <span className="shortcut">R</span>
            </Command.Item>
            <Command.Item
              value="orient to principal axes"
              onSelect={() => run(() => viewer.orientView(activeSlot))}
            >
              Orient to the structure&apos;s own axes <span className="shortcut">O</span>
            </Command.Item>
            {(['x', 'y', 'z'] as const).map((axis) => (
              <Command.Item
                key={axis}
                value={`view down ${axis} axis`}
                onSelect={() => run(() => viewer.viewAlongAxis(activeSlot, axis))}
              >
                View down the {axis.toUpperCase()} axis
              </Command.Item>
            ))}
            <Command.Item
              value="auto rotate spin"
              onSelect={() => run(() => store.patchSlot(
                activeSlot, { spinning: !store.slots[activeSlot].spinning },
              ))}
            >
              Toggle auto-rotate <span className="shortcut">S</span>
            </Command.Item>
            <Command.Item
              value="link cameras"
              onSelect={() => run(() => {
                store.setLinkedCameras(!store.linkedCameras);
                viewer.syncCameras(activeSlot);
              })}
            >
              {store.linkedCameras ? 'Unlink pane cameras' : 'Link pane cameras'}
              <span className="shortcut">L</span>
            </Command.Item>
            <Command.Item
              value="match panes"
              onSelect={() => run(() => viewer.syncCameras(activeSlot))}
            >
              Match all panes to pane {activeSlot + 1}
            </Command.Item>
            <Command.Item
              value="screenshot png export"
              onSelect={() => run(() => void saveScreenshot(activeSlot))}
            >
              Save pane {activeSlot + 1} as PNG
            </Command.Item>
            <Command.Item
              value="density map electron microscopy experimental evidence"
              onSelect={() => run(() => {
                if (store.slots[activeSlot].density.status === 'ready') {
                  viewer.hideDensity(activeSlot);
                } else {
                  store.setPanel('scene');
                  void viewer.showDensity(activeSlot);
                }
              })}
            >
              {store.slots[activeSlot].density.status === 'ready'
                ? 'Remove the density map'
                : 'Show the experimental density map'}
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Layout">
            {LAYOUTS.map((l) => (
              <Command.Item
                key={l.value}
                value={`layout ${l.label}`}
                onSelect={() => run(() => store.setLayout(l.value))}
              >
                {l.label}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Representation">
            {STYLE_ORDER.filter((s) => s !== Style.None).map((style) => (
              <Command.Item
                key={style}
                value={`style all ${STYLE_LABELS[style]}`}
                onSelect={() => run(() => store.setComponents(
                  activeSlot,
                  store.slots[activeSlot].components.map((c) => ({ ...c, style })),
                ))}
              >
                Style every component as {STYLE_LABELS[style].toLowerCase()}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Add component">
            {SELECTION_EXAMPLES.map((example) => (
              <Command.Item
                key={example.value}
                value={`add component ${example.label} ${example.value}`}
                onSelect={() => run(() => store.setComponents(activeSlot, [
                  ...store.slots[activeSlot].components,
                  makeComponent({
                    name: example.label,
                    selection: example.value,
                    style: Style.BallStick,
                  }),
                ]))}
              >
                {example.label}
                <span className="shortcut">{example.value}</span>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Colour">
            {(Object.keys(COLOR_SCHEME_LABELS) as ColorScheme[]).map((scheme) => (
              <Command.Item
                key={scheme}
                value={`colour ${COLOR_SCHEME_LABELS[scheme]}`}
                onSelect={() => run(() => store.patchSlot(activeSlot, { colorScheme: scheme }))}
              >
                Colour by {COLOR_SCHEME_LABELS[scheme].toLowerCase()}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Panel">
            <Command.Item value="browse search" onSelect={() => run(() => store.setPanel('browse'))}>
              Open browser
            </Command.Item>
            <Command.Item value="definition entry inspector" onSelect={() => run(() => store.toggleInspector())}>
              Toggle entry definition <span className="shortcut">]</span>
            </Command.Item>
            <Command.Item value="sequence" onSelect={() => run(() => store.setPanel('sequence'))}>
              Open sequence
            </Command.Item>
            <Command.Item
              value="projects save load export import"
              onSelect={() => run(() => store.setPanel('project'))}
            >
              Open projects
            </Command.Item>
            <Command.Item
              value="new project clear session"
              onSelect={() => run(() => {
                viewer.newProject('Untitled');
                store.setPanel('project');
              })}
            >
              New project
            </Command.Item>
            <Command.Item
              value="clear pane"
              onSelect={() => run(() => viewer.unload(activeSlot))}
            >
              Clear pane {activeSlot + 1}
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </>
  );
}

async function saveScreenshot(slot: number): Promise<void> {
  const blob = await viewer.screenshot(slot);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `molview-pane${slot + 1}.png`;
  a.click();
  URL.revokeObjectURL(url);
}
