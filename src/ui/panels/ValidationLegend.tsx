/**
 * What the validation colours mean, and where the worst of them are.
 *
 * A colour ramp with no legend is a decoration. Worse, these two ramps are
 * anchored to fixed thresholds rather than to the entry's own range, precisely
 * so the same colour means the same thing between structures — and that only
 * pays off if the thresholds are stated. The list underneath turns the picture
 * into somewhere to click.
 */

import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import type { ColorScheme } from '../../mol/coloring';

const RAMP = ['#3b4cc0', '#39b8d8', '#5ddb6f', '#f5d13a', '#e8483c'];

export function ValidationLegend({ scheme, slot }: { scheme: ColorScheme; slot: number }) {
  // Reading the pane's status is what makes this re-render once the fetch
  // lands; the metrics themselves live in the controller.
  useStore((s) => s.slots[slot].components);
  const validation = viewer.getResidueValidation(slot);
  const metric = scheme === 'rsrz' ? 'rsrz' : 'outliers';

  if (!validation) {
    return <p className="panel-note">Fetching the per-residue report…</p>;
  }

  if (metric === 'rsrz' && !validation.hasDensityFit) {
    return (
      <p className="vrpt-note">
        This entry has no per-residue fit to density — structure factors were
        never deposited, so every residue is drawn as unmeasured.
      </p>
    );
  }
  if (metric === 'outliers' && !validation.hasGeometry) {
    return (
      <p className="panel-note">
        The report lists no geometry outliers in this entry.
      </p>
    );
  }

  const worst = viewer.worstResidues(slot, metric, 6);

  return (
    <>
      <div className="legend-ramp" aria-hidden="true">
        {RAMP.map((c) => <span key={c} style={{ background: c }} />)}
      </div>
      <div className="legend-scale">
        {metric === 'rsrz' ? (
          <>
            <span>0 σ · fits</span>
            <span>2 σ · outlier</span>
            <span>4 σ+</span>
          </>
        ) : (
          <>
            <span>none</span>
            <span>3 faults</span>
            <span>6+</span>
          </>
        )}
      </div>
      <p className="panel-note" style={{ marginTop: 7 }}>
        {metric === 'rsrz'
          ? 'Real-space R Z-score per residue: how badly the model fits its own '
            + 'density compared with residues of the same type elsewhere in the archive.'
          : 'Clashes and bond, angle and stereochemistry outliers, counted together. '
            + 'Grey residues are ones the report does not cover.'}
      </p>

      {worst.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 9 }}><span>Worst residues</span></div>
          {worst.map((r) => (
            <button
              key={`${r.chain}:${r.seq}`}
              type="button"
              className="chain-toggle"
              style={{ width: '100%', textAlign: 'left' }}
              onClick={() => viewer.focusSelection(slot, `/${r.chain} and :${r.seq}`)}
            >
              <span className="chain-name">{r.chain} {r.seq}</span>
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10 }}>
                {metric === 'rsrz' ? `${r.value.toFixed(1)} σ` : `${r.value} faults`}
              </span>
            </button>
          ))}
        </>
      )}
    </>
  );
}
