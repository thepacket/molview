# Backlog

Forward work, roughly in the order it would pay off. Current limitations of what
already exists are documented at the end of [README.md](README.md) instead.

---

## 1. Smaller wins

- **Overlay two structures in one pane**: superposition already puts panes in a
  shared frame, but drawing both in a single viewport would make the comparison
  direct rather than side-by-side.
- **Per-chain alignment choice**: superposition picks the longest polymer chain
  in each pane; the chains should be selectable.
- **Ensemble overlay**: models can be stepped through one at a time, but drawing
  several at once is the usual way to read NMR spread.
- **Projects with local files**: a pane opened from disk has no id to refetch,
  so it is saved as an empty pane. Embedding the coordinates behind an explicit
  opt-in is the open question.
- **Shareable URLs**: the project serialiser is the hard part and it exists now;
  what is missing is a compact encoding that fits in a link.
- **Two structures in one pane**: superposition puts panes in a shared frame,
  but overlaying both in a single viewport would make the comparison direct.
- **Per-chain alignment choice**: superposition currently picks the longest
  polymer chain in each pane; the chains should be selectable.

---

## Done

- **Biological assemblies** (`b8daf53`) — operator expressions applied on the
  GPU; a 49k-atom asymmetric unit becomes a 900-chain capsid for the cost of
  sixty matrices.
- **Selection model** (`f1801fc`) — an atom-specification language and ordered
  draw components, replacing the per-pane global representation.
- **Measurements, contacts and labels** (`6ccf946`) — runtime font atlas and a
  blended label pass, distances/angles/torsions, and geometric hydrogen bonds.
- **Structural superposition** (`1462ed5`) — sequence-guided alignment (Gotoh,
  BLOSUM62) plus Kabsch fitting with iterative pruning, applied as a per-pane
  scene transform so coordinates are never rewritten.
- **Nucleotide base slabs** (`2928528`) — bases fitted in their own ring plane,
  so a double helix reads as one instead of as two bare tubes.
- **Smaller wins** (`d5f2e7a`, `b82880a`) — lighting presets, colour by symmetry
  operator, download-size warnings, and NMR model selection.
- **Projects** — save/load in IndexedDB, export/import as `.molview.json`.
  Sessions round-trip exactly; measurements are stored as readable atom
  references rather than array indices.

---

## Not planned

Modeller, dockprep, mutation, docking — these need scientific backends there is
no case for reimplementing. VR. And the full ChimeraX command surface: hundreds
of commands built over decades, and chasing it is mimicry rather than design.

Molecular surfaces (SES/Gaussian) are genuinely wanted but structurally awkward:
the deferred pipeline is opaque-only, and a surface you cannot see the cartoon
through is half a feature. It needs order-independent transparency or a second
forward pass before it is worth starting.
