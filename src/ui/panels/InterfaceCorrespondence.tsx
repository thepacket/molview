import { useEffect, useRef, useState } from 'react';
import type { ChainInterface } from '../../mol/interfaces';
import { runAnalysis } from '../../mol/analysis';
import type { AnalysisResult } from '../../mol/analysisTasks';
import { residueLabel } from '../../mol/investigation';
import { viewer } from '../../viewer/ViewerController';
import { useStore } from '../../state/store';
type Result = Extract<AnalysisResult, { kind: 'interface-comparison' }>;
export function InterfaceCorrespondence({
  reference,
  mobile,
  reports,
}: {
  reference: number;
  mobile: number;
  reports: [ChainInterface[], ChainInterface[]];
}) {
  const [ri, setRi] = useState(''),
    [mi, setMi] = useState(''),
    [reverse, setReverse] = useState(false);
  const [result, setResult] = useState<Result | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<ReturnType<typeof runAnalysis> | null>(null);
  const rs = viewer.getStructure(reference)!,
    ms = viewer.getStructure(mobile)!;
  const r = reports[0][+ri],
    m = reports[1][+mi];
  useEffect(() => {
    setResult(null);
    setError('');
    setBusy(false);
    return () => {
      pending.current?.cancel();
      pending.current = null;
    };
  }, [ri, mi, reverse, reports[0], reports[1], rs, ms]);
  const label = (v: ChainInterface) =>
    `${v.chainA} ↔ ${v.chainB}${v.copyB === undefined ? '' : ` (copy ${v.copyB})`} · ${v.contacts} contacts`;
  return (
    <section className="investigation">
      <h4>Match two interfaces</h4>
      <p>
        Choose the interface in each assembly and explicitly pair its sides.
        Sequence alignment compares contacting residues; it does not establish
        biological equivalence.
      </p>
      {reports.map((rows, i) => (
        <label key={i}>
          Interface in {i ? ms.id : rs.id}
          <select
            className="text-input"
            value={i ? mi : ri}
            onChange={(e) => (i ? setMi : setRi)(e.target.value)}
          >
            <option value="">Choose an interface</option>
            {rows.map((v, j) => (
              <option key={j} value={j}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <label>
        Side pairing
        <select
          className="text-input"
          value={String(reverse)}
          onChange={(e) => setReverse(e.target.value === 'true')}
        >
          <option value="false">First ↔ first, second ↔ second</option>
          <option value="true">First ↔ second, second ↔ first</option>
        </select>
      </label>
      <button
        className="btn"
        disabled={busy || ri === '' || mi === ''}
        onClick={() => {
          const job = runAnalysis({
            kind: 'interface-comparison',
            reference: rs,
            mobile: ms,
            referenceInterface: r,
            mobileInterface: m,
            reverse,
          });
          pending.current?.cancel();
          pending.current = job;
          setBusy(true);
          setError('');
          setResult(null);
          void job.promise
            .then((value) => {
              if (
                pending.current === job &&
                value.kind === 'interface-comparison'
              )
                setResult(value);
            })
            .catch((e) => {
              if (pending.current === job && e.name !== 'AbortError')
                setError(e.message);
            })
            .finally(() => {
              if (pending.current === job) setBusy(false);
            });
        }}
      >
        Compare selected interfaces
      </button>
      {busy && (
        <button
          className="btn"
          onClick={() => {
            pending.current?.cancel();
            pending.current = null;
            setBusy(false);
          }}
        >
          Cancel interface comparison
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          {result.sides.map((side, i) => (
            <div key={i}>
              <h4>
                Side {i + 1}: {rs.chainAuthId[side.referenceChain]} ↔{' '}
                {ms.chainAuthId[side.mobileChain]}
              </h4>
              <p>
                {side.matched} aligned anchors ·{' '}
                {(side.identity * 100).toFixed(1)}% identity · coverage{' '}
                {(side.referenceCoverage * 100).toFixed(1)}% /{' '}
                {(side.mobileCoverage * 100).toFixed(1)}%
              </p>
              <p>
                {side.conserved} shared contacting positions · {side.lost}{' '}
                reference-only · {side.gained} comparison-only.
              </p>
              <p>
                {side.unmappedReference.length} / {side.unmappedMobile.length}{' '}
                contacting residues lack correspondence and are excluded from
                differences.
              </p>
              {side.identity < 0.5 && (
                <p>
                  Low sequence identity: inspect this side pairing carefully.
                </p>
              )}
              <details>
                <summary>Inspect contact-position differences</summary>
                {side.contacts
                  .filter((p) => p.referenceContact !== p.mobileContact)
                  .map((p) => (
                    <button
                      className="btn evidence-row"
                      key={p.referenceResidue}
                      onClick={() => {
                        useStore
                          .getState()
                          .patchSlot(reference, {
                            selectedResidue: p.referenceResidue,
                          });
                        useStore
                          .getState()
                          .patchSlot(mobile, {
                            selectedResidue: p.mobileResidue,
                          });
                        viewer.focusResidue(reference, p.referenceResidue);
                        viewer.focusResidue(mobile, p.mobileResidue);
                      }}
                    >
                      {residueLabel(rs, p.referenceResidue)} ↔{' '}
                      {residueLabel(ms, p.mobileResidue)} ·{' '}
                      {p.referenceContact
                        ? 'reference-only'
                        : 'comparison-only'}
                    </button>
                  ))}
              </details>
            </div>
          ))}
          <p>
            For symmetry partners, focus shows the source residue in deposited
            coordinates. Contact-position overlap is not atom-pair conservation
            or a binding-energy estimate.
          </p>
          <button
            className="btn"
            onClick={() => {
              const doc = {
                schema: 'molview-interface-correspondence-1',
                createdAt: new Date().toISOString(),
                reference: rs.id,
                mobile: ms.id,
                referenceAssembly:
                  useStore.getState().slots[reference].assemblyId,
                mobileAssembly: useStore.getState().slots[mobile].assemblyId,
                referenceInterface: r,
                mobileInterface: m,
                reverse,
                sides: result.sides,
                referenceResidues: Array.from(
                  { length: rs.residueCount },
                  (_, i) => residueLabel(rs, i),
                ),
                mobileResidues: Array.from(
                  { length: ms.residueCount },
                  (_, i) => residueLabel(ms, i),
                ),
                limitations:
                  'User-selected side pairing; sequence-aligned contact positions, not biological equivalence. Unmapped positions excluded; symmetry partners retain source indices and operator matrices.',
              };
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(doc, null, 2)], {
                  type: 'application/json',
                }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = `${rs.id}-${ms.id}-interfaces.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export interface correspondence
          </button>
        </>
      )}
    </section>
  );
}
