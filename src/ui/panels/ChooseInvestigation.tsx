import { residueLabel } from '../../mol/investigation';
import { useEffect, useRef, useState } from 'react';
import {
  fetchEntryDetail,
  searchBySequence,
  type EntryDetail,
} from '../../rcsb/api';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';

export function ChooseInvestigation() {
  const active = useStore((s) => s.activeSlot),
    slot = useStore((s) => s.slots[s.activeSlot]);
  const [entity, setEntity] = useState('');
  const [position, setPosition] = useState('');
  const structure = viewer.getStructure(active);
  const matchingResidues = structure
    ? Array.from({ length: structure.residueCount }, (_, r) => r).filter(
        (r) =>
          `${structure.resSeq[r]}${structure.resInsCode[r]}` ===
          position.trim(),
      )
    : [];
  const [purpose, setPurpose] = useState('ligand');
  const [ligandFilter, setLigandFilter] = useState('');
  const [hits, setHits] = useState<EntryDetail[]>([]);
  const [nextStart, setNextStart] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [pageSize, setPageSize] = useState(24);
  const [identity, setIdentity] = useState(0.9);
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setHits([]);
    setNextStart(0);
    setTotal(null);
    setFailedIds([]);
    setEntity('');
    setBusy(false);
    setError('');
    return () => request.current?.abort();
  }, [slot.entryId]);
  const entities =
    slot.detail?.polymerEntities.filter(
      (e) => e.sequence && e.polymerType.toLowerCase().includes('protein'),
    ) ?? [];
  const selected = entities.find((e) => e.id === entity) ?? entities[0];
  const run = async (append = false, retry = false) => {
    if (!selected?.sequence) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    if (!append) {
      setHits([]);
      setFailedIds([]);
      setNextStart(0);
      setTotal(null);
    }
    try {
      const result = retry
        ? null
        : await searchBySequence(
            selected.sequence,
            identity,
            pageSize,
            controller.signal,
            append ? nextStart : 0,
          );
      const existing = new Set(append ? hits.map((h) => h.id) : []);
      const ids = retry
        ? failedIds
        : [...new Set(result!.hits.map((h) => h.entryId))].filter(
            (id) => !existing.has(id),
          );
      const details: EntryDetail[] = [];
      let index = 0;
      const failures: string[] = [];
      await Promise.all(
        Array.from({ length: Math.min(3, ids.length) }, async () => {
          while (index < ids.length && !controller.signal.aborted) {
            const id = ids[index++];
            try {
              details.push(await fetchEntryDetail(id, controller.signal));
            } catch (e) {
              if (controller.signal.aborted) throw e;
              failures.push(id);
            }
          }
        }),
      );
      if (controller.signal.aborted) return;
      setHits((previous) => (append ? [...previous, ...details] : details));
      setFailedIds((previous) =>
        retry || !append ? failures : [...new Set([...previous, ...failures])],
      );
      if (result) {
        setTotal(result.total);
        setNextStart(result.nextStart);
      }
      if (failures.length)
        setError(
          `${failures.length} entries could not be fetched. Results below are incomplete.`,
        );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request.current === controller) setBusy(false);
    }
  };
  const ranked = hits
    .filter(
      (d) =>
        !ligandFilter.trim() ||
        d.nonPolymerEntities.some(
          (e) => e.compId === ligandFilter.trim().toUpperCase(),
        ),
    )
    .sort((a, b) => {
      if (purpose === 'ligand') {
        const d =
          Number(b.nonPolymerEntities.length > 0) -
          Number(a.nonPolymerEntities.length > 0);
        if (d) return d;
      }
      if (purpose === 'validation') {
        const d =
          (a.validation.clashscore ?? Infinity) -
          (b.validation.clashscore ?? Infinity);
        if (!Number.isNaN(d) && d) return d;
      }
      if (purpose === 'sequence') {
        const d =
          Math.max(
            0,
            ...b.polymerEntities.map((e) => e.sequence?.length ?? 0),
          ) -
          Math.max(0, ...a.polymerEntities.map((e) => e.sequence?.length ?? 0));
        if (d) return d;
      }
      return (
        (a.resolution ?? Infinity) - (b.resolution ?? Infinity) ||
        a.id.localeCompare(b.id)
      );
    });
  return (
    <div className="panel-section investigation">
      <h3>Choose a structure</h3>
      <p>
        Start with a PDB entry from Browse. Find close sequence matches, then
        inspect the evidence relevant to your question.
      </p>
      {structure && slot.status === 'ready' && (
        <details open>
          <summary>Inspect the loaded construct</summary>
          {slot.detail?.polymerEntities.map((e) => {
            const chainRows = Array.from(
              { length: structure.chainCount },
              (_, c) => c,
            ).filter(
              (c) =>
                e.chains.includes(structure.chainAuthId[c]) &&
                structure.chainKind[c] < 2,
            );
            return (
              <div key={e.id}>
                {chainRows.map((c) => {
                  const labels = new Set(
                    Array.from(
                      structure.resLabelSeq.slice(
                        structure.chainResStart[c],
                        structure.chainResStart[c + 1],
                      ),
                    ).filter((n) => n > 0),
                  );
                  const total = e.sequence?.length ?? 0;
                  return (
                    <p key={c}>
                      Chain {structure.chainAuthId[c]} · model{' '}
                      {structure.chainModel[c]}: {labels.size} labelled modelled
                      positions / {total || '?'} deposited sequence positions
                      {total && labels.size
                        ? ` (${((100 * labels.size) / total).toFixed(1)}%)`
                        : ''}
                      .
                    </p>
                  );
                })}
              </div>
            );
          })}
          <p>
            Coverage uses mmCIF entity positions. Zero-occupancy atoms are
            excluded. This is deposited-construct coverage, not full-protein
            coverage.
          </p>
          <label>
            Find author residue number (for example 132 or 100A)
            <input
              className="text-input"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            />
          </label>
          {position && matchingResidues.length === 0 && (
            <p>No modelled residue with this author number.</p>
          )}
          {matchingResidues.map((r) => (
            <button
              className="btn"
              key={r}
              onClick={() => {
                useStore.getState().patchSlot(active, {
                  selectedResidue: r,
                  selectionLabel: residueLabel(structure, r),
                });
                viewer.focusResidue(active, r);
                viewer.refreshOverlay(active);
              }}
            >
              {residueLabel(structure, r)}
            </button>
          ))}
        </details>
      )}
      <label>
        Polymer entity
        <select
          className="text-input"
          value={selected?.id ?? ''}
          onChange={(e) => {
            setEntity(e.target.value);
            request.current?.abort();
            setBusy(false);
            setHits([]);
            setTotal(null);
            setNextStart(0);
            setFailedIds([]);
          }}
        >
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {e.description} · chains {e.chains.join(', ')}
            </option>
          ))}
        </select>
      </label>
      <label>
        Minimum sequence identity
        <select
          className="text-input"
          value={identity}
          disabled={busy}
          onChange={(e) => {
            setIdentity(+e.target.value);
            setHits([]);
            setTotal(null);
            setNextStart(0);
            setFailedIds([]);
          }}
        >
          <option value={0.9}>90%</option>
          <option value={0.7}>70%</option>
          <option value={0.5}>50%</option>
        </select>
      </label>
      <label>
        Entity hits per page
        <select
          className="text-input"
          value={pageSize}
          disabled={busy}
          onChange={(e) => setPageSize(+e.target.value)}
        >
          <option value={24}>24</option>
          <option value={48}>48</option>
          <option value={96}>96</option>
        </select>
      </label>
      <label>
        Prioritize
        <select
          className="text-input"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        >
          <option value="ligand">Entries with ligands or ions</option>
          <option value="validation">Lower deposited clashscore</option>
          <option value="sequence">Longer deposited constructs</option>
        </select>
      </label>
      <label>
        Filter candidate ligand ID (optional)
        <input
          className="text-input"
          placeholder="For example REA"
          value={ligandFilter}
          onChange={(e) => setLigandFilter(e.target.value)}
        />
      </label>
      {hits.length > 0 && ranked.length === 0 && (
        <p>No candidates contain that ligand ID in this shortlist.</p>
      )}
      <button
        className="btn primary"
        disabled={!selected || busy}
        onClick={() => void run()}
      >
        {busy ? 'Finding candidates…' : 'Find close sequence matches'}
      </button>
      {total !== null && nextStart < total && (
        <button className="btn" disabled={busy} onClick={() => void run(true)}>
          Load more candidates
        </button>
      )}
      {failedIds.length > 0 && (
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(true, true)}
        >
          Retry {failedIds.length} unavailable entries
        </button>
      )}
      {total !== null && (
        <p>
          {hits.length} unique entries loaded · {nextStart} / {total} matching
          polymer entities examined.
        </p>
      )}
      {busy && (
        <button
          className="btn"
          onClick={() => {
            request.current?.abort();
            setBusy(false);
          }}
        >
          Cancel
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <p>
        Sequence search covers protein entities. Multiple matching entities can
        belong to one entry. Priorities and the ligand filter apply to loaded
        entries only; load more to expand the shortlist. Resolution only breaks
        ties.
      </p>
      {purpose === 'sequence' && (
        <p>
          Construct length is the longest deposited polymer sequence in each
          entry, not modelled or UniProt coverage. Check the relevant chain
          after loading.
        </p>
      )}
      {ranked.map((d) => (
        <article className="candidate" key={d.id}>
          <h4>{d.id}</h4>
          <p>{d.title}</p>
          <p>
            {d.method} ·{' '}
            {d.resolution !== null
              ? `${d.resolution} Å`
              : 'Resolution unavailable'}{' '}
            · clashscore {d.validation.clashscore ?? 'unavailable'}
          </p>
          <p>
            Ligands:{' '}
            {d.nonPolymerEntities
              .map((e) => `${e.compId} (${e.name})`)
              .join('; ') || 'None listed'}
          </p>
          <details>
            <summary>Constructs and organisms</summary>
            {d.polymerEntities.map((e) => (
              <p key={e.id}>
                {e.description} · {e.sequence?.length ?? '?'} deposited residues
                · {e.organisms.join(', ')} · chains {e.chains.join(', ')}
              </p>
            ))}
          </details>
          <button
            className="btn"
            onClick={() => void viewer.load(active, d.id)}
          >
            Load in pane {active + 1}
          </button>
          <button
            className="btn"
            onClick={() => {
              const s = useStore.getState();
              const target = s.slots.findIndex(
                (v, i) => i !== active && v.status === 'empty',
              );
              if (target < 0) {
                setError(
                  'All panes are occupied. Clear a pane or load into the active pane.',
                );
                return;
              }
              s.setLayout(target > 1 ? 'quad' : 'columns');
              s.setActiveSlot(target);
              void viewer.load(target, d.id);
            }}
          >
            Open in empty comparison pane
          </button>
        </article>
      ))}
      {!busy && hits.length === 0 && !error && <p>No candidate list loaded.</p>}
    </div>
  );
}
