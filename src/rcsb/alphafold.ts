/**
 * AlphaFold DB, and the UniProt lookup that reaches it.
 *
 * The archive is now the smaller half of what people look at: AlphaFold covers
 * over two hundred million sequences against the PDB's quarter of a million.
 * The load path is almost free — the models are BinaryCIF, which `bcif.ts`
 * already decodes — so what this module is really for is the three things that
 * come with a prediction and have no equivalent in an experimental entry:
 *
 * - **pLDDT**, per residue, in the B-factor column. Read in bands at 90/70/50,
 *   not as a continuous ramp.
 * - **PAE**, the predicted aligned error between every pair of residues. This
 *   is the one with no analogue anywhere else in the app, and it answers the
 *   question pLDDT cannot: two domains can each be confidently folded and still
 *   be placed relative to each other with no confidence at all.
 * - **AlphaMissense**, a pathogenicity score for every possible substitution.
 *
 * The prediction endpoint takes a UniProt accession and nothing else — not a
 * gene name, not a protein name — so the search below exists to get one.
 */

const ALPHAFOLD_API = 'https://alphafold.ebi.ac.uk/api/prediction';
const UNIPROT_SEARCH = 'https://rest.uniprot.org/uniprotkb/search';

export interface UniProtHit {
  accession: string;
  /** The mnemonic, like HBA_HUMAN. */
  id: string;
  name: string;
  gene: string | null;
  organism: string | null;
  length: number;
}

export interface Prediction {
  accession: string;
  uniprotId: string;
  description: string;
  gene: string | null;
  organism: string | null;
  /** Mean pLDDT over the model, as AlphaFold reports it. */
  meanPlddt: number;
  sequence: string;
  bcifUrl: string;
  paeUrl: string | null;
  alphaMissenseUrl: string | null;
  version: number;
}

export class NoPredictionError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * UniProt entries matching free text, or the entry for an accession typed
 * directly. Reviewed entries first: an unreviewed hit is usually a fragment or
 * an automatic annotation of the same protein, and burying the reviewed one
 * under six of them makes the search look broken.
 */
export async function searchUniProt(
  query: string,
  signal?: AbortSignal,
): Promise<UniProtHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const accession = /^[A-NR-Z][0-9][A-Z0-9]{3}[0-9]$|^[OPQ][0-9][A-Z0-9]{3}[0-9]$/i;
  const q = accession.test(trimmed) ? `accession:${trimmed}` : trimmed;

  const url = `${UNIPROT_SEARCH}?query=${encodeURIComponent(q)}`
    + '&fields=accession,id,protein_name,gene_names,organism_name,length'
    + '&size=25&format=json';
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`UniProt search ${res.status} ${res.statusText}`);
  const json = await res.json();

  const hits: UniProtHit[] = (json.results ?? []).map((r: any) => ({
    accession: r.primaryAccession,
    id: r.uniProtkbId,
    name: r.proteinDescription?.recommendedName?.fullName?.value
      ?? r.proteinDescription?.submissionNames?.[0]?.fullName?.value
      ?? 'Unnamed protein',
    gene: r.genes?.[0]?.geneName?.value ?? null,
    organism: r.organism?.scientificName ?? null,
    length: r.sequence?.length ?? 0,
  }));

  return hits.sort((a, b) => Number(b.id.includes('_')) - Number(a.id.includes('_')));
}

/**
 * The AlphaFold entry for an accession. Returns the file URLs the API itself
 * reports rather than composing them: the database version is in every
 * filename and it moves — the widely copied `_v4` URLs are already dead.
 */
