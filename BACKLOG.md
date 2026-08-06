# Backlog

Forward work, roughly in the order it would pay off. Current limitations of what
already exists are documented at the end of [README.md](README.md) instead.

---

## Open

- **Validation in the browse results.** The definition panel now shows the wwPDB
  summary (`2fdd77a`), but the decision it most affects is picking among the
  dozens of entries for the same protein, where resolution is the usual and poor
  tiebreaker. A three-segment bar per hit — clashes, geometry, density fit —
  plus sorting by it. Not built because the result rows are much tighter than
  the panel and the layout wants a real eye on it. Costs a second batched query,
  since `fetchSummaries` does not carry the validation fields.
- **Per-residue validation.** Entry-level numbers say "9.5% rotamer outliers"
  but not which residues, so the structure cannot be coloured by fault. The
  per-residue data is in the validation XML; whether RCSB exposes it through
  GraphQL is unverified.

Ideas that came up along the way and were deliberately not taken are under "Not
planned" below; current limitations of what exists are at the end of
[README.md](README.md).

### From the ChimeraX comparison

Its seven toolbars read against what MolView has, ranked by payoff per unit of
work rather than by how large the gap is. Mimicry is not the goal — several of
these are deliberately declined under "Not planned".

- **Nucleotide representations.** ChimeraX offers eight base styles; MolView has
  one. Ladder and stubs reuse the ring-plane frame `addBaseSlab` already fits,
  and per-base A/T/G/C colouring is a new entry in the colour-scheme table over
  data already parsed. Cheapest real win, and DNA/RNA is where the renderer
  currently looks weakest — `1BNA` and `7A5R` are both featured entries.
- **Interfaces.** Chain-chain contact analysis: what touches what, how much
  area, and a way to select the interface between two chains. Fits the neighbour
  search that H-bond detection already uses, and answers the obvious next
  question about an assembly — which is the thing MolView is unusually good at.
- **Shadows.** The deferred pipeline lights once after rasterisation, so a
  shadow pass is additive rather than invasive.
- **Camera: orient and side view.** Snap to standard axes; a depth widget for
  setting the clipping plane by eye rather than by slider.
- **Electrostatic colouring.** Needs a charge model and a Poisson-Boltzmann
  solve, or a crude Coulombic approximation that would be worse than nothing if
  presented as the real thing.
- **Movie recording.** Auto-rotate exists; capturing it does not.
- **Per-model interactive transforms, settable pivot, draggable labels, a colour
  key.** Small, individually unremarkable, and each one is a real gap.
- **Density maps.** The largest coherent absence: no volumetric data at all — no
  map fetch, no isosurface, no contour level, no slices. It changes what the app
  is for, since it is what lets you check a model against evidence rather than
  admire it. It is a project rather than a work item: a new fetch and parse path
  (CCP4/MRC), marching cubes or a volume raycaster, and the transparency work
  that already blocks molecular surfaces.

Not taken: structure editing and dynamics (bond rotation, swapaa, tug,
minimize), markers, and the map tab's analysis tools — see "Not planned".

Ideas that surfaced while building the assistant:

- **Feed action results back to the model.** Results are shown to the user but
  not returned to the model, so it cannot see that a chain id was rejected and
  correct itself.
- **A confirmation mode for actions.** Everything the assistant can do is a
  reversible view change, so it runs directly; a toggle for people who want to
  approve each one would be cheap.

Two that would be worth revisiting if the app grows:

- **Molecular surfaces** — see the note below. The blocker is transparency, not
  the surface itself.
- **A real command line** — the ⌘K palette and the selection grammar between
  them cover most of what a command line would, but typed commands compose in a
  way menus cannot.

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
- **Projects with local files** — coordinates embedded behind an opt-in, and a
  clear explanation when a pane was saved without them.
- **Assistant** — an OpenRouter-backed panel that answers in Markdown/LaTeX and
  drives the viewer through a validated 18-action command surface.
- **Ensemble overlay** — every NMR model at once as backbone traces, each model
  a separate chain so `model 3` selects one of them.
- **Shareable URLs** — the session deflated into the URL fragment; a four-pane
  project including a 2.9M-atom capsid fits in about 1 kB of link.
- **Overlay structures in one pane** — a pane can draw other panes' structures
  in their own superposed frames, turning a side-by-side comparison into a
  direct one.
- **Per-chain alignment choice** — chain selectors on both sides of a
  superposition, defaulting to the longest.
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
