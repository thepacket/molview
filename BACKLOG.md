# Backlog

Forward work, roughly in the order it would pay off. Current limitations of what
already exists are documented at the end of [README.md](README.md) instead.

---

## Open

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

- **A side view widget.** Setting the clipping plane by eye — the camera and
  its planes drawn edge-on, draggable — rather than by the slider that exists.
  The orient half of this is done (`c08ae3d`).
- **Electrostatic colouring.** Needs a charge model and a Poisson-Boltzmann
  solve, or a crude Coulombic approximation that would be worse than nothing if
  presented as the real thing.
- **Movie recording.** Auto-rotate exists; capturing it does not.
- **Per-model interactive transforms, settable pivot, draggable labels, a colour
  key.** Small, individually unremarkable, and each one is a real gap.
Not taken: structure editing and dynamics (bond rotation, swapaa, tug,
minimize), markers, and the map tab's analysis tools — see "Not planned".

Ideas that surfaced while building the assistant:

- **A confirmation mode for actions.** Everything the assistant can do is a
  reversible view change, so it runs directly; a toggle for people who want to
  approve each one would be cheap.

- **Molecular surfaces.** A Gaussian or solvent-excluded surface, reusing the
  marching cubes and the forward transparent pass the density work added. What
  is left is generating the field: a Gaussian sum over atoms on a grid, which is
  the same shape of problem as `nearMask` already solves.

One that would be worth revisiting if the app grows:

- **A real command line** — the ⌘K palette and the selection grammar between
  them cover most of what a command line would, but typed commands compose in a
  way menus cannot.

---

## Done

- **Density maps** — the deposited experimental density, fetched from RCSB's
  VolumeServer and contoured with marching cubes.

  Four decisions worth keeping:

  - **A box around the model, not the unit cell.** The server then applies the
    spacegroup, so density arrives where the molecule is rather than wherever
    the asymmetric unit happens to sit. For cryo-EM the same request spends the
    detail budget on the particle instead of on empty box — 2 Å sampling for the
    bytes that a whole-map request spent on 4 Å — and it makes sigma mean the
    variation over the region being looked at.
  - **The 256-case triangle table is derived, not transcribed.** It is built at
    module load from the cube's face connectivity, with ambiguous faces resolved
    by a rule that depends only on the four shared corners, so the two cubes
    meeting there always agree. The mesh is watertight at every contour tested,
    and correctness is an argument rather than a proofread.
  - **Wireframe first.** Chicken wire is how maps are read, and it is the only
    see-through surface a deferred renderer gets for nothing. The solid surface
    rides on a new forward pass that blends over the resolved image and
    depth-tests against the G-buffer, which is the transparency that molecular
    surfaces were waiting on.
  - **The opening contour is chosen against a triangle budget.** Surface cells
    are counted before any geometry is built, and the level rises until the
    surface fits. A fixed default gives one entry a clean map and the next a
    half-drawn one.

  Validated against the coordinates rather than by eye: 2Fo-Fc sampled at the
  660 atoms of 1UBQ averages 2.65 sigma with 90% above 1 sigma, while the same
  atoms displaced 7 Å average 0.03 — which pins the axis order, the fractional
  origin and the grid indexing all at once.

- **Camera orientation on demand** (`c08ae3d`) — O re-orients a pane to its own
  principal axes, the palette offers views down X, Y and Z, and the assistant
  has a `view` action for both. Turning and refitting animate as one movement,
  since snapping then gliding reads as two events.

- **Shadows** (`7a778e7`) — screen-space contact shadows marched along the key
  light, sixteen steps through the existing depth buffer. A shadow map was not
  taken: it would mean a light's-eye pass over every pane's geometry, for an
  effect that mostly matters at contact range. Reach follows the scene, so it
  reads the same on a ligand and a capsid.

- **Validation in the browse results** (`d5c824e`) — one chip per hit naming the
  entry's weakest metric. It rides the existing batched summary query, so it
  costs no extra round trip. Sorting by quality was not added: the search API
  sorts server-side, so a client-side re-sort would reorder the current page
  only and quietly lie about the rest.

- **Interfaces for the assistant, and results fed back** (`4c75173`) — an
  `interfaces` action, and every action's outcome returned to the model as a
  RESULTS message. Asked what chain A touches, it was reasoning from entity
  stoichiometry while the answer sat computed in the panel beside it.

- **Interfaces** (`ce8e8b4`) — heavy-atom contacts grouped by chain pair, with
  focus and draw-as-component actions. Validated against known architecture:
  4HHB's alpha1beta1 pairs rank above alpha1beta2 above alpha1alpha2, 1AF6's
  trimer is three equal interfaces, 1KX5 finds the DNA duplex then the four
  histone dimers. Buried surface area was not attempted; it needs SASA, and
  contacts answer the question the panel is actually asking.

- **Nucleotide representations** (`4856936`) — ladder, stubs and none beside the
  existing slab, plus colouring by base. Watson-Crick pairing is geometric and
  validated against known answers: 12/12 in 1BNA, 146/147 in the 1KX5
  nucleosome. Tube/Ellipsoid and Tube/Muffler were not taken; they are variants
  of the same idea rather than a different reading of the molecule.

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

Molecular surfaces (SES/Gaussian) are genuinely wanted, and the blocker is now
gone: the density work added the forward blended pass they were waiting on, so
they have moved to "Open" above.
