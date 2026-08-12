# Backlog

Forward work, roughly in the order it would pay off. Current limitations of what
already exists are documented at the end of [README.md](README.md) instead.

---

## Open

The ChimeraX comparison is closed out — what is left of it is at the bottom of
this section. What follows came from asking a different question: not "what
does another viewer have" but "what does someone actually want to do with a
structure now, and can MolView do it". Endpoints below were probed, not
assumed.

Ideas deliberately not taken are under "Not planned"; current limitations of
what exists are at the end of [README.md](README.md).

The five that follow are **parity features, not differentiators** — checked
after they were written, against Mol*, iCn3D, Coot, ChimeraX and PyMOL. Coot has
had all five for twenty years. That is still a reason to build them, since a
viewer missing table stakes is a toy, but it is not the reason they were first
argued for: "no browser viewer does this" was asserted about real-space
correlation and is wrong, since Mol* and iCn3D are browser viewers with serious
validation features. The narrower claim survives — MolView could *compute*
correlation from a map it already holds rather than display fetched per-residue
scores — but whether the others compute or fetch was not verified either.

Treat comparison tables carefully: the one consulted credited Coot with
functions named `sampleSigma` and `gridIndexOf`, which are identifiers from this
repository, so it was at least partly echoing its input back.

Note also that this section's own preamble says the list came from asking what
someone wants to do rather than what another viewer has. These five are the
second kind, arrived at by reading MolView's gaps rather than another viewer's
menus, which is the same list by a different route.

### Real-space correlation per residue, computed here

The question asked of every crystal structure is whether an atom is supported by
the data or by the modeller's hope. MolView answers it today with wwPDB's RSRZ,
fetched per residue — and RSRZ **excludes ligands**, so the part you doubt most
is the part not covered.

Both halves are already in the client: the map is fetched for the density
feature, the model is loaded, and the trilinear sampling with the inverse step
matrix exists (`sampleSigma`, `gridIndexOf`). What is missing is the
correlation itself — density from the model, density from the map, correlated
over the residue's own envelope.

Validation is unusually clean: correlate the computed per-residue value against
wwPDB's RSRZ across a set of entries, where both should rank residues the same
way. Disagreement is then either a bug or a ligand, and the ligands are the
point.

Worth doing first because it is the only item here that MolView is uniquely
placed to do — no other browser viewer holds model and map in the same client.

### A ligand interaction report

Hydrogen bonds exist; the inventory does not. For a bound ligand: hydrogen
bonds, salt bridges, hydrophobic contacts, pi-stacking, each with the residue
making it and a selection that draws it. It is the first question anyone asks
of a complex, and it is pure geometry over coordinates already in memory.

Checkable against something independent: the UniProt binding-site annotations
the app already fetches. 1CBS puts its binding site on Arg132 and Tyr134, and a
contact report that does not name those two is wrong.

The trap is the one the pockets feature already avoids — reporting a contact as
an interaction. Distance and angle criteria are geometric; affinity is not.

### A Ramachandran plot

The standard artefact for judging a model, and MolView reports wwPDB's
percentile without ever drawing it. Phi and psi are four atoms and an arctangent
over the backbone; the plot is a small 2D panel, and its points should be
clickable to select the residue, which ties it to the per-residue validation
colouring already there.

Validates against itself: the fraction of residues in favoured regions should
track the Ramachandran percentile the entry panel already displays.

### Open your own structure

Everything MolView can show is bounded by what RCSB serves. A refined model, a
docking pose, a predicted complex — none of them can be opened, and the drop
target says mmCIF. Legacy PDB is still what most tools emit.

A PDB-format reader is fixed-column parsing, element inference, altlocs,
insertion codes and multi-model — not large, but the kind of parser that fails
silently on edge cases, so it wants a corpus of real files to check against
rather than one example.