export async function fetchPrediction(
  accession: string,
  signal?: AbortSignal,
): Promise<Prediction> {
  const res = await fetch(`${ALPHAFOLD_API}/${accession.toUpperCase()}`, { signal });
  if (res.status === 404 || res.status === 400) {
    throw new NoPredictionError(
      `AlphaFold has no model for ${accession.toUpperCase()}. `
      + 'It takes a UniProt accession — search by name to find one.',
    );
  }
  if (!res.ok) throw new Error(`AlphaFold ${res.status} ${res.statusText}`);

  const list = await res.json();
  const entry = Array.isArray(list) ? list[0] : list;
  if (!entry?.bcifUrl) throw new NoPredictionError(`No model returned for ${accession}.`);

  return {
    accession: entry.uniprotAccession ?? accession.toUpperCase(),
    uniprotId: entry.uniprotId ?? '',
    description: entry.uniprotDescription ?? 'Predicted structure',
    gene: entry.gene ?? null,
    organism: entry.organismScientificName ?? null,
    meanPlddt: entry.globalMetricValue ?? Number.NaN,
    sequence: entry.sequence ?? '',
    bcifUrl: entry.bcifUrl,
    paeUrl: entry.paeDocUrl ?? null,
    alphaMissenseUrl: entry.amAnnotationsUrl ?? null,
    version: entry.latestVersion ?? 0,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PaeMatrix {
  /** Residues per side. */
  size: number;
  /** Row-major, `size * size` values in Ångströms. */
  values: Float32Array;
  max: number;
}

export async function fetchPae(url: string, signal?: AbortSignal): Promise<PaeMatrix> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`PAE ${res.status} ${res.statusText}`);
  const json = await res.json();
  const entry = Array.isArray(json) ? json[0] : json;
  const rows: number[][] = entry?.predicted_aligned_error;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('The PAE file had no matrix in it.');
  }

  const size = rows.length;
  const values = new Float32Array(size * size);
  for (let i = 0; i < size; i++) {
    const row = rows[i];
    for (let j = 0; j < size; j++) values[i * size + j] = row[j];
  }
  return { size, values, max: entry.max_predicted_aligned_error ?? 31.75 };
}

/**
 * AlphaMissense, averaged over the substitutions at each position.
 *
 * The file scores every possible substitution — nineteen rows per residue —
 * and a per-residue mean is the only thing a colour scheme can show. It is a
 * real simplification: a position where one substitution is catastrophic and
 * eighteen are tolerated averages to something unremarkable. What the mean
 * does say, and says well, is how constrained a position is overall, which is
 * the question a structure is being asked when it is coloured at all.
 */
export async function fetchAlphaMissense(
  url: string,
  length: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`AlphaMissense ${res.status} ${res.statusText}`);
  const text = await res.text();

  const sums = new Float64Array(length + 1);
  const counts = new Uint32Array(length + 1);

  for (const line of text.split('\n')) {
    // protein_variant,am_pathogenicity,am_class — e.g. "M1A,0.4454,Amb"
    const comma = line.indexOf(',');
    if (comma < 2) continue;
    const variant = line.slice(0, comma);
    const position = Number.parseInt(variant.slice(1, -1), 10);
    if (!Number.isFinite(position) || position < 1 || position > length) continue;
    const score = Number.parseFloat(line.slice(comma + 1, line.indexOf(',', comma + 1)));
    if (!Number.isFinite(score)) continue;
    sums[position] += score;
    counts[position]++;
  }

  // Indexed by residue number, so index 0 is unused and lookups need no shift.
  const out = new Float32Array(length + 1).fill(Number.NaN);
  for (let i = 1; i <= length; i++) {
    if (counts[i] > 0) out[i] = sums[i] / counts[i];
  }
  return out;
}

/** The four bands AlphaFold's own colouring uses, and its own colours. */
export const PLDDT_BANDS: { min: number; label: string; color: number }[] = [
  { min: 90, label: 'Very high', color: 0x0053d6 },
  { min: 70, label: 'Confident', color: 0x65cbf3 },
  { min: 50, label: 'Low', color: 0xffdb13 },
  { min: 0, label: 'Very low', color: 0xff7d45 },
];

export function plddtColor(value: number): number {
  for (const band of PLDDT_BANDS) if (value >= band.min) return band.color;
  return PLDDT_BANDS[PLDDT_BANDS.length - 1].color;
}
