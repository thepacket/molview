/**
 * What UniProt says the residues are for.
 *
 * The Definition panel already said what a structure *is*; this says what parts
 * of it do. Every row is selectable and drawable, because the point is not to
 * read that there is a binding site but to look at it — the list is a way into
 * the structure, not a summary of a database record.
 */

import { useRef, useState } from 'react';
import { Crosshair, Layers, Loader2, Tags } from 'lucide-react';
import { fetchAnnotations, type Annotation } from '../../rcsb/annotations';
import { makeComponent, Style } from '../../mol/components';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Tip } from '../controls';

export function AnnotationSection() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const components = useStore((s) => s.slots[s.activeSlot].components);
  const setComponents = useStore((s) => s.setComponents);
  const [list, setList] = useState<Annotation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (slot.status !== 'ready' || !slot.entryId || slot.prediction || slot.sourceFileName) {
    return null;
  }

  const load = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const found = await fetchAnnotations(slot.entryId!, controller.signal);
      if (!controller.signal.aborted) setList(found);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  const draw = (annotation: Annotation) => {
    const name = annotation.detail
      ? `${annotation.label}: ${annotation.detail}`.slice(0, 40)
      : annotation.label;
    const existing = components.findIndex((c) => c.name === name);
    const next = existing >= 0
      ? components.map((c, i) =>
        (i === existing ? { ...c, selection: annotation.selection, visible: true } : c))
      : [...components, makeComponent({
        name,
        selection: annotation.selection,
        // Regions are big and read as a coloured stretch of ribbon; sites are
        // a handful of residues and are only legible as side chains.
        style: annotation.residues.length > 20 ? Style.Cartoon : Style.BallStick,
        colorScheme: 'uniform',
        uniformColor: 0xffd94a,
      })];
    setComponents(activeSlot, next);
  };

  return (
    <div className="panel-section">
      <div className="section-label">
        <span><Tags size={10} style={{ verticalAlign: -1 }} /> Function</span>
      </div>

      {list === null ? (
        <>
          <p className="panel-note">
            UniProt&apos;s annotations for this protein, landed on the residues in
            the pane — active and binding sites, modifications, motifs, domains,
            mutagenesis results.
          </p>
          <button
            type="button"
            className="btn small"
            style={{ width: '100%' }}
            disabled={busy}
            onClick={() => void load()}
          >
            {busy
              ? <><Loader2 size={11} className="spin" /> Fetching…</>
              : <><Tags size={11} /> Load annotations</>}
          </button>
          {error && (
            <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 7 }}>{error}</p>
          )}
        </>
      ) : list.length === 0 ? (
        <p className="panel-note" style={{ marginBottom: 0 }}>
          UniProt has no positioned annotations for this entry, or the entry has
          no UniProt reference.
        </p>
      ) : (
        <>
          {list.map((annotation) => (
            <div key={`${annotation.type}|${annotation.detail}`} className="measurement">
              <div className="measurement-head">
                <span style={{ fontSize: 11.5, marginRight: 'auto' }}>
                  {annotation.label}
                  <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>
                    {' '}· {annotation.residues.length} residue
                    {annotation.residues.length === 1 ? '' : 's'}
                  </span>
                </span>
                <Tip label="Frame it">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Focus ${annotation.label}`}
                    onClick={() => viewer.focusSelection(activeSlot, annotation.selection)}
                  >
                    <Crosshair size={11} />
                  </button>
                </Tip>
                <Tip label="Draw it as a component">
                  <button
                    type="button"
                    className="pane-icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`Show ${annotation.label}`}
                    onClick={() => draw(annotation)}
                  >
                    <Layers size={11} />
                  </button>
                </Tip>
              </div>
              {annotation.detail && (
                <div style={{ fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-dim)' }}>
                  {annotation.detail}
                </div>
              )}
              <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
                {annotation.residues.slice(0, 8).map((r) => `${r.chain}${r.seq}`).join(' ')}
                {annotation.residues.length > 8 && ' …'}
              </div>
            </div>
          ))}
          <p className="panel-note" style={{ marginTop: 7, marginBottom: 0 }}>
            From {list[0].accession}. Positions are UniProt&apos;s and have been
            mapped through the entity alignment, so they land on this entry&apos;s
            own numbering rather than on the sequence database&apos;s.
          </p>
        </>
      )}
    </div>
  );
}