It also unblocks the ESM Metagenomic Atlas. Probed and reachable —
`api.esmatlas.com/fetchPredictedStructure/{MGYP...}` answers 200 with
`Access-Control-Allow-Origin: *`, and there is a companion endpoint for the
PAE — but it serves legacy PDB, and it is keyed by MGnify accession rather than
UniProt, so the existing "predicted structures" path (UniProt search ->
accession) cannot reach it. With a PDB reader in place it needs only a second
entry point: an accession field, or search by sequence. Its value is coverage
of sequences nobody has named, not accuracy; ESMFold is below AlphaFold2 on the
same sequence.

### Entry classification, computed rather than restated

The pane shows `Content: Protein (only)`, which is RCSB's own `polymerTypes`
field passed straight through. Nothing about what an entry *is* is derived
here. The closest thing MolView computes for itself is MolKind per residue —
protein, nucleic, ligand, ion, water — which drives colouring and the colour key
and is never presented as a claim.

Worth doing because the machinery is now unusually well placed to make the
claim honestly: chain composition, the biological assembly the depositor
declares, buried area between chains, and — since the lattice landed — whether a
contact is packing or biology. "Two chains, 816 A2 buried, assembly says
tetramer" is a classification with its evidence attached, which is the only kind
worth showing.

The failure mode to avoid is the one already avoided for interfaces: a badge
saying "dimer" is believed further than the evidence goes.

### A light theme

Asked for and scoped but not built. The chrome is one hard-coded `:root` block
in `styles/app.css` ending in `color-scheme: dark`, with no media query and no
second palette — every colour already resolves through those variables, so
swapping them reskins the whole UI. That half is nearly free.

The canvas is the real work. Its background is a `VisualSettings` default that
nothing in the UI or in project persistence ever writes, and it is not a CSS
variable: it goes into the uniform buffer and the fog reads it, so depth cueing
currently fades geometry *towards* black. On a light canvas that inverts, and
the label backdrops (a dark plate behind bright text) and the hemispheric
ambient were all chosen against near-black. Two commits: the CSS palette split,
then the canvas with the fog and ambient re-checked rather than assumed.

### Blocked for now

- **Conservation colouring.** ConSurf-DB has precomputed profiles for most PDB
  chains, which is exactly what is wanted, but the host did not respond to a
  probe and does not appear to send CORS headers. Without a server there is no
  way to reach it, and computing conservation client-side means fetching and
  aligning a homologue set, which is a different project.

### Left from the ChimeraX comparison

Nothing, now. The last of it was electrostatic colouring, and the Coulombic
half of that is done and labelled as Coulombic; a Poisson-Boltzmann solve is
under "Not planned" with the other scientific backends.

Also not taken: structure editing and dynamics (bond rotation, swapaa, tug,
minimize), markers, and the map tab's analysis tools — see "Not planned".

---

## Done

- **Absence, made visible** — gaps and alternate conformations, and both turned
  out to be half-done or wrong rather than missing.

  The dashed ribbon across unmodelled residues had already shipped in
  `701a465`; this entry was written as though it had not. What was actually
  missing was the sequence track, which ran 34, 37, 69 with nothing between the
  cells and so read as a continuous chain.

  The rule underneath both was wrong, and in the direction this feature exists
  to prevent. It took any jump in `auth_seq_id` as a gap, so trypsin — numbered
  by chymotrypsinogen alignment, jumping 34->37, 67->69 and four more across a
  flat 3.8 Å with nothing missing — was drawn with six dashed gaps that do not
  exist. The comment defending that rule cited 1KX5 chain C jumping 12 -> 15;
  that chain runs 1 to 128 with no skips, and the example does not exist.
  Numbering and geometry are now both consulted, against a threshold measured
  from 49,852 certainly-real peptide bonds (median 3.80 Å, maximum 4.27 Å, so
  4.2 Å admits all but 0.014%). A jump across less than that is a renumbering
  and gets a hairline; across more, a hole. GFP supplied the second false
  positive — Thr65-Tyr66-Gly67 is one CRO residue at position 66, and stepping
  over it reported three residues missing from a continuous chain — so an
  unrecognised component inside a polymer chain now ends the run and claims
  nothing.

  For alternates, the choice had to become per residue rather than per file:
  only 3 of crambin's 17 alternate positions carry a C conformer, so selecting
  C globally would strip fourteen side chains. 1EJG also settled the shape of
  the feature, being a mixture of two natural isoforms — position 22 is Pro in
  A and Ser in B and C, sharing one backbone N — so switching conformer changes
  the sequence and not merely a side chain.

  What is deliberately not done: occupancy is still not carried, so the 21%
  conformer counts the same as the 57% one, and there is no way to draw two
  conformers at once or to mix them per residue.

