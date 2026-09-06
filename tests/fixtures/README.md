# Scientific regression fixtures

`1CBS.cif` was downloaded on 2026-09-06 from
https://files.rcsb.org/download/1CBS.cif (RCSB PDB public archive).
It contains the deposited retinoic-acid-binding protein II structure and its
retinoic acid ligand. The fixture is used offline: tests do not query any service.

Primary reference: Kleywegt et al., Structure (1994),
https://doi.org/10.1016/S0969-2126(94)00125-1.

Small synthetic mmCIF cases in `science.test.ts` isolate occupancy, insertion
codes, and NMR-model identity. They are software test inputs, not experimental
observations.
