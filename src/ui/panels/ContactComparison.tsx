import { InterfaceCorrespondence } from './InterfaceCorrespondence';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { runAnalysis } from '../../mol/analysis';
import type { AnalysisResult } from '../../mol/analysisTasks';
import { ligandResidues, residueLabel } from '../../mol/investigation';

type Context = Extract<AnalysisResult, { kind: 'context' }>;
export function ContactComparison({
  reference,
  mobile,
}: {
  reference: number;
  mobile: number;
}) {
  const slots = useStore((s) => s.slots),
    rs = viewer.getStructure(reference),
    ms = viewer.getStructure(mobile);
  const [rl, setRl] = useState(''),
    [ml, setMl] = useState('');
  const [result, setResult] = useState<[Context, Context] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<ReturnType<typeof runAnalysis>[]>([]);
  useEffect(() => {
    setResult(null);
    setBusy(false);
    setError('');
    return () => {
      pending.current.forEach((j) => j.cancel());
      pending.current = [];
    };
  }, [rs, ms, rl, ml, slots[reference].assemblyId, slots[mobile].assemblyId]);
  if (!rs || !ms) return null;
  const alignment = viewer.getAlignment(mobile);
  const referenceContacts = result?.[0].ligand?.contacts ?? [],
    mobileContacts = result?.[1].ligand?.contacts ?? [];
  const changes =
    alignment?.pairs
      .map((pair) => ({
        pair,
        r: referenceContacts.find((c) => c.residue === pair.referenceResidue),
        m: mobileContacts.find((c) => c.residue === pair.mobileResidue),
      }))
      .filter(
        (c) =>
          Boolean(c.r) !== Boolean(c.m) ||
          (c.r && c.m && c.r.kinds.join(',') !== c.m.kinds.join(',')),
      ) ?? [];
  return (
    <details className="investigation">
      <summary>Compare ligand contacts and interfaces</summary>
      <p>
        Select the ligand instance in each structure. Reports use geometric
        criteria; contacts to crystal symmetry copies are not included in ligand
        reports.
      </p>
      {([rs, ms] as const).map((s, i) => (
        <label key={i}>
          Ligand in {s.id}
          <select
            className="text-input"
            value={i ? ml : rl}
            onChange={(e) => (i ? setMl : setRl)(e.target.value)}
          >
            <option value="">No ligand comparison</option>
            {ligandResidues(s).map((r) => (
              <option key={r} value={r}>
                {residueLabel(s, r)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          pending.current.forEach((j) => j.cancel());
          setResult(null);
          setBusy(true);
          setError('');
          const jobs = [
            runAnalysis({
              kind: 'context',
              structure: rs,
              assemblyId: slots[reference].assemblyId,
              ligand: rl === '' ? null : +rl,
            }),
            runAnalysis({
              kind: 'context',
              structure: ms,
              assemblyId: slots[mobile].assemblyId,
              ligand: ml === '' ? null : +ml,
            }),
          ];
          pending.current = jobs;
          void Promise.all(jobs.map((j) => j.promise))
            .then(([r, m]) => {
              if (pending.current !== jobs) return;
              if (r.kind === 'context' && m.kind === 'context')
                setResult([r, m]);
            })
            .catch((e) => {
              if (pending.current === jobs && e.name !== 'AbortError')
                setError(e.message);
            })
            .finally(() => {
              if (pending.current === jobs) setBusy(false);
            });
        }}
      >
        Calculate contact evidence
      </button>
      {busy && (
        <button
          className="btn"
          onClick={() => {
            pending.current.forEach((j) => j.cancel());
            pending.current = [];
            setBusy(false);
          }}
        >
          Cancel
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {result && (
        <>
          <button
            className="btn"
            onClick={() => {
              const doc = {
                schema: 'molview-contacts-1',
                reference: rs.id,
                mobile: ms.id,
                referenceLigand: rl === '' ? null : residueLabel(rs, +rl),
                mobileLigand: ml === '' ? null : residueLabel(ms, +ml),
                referenceAssembly: slots[reference].assemblyId,
                mobileAssembly: slots[mobile].assemblyId,
                reports: result,
                referenceResidues: Array.from(
                  { length: rs.residueCount },
                  (_, r) => residueLabel(rs, r),
                ),
                mobileResidues: Array.from(
                  { length: ms.residueCount },
                  (_, r) => residueLabel(ms, r),
                ),
                createdAt: new Date().toISOString(),
                limitations:
                  'Geometric criteria; ligand contacts exclude symmetry copies; interface census is around the deposited copy.',
              };
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(doc, null, 2)], {
                  type: 'application/json',
                }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = `${rs.id}-${ms.id}-contacts.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export contact evidence
          </button>
          {result.map((report, i) => (
            <div key={i}>
              <h4>{i ? ms.id : rs.id} · interfaces</h4>
              <p>
                {report.interfaces.length} interfaces around the deposited copy
                in the selected assembly.
              </p>
              {report.interfaces.map((v, j) => (
                <p key={j}>
                  {v.chainA} ↔ {v.chainB}
                  {v.copyB !== undefined ? ` (copy ${v.copyB})` : ''}:{' '}
                  {v.contacts} atom contacts, {v.residuesA.length}/
                  {v.residuesB.length} residues
                </p>
              ))}
              <p>
                Selected ligand: {report.ligand?.contacts.length ?? 0}{' '}
                contacting residues
                {report.ligand
                  ? `, ${report.ligand.covalent.length} covalent partners excluded`
                  : ' (no ligand selected)'}
              </p>
            </div>
          ))}
          <InterfaceCorrespondence
            reference={reference}
            mobile={mobile}
            reports={[result[0].interfaces, result[1].interfaces]}
          />
          {rl !== '' && ml !== '' && (
            <>
              <h4>Changed contacts at aligned residues</h4>
              {changes.length ? (
                changes.map(({ pair, r, m }) => (
                  <button
                    className="btn evidence-row"
                    key={pair.mobileResidue}
                    onClick={() => viewer.focusAlignedPair(mobile, pair)}
                  >
                    {residueLabel(ms, pair.mobileResidue)}:{' '}
                    {r?.kinds.join(', ') || 'no contact'} →{' '}
                    {m?.kinds.join(', ') || 'no contact'}
                  </button>
                ))
              ) : (
                <p>No changed contact categories among aligned residues.</p>
              )}
              <p>
                Unaligned partners are excluded from this difference list.
                Different ligand chemistry can explain different contacts.
              </p>
            </>
          )}
        </>
      )}
    </details>
  );
}
