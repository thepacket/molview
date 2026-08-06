/** Search and browse the PDB. Hits load straight into the active pane. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Filter, Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  fetchSummaries, hasActiveFilters, searchEntries, type EntrySummary,
} from '../../rcsb/api';
import { useStore, visibleSlotCount } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Chip, Field, Select, Slider, Tip } from '../controls';

const PAGE_SIZE = 25;

const METHODS = [
  { value: 'X-RAY DIFFRACTION', label: 'X-ray' },
  { value: 'ELECTRON MICROSCOPY', label: 'Cryo-EM' },
  { value: 'SOLUTION NMR', label: 'NMR' },
  { value: 'NEUTRON DIFFRACTION', label: 'Neutron' },
] as const;

const POLYMER_TYPES = [
  { value: '', label: 'Any content' },
  { value: 'Protein (only)', label: 'Protein only' },
  { value: 'Nucleic acid (only)', label: 'Nucleic acid only' },
  { value: 'Protein/NA', label: 'Protein + nucleic acid' },
  { value: 'Other', label: 'Other' },
] as const;

const SORTS = [
  { value: 'score', label: 'Best match' },
  { value: 'release_desc', label: 'Newest first' },
  { value: 'release_asc', label: 'Oldest first' },
  { value: 'resolution', label: 'Highest resolution' },
] as const;

/** A few structures that show off different representations well. */
/**
 * The first thing a new user clicks, so every one of these has to be worth
 * looking at — capability coverage second, appearance first. Ordered small to
 * large, so working down the list is also a tour of the performance envelope.
 * Anything over a few megabytes carries its download size.
 */
const FEATURED: { id: string; note: string; size?: string }[] = [
  { id: '1UBQ', note: 'Ubiquitin — small, crisp β-grasp fold' },
  { id: '2K39', note: 'The same fold by NMR — 116 models at once' },
  { id: '1EMA', note: 'GFP — a β-barrel with its chromophore threaded inside' },
  { id: '101M', note: 'Myoglobin — the all-α fold, and a haem in a pocket' },
  { id: '1AF6', note: 'Maltoporin — three β-barrels through a membrane' },
  { id: '4HHB', note: 'Haemoglobin — α₂β₂ tetramer with haem groups' },
  { id: '1BNA', note: 'B-DNA dodecamer — the double helix' },
  { id: '1EHZ', note: 'Transfer RNA — an L of stems and loops' },
  { id: '1FHA', note: 'Ferritin — 24 copies close into a hollow shell' },
  { id: '1KX5', note: 'Nucleosome — 147 bp wound on a histone octamer' },
  { id: '1PRC', note: 'Reaction centre — the first membrane protein solved' },
  { id: '1AON', note: 'GroEL/GroES — a 21-chain folding chamber' },
  { id: '6VXX', note: 'SARS-CoV-2 spike — glycosylated trimer' },
  { id: '1JB0', note: 'Photosystem I — 36 chains and hundreds of cofactors' },
  { id: '2OM3', note: 'Tobacco mosaic virus — 98 coat proteins in a ring' },
  { id: '2GTL', note: 'Erythrocruorin — 180 globins in a hexagonal bilayer' },
  { id: '1CWP', note: 'Cowpea chlorotic mottle virus — 360 chains' },
  { id: '5GJR', note: '26S proteasome — 64 chains, caps on a barrel', size: '6.7 MB' },
  { id: '2BTV', note: 'Bluetongue virus — 15 chains become a 900-chain capsid' },
  { id: '4V6X', note: 'Human ribosome — RNA and protein at full scale', size: '12 MB' },
];

const looksLikePdbId = (value: string) => /^[0-9][a-z0-9]{3}$/i.test(value.trim());