- **1AKE reads low — resolved, and not ours.** The entry samples 0.56 sigma at
  its own atoms where every other entry tested reads 2.1-3.3. Ruled out, each by
  measurement: the map type (its Fo-Fc reads -0.08 sigma with 53% negative,
  exactly right for a fitted model, so the 2Fo-Fc is being identified
  correctly), sampling density (detail saturates at 0.63 A per sample and the
  number does not move), one bad chain (A and B agree at 0.64 and 0.49), atoms
  outside the grid (none), B-factors (4AKE has mean B 42.7 against 1AKE's 43.3
  and reads 2.17), a symmetry misplacement (all four operators of its space
  group give 0.56-0.61 against a full-cell map), a rigid shift (best offset
  0.14 A, worth 0.01 sigma), and a corrupt sigma in the header (11% from the
  samples, not the 4x needed).

  What it is: the map's strong features do not sit on the model. Of the grid
  points above 3 sigma, 41% are within 1 A of an atom, against 95% for 4AKE and
  100% for 1UBQ. The density exists — the map peaks at 9.5 sigma — but a
  minority of it coincides with atoms. That is a property of the map RCSB
  serves for this entry, and one entry in fourteen.

  Left as an entry-specific fact rather than a code change. The statistic
  behaved correctly throughout; it is the only check the density path has, and
  it did its job by flagging the one entry that is different.

- **Crystal lattice contacts** — the missing half of the interface story. The
  assembly says what the depositor believes; the lattice says what the crystal
  did, and only the first was reachable, so a monomeric entry reported no
  contacts while sitting packed against eight neighbours.

  RCSB ships the cell and space group but not the operators, so they are rebuilt
  from two or three generators per group and closed by composition. The general
  position multiplicity is stored as a checksum beside each group, which is the
  design decision that matters: a mistyped generator closes to the wrong order
  and the group is refused rather than producing a lattice that is plausible and
  wrong. It caught `P 42 3 2`, which is now absent. Only the 65 Sohncke groups
  are listed, since nothing chiral can sit in the others.

  Validated by independent agreement rather than by inspection: 1HHP's
  biological dimer is a crystallographic 2-fold, and it measures 1,614 A2 built
  from the deposited assembly operators and 1,614 A2 built from the space group
  and cell with no assembly at all. Packing separates from biology as expected —
  1HHP 1,614 against 258, 4HHB 816 against 353, and ubiquitin, myoglobin and
  lysozyme topping out at 292, 399 and 552 with no biological interface at all.

  The panel tags the provenance and shows the numbers; it does not print a
  verdict. The separation is a tendency and not a threshold, and a badge saying
  "biological" would be believed further than it deserves.

- **Coulombic colouring on the surface** — previously declined as "worse than
  nothing if presented as the real thing", where the qualifier was always the
  point. It is named Coulombic everywhere, the panel states what it is not, and
  a Poisson-Boltzmann solve remains out of scope.

  The charge model is deliberately small — ionisable side chains, termini,
  nucleic acid phosphates, ions — because that is what carries the gross
  character a Coulombic surface is read for, and a full partial-charge set
  would put a tenth of an electron on every backbone carbonyl and change the
  picture very little. Checked by arithmetic rather than by eye: 1KX5's DNA
  totals -292, exactly its 292 phosphates, against about +120 for the histone
  octamer, and the surface shows the octamer blue with the H2A/H2B acidic patch
  as a red spot.

  Potential is evaluated per vertex after meshing rather than per grid point
  before it: a surface has a few hundred thousand vertices and the grid a few
  million points, and only the ones on the surface are ever looked at.

