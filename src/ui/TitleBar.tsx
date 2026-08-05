import {
  Columns2, Command, Grid2x2, Link2, Link2Off, PanelLeft, PanelRight, Rows2, Square,
} from 'lucide-react';
import { useStore, type LayoutMode } from '../state/store';
import { viewer } from '../viewer/ViewerController';
import { Segmented, Tip } from './controls';

const LAYOUTS: { value: LayoutMode; label: React.ReactNode; title: string }[] = [
  { value: 'single', label: <Square size={12} />, title: 'Single pane' },
  { value: 'columns', label: <Columns2 size={12} />, title: 'Two panes side by side' },
  { value: 'rows', label: <Rows2 size={12} />, title: 'Two panes stacked' },
  { value: 'quad', label: <Grid2x2 size={12} />, title: 'Four panes' },
];

export function TitleBar() {
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const linked = useStore((s) => s.linkedCameras);
  const setLinked = useStore((s) => s.setLinkedCameras);
  const panelOpen = useStore((s) => s.panelOpen);
  const togglePanel = useStore((s) => s.togglePanel);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const toggleInspector = useStore((s) => s.toggleInspector);
  const setPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const activeSlot = useStore((s) => s.activeSlot);

  return (
    <header className="titlebar">
      <div className="brand">
        <MoleculeMark />
        <span className="brand-name">Mol<span>View</span></span>
      </div>

      <Tip label={panelOpen ? 'Hide left panel' : 'Show left panel'} shortcut="[">
        <button
          type="button"
          className="tool-btn icon-only"
          data-active={panelOpen}
          onClick={togglePanel}
          aria-label="Toggle left panel"
        >
          <PanelLeft size={14} />
        </button>
      </Tip>

      <div style={{ width: 8 }} />
      <Segmented value={layout} options={LAYOUTS} onChange={setLayout} />

      <Tip
        label={linked ? 'Cameras linked across panes' : 'Cameras independent'}
        shortcut="L"
      >
        <button
          type="button"
          className="tool-btn"
          data-active={linked}
          onClick={() => {
            setLinked(!linked);
            if (!linked) viewer.syncCameras(activeSlot);
          }}
        >
          {linked ? <Link2 size={14} /> : <Link2Off size={14} />}
          <span style={{ fontSize: 11 }}>Link</span>
        </button>
      </Tip>

      <div className="titlebar-spacer" />

      <button type="button" className="tool-btn" onClick={() => setPaletteOpen(true)}>
        <Command size={13} />
        <span style={{ fontSize: 11 }}>Commands</span>
        <span className="kbd">⌘K</span>
      </button>

      <Tip label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} shortcut="]">
        <button
          type="button"
          className="tool-btn icon-only"
          data-active={inspectorOpen}
          onClick={toggleInspector}
          aria-label="Toggle inspector"
        >
          <PanelRight size={14} />
        </button>
      </Tip>
    </header>
  );
}

function MoleculeMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5.5 6 9v6l6 3.5L18 15V9l-6-3.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <circle cx="12" cy="5.5" r="2.1" fill="currentColor" />
      <circle cx="6" cy="9" r="1.7" fill="currentColor" opacity="0.75" />
      <circle cx="18" cy="15" r="1.7" fill="currentColor" opacity="0.75" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
