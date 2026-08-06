# MolView

**[molview.fly.dev](https://molview.fly.dev)**

![MolView with four panes open at once — haemoglobin, myoglobin, a phenylalanine tRNA and a B-DNA dodecamer — beside the component list on the left, the wwPDB validation summary on the right explaining why a 1984 model scores badly, and the assistant comparing all four below](docs/hero.png)

<sub>7A5R beside 4HHB — 15,387 atoms at 0.14 ms/frame. The definition panel
carries the wwPDB validation summary (83% of this 3.7 Å cryo-EM model's backbone
lies in the map), and the assistant answers in Markdown, reporting what the turn
cost in tokens.</sub>

A WebGPU molecular viewer for the RCSB Protein Data Bank. Browse and search the
PDB, and display up to four structures side by side — including macromolecular
assemblies of millions of atoms.

Everything runs in the browser. There is no server component: the deployment is
static files, and the app talks directly to RCSB's public endpoints, doing all
decoding, geometry generation and rendering on the client. Nothing you load or
save leaves your machine except the requests to RCSB itself.

Requires a WebGPU-capable browser (Chrome/Edge 113+, Safari 18+).

```bash
npm install
npm run dev
```

`npm run build` produces a static `dist/`, which is all a deployment is — see
[Deploying](#deploying) below.

## What it does

**Browse and search.** Full-text search across the PDB with filters for
experimental method, resolution, polymer content, source organism and release
date. Results are ranked by relevance, recency or resolution. Typing a
four-character PDB ID anywhere — the search box or the ⌘K palette — loads it
directly.

**A first view worth looking at.** A deposited coordinate frame is an accident
of the crystal, so MolView turns a structure to its own principal axes as it
loads — longest extent across the pane, thinnest towards the camera — and fits
it to the pane's real aspect rather than to a bounding sphere. `1BNA` arrives as
a double helix rather than as a circle seen down its axis, GroEL shows its two
stacked rings. Shapes too round for their axes to mean anything, capsids in
particular, are fitted but not turned. Reset view never re-orients: once you
have moved a structure, the camera is yours.

**O** re-orients a pane to those axes at any time, which is the way back after
turning a structure by hand — distinct from **R**, which returns to the
deposited frame and its arbitrary orientation. The ⌘K palette also offers views
straight down the X, Y and Z axes, for molecules with an axis of their own.

**Up to four structures at once.** Single, split (horizontal or vertical) or
quad layouts. Each pane has an independent camera, representation, colour
scheme and shading, or you can link the cameras so rotating one rotates all of
them — the usual way to compare two structures.

**Macromolecules.** Coordinates arrive as BinaryCIF, decoded in a worker so the
interface never blocks. The 2.44M-atom HIV-1 capsid (PDB `3J3Q`, a 113 MB
download) loads and renders in about ten seconds.

**Biological assemblies.** What a depositor deposits is the asymmetric unit,
which is frequently not the biological molecule. MolView reads
`pdbx_struct_assembly_gen` and applies the symmetry operators on the GPU, so
every assembly the file declares is one dropdown away and costs a list of
matrices rather than a copy of the atoms:

| Entry | Asymmetric unit | Assembly 1 | Cost |
| --- | --- | --- | --- |
| `1HHO` | 2 chains, 2.4k atoms | tetramer, 4 chains | 2 matrices |
| `1EI7` | 2 chains, 2.8k atoms | 68-chain disk aggregate | 34 matrices |
| `2BTV` | 15 chains, 49k atoms | 900-chain capsid, 2.9M atoms | 60 matrices |

Above roughly 70,000 atoms in view the default representation becomes spacefill
rather than cartoon: a ribbon is thinner than a pixel at that scale, and what
survives is dark noise costing millions of triangles. Compared side by side —
Photosystem I, the 26S proteasome, a CCMV capsid, the human ribosome — spheres
won every time.

2BTV's complete icosahedral capsid builds in ~1.6 s from a 2.4 MB download and
encodes a frame in 0.17 ms. Assembly 1 is selected automatically unless the
expansion would be extreme (icosahedral entries with thousands of copies stay
opt-in), and the asymmetric unit is always available as an explicit choice.

**Representations are composable.** A pane is an ordered list of *components* —
each one a selection plus how to draw it — applied like layers, so the last
component covering an atom wins. "Cartoon everywhere, spheres on chain A, sticks
at the haem" is three rows, not a special case. Styles are cartoon ribbons with
real secondary-structure cross-sections and β-strand arrowheads, backbone trace,
ball-and-stick, licorice and spacefill. Colour by chain, element, secondary
structure, residue type, B-factor/pLDDT, hydrophobicity, entity, nucleotide
base, or an N→C rainbow — per component or inherited from the pane.

Lone ions are drawn at half their van der Waals radius. At full size a 2.05 Å
manganese beside a 0.62 Å ribbon is the largest object in the scene, and in a
tRNA the magnesiums swamp the molecule they sit in.

Nucleic acid bases come in four styles. **Slab** fits a flat box in the base's
own ring plane, so a double helix reads as one rather than as two bare tubes.
**Ladder** joins Watson-Crick partners into a single rung — pairing is
geometric, a purine N1 within hydrogen-bonding distance of a pyrimidine N3 with
the ring planes side by side rather than stacked, which finds 12 of 12 pairs in
`1BNA` and 146 of the nucleosome's 147 in `1KX5`. **Stubs** reduces each base to
a rod, which is what stays readable on a ribosome. **None** leaves the bare
backbone. Anything unpaired keeps a stub under Ladder, so a single strand never
silently disappears. Colouring by nucleotide base puts purines warm and
pyrimidines cool, so a strand reads as its purine/pyrimidine pattern and the two
halves of a pair always contrast.

Assembly copies can be tinted by symmetry operator, which is what makes an
icosahedral capsid's facets and 5-fold vertices visible instead of
undifferentiated mush. Shading comes as named presets — Studio, Soft, Flat,
Plain — with the ambient-occlusion, shadow, outline and fog sliders still there
underneath.

**Shadows** are marched through the depth buffer along the key light rather than
rendered from a second camera: the pipeline lights once after rasterisation, and
a shadow map would mean drawing every pane's geometry again. Sixteen texture
loads per pixel buy the thing shadows are for here — telling a crevice from a
shallow dip, and telling which of two strands passes in front. The limitation is
inherent to the method: a caster that is off-screen or hidden behind something
else cannot cast, because the depth buffer has never seen it.

**NMR ensembles.** Every model at once as backbone traces, which is the usual
way to read the spread, or one at a time with the camera held still as you step
through them. Each model becomes its own chain, so ribbons never run from one
into the next, bond perception cannot join superposed models to each other, and
`model 3` selects a single member.

**Selections** use a compact atom-specification grammar:

| | |
| --- | --- |
| `/A,B` | chains, by auth id |
| `:1-140,200` | residues by sequence number |
| `:HEM` | residues by component name |
| `@CA,N,C,O` | atoms by name |
| `/A:1-140@CA` | all three, intersected |
| `model 3` | one member of an NMR ensemble |

Combined with `and` / `or` / `not`, parentheses, and category keywords —
`protein`, `nucleic`, `polymer`, `ligand`, `ion`, `water`, `hetero`, `helix`,
`sheet`, `coil`, `backbone`, `sidechain`, `hydrogen`, `heavy`. Juxtaposition
means intersection, so `protein /A` is `protein and /A`. A malformed expression
is reported inline and that layer is skipped; the rest of the scene still
renders.

**Measurements and contacts.** Distances, angles and torsions by clicking
atoms, with the value drawn in the viewport. Hydrogen bonds from a geometric
heavy-atom criterion, restricted to what is actually visible and recomputed
when the layers change. The haem Fe to proximal histidine NE2 in `4HHB`
measures 2.14 Å.

**Interfaces.** What touches what, which is the obvious question about an
assembly and the one a viewer usually leaves you to answer by eye. Heavy-atom
contacts within 4 Å are grouped by chain pair and ranked, and each pair can be
framed or drawn as its own component in one click. On `4HHB` it recovers the
architecture unprompted: the α1β1 pairs strongest, the α1β2 sliding interface
weaker, the α1α2 contact barely there.

**Symmetry copies count too**, which for an assembly is usually the whole point.
Ferritin's asymmetric unit is one chain and touches nothing at all; build the
24-mer and five interfaces appear, the strongest at 203 contacts. Only the
copies neighbouring the deposited coordinates are tested — in a symmetric
assembly every distinct interface already appears there, so a 60-copy capsid
costs 60 comparisons rather than 3,600. Bluetongue virus takes about 370 ms and
finds 33 lattice contacts on top of the 28 within its asymmetric unit. The far
side of such an interface is a matrix rather than a chain in the file, so only
the near side can be selected, and the panel says which side it is reporting.
It is still measured, though: the copy's spheres block the probe like any other
neighbour, and the far half of the area is taken on the congruent arrangement
the same operator's inverse produces, where both sides are real coordinates.
HIV-1 protease, whose biological dimer is made by a crystallographic 2-fold and
which therefore has no interface at all inside its asymmetric unit, comes out
at 1,614 Å².

Each pair also carries the area it buries — Shrake-Rupley SASA of the two
chains apart and together, reported as interface area (half the total change,
the convention PISA uses). Contacts rank the pairs; the area is what a paper
quotes, and the two disagree more often than you would expect, because a flat
patch and a knob in a socket can touch equally and bury very differently.
Haemoglobin comes out at 816–831 Å² for α1β1, 663–668 for α1β2 and 266 for
α1α2, against PISA's 830–870, and the whole tetramer's surface at 24,713 Å²
against a literature ~25,000. It is still a geometric criterion, not an
energetic one. A 237k-atom ribosome finds 244 pairs in about 300 ms; areas are
computed only for the pairs actually reported, since each is four SASA passes.

**Morphing between conformations.** With two structures superposed, the mobile
pane can be slid or played between its own conformation and the reference's,
along the alignment the fit already computed. Adenylate kinase open to closed
says in two seconds what its 7.13 Å RMSD cannot say at all. Identical chains
move together, so a homodimer does not appear to break in half. It is a
straight line through space and not a physical path — bonds stretch on the way
through and no barrier is respected — and the panel says so, because an
animation implies a mechanism whether or not one is claimed.

**Pockets.** Enclosed cavities, ranked by volume, by the LIGSITE buriedness
scan: a grid point counts as buried when protein lies on both sides of it along
at least four of seven axes, and connected buried points are a pocket. Each one
comes with the residues lining it, a ready-made selection, and any ligand
sitting in it.

That last column is the check on the method rather than a restatement of the
input, because ligands and waters are excluded from the grid before the scan.
Myoglobin's top cavity comes back at 410 Å&sup3; containing HEM, lined by Phe43, His64,
His97, Arg45 — the distal pocket, residue for residue. 1CBS puts retinoic acid
in its largest, 1EMA puts the GFP chromophore in the barrel. It measures
concavity, not affinity: a large pocket is not a druggable one.

**Overlay.** A pane can draw other panes' structures inside it, each keeping its
own superposition, so two folds land on top of each other in one viewport
rather than side by side.

**Superposition.** Align one pane onto another: sequence alignment decides
which residues correspond, then the paired Cα atoms are fitted and the outliers
pruned. Validated against known comparisons — 4HHB's identical alpha chains
0.30 Å, alpha vs beta 1.09 Å, alpha vs sperm whale myoglobin 1.07 Å.

The alignment it computes is shown rather than discarded: one cell per aligned
residue, coloured by how far the pair ended up apart after fitting, in sequence
order. An RMSD is an average, and an average of a bimodal distribution lies
about both halves — adenylate kinase open against closed reports 7.13 Å, and
the strip shows why: a rigid core in blue and a LID domain that has swung 18 Å,
which is the entire finding. Clicking a cell flies both panes to that pair.


**Shareable links.** The whole session compresses into the URL fragment — a
four-pane project including a 2.9M-atom capsid is about 1 kB of link. A fragment
never reaches a server, so the link discloses nothing in transit. Opening one
works both cold and pasted into a tab already running the app.

**Projects.** A session has a name, shown in the centre of the title bar and
renamed by clicking it; **New project** clears every pane back to defaults.
Save a session in the browser and reopen it later, or export it as
`.molview.json` to move between machines. Saving an already-saved project
updates it in place; **Save as new** branches it instead, so a session built on
an existing project does not overwrite its parent. Saving never downloads a file;
export is the only operation that touches the file system. Coordinates are not
stored — entries are referenced by PDB id and refetched, so a two-pane project
is about 2 KB.

**Assistant.** A panel beneath the canvas talks to any model on
[OpenRouter](https://openrouter.ai). It answers as a structural biologist would
— Markdown with GitHub tables and LaTeX equations — and it can drive the viewer:
loading entries, building representations from selections, measuring, colouring,
switching assemblies, superposing panes. Replies come back as one JSON object
carrying prose plus a list of actions; each action is re-validated against live
state before it runs, so a wrong chain id becomes a stated rejection rather than
a silent no-op. Twenty action types cover loading, layout, components, colour,
assemblies, focus, lighting, background, hydrogen bonds, measurement,
interfaces, nucleotide styles, camera views, superposition, overlay and
ensembles. Every one
is a reversible local view change, so they run without a confirmation step.
**Clear** discards the rolling history as well as the visible transcript, and
aborts a request in flight.

What the actions did comes back as a RESULTS message, and a turn is re-entered
once when it needs it. An action that asks a question — an interface search, a
measurement — returns its answer only after the model has already spoken, so
without a second pass the reply is "let me check" and the findings are left for
you to interpret. A rejected action gets the same treatment, told to correct it
or to say plainly that it cannot be done rather than describe it as done. Both
happen once, never twice: it is a correction, not a loop.

Where the model supports structured outputs — Claude and GPT do — the reply
shape is enforced by the API and the prompt does not restate the schema, which
is both cheaper and stricter. A toggle in Settings falls back to describing the
schema in the prompt, which is also what happens automatically for models that
cannot be constrained.

The API key is typed into Settings, held in that tab's `sessionStorage`, and sent
only to openrouter.ai — MolView has no server to send it to. It is never written
into a project or a shareable link.

Each reply is followed by its cost — `model · 1,340 in · 382 out`, with
reasoning tokens called out when the model bills for thinking it does not show.
A turn starts at about 1,300 input tokens; what grows it is the rolling history
of three exchanges, not the size of the structure, since the scene is counts and
chain names rather than coordinates. **Clear** is what resets it.

Search results carry the same judgement in one chip: the entry's weakest metric,
named and coloured together — `density 7.0%` in red, `clash 5.5` in amber. Two
cryo-EM models at the same resolution can differ fivefold in clashscore, and
resolution is the tiebreaker everyone reaches for, so it is worth seeing which
of a dozen entries for one protein is actually the better model before opening
it. Computed models have no wwPDB validation and get no chip.

**Validation.** The wwPDB validates the whole archive, and the definition panel
shows what it found: steric clashes, Ramachandran and rotamer outliers, fit to
density where structure factors were deposited, backbone coverage for cryo-EM.
Numbers rather than a grade — a green tick would invite the uncritical reading
this exists to prevent — with a dot for the judgement and a sentence only when
something is genuinely poor. A metric that could not be measured says why:
`4HHB` has no density fit because structure factors were not deposited in 1984.
It is worth knowing that the same entry, the classic haemoglobin, has a
clashscore of 142 where a modern structure at 1.74 Å sits near 2. The assistant
sees the summary too, so it will mention a weak model unprompted.

**Inspection.** Hover or click any atom for its residue, chain and atom name.
The sequence track is built from the loaded coordinates, so gaps in the model
appear as gaps and every residue you click actually exists in the scene. Where
a depositor left residues unmodelled the ribbon stops and a dashed Catmull-Rom
curve carries on to the next observed residue — the chain is continuous there,
the coordinates are not, and neither a solid ribbon nor a bare hole says that.
The disordered histone tails of `1KX5` are the case to look at. Chains
can be hidden or focused individually.

**Figures that explain themselves.** A colour key for the pane's scheme, drawn
over the canvas *and* painted into screenshots and recordings — a legend that
vanishes from the exported image is worse than none, since the export is the
one that gets shared. Measurement labels can be dragged out of the way of what
they measure. The camera's pivot can be moved onto whatever you are looking at
without flying there.

**Placing structures by hand.** Superposition computes a placement; a pane can
also be put into move mode, where the same drags turn and shift its structure
instead of its camera. That is for judging a placement by eye — pushing two
structures together to see whether a proposed contact is geometrically
possible at all.

**Turntable video.** Any pane records to a WebM clip of one or more full
revolutions. The camera is driven frame by frame rather than the screen being
captured in real time, so a structure that renders slowly costs a slow export
and still produces a smooth turn — and the clip is the length you asked for
rather than however long the export took.

**Clipping, set by eye.** A front and a rear plane, perpendicular to the view,
dragged on a small side-on schematic that shows where they sit relative to the
structure — which is the thing a pair of sliders labelled in Ångströms cannot
tell you. The pair defines a slab, so a section through a capsid stays a
section instead of becoming a silhouette against everything behind it. The
planes follow the camera, so rotating rotates the cut.

**Saturation and intensity.** Two sliders per pane adjust how strong the
colours are without changing the scheme itself — 1 is the scheme as authored, 0
saturation is greyscale, above 1 pushes further from grey. Both default to 2,
not 1: the schemes were authored to be *distinguishable*, and against a
near-black canvas with fog and ambient pulling everything towards the
background, "distinguishable" arrives looking washed out. They are applied to
the material colour in the resolve pass, before lighting, so they retune the
palette rather than the exposure and cost nothing: no geometry rebuild, and the
frame stays at 0.10 ms while you drag.

They are held at 1 when the colour-blind-safe palette is on, and the sliders
say so. Those eight colours are spaced so the closest pair survives
deuteranopia, and the composite clamps to 0..1: at 2, every fragment facing the
key light clips, and `#e69f00` and `#f0e442` come out identical under
simulation. Measured separation is 24–60 units across the lit range at 1, and
0.0 at 2. Strengthening a colour and preserving a distinction turn out to be
opposite operations.

They reach a molecular surface, because a chain-coloured envelope has to match
the cartoon inside it, and the colour key, because a legend that no longer
matches the picture is worse in an export than no legend. They deliberately do
*not* reach a density map: its blue, green and red identify which map and which
sign of the difference, and desaturating those would erase the distinction the
colours exist to make.

**Colour-blind-safe palette.** The default chain palette runs cyan, orange,
purple, green, pink — and the green/pink pair is the classic deuteranopia
collision, which makes a per-chain figure read as one colour to about eight per
cent of men. One toggle in Settings swaps in Okabe and Ito's eight colours,
which stay distinguishable. Eight rather than fourteen is the honest cost: a
structure with many chains repeats sooner.

**Take the view elsewhere.** The active pane exports as a PyMOL `.pml` or
ChimeraX `.cxc` script. Selections are recompiled from their parsed form rather
than string-substituted, so `not water` and nested parentheses survive into a
different grammar instead of quietly producing the wrong picture. What does not
transfer says so in a comment: the camera orientation, and MolView's per-residue
colour tables, which become the target's own nearest scheme rather than a
thousand colour commands.

**Finding structures from a structure.** The search box answers questions you
can phrase; two more services answer one you can only point at. **By shape**
compares the assembly on screen against every assembly in the archive — 4HHB
returns 1COH and 2HHB at the top, which is the right answer. **By sequence**
takes the longest chain and reports the identity of each hit, so 1CBS finds its
own family of retinoic-acid-binding proteins, including versions solved at
better resolution. The two disagree usefully: a hit in one and not the other is
generally the interesting one.

**Predicted structures.** AlphaFold DB alongside the PDB, searched by protein
name, gene or UniProt accession. A prediction gets its own Definition panel,
because the fields the experimental one is built from — method, resolution,
citation, validation — do not exist for it, and showing them empty would
suggest the model merely lacks metadata rather than lacking an experiment.
What it has instead is confidence, of two kinds:

- **pLDDT**, per residue, read in AlphaFold's own four bands at 90/70/50 rather
  than as a smooth ramp. The bands are how the number is actually used, and a
  gradient hides exactly the two lines that matter.
- **PAE**, the predicted error between every *pair* of residues, as a matrix
  beside the structure. This is the one people skip, and it answers what pLDDT
  cannot: two domains can each be confidently folded and still be placed
  relative to each other with no confidence at all. Calmodulin is the case to
  look at — two dark blocks on the diagonal, a pale everything else. Drag
  across a block to focus those residues in the pane.

**AlphaMissense** rides along where it exists: a predicted pathogenicity for
every possible substitution, averaged per residue, as a colour scheme. It says
where a mutation would matter, which is a different question from where the
model is confident — p53 shows it plainly, with the DNA-binding domain scored
pathogenic and the disordered tails benign.

**A command line.** A line beginning with `/` in the assistant's composer runs
as commands rather than going to a model — the same twenty-seven verbs the
assistant has, executed by the same function, so a second vocabulary cannot
drift from the first. Several at once, separated by newlines or semicolons:

```
/load 4HHB; /color chain; /view orient; /clip slab 25
```

It needs no API key and no account, which is half the point: the app is
drivable by typing whether or not you have an assistant. `/help` prints the
vocabulary, and an unrecognised verb suggests the nearest one.

**What the residues are for.** Everything else here is geometry; this is
function. UniProt's positioned annotations — active and binding sites, modified
residues, motifs, domains, mutagenesis results, natural variants — landed on the
residues of the loaded entry, each with a selection so it can be framed or drawn
rather than merely read.

The difficulty is entirely in the numbering, and it is a three-step chain:
UniProt position → entity sequence position via `rcsb_polymer_entity_align` →
`auth_seq_id` via `auth_to_entity_poly_seq_mapping` → a residue in the pane.
Skipping the first step is the classic error and it fails silently. `1CBS` is
offset by one, and doing it properly puts its binding site on Arg132 and Tyr134
— 2.7 and 2.6 Å from the carboxylate of the retinoic acid, which is what those
residues are there for. `101M`'s "proximal binding residue" comes out as His93,
whose NE2 sits 2.20 Å from the haem iron: the coordination bond itself.

**Validation, per residue.** The entry summary says "9.5% rotamer outliers";
two colour schemes say *which* residues. **Fit to density (RSRZ)** shows how
badly each residue matches its own experimental density, and **Geometry
outliers** counts clashes and bond, angle and stereochemistry faults together.
Both ramps are anchored to fixed thresholds rather than to each entry's range,
so the same colour means the same thing in two structures, and the legend says
where the thresholds are. A ranked list of the worst residues sits under it;
clicking one flies there. Paired with the density map this is the whole loop —
colour by fit, find the worst residue, look at the evidence under it.

**Molecular surfaces.** The envelope a molecule presents to the solvent, as a
Gaussian surface over the atoms currently drawn or over any selection, blended
so the cartoon stays visible through it. It carries the pane's colour scheme, so
a haemoglobin surface shows where its four subunits meet rather than being one
undifferentiated blob. It is a Gaussian surface, not a solvent-excluded one:
there is no rolling probe, so the re-entrant saddles of a true SES are absent
and the overall envelope is the same.

**Coulombic colouring.** A molecular surface can be coloured by electrostatic
potential — red negative, blue positive — from formal charges on the ionisable
side chains, the termini, the nucleic acid phosphates and the ions, with a
distance-dependent dielectric. The nucleosome is the check: its histone core
comes out overwhelmingly blue with the H2A/H2B acidic patch showing as a red
spot, and the charge model totals −292 for `1KX5`'s DNA, which is exactly its
292 phosphates, against about +120 for the octamer.

It is called Coulombic rather than "electrostatics" for a reason. There is no
Poisson-Boltzmann solve, no solvent screening and no ionic strength; it is
read for gross character — which face is acidic, which groove binds DNA — and
not for a number.

**Experimental density.** A model is an interpretation of an experiment, and
MolView will show you the experiment. The Panes tool fetches the deposited map
for the pane — 2Fo-Fc and Fo-Fc for X-ray entries, the EMDB map for cryo-EM —
and contours it around the model. Contours are quoted in sigma, because that is
the unit the argument is conducted in.

The default presentation is chicken wire, which is what a crystallographer
reads a map in and is also the only see-through surface a deferred renderer
gets for free; a blended solid surface is one toggle away. The difference map
is off until asked for and then appears as both lobes at once, green where the
data want atoms the model does not have and red where the model has atoms the
data do not support — reading only the green half is the classic way to talk
yourself into a ligand that is not there.

The map is fetched as a box around the model rather than as a whole unit cell,
so the server applies the spacegroup and the density arrives where the molecule
is. Density is then masked to within a few Ångströms of the atoms actually
drawn, because an X-ray box contains the crystal packing too. Entries with no
map say why: `4HHB` was deposited in 1984 without structure factors, which is
the same fact the validation panel reports as a missing density fit.

**Local files.** Drop an mmCIF or BinaryCIF file onto a pane, or open one from
the Panes tool. Nothing is uploaded.

## RCSB endpoints

| Purpose | Endpoint |
| --- | --- |
| Molecular definitions and metadata | `data.rcsb.org/graphql` |
| Search | `search.rcsb.org/rcsbsearch/v2/query` |
| Coordinates (BinaryCIF) | `models.rcsb.org/{id}.bcif` |
| Coordinates (mmCIF fallback) | `files.rcsb.org/download/{ID}.cif` |
| Density maps (BinaryCIF) | `maps.rcsb.org/{x-ray\|em}/{id}/box/...` |
| Shape and sequence similarity | the Search API's `structure` and `sequence` services |

Predicted structures come from two more, both CORS-open:

| Purpose | Endpoint |
| --- | --- |
| Predicted models, PAE, AlphaMissense | `alphafold.ebi.ac.uk/api/prediction/{accession}` |
| Name and gene to accession | `rest.uniprot.org/uniprotkb/search` |

AlphaFold is keyed by UniProt accession and nothing else, which is why the
UniProt lookup exists. File URLs are taken from the API response rather than
composed: the database version is in every filename and it moves — the widely
copied `_v4` URLs are already dead.

Per-residue validation comes from the same GraphQL endpoint, as polymer
*instance features* rather than as a validation category — `RSRZ`, `RSCC` and
`OWAB` as arrays along the entity sequence, faults as one position per residue.
They are numbered in entity sequence, so `auth_to_entity_poly_seq_mapping`
converts before anything is coloured.

Search returns identifiers only; a single batched GraphQL query then fetches the
definition for a whole page of hits.

## Architecture

```
src/
  rcsb/        GraphQL + Search clients, MessagePack, BinaryCIF, mmCIF text
               parser, wwPDB validation summary, density maps
  mol/         Structure model, element data, bond perception, colour schemes,
               selections, components, measurements, alignment, chain contacts,
               loading worker
  gfx/         WebGPU engine, camera, geometry generation, WGSL shaders, text,
               first-view orientation, marching-cubes isosurfaces
  ai/          Action vocabulary and executor, prompt, OpenRouter client,
               reply parser, Markdown/KaTeX renderer
  viewer/      Controller bridging React state to GPU resources
  ui/          Application shell, panels, command palette, assistant
  state/       Zustand store, project serialisation, IndexedDB, share links
```

**The structure model** is structure-of-arrays: flat typed arrays for
coordinates, elements, residues and chains, with atom and residue names interned
into a shared string table. Loading happens in a worker and the whole model is
transferred back zero-copy.

**Rendering** is deferred. Atoms are ray-traced sphere impostors — four vertices
each, exact silhouettes and exact depth from the fragment shader — which is what
makes millions of atoms tractable. Bonds are instanced cylinder meshes. Cartoons
are a generated triangle mesh, swept along a Catmull-Rom spline through the Cα
trace using Carson–Bugg peptide-plane frames, with cross-sections that vary by
secondary structure.

Instance data lives in **storage buffers rather than vertex buffers**, which is
what makes assemblies nearly free: a draw issues `instanceCount x transformCount`
instances and the shader recovers `atom = i % n`, `copy = i / n`. A scene is a
list of groups — one per assembly generator, since generators replicate
different chain subsets — each holding its geometry once plus the matrices it
repeats under.

All four panes render into one G-buffer via viewport and scissor rectangles,
then a single resolve pass applies screen-space ambient occlusion, three-point
lighting, depth-discontinuity outlines and fog. Because shading happens once,
after rasterisation, an impostor sphere and a ribbon are lit identically and
read as parts of the same object.

Occlusion radius, outline thresholds and fog density are normalised against
scene size, so the same settings look the same on a 20 Å ligand and a 1000 Å
capsid.

**Labels** are a separate pass after the resolve, blended straight onto the
swap chain so they never touch the G-buffer. The font atlas is rasterised at
runtime with Canvas 2D — no font ships, and the metrics match whatever
monospace face the platform actually has. An opaque block reserved in the atlas
lets the background pills go through the same pipeline as the glyphs.

**Assistant replies** are rendered with `marked` + KaTeX + DOMPurify. Two
orderings matter: math is lifted out before Markdown parsing, because emphasis
rules will otherwise chew through `\frac{a}{b}`; and KaTeX runs *after*
sanitisation, writing into the already-cleaned DOM, since sanitising KaTeX's own
output would strip the markup it depends on. Model HTML is dropped and non-http
links are defanged. The whole renderer is dynamically imported, keeping KaTeX's
330 kB out of the initial bundle.

## Interaction

| | |
| --- | --- |
| Rotate | drag |
| Pan | shift-drag, or middle/right drag |
| Roll | alt-drag |
| Zoom | wheel |
| Focus a residue | double-click |
| Select | click |
| Command palette | ⌘K |
| Search | ⌘F |
| Panes 1–4 | `1` `2` `3` `4` |
| Reset view | `R` |
| Orient to the structure's axes | `O` |
| Auto-rotate | `S` |
| Link cameras | `L` |
| Toggle panels | `[` `]` |

## Known limits

- Secondary structure comes from the file's `struct_conf` / `struct_sheet_range`
  records. When a file carries none, a Cα-geometry heuristic stands in; it is
  not DSSP and will differ at the edges of helices and strands.
- Only the dominant alternate conformation is read; altloc B and beyond are
  discarded.
- Whole-structure bond perception is skipped above 250,000 atoms, so
  ball-and-stick on very large structures falls back to ligand connectivity.
  Cartoon and spacefill are unaffected.
- Picking is a linear scan over atom centres, repeated for each assembly copy
  whose bounding sphere the ray crosses; the hover interval widens with scene
  size to keep the cost off the frame budget.
- Secondary structure, hydrogen bonds and superposition are geometric
  approximations, not DSSP, an energetic H-bond analysis, or a structure-based
  aligner. They are good enough to look at and to reason from; they are not
  what you would cite.
- A pane opened from a local file has no id to refetch, so a project must embed
  its bytes to restore it. That is an opt-in, capped at 25 MB per file, and
  never included in a shareable link.
- Transparency is not depth-sorted. Isosurfaces are drawn back faces first and
  then front faces, which is the right order for one closed surface and enough
  for almost everything; two separate transparent surfaces in front of each
  other still blend in the order they were submitted.
- Molecular surfaces are Gaussian, not solvent-excluded: no rolling probe, so
  no re-entrant saddles.
- Recording produces WebM, the only format browsers encode natively, and the
  pane has to stay visible while it runs.
- The production Content-Security-Policy pins `connect-src` to an explicit host
  list, so an endpoint added without updating `security-headers.conf` works in
  development and is blocked once deployed. `npm run check:csp` diffs the source
  against that list and runs as part of `npm run build`.
- Dragged label positions last for the session. A saved project restores its
  measurements by atom reference and gives them new ids, so the offsets have
  nothing to reattach to.
- Surfaces and density contours are generated on the CPU, so building one costs
  a stall — a fifth of a second for a small protein, a couple of seconds for a
  nucleosome — and it blocks the frame while it runs.
- A density map's opening contour is chosen against a triangle budget rather
  than fixed, so a map never arrives half-drawn; the level it settles on is the
  one the panel reports, and it is never lower than the one asked for.
- Symmetry contacts are found only around the deposited copy — enough to see
  every distinct interface in a symmetric assembly, not a per-copy census.
- The symmetry copies are the *assembly's* operators, not the crystal lattice.
  A dimer generated by a 2-fold is found and measured; the neighbours a monomer
  packs against in the crystal are not built at all, so MolView cannot yet tell
  crystal packing from a biological interface. The cell and space group are in
  the file, but RCSB does not ship the symmetry operators with the
  coordinates, so generating the lattice needs a space-group operator table
  that does not exist here yet.
- The assistant is only as good as the model behind it. Models that cannot be
  held to the reply schema mostly cope, since the shape is described in the
  prompt and fenced JSON is unwrapped, but a small one will emit prose where an
  action was wanted and may describe a change it failed to make. The rejection
  notices below a reply are the record of what actually happened.

## Deploying

The repo carries a [fly.io](https://fly.io) configuration. There is no server
component, so a deployment is a Vite build served by nginx: no secrets, no
environment variables, no volumes, no database.

Install [flyctl](https://fly.io/docs/flyctl/install/) and sign in:

```bash
fly auth login
```

Claim the app name — this reserves it and starts nothing, so it costs nothing:

```bash
fly apps create molview
```

If the name is taken it fails immediately; pick another and change `app` in
[fly.toml](fly.toml) to match. Then, from the repo root:

```bash
fly deploy
```

That builds the Dockerfile on Fly's remote builder — Docker does not need to be
running locally — and starts one machine. Every later deploy is the same
command. The app is then at `https://<app>.fly.dev`.

**HTTPS is mandatory, not a preference:** WebGPU requires a secure context, so
the app does not start over plain http. `force_https` in `fly.toml` covers it.

The machine sleeps when idle (`auto_stop_machines = 'suspend'` with
`min_machines_running = 0`), so an unvisited deployment costs nothing and the
first request after an idle period pays about a second of wake-up. Set
`min_machines_running = 1` if that matters.

To check the image locally before deploying:

```bash
docker build -t molview:test . && docker run --rm -p 8099:80 molview:test
```

The files involved are `Dockerfile`, `nginx.conf`, `security-headers.conf`,
`fly.toml` and `.dockerignore`. [DEPLOY.md](DEPLOY.md) explains what each one
assumes — caching, the Content Security Policy and the hosts it allows, and why
the token cost of the assistant is the only cost that scales.

## Contributions

**Pull requests are closed automatically.** MolView is a personal project, so
this is not a judgement on any particular change — nothing gets merged, and a PR
left open would only waste the time of whoever wrote it. Fork it and take it
where you like.

Issues are a different matter: a bug report, or a structure that renders wrong,
is genuinely useful and gets read.

## Licence

[MIT](LICENSE). The dependencies are all permissive too — MIT, ISC, and
DOMPurify under your choice of MPL-2.0 or Apache-2.0 — so a fork carries no
copyleft obligation. Structures come from the RCSB PDB, whose data is in the
public domain; MolView neither redistributes nor caches it.
