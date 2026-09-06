# Scientific investigations

The new workflows use existing public RCSB, UniProt and AlphaFold access. No
backend, paid data subscription or AI service is required for these workflows.

## Entry points

- **Investigate → Choose:** select the query polymer entity, search close
  sequence matches with 24/48/96 entity hits per page, load more, retry failed details, prioritize deposited metadata and filter by a ligand ID. Identity cutoffs are 90%, 70% or 50%.
  Candidate details show organisms, sequences, ligands/ions and quality metrics.
  Load a candidate into the current or an empty comparison pane. The loaded
  construct can be checked by author residue number (including insertion code).
- **Investigate → Compare:** align two panes with explicit chain choices.
  The report includes sequence differences, unmatched anchors, excluded pairs,
  largest displacements and experimental/assembly context. Ligand-contact and
  interface computations are explicit, cancellable operations. Choose two interfaces and their side pairing to compare aligned contacting positions and export the correspondence.
- **Evidence:** select a residue in 3D or Sequence. Its card is also in the right
  inspector. Public annotations and validation load on demand; neighbours are
  calculated in a worker. Correspondence links appear for the mobile chain of
  an alignment.
- **Guides:** five short investigations load named public examples. Loading an
  example replaces the named pane and uses an empty pane when a pair is needed.
- **Settings:** light/dark chrome, larger text, panel widths and diagnostics.
  Apply the theme background explicitly to change the scene's canvas colours.

## Reproducibility

Comparison JSON records PDB/model identifiers, chain and assembly choices,
per-residue alignment, RMSD, summary metrics and limitations. Contact JSON records
ligand instances, assembly choices, contact/interface results and residue labels.
Projects save alignment chain choices; reopening recomputes the correspondence
from the public coordinates. Public archive revisions can therefore change a
future result; JSON exports preserve the numerical snapshot.

## Interpretation limits

- Candidate priorities and ligand filtering apply to fetched entries, not the entire archive. Pagination counts raw polymer-entity hits; duplicate entries are merged. Prioritization is a visible
  ordering of metadata, not a validated structure-quality score. Ligands and ions
  are reported as deposited; the app does not infer whether a compound is an
  experimental buffer, a physiological ligand or an inhibitor.
- Loaded coverage is against the deposited entity sequence, not the full UniProt
  protein. Alignment coverage is against coordinate-bearing anchors. Neither
  metric alone establishes a complete biologically relevant construct.
- Sequence differences are differences between aligned modelled residues. They
  do not establish why a sequence differs, or predict the effect of a substitution.
- Distances, contact categories, interfaces and morphing use the existing
  geometric algorithms. Contact counts are not binding energies. Assembly reports
  cover the neighbourhood of the deposited copy; ligand contacts exclude crystal
  symmetry partners. Interface correspondence uses an explicit user-selected side pairing. It compares sequence-aligned contacting positions, not conserved atom pairs or automatically inferred biological equivalence. Unmapped contacts are counted separately. Symmetry-partner focus shows source coordinates.
- One alternate is drawn per residue. Occupancy-based choice uses mean known
  atom occupancy for each alternate; it is not refinement. Unknown occupancy is
  preserved as NaN and treated as one only in the approximate density calculation.
  Zero-occupancy atoms remain excluded. Per-residue manual mixing is not provided.
- External residues are resolved by archive label chain and entity position. Insertion codes and repeated author numbers are retained; model copies share instance-level validation. Missing archive positions remain unavailable. Absence of an annotation or density score is not
  evidence of a normal or unimportant residue.
- Density correlation remains approximate after [recalibration](density-calibration.md). The additional structures show weaker agreement. Do not compare it with published RSCC thresholds.
- Analysis workers copy inputs and consume extra memory. WebGPU is still required.

## Validation

Run `npm test` and `npm run build`. The offline tests include public 1CBS data and
synthetic edge cases. Browser smoke checks should cover public candidate retrieval,
paired alignment, linked residue focus, annotations, contact workers, surface and
density generation/cancellation, theme controls, and saved-project restoration.

A live public mapping check on 1IGT retained validation for all 16 inserted
polymer residues and verified four annotation selections against archive positions.
Reproduce with `npm run check:public-mapping`; the recorded result is in
[public-mapping-check.json](public-mapping-check.json). Offline regression tests
also exercise duplicated author identifiers, accession-specific UniProt alignment,
pagination offsets and interface-side correspondence. Archive-position selections
use `labelchain` and `labelseq`; author-number exports resolve them against the
loaded coordinates and omit selections the target cannot distinguish.
