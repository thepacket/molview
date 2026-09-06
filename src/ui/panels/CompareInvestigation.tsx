import { ContactComparison } from './ContactComparison';
import { useMemo, useState } from 'react';
import { useStore, visibleSlotCount } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import {
  comparisonSummary,
  ligandResidues,
  residueLabel,
} from '../../mol/investigation';
import { resNameOf } from '../../mol/structure';
import { AlignmentTrack } from './AlignmentTrack';

export function CompareInvestigation() {
  const slots = useStore((s) => s.slots);
  const layout = useStore((s) => s.layout);
  const [reference, setReference] = useState(0);
  const [mobile, setMobile] = useState(1);
  const [rc, setRc] = useState('');
  const [mc, setMc] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  void revision;
  const available = slots
    .slice(0, visibleSlotCount(layout))
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.status === 'ready');
  const rs = viewer.getStructure(reference),
    ms = viewer.getStructure(mobile);
  const alignment = viewer.getAlignment(mobile);
  const valid =
    slots[mobile]?.superposedOnto === reference &&
    alignment?.referenceSlot === reference &&
    rs &&
    ms &&
    slots[reference].status === 'ready' &&
    slots[mobile].status === 'ready';
  const summary = useMemo(
    () =>
      valid
        ? comparisonSummary(
            rs,
            ms,
            alignment.referenceChain,
            alignment.mobileChain,
            alignment.pairs,
          )
        : null,
    [valid, rs, ms, alignment],
  );
  const focus = (index: number) =>
    alignment && viewer.focusAlignedPair(mobile, alignment.pairs[index]);
  const chains = (slot: number, value: string, change: (v: string) => void) => (
    <select
      className="text-input"
      aria-label={`Chain in pane ${slot + 1}`}
      value={value}
      onChange={(e) => change(e.target.value)}
    >
      <option value="">Longest polymer chain</option>
      {viewer.alignableChains(slot).map((c) => (
        <option key={c.authId} value={c.authId}>
          {c.authId} · {c.residues.length} anchors
        </option>
      ))}
    </select>
  );
  return (
    <div className="panel-section investigation">
      <h3>What changed?</h3>
      <p>Choose two loaded panes and the chains to compare.</p>
      {available.length < 2 && (
        <p>
          Load a second structure using Browse or Choose, then open a split
          layout.
        </p>
      )}
      <label>
        Reference
        <select
          className="text-input"
          value={reference}
          onChange={(e) => {
            setReference(+e.target.value);
            setRc('');
          }}
        >
          {available.map(({ s, i }) => (
            <option key={i} value={i}>
              Pane {i + 1} · {s.entryId}
            </option>
          ))}
        </select>
      </label>
      {chains(reference, rc, setRc)}
      <label>
        Compare with
        <select
          className="text-input"
          value={mobile}
          onChange={(e) => {
            setMobile(+e.target.value);
            setMc('');
          }}
        >
          {available.map(({ s, i }) => (
            <option key={i} value={i}>
              Pane {i + 1} · {s.entryId}
            </option>
          ))}
        </select>
      </label>
      {chains(mobile, mc, setMc)}
      <button
        className="btn primary"
        disabled={
          reference === mobile ||
          !available.some((v) => v.i === reference) ||
          !available.some((v) => v.i === mobile)
        }
        onClick={() => {
          const result = viewer.superpose(
            mobile,
            reference,
            mc || undefined,
            rc || undefined,
          );
          setError(typeof result === 'string' ? result : '');
          setRevision((v) => v + 1);
        }}
      >
        Align and compare
      </button>
      {error && <p role="alert">{error}</p>}
      {summary && alignment && rs && ms && (
        <>
          <h4>Alignment evidence · calculated</h4>
          <p>
            {slots[reference].entryId} / {alignment.referenceChain} →{' '}
            {slots[mobile].entryId} / {alignment.mobileChain}
          </p>
          <dl className="meta-grid">
            <dt>Fitted RMSD</dt>
            <dd>{slots[mobile].superposeRmsd?.toFixed(2)} Å</dd>
            <dt>Matched / fitted</dt>
            <dd>
              {summary.matched} / {summary.fitted}
            </dd>
            <dt>Excluded from fit</dt>
            <dd>{summary.excluded}</dd>
            <dt>Aligned identity</dt>
            <dd>
              {summary.identity === null
                ? 'Unavailable'
                : `${(100 * summary.identity).toFixed(1)}%`}
            </dd>
            <dt>Anchor coverage</dt>
            <dd>
              {((summary.referenceCoverage ?? 0) * 100).toFixed(0)}% /{' '}
              {((summary.mobileCoverage ?? 0) * 100).toFixed(0)}%
            </dd>
            <dt>Unmatched anchors</dt>
            <dd>
              {summary.referenceUnmatched.length} /{' '}
              {summary.mobileUnmatched.length}
            </dd>
          </dl>
          <p>
            Coverage is relative to coordinate-bearing chain anchors, not the
            full UniProt sequence. RMSD excludes pruned pairs.
          </p>
          <h4>Experimental context · deposited</h4>
          {[reference, mobile].map((i) => (
            <p key={i}>
              <b>{slots[i].entryId}</b>:{' '}
              {slots[i].prediction
                ? 'Predicted model'
                : (slots[i].detail?.method ?? 'Method unavailable')}
              ; resolution {slots[i].detail?.resolution ?? 'unavailable'}
              {slots[i].detail?.resolution ? ' Å' : ''}; assembly{' '}
              {slots[i].assemblyId || 'asymmetric unit'} ·{' '}
              {viewer
                .getStructure(i)
                ?.assemblies.find((a) => a.id === slots[i].assemblyId)
                ?.oligomericDetails || 'No declared oligomeric description'}
              .
            </p>
          ))}
          <p>
            Different constructs, experimental conditions and methods can
            explain differences. A displacement alone does not establish a
            biological mechanism.
          </p>
          <h4>Largest anchor displacements</h4>
          {summary.largest.map((p) => (
            <button
              className="btn evidence-row"
              key={p.mobileResidue}
              onClick={() => focus(alignment.pairs.indexOf(p))}
            >
              {residueLabel(ms, p.mobileResidue)} · {p.distance.toFixed(2)} Å
              {!p.used ? ' · excluded' : ''}
            </button>
          ))}
          <details>
            <summary>
              Sequence differences ({summary.substitutions.length})
            </summary>
            {summary.substitutions.map((p) => (
              <button
                className="btn evidence-row"
                key={p.mobileResidue}
                onClick={() => focus(alignment.pairs.indexOf(p))}
              >
                {residueLabel(rs, p.referenceResidue)} →{' '}
                {residueLabel(ms, p.mobileResidue)}
              </button>
            ))}
          </details>
          <h4>Ligands in deposited coordinates</h4>
          {[rs, ms].map((s, i) => (
            <p key={i}>
              <b>{s.id}</b>:{' '}
              {[...new Set(ligandResidues(s).map((r) => resNameOf(s, r)))].join(
                ', ',
              ) || 'None modelled'}
            </p>
          ))}
          <p>
            Absence from a model does not establish absence from the sample.
          </p>
          <ContactComparison reference={reference} mobile={mobile} />
          <AlignmentTrack slot={mobile} />
          <button
            className="btn"
            onClick={() => {
              const report = {
                schema: 'molview-comparison-1',
                reference: rs.id,
                mobile: ms.id,
                referenceChain: alignment.referenceChain,
                mobileChain: alignment.mobileChain,
                referenceAssembly: slots[reference].assemblyId,
                mobileAssembly: slots[mobile].assemblyId,
                referenceMethod: slots[reference].detail?.method,
                mobileMethod: slots[mobile].detail?.method,
                rmsd: slots[mobile].superposeRmsd,
                summary,
                pairs: alignment.pairs,
                createdAt: new Date().toISOString(),
                limitations:
                  'Sequence-guided anchor alignment; pruned RMSD; coverage of modelled anchors only; geometric differences do not establish mechanism.',
              };
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report, null, 2)], {
                  type: 'application/json',
                }),
              );
              const a = document.createElement('a');
              a.href = url;
              a.download = `${rs.id}-${ms.id}-comparison.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Export comparison evidence
          </button>
          <p>Use Projects → Share to reopen the scene and its structures.</p>
        </>
      )}
    </div>
  );
}
