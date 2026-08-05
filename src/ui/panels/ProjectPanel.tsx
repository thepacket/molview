/**
 * Projects: save and load sessions in the browser, export and import them as
 * files. Saving never downloads anything — that distinction is the whole point
 * of having both.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download, FilePlus2, FolderOpen, Link, Loader2, Save, Trash2, Upload,
} from 'lucide-react';
import {
  hasLocalFilePanes, parseProject, projectFilename, restoreProject,
  serialiseProjectWithFiles, type RestoreReport,
} from '../../state/project';
import {
  deleteProject, listProjects, loadProject, saveProject, type ProjectSummary,
} from '../../state/projectStore';
import { buildShareLink } from '../../state/share';
import { DEFAULT_PROJECT_NAME, useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Tip, Toggle } from '../controls';

export function ProjectPanel() {
  const slots = useStore((s) => s.slots);
  const projectName = useStore((s) => s.projectName);
  const projectId = useStore((s) => s.projectId);
  const setProjectName = useStore((s) => s.setProjectName);
  const setProjectId = useStore((s) => s.setProjectId);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState(projectName);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [includeCoordinates, setIncludeCoordinates] = useState(true);
  const [pasted, setPasted] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    listProjects()
      .then(setProjects)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(refresh, [refresh]);
  // Renaming in the title bar should be reflected here rather than fighting it.
  useEffect(() => setName(projectName), [projectName]);

  const loadedEntries = slots.map((s) => s.entryId).filter(Boolean) as string[];
  const hasContent = loadedEntries.length > 0;
  const localFiles = hasLocalFilePanes();

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
    // Renaming here renames the project itself, so the title bar and the saved
    // record never disagree.
    const finalName = name.trim() || projectName;
    setProjectName(finalName);
    const document = {
      ...(await serialiseProjectWithFiles({ includeCoordinates })),
      name: finalName,
    };
    const saved = await saveProject(finalName, document, projectId ?? undefined);
    setProjectId(saved.id);
    refresh();
    setStatus(
      projectId ? `Updated "${saved.name}"` : `Saved "${saved.name}" in this browser`,
    );
  });

  const doNew = () => {
    viewer.newProject(newName || DEFAULT_PROJECT_NAME);
    setNewName('');
    setCreating(false);
    setStatus(null);
    setError(null);
  };

  const doOpen = (id: string) => withBusy('Loading…', async () => {
    const project = await loadProject(id);
    if (!project) throw new Error('That project is no longer in the store');
    const report = await restoreProject(project.document);
    // Remember which record this came from, so the next save updates it.
    setProjectName(project.name);
    setProjectId(project.id);
    setStatus(describe(report));
  });

  const doExport = () => void withBusy('Exporting…', async () => {
    const document = await serialiseProjectWithFiles({ includeCoordinates });
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = projectFilename(document);
    a.click();
    URL.revokeObjectURL(url);
    setStatus(
      `Exported ${projectFilename(document)} — ${(blob.size / 1024).toFixed(1)} kB`,
    );
  });

  const doShare = () => withBusy('Building link…', async () => {
    const link = await buildShareLink();
    try {
      await navigator.clipboard.writeText(link.url);
    } catch {
      // Clipboard access can be refused; the link is still worth showing.
      setShareUrl(link.url);
    }
    const kb = (link.bytes / 1024).toFixed(1);
    if (localFiles) {
      setError(
        'Panes opened from disk are not in this link — a link cannot carry '
        + 'coordinates. Export a file if you need those.',
      );
    }
    setStatus(
      link.tooLong
        ? `Link copied, but it is ${link.url.length} characters — some chat and `
          + 'mail clients truncate links that long. Export a file instead.'
        : `Link copied — ${kb} kB of URL, compressed from `
          + `${(link.rawBytes / 1024).toFixed(1)} kB of JSON.`,
    );
  });

  const doImport = (text: string) => withBusy('Importing…', async () => {
    const report = await restoreProject(parseProject(text));
    // An imported project is not yet a record in this browser.
    setProjectId(null);
    setPasting(false);
    setPasted('');
    setStatus(describe(report));
  });

  return (
    <>
      <div className="panel-section">
        <div className="section-label"><span>Current project</span></div>
        {!creating ? (
          <>
            <div className="current-project">{projectName}</div>
            <button
              type="button"
              className="btn"
              style={{ width: '100%', marginTop: 7 }}
              onClick={() => setCreating(true)}
            >
              <FilePlus2 size={12} /> New project
            </button>
          </>
        ) : (
          <>
            <input
              className="text-input"
              placeholder={DEFAULT_PROJECT_NAME}
              value={newName}
              autoFocus
              spellCheck={false}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doNew();
                if (e.key === 'Escape') { setCreating(false); setNewName(''); }
              }}
            />
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)', margin: '7px 0', lineHeight: 1.5 }}>
              Clears every pane and returns all settings to their defaults.
              Anything unsaved is lost.
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" className="btn primary small" style={{ flex: 1 }} onClick={doNew}>
                Create
              </button>
              <button
                type="button"
                className="btn small"
                style={{ flex: 1 }}
                onClick={() => { setCreating(false); setNewName(''); }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Save to this browser</span></div>
        <input
          className="text-input"
          placeholder={projectName}
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
          <Save size={12} /> {projectId ? 'Save changes' : 'Save project'}
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

      {localFiles && (
        <div className="panel-section">
          <div className="section-label"><span>Local coordinates</span></div>
          <Toggle
            label="Embed files in this project"
            checked={includeCoordinates}
            onChange={setIncludeCoordinates}
            hint="Panes opened from disk have no PDB id, so their bytes must travel with the project"
          />
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
            A pane opened from disk cannot be refetched. With this off it is
            saved as an empty pane; with it on the project carries the file and
            grows accordingly. Shareable links never embed coordinates.
          </p>
        </div>
      )}

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
          className="btn"
          style={{ width: '100%', marginTop: 6 }}
          disabled={!hasContent || busy}
          onClick={doShare}
        >
          <Link size={12} /> Copy shareable link
        </button>
        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
          The whole session is compressed into the link's fragment, which never
          leaves the browser it is opened in.
        </p>
        {shareUrl && (
          <textarea
            className="text-input"
            readOnly
            style={{ height: 70, marginTop: 6, padding: 7, fontFamily: 'var(--mono)', fontSize: 9.5 }}
            value={shareUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
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
