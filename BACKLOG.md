# Backlog

Forward work, roughly in the order it would pay off. Current limitations of what
already exists are documented at the end of [README.md](README.md) instead.

---

## Open

Ideas that came up along the way and were deliberately not taken are under "Not
planned" below; current limitations of what exists are at the end of
[README.md](README.md).

### From the ChimeraX comparison

Its seven toolbars read against what MolView has, ranked by payoff per unit of
work rather than by how large the gap is. Mimicry is not the goal — several of
these are deliberately declined under "Not planned".

- **Electrostatic colouring.** Needs a charge model and a Poisson-Boltzmann
  solve, or a crude Coulombic approximation that would be worse than nothing if
  presented as the real thing.
- **Per-model interactive transforms, settable pivot, draggable labels, a colour
  key.** Small, individually unremarkable, and each one is a real gap.

Not taken: structure editing and dynamics (bond rotation, swapaa, tug,
minimize), markers, and the map tab's analysis tools — see "Not planned".

One that would be worth revisiting if the app grows:

- **A real command line** — the ⌘K palette and the selection grammar between
  them cover most of what a command line would, but typed commands compose in a
  way menus cannot.

---

## Done

- **A confirmation mode for assistant actions** — off by default, and that is a
  position rather than laziness: everything the assistant can do is a
  reversible view change, so a confirmation on each one protects against
  nothing. It exists because "it moved my scene without asking" is a reasonable
  objection even when nothing was at stake, and because watching what a weak
  model *wanted* to do is the fastest way to see why it went wrong. Approval is
  per action rather than all-or-nothing: the case it is really for is a reply
  that gets three things right and one wrong, and keeping the three is what
  makes it a review step instead of an obstacle. A skipped action is never
  reported back as a rejection — the model did nothing wrong, and telling it
  otherwise would send it off correcting the user's decision.

- **Per-residue validation** — two colour schemes, fit to density (RSRZ) and
  counted geometry faults, plus a legend, a ranked worst-residues list that
  focuses on click, and a `validation` action that hands the assistant the same
  ranking with a ready-made selection.

  RCSB does expose it, which the earlier note doubted: not as a validation
  category but as polymer *instance features*, `RSRZ` and `RSCC` and `OWAB` as
  one array running along the entity sequence, clashes and bond/angle/stereo
  outliers as one position per affected residue. Two things had to be right or
  the picture lies quietly:

  - **Entity numbering is not auth numbering.** `auth_to_entity_poly_seq_mapping`
    converts; without it the colours land on the wrong residues in every entry
    whose chains do not start at 1.
  - **Every covered residue needs a row, including the clean ones.** Filling the
    map from features alone leaves a residue with nothing wrong with it
    indistinguishable from one nobody checked — and on a well-refined structure
    that is almost all of them. 4HHB went from 142 rows to its full 574.

  Both ramps are anchored to fixed thresholds (2 sigma is an outlier, 4 is bad)
  rather than to each entry's own range, so the same colour means the same
  thing between two structures. That only pays off if the thresholds are
  stated, hence the legend.

- **Turntable recording** — a pane exported as WebM. Not a screen capture: the
  camera is stepped as a function of frame number and the recorder is fed one
  frame per step, so a slow structure produces a slow export and a smooth
  video rather than a real-time capture of the stutter. Each step sets the pose
  absolutely from the starting one, so a dropped frame cannot accumulate into
  drift. WebM only — MP4 needs a shipped encoder and GIF a shipped quantiser,
  both large additions for a conversion any tool does.

- **A side view, and a rear clipping plane** — the scene drawn edge-on with
  both planes draggable, replacing the front-clipping slider. The widget is
  schematic rather than a second render: what matters while clipping is where
  the planes sit *relative to the molecule*, and that is three numbers, not
  another pass over the geometry. A rear plane had to exist for it to be worth
  drawing — with only a front plane there is no slab to show, and a thin
  section through a large assembly reads as a silhouette against everything
  behind it. The assistant gets `clip`, where "slab 20" is the one people mean.

- **Molecular surfaces** — a Gaussian surface over the drawn atoms or any
  selection, coloured by the pane's scheme so subunit boundaries show on the
  envelope. It reuses the density work wholesale: the field is emitted as a
  `VolumeGrid` with mean 0 and sigma 1, so the same marching cubes, wireframe,
  transparency and budget code contour it with nothing added.

  The two things that made it look right rather than merely exist:

  - **Per-vertex colour, blended along the cut edge.** Whichever atom dominates
    the field at each grid point is recorded during accumulation, which is free,
    and the surface takes its colour from there. A flat surface says nothing
    about the molecule under it.
  - **Silhouette weighting had to become a per-style number.** The rim-opaque
    look that makes a density contour read as a boundary rather than as fog
    turns a molecular surface into lace, because that surface is all bumps and
    every bump has a rim.

  Transparency is now drawn back faces then front faces, which needed the
  marching cubes to wind consistently — each triangle is turned to agree with
  its own vertex normals as it is emitted, one dot product, and the derived
  table still never reasons about orientation.

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

A true solvent-excluded surface. The Gaussian surface that exists answers the
question people ask a surface — what shape does this present to the world — and
a rolling-probe SES would add re-entrant saddles at the cost of a much more
delicate algorithm.
