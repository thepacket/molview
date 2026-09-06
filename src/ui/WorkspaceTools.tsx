import { useStore } from '../state/store';
export function WorkspaceTools() {
  return (
    <nav className="workspace-tools" aria-label="Workspace presets">
      {[
        ['Explore', 'browse'],
        ['Investigate', 'investigate'],
        ['Inspect evidence', 'sequence'],
        ['Make a figure', 'style'],
      ].map(([label, panel]) => (
        <button
          className="btn small"
          key={label}
          onClick={() => {
            useStore.setState({
              panel: panel as 'browse' | 'investigate' | 'sequence' | 'style',
              panelOpen: true,
              inspectorOpen: label !== 'Make a figure',
            });
            window.dispatchEvent(
              new CustomEvent('molview:collapse-assistant', { detail: true }),
            );
          }}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