- **Morphing between two superposed conformations** — nearly free once the
  superposition kept its alignment. Each aligned residue is translated bodily
  by its own anchor's displacement, unaligned residues are carried by their
  nearest neighbours within twenty positions, and identical chains get the same
  displacement by residue number so a homodimer does not look broken in half.
  Verified exactly: at full morph the worst-moving anchor travels 18.3 A, which
  is precisely its measured pair distance, and reset restores the coordinates
  to zero error. A rebuild is 15 ms, so it plays.

  It is a straight line through space and the panel says so. Bonds stretch on
  the way through and no barrier is respected; the animation shows what moved,
  and would be read as how it moves if left unqualified.

- **A command line** — a `/` line in the assistant composer runs as commands
  instead of going to a model. Deferred twice on the grounds that the palette
  covered it; twenty-seven actions later it did not.

  The decision that matters is that it executes *the same* actions through the
  same function rather than defining verbs of its own — a second vocabulary
  would drift from the first, and every action already returns a sentence
  saying what it did, which is the entire output format. Reusing the composer
  and the transcript meant no new surface at all. It also works with no API
  key, which is half the point: the app should be drivable by typing whether or
  not you have an account anywhere.

- **UniProt functional annotations, on the residues** — active and binding
  sites, modified residues, motifs, domains, mutagenesis results, each selectable
  and drawable. The app could describe a structure's geometry in detail and say
  nothing about what any of it does; this is the part that does.

  All of the difficulty is numbering, and it is silent when wrong. UniProt
  position to entity position through `rcsb_polymer_entity_align`, then to
  `auth_seq_id` through `auth_to_entity_poly_seq_mapping`. Checked by distance
  rather than by inspection: 101M's "proximal binding residue" comes out as
  His93 with its NE2 2.20 A from the haem iron — the coordination bond — and
  1CBS, which is offset by one and so is exactly where a missing alignment step
  would show, puts its binding site on Arg132 and Tyr134 at 2.7 and 2.6 A from
  the ligand carboxylate.

- **Pocket detection** — the LIGSITE buriedness scan: enclosed along four of
  seven axes, clustered, ranked by volume, with lining residues and a ready
  selection.

  The design decision that makes the answer trustworthy is excluding ligands
  and waters from the grid. It is also what makes the result checkable: a
  ligand named beside a pocket was *found*, not restated. Myoglobin's top
  cavity is 410 A3 containing HEM and lined by Phe43, His64, His97 and Arg45 —
  the distal pocket residue for residue; 1CBS puts retinoic acid in its
  largest; 1EMA puts the GFP chromophore inside the barrel. 3EIY corrected me
  rather than the reverse: I expected ATP, the entry has pyrophosphate, and the
  scan had it right.

  Four of seven rather than LIGSITE's five, because at five only the single
  deepest cavity survives on most structures — which answers "where is the
  site" but not "where are the cavities". The ligand pocket still ranks first
  everywhere it was checked.

- **The alignment a superposition computes** — it was being calculated and then
  reduced to one number. An RMSD is an average, and an average of a bimodal
  distribution lies about both halves: adenylate kinase open against closed
  reports 7.13 A, and what that actually means is a rigid core plus a LID domain
  that has swung 18 A. One cell per aligned residue, coloured by residual
  distance, in sequence order — the shape of the strip is the answer. Pruned
  pairs are hatched rather than recoloured, so colour keeps meaning only
  distance, and every pair is reported rather than only the fitted core, because
  the residue the pruning threw out is precisely the interesting one.

- **A colour-blind-safe palette, and script export** — the two small ones.

  The palette is Okabe and Ito's eight, persisted in localStorage rather than
  sessionStorage: an accessibility setting that has to be found again every
  session is one the person it exists for stops using. Colours are baked into
  the geometry buffers, so changing it rebuilds every pane rather than merely
  redrawing.

  The script export recompiles selections from their parsed AST rather than
  substituting strings, because substitution gets `not water` and nested
  parentheses wrong in ways that stay silent until someone runs the script.
  Each target's own hex convention had to be respected too — PyMOL takes
  `0xRRGGBB` and ChimeraX `#RRGGBB`, and each rejects the other.

