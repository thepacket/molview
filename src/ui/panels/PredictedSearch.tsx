/**
 * Finding a predicted structure.
 *
 * Separate from the PDB search rather than folded into it, because the two
 * answer different questions and mixing the results would blur the one
 * distinction that matters most: whether what you are looking at was measured
 * or computed. A row here always leads to a model; a row there always leads to
 * an experiment.
 *
 * The search is UniProt's, not AlphaFold's. AlphaFold is keyed by accession
 * and nothing else — it will not take a gene name or a protein name — so the
 * lookup has to happen somewhere, and doing it here means "hemoglobin" works.
 */

import { useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { searchUniProt, type UniProtHit } from '../../rcsb/alphafold';
import { isMgnifyAccession } from '../../rcsb/esmatlas';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Chip } from '../controls';

export function PredictedSearch() {
  const [draft, setDraft] = useState('');
  const [hits, setHits] = useState<UniProtHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = async () => {
    const query = draft.trim();
    if (!query) return;

    // An MGnify accession goes straight to the ESM Atlas. Searching UniProt for
    // it is not merely slower, it can never succeed: the whole point of the
    // Atlas is sequences UniProt does not have.
    if (isMgnifyAccession(query)) {
      setHits(null);
      setError(null);
      open(query);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const results = await searchUniProt(query, controller.signal);
      if (controller.signal.aborted) return;
      setHits(results);
      if (results.length === 0) setError(`Nothing in UniProt matches "${query}".`);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  const open = (accession: string) => {
    void viewer.loadPrediction(useStore.getState().activeSlot, accession);
  };

  return (
    <div className="panel-section">
      <div className="section-label">
        <span><Sparkles size={10} style={{ verticalAlign: -1 }} /> Predicted structures</span>
      </div>

      <div className="search-wrap">
        {busy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
        <input
          className="text-input"
          placeholder="Protein, gene, UniProt or MGnify accession"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') { setDraft(''); setHits(null); setError(null); }
          }}
        />
      </div>

      {hits === null && !error && (
        <p className="panel-note" style={{ marginTop: 8, marginBottom: 0 }}>
          AlphaFold DB covers over 200 million sequences — most proteins have a
          model and no experimental structure. These are predictions: confident
          ones are very good and unconfident ones are fiction, and the pane says
          which is which.
        </p>
      )}

      {hits === null && !error && (
        <p className="panel-note" style={{ marginTop: 8, marginBottom: 0 }}>
          An MGnify accession like <code>MGYP000911143359</code> loads from the
          ESM Metagenomic Atlas instead: sequence read out of soil and seawater,
          from organisms nobody has named. Its value is that coverage rather
          than accuracy — ESMFold folds from one sequence with no alignment, and
          reads below AlphaFold on the same protein.
        </p>
      )}

      {error && (
        <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 7 }}>{error}</p>
      )}

      {hits?.map((hit) => (
        <button
          key={hit.accession}
          type="button"
          className="result"
          style={{ width: '100%', textAlign: 'left' }}
          onClick={() => open(hit.accession)}
        >
          <div className="result-top">
            <span className="pdb-id">{hit.accession}</span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{hit.id}</span>
          </div>
          <div className="result-title">{hit.name}</div>
          <div className="chip-row">
            {hit.gene && <Chip accent>{hit.gene}</Chip>}
            {hit.organism && <Chip>{hit.organism}</Chip>}
            {hit.length > 0 && <Chip>{hit.length} aa</Chip>}
          </div>
        </button>
      ))}
    </div>
  );
}
