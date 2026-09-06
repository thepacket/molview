import { mappedResidueMatches } from '../../rcsb/residueMapping';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { fetchAnnotations, type Annotation } from '../../rcsb/annotations';
import {
  residueMetrics,
  type ResidueValidation,
} from '../../rcsb/residueValidation';
import { occupancySummary, residueLabel } from '../../mol/investigation';
import { runAnalysis } from '../../mol/analysis';

export function ResidueEvidence() {
  const active = useStore((s) => s.activeSlot),
    slot = useStore((s) => s.slots[s.activeSlot]);
  const structure = viewer.getStructure(active),
    r = slot.selectedResidue;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [validation, setValidation] = useState<ResidueValidation | null>(null);
  const [status, setStatus] = useState('');
  const [contacts, setContacts] = useState<
    { residue: number; distance: number }[] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const job = useRef<ReturnType<typeof runAnalysis> | null>(null);
  const evidenceRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setAnnotations([]);
    setValidation(null);
    setStatus('');
    return () => evidenceRequest.current?.abort();
  }, [structure]);
  useEffect(() => {
    setContacts(null);
    setBusy(false);
    return () => job.current?.cancel();
  }, [structure, r]);
  if (
    !structure ||
    slot.status !== 'ready' ||
    r === null ||
    r >= structure.residueCount
  )
    return (
      <div className="panel-section investigation">
        <h3>Residue evidence</h3>
        <p>Select a residue in the molecule or Sequence panel.</p>
      </div>
    );
  const metric = residueMetrics(validation, structure, r);
  const features = annotations.filter((a) =>
    a.residues.some((p) => mappedResidueMatches(structure, r, p)),
  );
  const occ = occupancySummary(structure, r);
  const anchor = structure.resAnchor[r];
  const alignment = viewer.getAlignment(active);
  const pair =
    slot.superposedOnto !== null
      ? alignment?.pairs.find((p) => p.mobileResidue === r)
      : undefined;
  return (
    <div className="panel-section investigation">
      <h3>{residueLabel(structure, r)}</h3>
      <p>
        <b>
          {slot.prediction ? 'Predicted coordinates' : 'Deposited coordinates'}
        </b>{' '}
        · {slot.entryId} · model {structure.chainModel[structure.resChain[r]]}
      </p>
      <dl className="meta-grid">
        <dt>Occupancy range</dt>
        <dd>
          {occ.min === null
            ? 'Unspecified'
            : `${occ.min.toFixed(2)}–${occ.max!.toFixed(2)}`}
          {occ.unknown ? ` · ${occ.unknown} unspecified` : ''}
        </dd>
        <dt>Selected alternate</dt>
        <dd>{structure.resAltLoc[r] || 'None'}</dd>
        <dt>Other alternates</dt>
        <dd>{structure.resAltCount[r]}</dd>
        {slot.prediction && (
          <>
            <dt>Anchor pLDDT</dt>
            <dd>
              {anchor >= 0
                ? structure.bFactor[anchor].toFixed(1)
                : 'No backbone anchor'}
            </dd>
          </>
        )}
      </dl>
      {slot.prediction && (
        <p>
          pLDDT describes local model confidence. Inspect PAE for confidence in
          the relative placement of domains.
        </p>
      )}
      {!slot.prediction && (
        <>
          <button
            className="btn"
            disabled={status === 'Loading…' || !!slot.sourceFileName}
            onClick={() => {
              const current = structure;
              evidenceRequest.current?.abort();
              const controller = new AbortController();
              evidenceRequest.current = controller;
              setStatus('Loading…');
              void Promise.allSettled([
                fetchAnnotations(slot.entryId!, controller.signal),
                viewer.loadResidueValidation(active),
              ]).then(([a, v]) => {
                if (
                  controller.signal.aborted ||
                  viewer.getStructure(active) !== current
                )
                  return;
                if (a.status === 'fulfilled') setAnnotations(a.value);
                if (v.status === 'fulfilled') setValidation(v.value);
                setStatus(
                  a.status === 'rejected' ||
                    v.status === 'rejected' ||
                    (v.status === 'fulfilled' && !v.value)
                    ? 'Some evidence is unavailable.'
                    : 'Evidence loaded.',
                );
              });
            }}
          >
            Load public annotations and validation
          </button>
          <p role="status">{status}</p>
          {structure.resLabelSeq[r] <= 0 ? (
            <p>
              This residue has no deposited polymer sequence position. Polymer
              annotations and validation cannot be assigned.
            </p>
          ) : (
            <>
              {status && (
                <>
                  <h4>wwPDB validation · external</h4>
                  <p>
                    Mapped by archive chain{' '}
                    {structure.chainLabelId[structure.resChain[r]]}, position{' '}
                    {structure.resLabelSeq[r]}. These instance-level scores are
                    shared across model copies.
                  </p>
                  <p>
                    RSRZ: {metric?.rsrz?.toFixed(2) ?? 'unavailable'} · RSCC:{' '}
                    {metric?.rscc?.toFixed(2) ?? 'unavailable'} · reported
                    faults: {metric ? metric.outliers : 'unavailable'}
                  </p>
                  <h4>UniProt annotations · external</h4>
                  {features.length ? (
                    features.map((a, i) => (
                      <p key={i}>
                        <b>{a.label}</b>: {a.detail || 'No description'} ·{' '}
                        <a
                          href={`https://www.uniprot.org/uniprotkb/${encodeURIComponent(a.accession)}/entry`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {a.accession}
                        </a>
                      </p>
                    ))
                  ) : (
                    <p>No mapped annotation returned for this residue.</p>
                  )}
                </>
              )}
            </>
          )}
          <button
            className="btn"
            onClick={() => void viewer.showDensity(active)}
          >
            Inspect available experimental density
          </button>
          {slot.density.error && <p role="alert">{slot.density.error}</p>}
        </>
      )}
      {pair && (
        <button
          className="btn"
          onClick={() => viewer.focusAlignedPair(active, pair)}
        >
          Focus corresponding residue · {pair.distance.toFixed(2)} Å apart
        </button>
      )}
      <h4>Nearby residues · calculated</h4>
      <p>
        Heavy atoms within 4.5 Å in the deposited model. Excludes water and
        symmetry copies; proximity does not establish binding energy.
      </p>
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          const current = structure;
          const target = r;
          const pending = runAnalysis({
            kind: 'neighbours',
            structure,
            residue: r,
          });
          job.current?.cancel();
          job.current = pending;
          setBusy(true);
          void pending.promise
            .then((result) => {
              if (
                viewer.getStructure(active) === current &&
                useStore.getState().slots[active].selectedResidue === target &&
                result.kind === 'neighbours'
              )
                setContacts(result.neighbours);
            })
            .catch((e) => {
              if (e.name !== 'AbortError') setStatus(e.message);
            })
            .finally(() => {
              if (job.current === pending) setBusy(false);
            });
        }}
      >
        Find nearby residues
      </button>
      {contacts?.map((c) => (
        <button
          className="btn evidence-row"
          key={c.residue}
          onClick={() => {
            useStore.getState().patchSlot(active, {
              selectedResidue: c.residue,
              selectionLabel: residueLabel(structure, c.residue),
            });
            viewer.refreshOverlay(active);
            viewer.focusResidue(active, c.residue);
          }}
        >
          {residueLabel(structure, c.residue)} · {c.distance.toFixed(2)} Å
        </button>
      ))}
      {contacts?.length === 0 && <p>No neighbours inside the cutoff.</p>}
    </div>
  );
}
