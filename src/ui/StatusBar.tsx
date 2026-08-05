import { useStore, visibleSlotCount } from '../state/store';

export function StatusBar() {
  const gpuName = useStore((s) => s.gpuName);
  const gpuError = useStore((s) => s.gpuError);
  const frameMs = useStore((s) => s.frameMs);
  const slots = useStore((s) => s.slots);
  const layout = useStore((s) => s.layout);
  const activeSlot = useStore((s) => s.activeSlot);

  const visible = slots.slice(0, visibleSlotCount(layout));
  const loaded = visible.filter((s) => s.status === 'ready');
  const totalAtoms = loaded.reduce((sum, s) => sum + (s.stats?.atoms ?? 0), 0);
  const busy = visible.some((s) => s.status === 'loading');

  return (
    <footer className="statusbar">
      <span className="status-item">
        <span className={`status-dot ${gpuError ? 'error' : busy ? 'warn' : ''}`} />
        {gpuError ? 'GPU unavailable' : gpuName || 'Initialising WebGPU…'}
      </span>

      {frameMs > 0 && (
        <span className="status-item" title="CPU time spent encoding a frame">
          {frameMs.toFixed(2)} ms/frame
        </span>
      )}

      <span className="status-item">
        pane {activeSlot + 1}/{visible.length}
      </span>

      {loaded.length > 0 && (
        <>
          <span className="status-item">
            {loaded.map((s) => s.entryId).join(' · ')}
          </span>
          <span className="status-item">
            {totalAtoms.toLocaleString()} atoms in scene
          </span>
        </>
      )}

      <span className="status-spacer" />
      <span className="status-item" style={{ opacity: 0.7 }}>
        drag rotate · shift+drag pan · wheel zoom · double-click focus
      </span>
      <span className="status-item">RCSB PDB · GraphQL</span>
    </footer>
  );
}
