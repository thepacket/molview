/**
 * Finding structures like the one already loaded.
 *
 * The search box above answers questions you can phrase. These answer one you
 * can only point at — "what else looks like this", "what else has this
 * sequence" — and the difference matters because the interesting cases are
 * exactly the ones you cannot name: a fold you do not recognise, a protein
 * whose family you are trying to establish.
 *
 * Two services, and they disagree usefully. Shape similarity finds things built
 * the same way regardless of sequence; sequence similarity finds relatives
 * regardless of what they have been crystallised with. A hit in one and not the
 * other is usually the interesting one.
 */

import { useRef, useState } from 'react';
import { Dna, Loader2, Shapes } from 'lucide-react';
import {
  fetchSummaries, searchByShape, searchBySequence, type EntrySummary, type SimilarHit,
} from '../../rcsb/api';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Chip } from '../controls';

const ROWS = 15;

type Mode = 'shape' | 'sequence';

export function SimilarSection() {
  const activeSlot = useStore((s) => s.activeSlot);
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [hits, setHits] = useState<SimilarHit[] | null>(null);
  const [summaries, setSummaries] = useState<Map<string, EntrySummary>>(new Map());
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (slot.status !== 'ready' || !slot.entryId) return null;
  // A prediction has no PDB entry to search from, and its sequence is better
  // searched from UniProt than from here.
  if (slot.prediction) return null;

  const longestChain = slot.detail?.polymerEntities
    .filter((e) => e.sequence)
    .sort((a, b) => (b.sequence?.length ?? 0) - (a.sequence?.length ?? 0))[0];

  const run = async (which: Mode) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setMode(which);
    setError(null);
    setHits(null);

    try {
      const result = which === 'shape'
        ? await searchByShape(slot.entryId!, slot.assemblyId || '1', ROWS, controller.signal)
        : await searchBySequence(longestChain!.sequence!, 0.3, ROWS * 2, controller.signal);
      if (controller.signal.aborted) return;

      // The entry itself is always its own best match, and saying so is noise.
      const filtered = result.hits.filter((h) => h.entryId !== slot.entryId).slice(0, ROWS);
      setHits(filtered);
      setTotal(result.total);
      const meta = await fetchSummaries(filtered.map((h) => h.entryId), controller.signal);
      if (!controller.signal.aborted) setSummaries(meta);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  return (
    <div className="panel-section">
      <div className="section-label"><span>Structures like {slot.entryId}</span></div>

      <div className="similar-buttons">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => void run('shape')}
        >
          <Shapes size={11} /> By shape
        </button>
        <button
          type="button"
          className="btn small"
          disabled={busy || !longestChain}
          title={longestChain ? undefined : 'No polymer sequence in this entry'}
          onClick={() => void run('sequence')}
        >
          <Dna size={11} /> By sequence
        </button>
      </div>

      {busy && (
        <p className="panel-note" style={{ marginTop: 8, marginBottom: 0 }}>
          <Loader2 size={11} className="spin" style={{ verticalAlign: -1 }} /> Searching…
        </p>
      )}

      {!busy && hits === null && !error && (
        <p className="panel-note" style={{ marginTop: 8, marginBottom: 0 }}>
          Shape compares the assembly on screen against every assembly in the
          archive. Sequence compares {longestChain
            ? `${longestChain.description.toLowerCase()} (${longestChain.sequence?.length} aa)`
            : 'the longest chain'} and reports the identity of each hit.
        </p>
      )}

      {error && <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 7 }}>{error}</p>}

      {hits && hits.length === 0 && (
        <p className="panel-note" style={{ marginTop: 8, marginBottom: 0 }}>
          Nothing else in the archive matched.
        </p>
      )}

      {hits && hits.length > 0 && (
        <>
          <p className="panel-note" style={{ marginTop: 8 }}>
            {total.toLocaleString()} match{total === 1 ? '' : 'es'} by {mode}
            {hits.length < total ? `, showing the closest ${hits.length}` : ''}.
          </p>
          <div className="result-list" style={{ margin: '0 -10px -10px' }}>
            {hits.map((hit) => {
              const summary = summaries.get(hit.entryId);
              return (
                <button
                  key={hit.entryId}
                  type="button"
                  className="result"
                  onClick={() => void viewer.load(activeSlot, hit.entryId)}
                >
                  <div className="result-top">
                    <span className="pdb-id">{hit.entryId}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'var(--mono)' }}>
                      {mode === 'sequence' && hit.identity !== undefined
                        ? `${Math.round(hit.identity * 100)}% id`
                        : `${hit.score.toFixed(3)}`}
                    </span>
                  </div>
                  <div className="result-title">{summary?.title ?? '…'}</div>
                  {summary && (
                    <div className="chip-row">
                      <Chip>{summary.method}</Chip>
                      {summary.resolution !== null && (
                        <Chip accent>{summary.resolution.toFixed(2)} Å</Chip>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