- **Similarity search from the pane, and buried surface area** — two answers
  the app could not give about what was already on screen.

  Shape and sequence similarity are one request each to services the search
  panel was already talking to. Shape asks about the assembly rather than the
  entry, because shape is a property of the biological molecule; sequence needs
  `results_verbosity: verbose`, without which the identity and E-value — the
  whole reason to run it — never come back.

  Buried area is Shrake-Rupley over the spatial hash the contact search already
  builds, quoted as interface area the way PISA does. Contacts still rank the
  pairs and only the reported ones are measured. Validated against published
  numbers: haemoglobin's alpha1beta1 at 816 and 831 A2 against PISA's 830-870,
  the whole tetramer's surface at 24,713 A2 against a literature ~25,000, and
  maltoporin's three-fold trimer giving three interfaces equal to within 16 A2.
  Symmetry pairs report no area rather than a wrong one — the far side is a
  matrix, not atoms.

- **Predicted structures** — AlphaFold DB beside the PDB: searched through
  UniProt, loaded through the existing BinaryCIF path, with pLDDT in bands, the
  PAE matrix, and AlphaMissense.

  - **A prediction gets its own Definition panel.** Method, resolution,
    citation and validation do not exist for it; showing those fields empty
    would read as missing metadata rather than as a missing experiment.
  - **pLDDT in AlphaFold's four bands, not as a ramp.** The number is used as a
    threshold — above 90 trust the side chain, below 50 trust nothing — and a
    smooth gradient hides both lines.
  - **The PAE matrix is the point.** It is the only thing that shows two
    confidently folded domains placed relative to each other with no confidence
    at all, and dragging a diagonal block into a 3D selection is what makes it
    worth having beside the structure rather than on another website.
  - **File URLs come from the API, not from a template.** The database version
    is in every filename and it moves; the `_v4` URLs everyone copies are dead.

  It also turned up three bugs of my own: `focusSelection` failed silently on
  an invalid selection, and three separate callers had been emitting `127`
  where the grammar wants `:127`. It now returns whether it did anything and
  warns in dev, which is what would have made them visible the first time.

- **The four small gaps** — each unremarkable alone, and the set closes the
  ChimeraX comparison.

  - **A colour key**, which had to exist twice. The overlay is HTML over the
    canvas, so it is not part of the WebGPU surface a screenshot copies; both
    export paths already compose through a 2D context, so they paint their own
    copy from the same model. A legend that vanishes from the exported PNG is
    worse than none, since the figure it was explaining is the one that gets
    shared.
  - **Per-model interactive transforms.** The same drags act on the pane's
    scene transform instead of its camera. Rotation is about the structure's
    centre in its *current* placement, so drags compose without creep — 40
    mixed rotate and roll drags move the centre by 0.00003 A and the matrix
    stays orthonormal to six decimals, which matters because picking inverts it
    by transposing.
  - **Draggable labels.** Measurement labels already carried a pixel offset for
    the shader; what was missing was somewhere to keep it and a hit test that
    agrees with what is on screen. A label under the pointer takes the drag,
    because nudging one aside is a commoner intention than starting an orbit
    from exactly that pixel.
  - **A settable pivot** — moves what the camera turns about without moving the
    camera. Distinct from focusing, which also flies in; once you are looking
    at an active site, flying somewhere is exactly what you do not want.

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

Molecular dynamics trajectories. The formats alone are a zoo (DCD, XTC, TRR,
NetCDF), a useful trajectory is larger than anything the app loads today, and
the interesting questions about one — RMSF, clustering, occupancy over time —
are an analysis application rather than a viewer. The NMR ensemble path already
covers "several models of the same thing", which is the part that fits.

Modeller, dockprep, mutation, docking, and a Poisson-Boltzmann solve — these
need scientific backends there is no case for reimplementing in a viewer, and
the Coulombic approximation that is here is labelled as one. VR. And the full ChimeraX command surface: hundreds
of commands built over decades, and chasing it is mimicry rather than design.

A true solvent-excluded surface. The Gaussian surface that exists answers the
question people ask a surface — what shape does this present to the world — and
a rolling-probe SES would add re-entrant saddles at the cost of a much more
delicate algorithm.
