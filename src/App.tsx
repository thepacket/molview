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
import { ProjectPanel } from './ui/panels/ProjectPanel';
import { SettingsPanel } from './ui/panels/SettingsPanel';
import { AssistantPanel } from './ui/AssistantPanel';
import { SequencePanel } from './ui/panels/SequencePanel';
import { StylePanel } from './ui/panels/StylePanel';
import { restoreProject } from './state/project';
import {
  clearProjectPayload, decodeProject, projectPayloadFromLocation,
} from './state/share';
import { LAYOUT_SLOT_COUNT, useStore } from './state/store';
import { viewer } from './viewer/ViewerController';

export default function App() {
  useGlobalShortcuts();
  useSharedProject();

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
                {panel === 'project' && <ProjectPanel />}
                {panel === 'settings' && <SettingsPanel />}
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

        <AssistantPanel />
        <StatusBar />
      </div>

      <CommandPalette />
    </Tooltip.Provider>
  );
}

/**
 * Opens a project carried in the URL fragment. Waits for the engine, because
 * restoring loads structures straight into GPU slots.
 */
function useSharedProject(): void {
  useEffect(() => {
    let cancelled = false;
    let running = false;

    const open = async (payload: string) => {
      // Pasting a second link while one is still opening would interleave two
      // restores over the same panes.
      if (running) return;
      running = true;
      try {
        const doc = await decodeProject(payload);
        await restoreProject(doc);
        // The session is live now; a stale fragment would misdescribe it.
        clearProjectPayload();
      } catch (err) {
        useStore.getState().setGpuInfo(
          useStore.getState().gpuName,
          `Could not open the shared project: ${
            err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        running = false;
      }
    };

    const payload = projectPayloadFromLocation();
    if (payload) {
      void viewer.ready.then(() => {
        // StrictMode mounts effects twice; the first pass bails here.
        if (!cancelled) void open(payload);
      });
    }

    // Pasting a link into the address bar of a tab already running the app is
    // a same-document navigation: no reload, so only hashchange sees it.
    const onHashChange = () => {
      const next = projectPayloadFromLocation();
      if (next && !cancelled) void open(next);
    };
    window.addEventListener('hashchange', onHashChange);

    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);
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
