import { AlignLeft, LayoutGrid, Palette, Ruler, Search } from 'lucide-react';
import { useStore, type PanelId } from '../state/store';
import { Tip } from './controls';

// The entry definition lives in the right-hand inspector, so it is not a rail
// destination — everything here is a left-panel tool.
const ITEMS: { id: PanelId; icon: React.ReactNode; label: string; shortcut: string }[] = [
  { id: 'browse', icon: <Search size={16} />, label: 'Browse the PDB', shortcut: '⌘F' },
  { id: 'style', icon: <Palette size={16} />, label: 'Representation', shortcut: '' },
  { id: 'sequence', icon: <AlignLeft size={16} />, label: 'Sequence', shortcut: '' },
  { id: 'measure', icon: <Ruler size={16} />, label: 'Measure', shortcut: '' },
  { id: 'scene', icon: <LayoutGrid size={16} />, label: 'Panes and layout', shortcut: '' },
];

export function ActivityRail() {
  const panel = useStore((s) => s.panel);
  const panelOpen = useStore((s) => s.panelOpen);
  const setPanel = useStore((s) => s.setPanel);

  return (
    <nav className="rail" aria-label="Panels">
      {ITEMS.map((item) => (
        <Tip key={item.id} label={item.label} shortcut={item.shortcut} side="right">
          <button
            type="button"
            className="rail-btn"
            data-active={panelOpen && panel === item.id}
            aria-label={item.label}
            onClick={() => setPanel(item.id)}
          >
            {item.icon}
          </button>
        </Tip>
      ))}
      <div className="rail-spacer" />
    </nav>
  );
}

export const PANEL_TITLES: Record<PanelId, string> = {
  browse: 'Browse',
  entry: 'Definition',
  style: 'Representation',
  sequence: 'Sequence',
  measure: 'Measure',
  scene: 'Panes',
};
