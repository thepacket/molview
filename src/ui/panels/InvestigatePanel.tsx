import { useState } from 'react';
import { ChooseInvestigation } from './ChooseInvestigation';
import { CompareInvestigation } from './CompareInvestigation';
import { ResidueEvidence } from './ResidueEvidence';
import { GuidedInvestigation } from './GuidedInvestigation';
export function InvestigatePanel() {
  const [tab, setTab] = useState('choose');
  return (
    <>
      <div
        className="investigation-tabs"
        role="tablist"
        aria-label="Scientific investigation"
      >
        {['choose', 'compare', 'evidence', 'guides'].map((t) => (
          <button
            className="btn"
            role="tab"
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'choose' ? (
          <ChooseInvestigation />
        ) : tab === 'compare' ? (
          <CompareInvestigation />
        ) : tab === 'evidence' ? (
          <ResidueEvidence />
        ) : (
          <GuidedInvestigation />
        )}
      </div>
    </>
  );
}
