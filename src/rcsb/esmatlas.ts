/**
 * The ESM Metagenomic Atlas.
 *
 * AlphaFold DB covers UniProt: proteins from organisms somebody has named. The
 * ESM Atlas covers MGnify, which is metagenomic — sequence read straight out of
 * soil, seawater and gut samples, where the source organism was frequently
 * never cultured and often is not known at all. That is the whole reason to
 * have it. It is not the more accurate of the two: ESMFold folds from a single
 * sequence with no multiple alignment, which is what made 617 million
 * predictions tractable and also what puts it below AlphaFold2 on the same
 * sequence.
 *
 * It could not be reached before the PDB reader existed, because it serves
 * legacy PDB rather than BinaryCIF. It also cannot be reached through the
 * existing predicted-structure path, which goes UniProt search -> accession:
 * an MGnify accession is not a UniProt one and no amount of searching UniProt
 * will produce it. Hence a second entry point rather than a new result type.
 */

import type { PaeMatrix } from './alphafold';

const ESM_API = 'https://api.esmatlas.com';

/**
 * MGnify protein accessions are `MGYP` followed by twelve digits. Recognising
 * them is what lets one input box serve both databases without asking the user
 * which they meant.
 */
const MGNIFY_ACCESSION = /^MGYP\d{12}$/i;

export function isMgnifyAccession(text: string): boolean {
  return MGNIFY_ACCESSION.test(text.trim());
}

export interface EsmPrediction {
  accession: string;
  /** Legacy PDB, which is why this needed the reader first. */
  structureUrl: string;
  paeUrl: string;
}

export function esmPrediction(accession: string): EsmPrediction {
  const id = accession.trim().toUpperCase();
  return {
    accession: id,
    structureUrl: `${ESM_API}/fetchPredictedStructure/${id}`,
    paeUrl: `${ESM_API}/fetchConfidencePrediction/${id}`,
  };
}

/**
 * Confirms the accession exists before a pane is committed to it.
 *
 * The load path fetches the coordinates in a worker, where a 404 surfaces as a
 * parse failure with nothing useful to say. One request here turns that into a
 * sentence naming the accession.
 */
export async function checkEsmAccession(
  accession: string, signal?: AbortSignal,
): Promise<void> {
  const { structureUrl, accession: id } = esmPrediction(accession);
  const res = await fetch(structureUrl, { signal });
  if (res.status === 404) {
    throw new Error(
      `The ESM Atlas has no model for ${id}. It takes an MGnify protein `
      + 'accession, which looks like MGYP000911143359.',
    );
  }
  if (!res.ok) throw new Error(`ESM Atlas ${res.status} ${res.statusText}`);
}

/**
 * ESMFold's predicted aligned error.
 *
 * The same quantity AlphaFold publishes and the same panel draws it, but the
 * document is shaped differently — a bare `pae` matrix rather than
 * `predicted_aligned_error` — and it carries no stated maximum, so the scale
 * comes from the values themselves.
 */
export async function fetchEsmPae(
  url: string, signal?: AbortSignal,
): Promise<PaeMatrix> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`PAE ${res.status} ${res.statusText}`);
  const json = await res.json() as { pae?: number[][] };
  const rows = json?.pae;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The ESM Atlas returned no PAE matrix.');
  }

  const size = rows.length;
  const values = new Float32Array(size * size);
  let max = 0;
  for (let i = 0; i < size; i++) {
    const row = rows[i];
    for (let j = 0; j < size; j++) {
      const v = row[j];
      values[i * size + j] = v;
      if (v > max) max = v;
    }
  }
  return { size, values, max: max || 31.75 };
}