export function BrowsePanel() {
  const search = useStore((s) => s.search);
  const setFilters = useStore((s) => s.setFilters);
  const setSearchState = useStore((s) => s.setSearchState);
  const pushHistory = useStore((s) => s.pushHistory);
  const slots = useStore((s) => s.slots);
  const activeSlot = useStore((s) => s.activeSlot);
  const layout = useStore((s) => s.layout);

  const [showFilters, setShowFilters] = useState(false);
  const [draft, setDraft] = useState(search.filters.text);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadedIds = new Set(
    slots.slice(0, visibleSlotCount(layout)).map((s) => s.entryId).filter(Boolean) as string[],
  );

  const run = useCallback(async (page: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const state = useStore.getState();
    const filters = state.search.filters;
    setSearchState({ status: 'loading', error: null });

    try {
      const result = await searchEntries(
        filters, page * PAGE_SIZE, PAGE_SIZE, controller.signal,
      );
      // The search service returns identifiers only; GraphQL supplies the
      // molecular definitions in a single batched round trip.
      const summaries = await fetchSummaries(result.ids, controller.signal);
      const ordered = result.ids
        .map((id) => summaries.get(id))
        .filter((e): e is EntrySummary => !!e);

      const previous = page === 0 ? [] : useStore.getState().search.results;
      setSearchState({
        status: 'idle',
        results: [...previous, ...ordered],
        total: result.total,
        loadedPages: page + 1,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setSearchState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [setSearchState]);

  const submit = () => {
    setFilters({ text: draft });
    pushHistory(draft);
    // Zustand's set is synchronous, so the filters are in place already.
    void run(0);
  };

  // Re-run when a filter (not the free-text box) changes. Comparing against
  // the last value seen — rather than a "first render" flag — keeps StrictMode's
  // double mount from firing a search nobody asked for.
  const filterSignature = JSON.stringify({ ...search.filters, text: undefined });
  const lastSignature = useRef(filterSignature);
  useEffect(() => {
    if (lastSignature.current === filterSignature) return;
    lastSignature.current = filterSignature;
    void run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterSignature]);

  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener('molview:focus-search', focus);
    return () => window.removeEventListener('molview:focus-search', focus);
  }, []);

  const openEntry = (id: string) => {
    void viewer.load(useStore.getState().activeSlot, id);
  };

  const isDirectId = looksLikePdbId(draft);
  const filtersActive = hasActiveFilters(search.filters);

  return (
    <>
      <div className="panel-section">
        <div className="search-row">
          <div className="search-wrap">
            <Search size={12} />
            <input
              ref={inputRef}
              className="text-input"
              placeholder="Search the PDB, or enter an ID"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (isDirectId) openEntry(draft);
                  else submit();
                }
                if (e.key === 'Escape') setDraft('');
              }}
            />
          </div>
          <Tip label="Filters" side="bottom">
            <button
              type="button"
              className="tool-btn icon-only"
              data-active={showFilters || filtersActive}
              onClick={() => setShowFilters((v) => !v)}
              aria-label="Toggle filters"
            >
              {filtersActive ? <Filter size={13} /> : <SlidersHorizontal size={13} />}
            </button>
          </Tip>
        </div>

        {isDirectId && (
          <button
            type="button"
            className="btn primary small"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => openEntry(draft)}
          >
            Load {draft.toUpperCase()} into pane {activeSlot + 1}
          </button>
        )}

        {!isDirectId && search.history.length > 0 && !draft && (
          <div className="chip-row" style={{ marginTop: 8 }}>
            {search.history.slice(0, 6).map((h) => (
              <button
                key={h}
                type="button"
                className="chip"
                onClick={() => { setDraft(h); setFilters({ text: h }); void run(0); }}
              >
                {h}
              </button>
            ))}
          </div>
        )}
      </div>

      {showFilters && (
        <div className="panel-section">
          <div className="section-label">
            <span>Refine</span>
            {filtersActive && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setFilters({
                  methods: [], resolutionMax: null, polymerType: null,
                  organism: null, yearFrom: null,
                })}
              >
                <X size={11} /> Clear
              </button>
            )}
          </div>

          <Field label="Experimental method">
            <div className="chip-row">
              {METHODS.map((m) => {
                const on = search.filters.methods.includes(m.value);
                return (
                  <button
                    key={m.value}
                    type="button"
                    className={on ? 'chip accent' : 'chip'}
                    onClick={() => setFilters({
                      methods: on
                        ? search.filters.methods.filter((x) => x !== m.value)
                        : [...search.filters.methods, m.value],
                    })}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field
            label="Resolution"
            value={search.filters.resolutionMax
              ? `≤ ${search.filters.resolutionMax.toFixed(1)} Å`
              : 'any'}
          >
            <Slider
              value={search.filters.resolutionMax ?? 6}
              min={1}
              max={6}
              step={0.1}
              onChange={(v) => setFilters({ resolutionMax: v >= 6 ? null : v })}
            />
          </Field>

          <Field label="Content">
            <Select
              ariaLabel="Polymer content"
              value={search.filters.polymerType ?? ''}
              options={POLYMER_TYPES as unknown as { value: string; label: string }[]}
              onChange={(v) => setFilters({ polymerType: v || null })}
            />
          </Field>

          <Field label="Source organism">
            <input
              className="text-input"
              placeholder="e.g. Homo sapiens"
              spellCheck={false}
              value={search.filters.organism ?? ''}
              onChange={(e) => setFilters({ organism: e.target.value || null })}
            />
          </Field>

          <Field
            label="Released since"
            value={search.filters.yearFrom ? String(search.filters.yearFrom) : 'any'}
          >
            <Slider
              value={search.filters.yearFrom ?? 1976}
              min={1976}
              max={new Date().getFullYear()}
              step={1}
              onChange={(v) => setFilters({ yearFrom: v <= 1976 ? null : v })}
            />
          </Field>

          <Field label="Order by">
            <Select
              ariaLabel="Sort order"
              value={search.filters.sort}
              options={SORTS as unknown as { value: string; label: string }[]}
              onChange={(v) => setFilters({ sort: v as typeof search.filters.sort })}
            />
          </Field>
        </div>
      )}

      {search.status === 'error' && (
        <div className="panel-section" style={{ color: 'var(--error)' }}>
          {search.error}
        </div>
      )}

      {search.results.length === 0 && search.status !== 'loading' && (
        <div className="panel-section">
          <div className="section-label"><span>Start here</span></div>
          <div className="result-list" style={{ margin: '0 -10px -10px' }}>
            {FEATURED.map((f) => (
              <button
                key={f.id}
                type="button"
                className="result"
                data-loaded={loadedIds.has(f.id)}
                onClick={() => openEntry(f.id)}
              >
                <div className="result-top">
                  <span className="pdb-id">{f.id}</span>
                  {f.size && <Chip>{f.size} download</Chip>}
                </div>
                <div className="result-title">{f.note}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {search.results.length > 0 && (
        <>
          <div className="panel-section" style={{ padding: '6px 10px' }}>
            <div className="section-label" style={{ margin: 0 }}>
              <span>{search.total.toLocaleString()} entries</span>
              <span>showing {search.results.length}</span>
            </div>
          </div>
          <div className="result-list">
            {search.results.map((e) => (
              <ResultRow
                key={e.id}
                entry={e}
                loaded={loadedIds.has(e.id)}
                onOpen={() => openEntry(e.id)}
              />
            ))}
          </div>
          {search.results.length < search.total && (
            <div className="panel-section">
              <button
                type="button"
                className="btn"
                style={{ width: '100%' }}
                disabled={search.status === 'loading'}
                onClick={() => void run(search.loadedPages)}
              >
                {search.status === 'loading' ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {search.status === 'loading' && search.results.length === 0 && (
        <div className="empty-state">
          <Loader2 size={18} className="spin" />
          Searching the PDB…
        </div>
      )}
    </>
  );
}

function ResultRow({ entry, loaded, onOpen }: {
  entry: EntrySummary;
  loaded: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="result" data-loaded={loaded} onClick={onOpen}>
      <div className="result-top">
        <span className="pdb-id">{entry.id}</span>
        {entry.releaseDate && (
          <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
            {entry.releaseDate.slice(0, 4)}
          </span>
        )}
      </div>
      <div className="result-title">{entry.title}</div>
      <div className="chip-row">
        <Chip>{entry.method}</Chip>
        {entry.resolution !== null && <Chip accent>{entry.resolution.toFixed(2)} Å</Chip>}
        {entry.atomCount !== null && <Chip>{entry.atomCount.toLocaleString()} atoms</Chip>}
        {entry.weightKda !== null && <Chip>{Math.round(entry.weightKda)} kDa</Chip>}
      </div>
    </button>
  );
}
