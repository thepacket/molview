import { useState } from 'react';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { ligandResidues, residueLabel } from '../../mol/investigation';
const GUIDES: {
  id: string;
  title: string;
  entries: string[];
  prediction?: string;
  steps: string[];
}[] = [
  {
    id: 'prediction',
    title: 'Compare experiment and prediction',
    entries: ['1CBS'],
    prediction: 'P29373',
    steps: [
      'Load the experimental structure and the public AlphaFold model for its UniProt protein.',
      'Align the chains in Compare and inspect coverage and sequence differences.',
      'Open the prediction Definition panel and inspect pLDDT and PAE; compare with experimental validation.',
    ],
  },
  {
    id: 'ligand',
    title: 'Inspect a bound ligand',
    entries: ['1CBS'],
    steps: [
      'Load retinoic-acid-binding protein from the PDB.',
      'Focus the modelled ligand and inspect nearby residues.',
      'Load residue evidence and compare the model with available density.',
    ],
  },
  {
    id: 'motion',
    title: 'Compare two conformations',
    entries: ['1AKE', '4AKE'],
    steps: [
      'Load two adenylate kinase structures.',
      'Align chain A and inspect the largest displacements in Compare.',
      'Check ligands and experimental context before interpreting the movement.',
    ],
  },
  {
    id: 'validation',
    title: 'Investigate model support',
    entries: ['1UBQ'],
    steps: [
      'Load ubiquitin from the PDB.',
      'Open validation and inspect the residues flagged by wwPDB.',
      'Select a residue, load its evidence, and inspect the density.',
    ],
  },
  {
    id: 'assembly',
    title: 'Explore an assembly',
    entries: ['4HHB'],
    steps: [
      'Load haemoglobin from the PDB.',
      'Compare the deposited asymmetric unit with biological assembly 1 in Representation.',
      'Inspect chain interfaces in Measure and distinguish assembly contacts from crystal packing.',
    ],
  },
];
export function GuidedInvestigation() {
  const [selected, setSelected] = useState('ligand'),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const guide = GUIDES.find((g) => g.id === selected)!;
  const active = useStore((s) => s.activeSlot);
  return (
    <div className="panel-section investigation">
      <h3>Guided investigations</h3>
      <p>
        Free public structures and reproducible controls. No account or AI key
        required.
      </p>
      <select
        className="text-input"
        aria-label="Investigation"
        disabled={busy}
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value);
          setMessage('');
        }}
      >
        {GUIDES.map((g) => (
          <option key={g.id} value={g.id}>
            {g.title}
          </option>
        ))}
      </select>
      <ol>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <button
        className="btn primary"
        disabled={busy || !viewer.isReady}
        onClick={() => {
          const store = useStore.getState();
          const target = active;
          const second = store.slots.findIndex(
            (s, i) => i !== target && s.status === 'empty',
          );
          if ((guide.entries.length > 1 || guide.prediction) && second < 0) {
            setMessage('Clear one pane for the second example structure.');
            return;
          }
          setBusy(true);
          setMessage('Loading public structures…');
          if (guide.entries.length > 1 || guide.prediction)
            store.setLayout(Math.max(target, second) > 1 ? 'quad' : 'columns');
          void (async () => {
            await viewer.load(target, guide.entries[0]);
            if (useStore.getState().slots[target].status !== 'ready')
              throw new Error(
                'The first structure failed to load. See the pane error.',
              );
            if (guide.entries[1] || guide.prediction) {
              if (guide.prediction)
                await viewer.loadPrediction(second, guide.prediction);
              else await viewer.load(second, guide.entries[1]);
              if (useStore.getState().slots[second].status !== 'ready')
                throw new Error(
                  'The second structure failed to load. See the pane error.',
                );
              const result = viewer.superpose(second, target, 'A', 'A');
              if (typeof result === 'string') throw new Error(result);
            }
            const s = viewer.getStructure(target);
            if (selected === 'ligand' && s) {
              const r = ligandResidues(s)[0];
              if (r !== undefined) {
                store.patchSlot(target, {
                  selectedResidue: r,
                  selectionLabel: residueLabel(s, r),
                });
                viewer.focusSelection(
                  target,
                  `/${s.chainAuthId[s.resChain[r]]}:${s.resSeq[r]}`,
                );
                viewer.refreshOverlay(target);
              }
            }
            setMessage(
              'Example ready. Follow the steps above; use Evidence, Compare, Representation or Measure as indicated.',
            );
          })()
            .catch((e) => setMessage(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy
          ? 'Loading…'
          : `Load example into pane ${active + 1}${guide.entries.length > 1 || guide.prediction ? ' and an empty pane' : ''}`}
      </button>
      <p>
        The example replaces the contents of the named pane. Save your project
        first if you want to retain that scene.
      </p>
      <p role="status">{message}</p>
    </div>
  );
}
