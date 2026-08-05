import { useEffect } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ActivityRail, PANEL_TITLES } from './ui/ActivityRail';
import { CommandPalette } from './ui/CommandPalette';
import { StatusBar } from './ui/StatusBar';
import { TitleBar } from './ui/TitleBar';
import { ViewportGrid } from './ui/ViewportGrid';
import { BrowsePanel } from './ui/panels/BrowsePanel';
import { EntryPanel } from './ui/panels/EntryPanel';
import { ScenePanel } from './ui/panels/ScenePanel';
import { MeasurePanel } from './ui/panels/MeasurePanel';
import { SequencePanel } from './ui/panels/SequencePanel';
import { StylePanel } from './ui/panels/StylePanel';
import { LAYOUT_SLOT_COUNT, useStore } from './state/store';
import { viewer } from './viewer/ViewerController';

export default function App() {
  useGlobalShortcuts();

  const panel = useStore((s) => s.panel);
  const panelOpen = useStore((s) => s.panelOpen);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const activeSlot = useStore((s) => s.activeSlot);
  const entryId = useStore((s) => s.slots[s.activeSlot].entryId);

  return (
    <Tooltip.Provider delayDuration={450} skipDelayDuration={200}>
      <div className="shell">
        <TitleBar />

        <div className="shell-body">
          <ActivityRail />

          {panelOpen && (
            <aside className="panel">
              <div className="panel-header">
                <span className="panel-title">{PANEL_TITLES[panel]}</span>
              </div>
              <div className="panel-body">
                {panel === 'browse' && <BrowsePanel />}
                {panel === 'style' && <StylePanel />}
                {panel === 'sequence' && <SequencePanel />}
                {panel === 'measure' && <MeasurePanel />}
                {panel === 'scene' && <ScenePanel />}
                {panel === 'entry' && <EntryPanel />}
              </div>
            </aside>
          )}

          <ViewportGrid />

          {inspectorOpen && (
            <aside className="panel right">
              <div className="panel-header">
                <span className="panel-title">Definition</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-faint)' }}>
                  pane {activeSlot + 1}{entryId ? ` · ${entryId}` : ''}
                </span>
              </div>
              <div className="panel-body">
                <EntryPanel />
              </div>
            </aside>
          )}
        </div>

        <StatusBar />
      </div>

      <CommandPalette />
    </Tooltip.Provider>
  );
}

/** Application-level keyboard map. Ignored while typing into a field. */
function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      );

      const store = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        store.setCommandPaletteOpen(!store.commandPaletteOpen);
        return;
      }

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        store.setPanel('browse');
        // Let the panel mount before asking it to take focus.
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event('molview:focus-search'));
        });
        return;
      }

      if (typing || mod) return;

      switch (e.key) {
        case '[':
          store.togglePanel();
          break;
        case ']':
          store.toggleInspector();
          break;
        case '1': case '2': case '3': case '4': {
          const index = Number(e.key) - 1;
          if (index < LAYOUT_SLOT_COUNT[store.layout]) store.setActiveSlot(index);
          break;
        }
        case 'r': case 'R':
          viewer.resetView(store.activeSlot);
          break;
        case 's': case 'S':
          store.patchSlot(store.activeSlot, {
            spinning: !store.slots[store.activeSlot].spinning,
          });
          break;
        case 'l': case 'L':
          store.setLinkedCameras(!store.linkedCameras);
          if (!store.linkedCameras) viewer.syncCameras(store.activeSlot);
          break;
        case 'Escape':
          store.setCommandPaletteOpen(false);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
