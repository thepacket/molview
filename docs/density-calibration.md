# Density-score recalibration

The occupancy-weighted calculation retains the **1.8 Å envelope**. On the four
original calibration entries, that radius has the highest mean per-entry Pearson
correlation in the tested sweep. This is a parameter check, **not validation of a
universal quality score**. Agreement drops substantially on the additional entries.

## Results at the retained radius

The comparison is against public RCSB per-residue wwPDB RSCC, mapped by archive
chain and entity sequence position. Bias is MolView minus deposited RSCC.

| Entry | Set | Residues | Pearson r | Mean bias | Change in r from occupancy weighting |
|---|---|---:|---:|---:|---:|
| 1UBQ | training | 76 | 0.714 | -0.211 | -0.000 |
| 1CBS | training | 137 | 0.719 | -0.232 | +0.000 |
| 3PTB | training | 223 | 0.504 | -0.220 | +0.000 |
| 2HHB | training | 574 | 0.557 | -0.248 | +0.000 |
| 1AKE | held-out | 428 | 0.094 | -0.714 | +0.001 |
| 1HEL | held-out | 129 | 0.599 | -0.245 | +0.000 |
| 1EJG | held-out | 46 | 0.431 | -0.213 | +0.033 |
| 2FR3 | held-out | 137 | 0.559 | -0.248 | +0.014 |
| 3LZT | held-out | 129 | 0.447 | -0.152 | +0.042 |

Mean per-entry r is **0.624** on the original four entries and **0.426** on the
five additional entries. Pooling residues instead gives **0.532** and **0.351**;
these are different statistics and must not be interchanged. Occupancy weighting
increases mean r on the additional entries from 0.408 to 0.426. It does not change
the original four: those polymer residues have no relative within-residue
occupancy differences that affect the correlation. A uniform multiplicative
weight cancels from a Pearson correlation.

**1AKE is an unresolved outlier**, retained in every aggregate. Its r is 0.094,
with bias −0.714. Mean map density at protein heavy atoms is only 0.58 sigma,
compared with −0.05 for coordinates displaced +7 Å along all three axes. Other
successful entries have mean atom density 2.74–6.82 sigma. The grid-axis handling
was checked against the [Mol* DensityServer reader](https://github.com/molstar/molstar/blob/master/src/mol-model-formats/volume/density-server.ts).
These checks do not identify the cause of the weak agreement; neither the map
nor the score was adjusted to make this case fit. Even ranking within an entry
requires inspecting the map and corroborating evidence.

1BRS was attempted but returned no usable map. 2FR3 initially failed to fetch,
then succeeded on retry. Missing data are not scored as zero. 2FR3 and 3LZT were
added to extend the additional set after unavailable-map responses; this is a
small convenience sample, not a preregistered or archive-representative study.

## Reproduce

Run `npm run calibrate:density`. Set `MOLVIEW_CALIBRATION_CACHE` to choose the raw
response cache directory (default `.cache/density-calibration`). Set
`MOLVIEW_OFFLINE=1` to replay cached responses without network access. Delete the
cache to refresh public data. The script records exact URLs, GraphQL request
bodies, retrieval timestamps and SHA-256 hashes in
[density-calibration.json](density-calibration.json), along with each paired
residue score, grid dimensions, controls and all sweep results.

The sweep uses radii 1.4, 1.6, 1.8, 2.0 and 2.5 Å; minimum 30 grid points;
VolumeServer detail 4; a 6 Å padded coordinate box; deposited resolution;
protein residues with finite scores in both sources. Baseline and weighted
runs use identical selected coordinates, isolating occupancy weighting from
conformer selection. This does not assess errors from omitting other alternates.

No change of default radius or rescaling of scores was justified. The app labels
the calculation as approximate and does not interpret a numerical cutoff as
"good". Gaussian model density, sampled maps and the small tested corpus limit
transfer to other structures, ligands and experimental methods.
