/** Molecular definition for the active pane, as returned by the GraphQL API. */

import { ExternalLink, FlaskConical, Layers } from 'lucide-react';
import { RCSB_ENTRY_URL } from '../../rcsb/api';
import { useStore } from '../../state/store';
import { Chip } from '../controls';

export function EntryPanel() {
  const slot = useStore((s) => s.slots[s.activeSlot]);
  const activeSlot = useStore((s) => s.activeSlot);

  if (!slot.entryId) {
    return (
      <div className="empty-state">
        Pane {activeSlot + 1} is empty.
        <br />
        Search or pick a featured structure to fill it.
      </div>
    );
  }

  const detail = slot.detail;
  if (!detail) {
    return (
      <div className="empty-state">
        <div className="spinner" />
        Loading definition for {slot.entryId}…
      </div>
    );
  }

  return (
    <>
      <div className="panel-section">
        <div className="result-top">
          <span className="pdb-id" style={{ fontSize: 14 }}>{detail.id}</span>
          <a
            className="link"
            href={RCSB_ENTRY_URL(detail.id)}
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: 'auto', fontSize: 10.5 }}
          >
            RCSB <ExternalLink size={9} style={{ verticalAlign: -1 }} />
          </a>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 4 }}>{detail.title}</div>
        <div className="chip-row">
          <Chip>{detail.method}</Chip>
          {detail.resolution !== null && <Chip accent>{detail.resolution.toFixed(2)} Å</Chip>}
          {detail.releaseDate && <Chip>{detail.releaseDate}</Chip>}
        </div>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Entry</span></div>
        <dl className="meta-grid">
          {detail.weightKda !== null && (
            <><dt>Mass</dt><dd>{detail.weightKda.toFixed(1)} kDa</dd></>
          )}
          {detail.atomCount !== null && (
            <><dt>Deposited atoms</dt><dd>{detail.atomCount.toLocaleString()}</dd></>
          )}
          {detail.residueCount !== null && (
            <><dt>Polymer residues</dt><dd>{detail.residueCount.toLocaleString()}</dd></>
          )}
          {detail.polymerTypes && (
            <><dt>Content</dt><dd>{detail.polymerTypes}</dd></>
          )}
          {detail.assemblyCount > 0 && (
            <><dt>Assemblies</dt><dd>{detail.assemblyCount}</dd></>
          )}
          {detail.keywords && (
            <><dt>Keywords</dt><dd>{detail.keywords}</dd></>
          )}
        </dl>
      </div>

      {detail.polymerEntities.length > 0 && (
        <div className="panel-section" style={{ padding: 0 }}>
          <div className="section-label" style={{ padding: '10px 10px 6px', margin: 0 }}>
            <span><Layers size={10} style={{ verticalAlign: -1 }} /> Polymer entities</span>
          </div>
          {detail.polymerEntities.map((e) => (
            <div key={e.id} className="entity">
              <div className="entity-head">
                <span className="entity-name" title={e.description}>{e.description}</span>
              </div>
              <div className="entity-meta">
                {e.polymerType}
                {e.weightKda !== null && ` · ${e.weightKda.toFixed(1)} kDa`}
                {e.organisms.length > 0 && ` · ${e.organisms[0]}`}
              </div>
              <div className="chip-row">
                {e.chains.map((c) => <Chip key={c}>{c}</Chip>)}
                {e.sequence && <Chip>{e.sequence.length} aa</Chip>}
              </div>
            </div>
          ))}
        </div>
      )}

      {detail.nonPolymerEntities.length > 0 && (
        <div className="panel-section" style={{ padding: 0 }}>
          <div className="section-label" style={{ padding: '10px 10px 6px', margin: 0 }}>
            <span><FlaskConical size={10} style={{ verticalAlign: -1 }} /> Ligands</span>
          </div>
          {detail.nonPolymerEntities.map((e) => (
            <div key={e.id} className="entity">
              <div className="entity-head">
                <span className="pdb-id">{e.compId}</span>
                <span className="entity-name" title={e.name}>{e.name}</span>
              </div>
              <div className="entity-meta">{e.formula}</div>
            </div>
          ))}
        </div>
      )}

      {detail.citation && (
        <div className="panel-section">
          <div className="section-label"><span>Primary citation</span></div>
          <div style={{ fontSize: 11.5, lineHeight: 1.5 }}>{detail.citation.title}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4 }}>
            {detail.citation.authors.slice(0, 3).join('; ')}
            {detail.citation.authors.length > 3 && ' et al.'}
            {detail.citation.journal && ` · ${detail.citation.journal}`}
            {detail.citation.year && ` ${detail.citation.year}`}
          </div>
          {detail.citation.doi && (
            <a
              className="link"
              href={`https://doi.org/${detail.citation.doi}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 10.5, display: 'inline-block', marginTop: 5 }}
            >
              doi:{detail.citation.doi}
            </a>
          )}
        </div>
      )}
    </>
  );
}
