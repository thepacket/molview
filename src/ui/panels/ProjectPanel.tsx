/**
 * Projects: save and load sessions in the browser, export and import them as
 * files. Saving never downloads anything — that distinction is the whole point
 * of having both.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Loader2, Save, Trash2, Upload } from 'lucide-react';
import {
  parseProject, projectFilename, restoreProject, serialiseProject,
  type RestoreReport,
} from '../../state/project';
import {
  deleteProject, listProjects, loadProject, saveProject, type ProjectSummary,
} from '../../state/projectStore';
import { useStore } from '../../state/store';
import { Tip } from '../controls';

export function ProjectPanel() {
  const slots = useStore((s) => s.slots);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listProjects()
      .then(setProjects)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const loadedEntries = slots.map((s) => s.entryId).filter(Boolean) as string[];
  const hasContent = loadedEntries.length > 0;

  const describe = (report: RestoreReport) => {
    const parts = [`${report.panesRestored} pane${report.panesRestored === 1 ? '' : 's'} restored`];
    if (report.measurementsDropped > 0) {
      parts.push(`${report.measurementsDropped} measurement(s) could not be matched`);
    }
    if (report.failures.length > 0) parts.push(report.failures.join('; '));
    return parts.join(' · ');
  };

  const withBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setStatus(label);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const doSave = () => withBusy('Saving…', async () => {
    const document = serialiseProject();
    const saved = await saveProject(name || loadedEntries.join(', '), document);
    setName('');
    refresh();
    setStatus(`Saved "${saved.name}" in this browser`);
  });

  const doOpen = (id: string) => withBusy('Loading…', async () => {
    const project = await loadProject(id);
    if (!project) throw new Error('That project is no longer in the store');
    const report = await restoreProject(project.document);
    setStatus(describe(report));
  });

  const doExport = () => {
    const document = serialiseProject();
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = projectFilename(document);
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${projectFilename(document)}`);
  };

  const doImport = (text: string) => withBusy('Importing…', async () => {
    const report = await restoreProject(parseProject(text));
    setPasting(false);
    setPasted('');
    setStatus(describe(report));
  });

  return (
    <>
      <div className="panel-section">
        <div className="section-label"><span>Save to this browser</span></div>
        <input
          className="text-input"
          placeholder={hasContent ? loadedEntries.join(', ') : 'Nothing loaded yet'}
          value={name}
          spellCheck={false}
          disabled={!hasContent}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && hasContent) doSave(); }}
        />
        <button
          type="button"
          className="btn primary small"
          style={{ width: '100%', marginTop: 7 }}
          disabled={!hasContent || busy}
          onClick={doSave}
        >
          <Save size={12} /> Save project
        </button>
        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
          Stored in this browser only. Structures are referenced by PDB id and
          refetched on load, so a project stays small.
        </p>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Saved projects ({projects.length})</span></div>

        {projects.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            Nothing saved yet.
          </div>
        )}

        {projects.map((project) => (
          <div key={project.id} className="measurement">
            <div className="measurement-head">
              <span style={{ fontSize: 11.5, marginRight: 'auto', overflow: 'hidden' }}>
                {project.name}
              </span>
              <Tip label="Delete">
                <button
                  type="button"
                  className="pane-icon-btn"
                  style={{ width: 20, height: 20 }}
                  aria-label={`Delete ${project.name}`}
                  onClick={() => { void deleteProject(project.id).then(refresh); }}
                >
                  <Trash2 size={11} />
                </button>
              </Tip>
            </div>
            <div className="measurement-atoms">
              {project.entryIds.join(' · ') || 'empty'} — {project.updatedAt.slice(0, 16).replace('T', ' ')}
            </div>
            <button
              type="button"
              className="btn small"
              style={{ width: '100%', marginTop: 6 }}
              disabled={busy}
              onClick={() => doOpen(project.id)}
            >
              <FolderOpen size={11} /> Open
            </button>
          </div>
        ))}
      </div>

      <div className="panel-section">
        <div className="section-label"><span>File</span></div>
        <button
          type="button"
          className="btn"
          style={{ width: '100%' }}
          disabled={!hasContent}
          onClick={doExport}
        >
          <Download size={12} /> Export as .molview.json
        </button>

        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void file.text().then(doImport);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn"
          style={{ width: '100%', marginTop: 6 }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={12} /> Import from file
        </button>
        <button
          type="button"
          className="btn ghost small"
          style={{ width: '100%', marginTop: 6 }}
          onClick={() => setPasting((v) => !v)}
        >
          or paste project JSON
        </button>

        {pasting && (
          <>
            <textarea
              className="text-input"
              style={{ height: 110, marginTop: 6, padding: 7, fontFamily: 'var(--mono)', fontSize: 10 }}
              placeholder='{ "app": "molview", ... }'
              value={pasted}
              spellCheck={false}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button
              type="button"
              className="btn small"
              style={{ width: '100%', marginTop: 6 }}
              disabled={!pasted.trim() || busy}
              onClick={() => doImport(pasted)}
            >
              Import pasted project
            </button>
          </>
        )}
      </div>

      {(status || error || busy) && (
        <div className="panel-section">
          {busy && (
            <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 11 }}>
              <Loader2 size={12} className="spin" /> {status}
            </div>
          )}
          {!busy && status && (
            <div style={{ fontSize: 11, color: 'var(--ok)', lineHeight: 1.5 }}>{status}</div>
          )}
          {error && (
            <div style={{ fontSize: 11, color: 'var(--error)', marginTop: 5, lineHeight: 1.5 }}>
              {error}
            </div>
          )}
        </div>
      )}
    </>
  );
}
