/**
 * RCSB PDB data access — GraphQL for molecular definitions/metadata, the
 * Search API for discovery, and models.rcsb.org for coordinates.
 *
 * Everything here runs in the browser against public CORS-enabled endpoints;
 * there is no server component to this application.
 */

const GRAPHQL_ENDPOINT = 'https://data.rcsb.org/graphql';
const SEARCH_ENDPOINT = 'https://search.rcsb.org/rcsbsearch/v2/query';
const BCIF_ENDPOINT = 'https://models.rcsb.org';
const CIF_ENDPOINT = 'https://files.rcsb.org/download';

export interface PolymerEntity {
  id: string;
  description: string;
  polymerType: string;
  weightKda: number | null;
  chains: string[];
  organisms: string[];
  sequence: string | null;
}

export interface NonPolymerEntity {
  id: string;
  compId: string;
  name: string;
  formula: string;
  chains: string[];
}

export interface EntrySummary {
  id: string;
  title: string;
  method: string;
  resolution: number | null;
  atomCount: number | null;
  residueCount: number | null;
  entityCount: number | null;
  weightKda: number | null;
  polymerTypes: string | null;
  releaseDate: string | null;
  keywords: string | null;
  /** wwPDB validation, as far as it exists — see `EntryValidation`. */
  validation: EntryValidation;
}

/**
 * The wwPDB validation summary, as far as it exists for an entry.
 *
 * Geometry is computed from coordinates alone, so every entry in the archive
 * has it. The data-fit metrics are conditional: `rsrzOutliers` needs deposited
 * structure factors, which were not required before 2008, and
 * `emBackboneInclusion` only exists for cryo-EM. A null therefore means "this
 * could not be measured", never "this is zero" — which is why the panel prints
 * a reason beside the dash rather than leaving a gap.
 */
export interface EntryValidation {
  clashscore: number | null;
  ramaOutliers: number | null;
  rotamerOutliers: number | null;
  rsrzOutliers: number | null;
  emBackboneInclusion: number | null;
}

export interface EntryDetail extends EntrySummary {
  citation: {
    title: string | null;
    journal: string | null;
    year: number | null;
    doi: string | null;
    authors: string[];
  } | null;
  polymerEntities: PolymerEntity[];
  nonPolymerEntities: NonPolymerEntity[];
  assemblyCount: number;
  /** EMDB accessions for this entry; the density server keys EM maps by them. */
  emdbIds: string[];
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`RCSB GraphQL ${res.status} ${res.statusText}`);
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new Error('RCSB GraphQL returned no data');
  return json.data;
}

const SUMMARY_FIELDS = `
  rcsb_id
  struct { title }
  rcsb_entry_info {
    resolution_combined
    deposited_atom_count
    deposited_polymer_monomer_count
    polymer_entity_count
    experimental_method
    molecular_weight
    selected_polymer_entity_types
  }
  rcsb_accession_info { initial_release_date }
  struct_keywords { pdbx_keywords }
  pdbx_vrpt_summary_geometry {
    clashscore percent_ramachandran_outliers percent_rotamer_outliers
  }
  pdbx_vrpt_summary_diffraction { percent_RSRZ_outliers }
  pdbx_vrpt_summary_em { atom_inclusion_backbone }
`;

const DETAIL_FIELDS = `
  ${SUMMARY_FIELDS}
  rcsb_primary_citation {
    title journal_abbrev year pdbx_database_id_DOI rcsb_authors
  }
  polymer_entities {
    rcsb_id
    rcsb_polymer_entity { pdbx_description formula_weight }
    entity_poly { rcsb_entity_polymer_type pdbx_seq_one_letter_code_can }
    rcsb_polymer_entity_container_identifiers { auth_asym_ids }
    rcsb_entity_source_organism { ncbi_scientific_name }
  }
  nonpolymer_entities {
    rcsb_id
    nonpolymer_comp { chem_comp { id name formula } }
    rcsb_nonpolymer_entity_container_identifiers { auth_asym_ids }
  }
  assemblies { rcsb_id }
  rcsb_entry_container_identifiers { emdb_ids }
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toSummary(e: any): EntrySummary {
  const info = e.rcsb_entry_info ?? {};
  return {
    id: e.rcsb_id,
    title: e.struct?.title ?? 'Untitled entry',
    method: info.experimental_method ?? 'Unknown',
    resolution: info.resolution_combined?.[0] ?? null,
    atomCount: info.deposited_atom_count ?? null,
    residueCount: info.deposited_polymer_monomer_count ?? null,
    entityCount: info.polymer_entity_count ?? null,
    weightKda: info.molecular_weight ?? null,
    polymerTypes: info.selected_polymer_entity_types ?? null,
    releaseDate: e.rcsb_accession_info?.initial_release_date?.slice(0, 10) ?? null,
    keywords: e.struct_keywords?.pdbx_keywords ?? null,
    validation: toValidation(e),
  };
}

/** Batch metadata lookup — one round trip for a whole page of search hits. */
export async function fetchSummaries(
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, EntrySummary>> {
  if (ids.length === 0) return new Map();
  const data = await graphql<{ entries: any[] }>(
    `query Summaries($ids: [String!]!) { entries(entry_ids: $ids) { ${SUMMARY_FIELDS} } }`,
    { ids },
    signal,
  );
  const out = new Map<string, EntrySummary>();
  for (const e of data.entries ?? []) {
    if (e) out.set(e.rcsb_id, toSummary(e));
  }
  return out;
}

export async function fetchEntryDetail(
  id: string,
  signal?: AbortSignal,
): Promise<EntryDetail> {
  const data = await graphql<{ entry: any }>(
    `query Detail($id: String!) { entry(entry_id: $id) { ${DETAIL_FIELDS} } }`,
    { id: id.toUpperCase() },
    signal,
  );
  const e = data.entry;
  if (!e) throw new Error(`Entry ${id} not found`);

  const polymerEntities: PolymerEntity[] = (e.polymer_entities ?? []).map((p: any) => ({
    id: p.rcsb_id,
    description: p.rcsb_polymer_entity?.pdbx_description ?? 'Polymer',
    polymerType: p.entity_poly?.rcsb_entity_polymer_type ?? 'Other',
    weightKda: p.rcsb_polymer_entity?.formula_weight ?? null,
    chains: p.rcsb_polymer_entity_container_identifiers?.auth_asym_ids ?? [],
    organisms: (p.rcsb_entity_source_organism ?? [])
      .map((o: any) => o.ncbi_scientific_name)
      .filter(Boolean),
    sequence: p.entity_poly?.pdbx_seq_one_letter_code_can ?? null,
  }));

  const nonPolymerEntities: NonPolymerEntity[] = (e.nonpolymer_entities ?? []).map((p: any) => ({
    id: p.rcsb_id,
    compId: p.nonpolymer_comp?.chem_comp?.id ?? '?',
    name: p.nonpolymer_comp?.chem_comp?.name ?? 'Ligand',
    formula: p.nonpolymer_comp?.chem_comp?.formula ?? '',
    chains: p.rcsb_nonpolymer_entity_container_identifiers?.auth_asym_ids ?? [],
  }));

  const c = e.rcsb_primary_citation;
  return {
    ...toSummary(e),
    citation: c
      ? {
          title: c.title ?? null,
          journal: c.journal_abbrev ?? null,
          year: c.year ?? null,
          doi: c.pdbx_database_id_DOI ?? null,
          authors: c.rcsb_authors ?? [],
        }
      : null,
    polymerEntities,
    nonPolymerEntities,
    assemblyCount: (e.assemblies ?? []).length,
    emdbIds: e.rcsb_entry_container_identifiers?.emdb_ids ?? [],
  };
}

/** These come back as single-element lists, but defend against either shape. */
function one(v: any): any {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toValidation(e: any): EntryValidation {
  const geometry = one(e.pdbx_vrpt_summary_geometry) ?? {};
  const diffraction = one(e.pdbx_vrpt_summary_diffraction) ?? {};
  const em = one(e.pdbx_vrpt_summary_em) ?? {};
  return {
    clashscore: num(geometry.clashscore),
    ramaOutliers: num(geometry.percent_ramachandran_outliers),
    rotamerOutliers: num(geometry.percent_rotamer_outliers),
    rsrzOutliers: num(diffraction.percent_RSRZ_outliers),
    emBackboneInclusion: num(em.atom_inclusion_backbone),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchFilters {
  text: string;
  methods: string[];
  resolutionMax: number | null;
  polymerType: string | null;
  organism: string | null;
  yearFrom: number | null;
  sort: 'score' | 'release_desc' | 'release_asc' | 'resolution';
}

export const EMPTY_FILTERS: SearchFilters = {
  text: '',
  methods: [],
  resolutionMax: null,
  polymerType: null,
  organism: null,
  yearFrom: null,
  sort: 'score',
};

export interface SearchPage {
  total: number;
  ids: string[];
}

type Node = Record<string, unknown>;

function terminal(service: string, parameters: Node): Node {
  return { type: 'terminal', service, parameters };
}

function attribute(attr: string, operator: string, value: unknown): Node {
  return terminal('text', { attribute: attr, operator, value });
}

export function hasActiveFilters(f: SearchFilters): boolean {
  return (
    f.methods.length > 0 ||
    f.resolutionMax !== null ||
    f.polymerType !== null ||
    !!f.organism ||
    f.yearFrom !== null
  );
}

export async function searchEntries(
  filters: SearchFilters,
  start: number,
  rows: number,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const nodes: Node[] = [];

  const text = filters.text.trim();
  if (text) nodes.push(terminal('full_text', { value: text }));

  if (filters.methods.length > 0) {
    nodes.push(attribute('exptl.method', 'in', filters.methods));
  }
  if (filters.resolutionMax !== null) {
    nodes.push(attribute(
      'rcsb_entry_info.resolution_combined',
      'less_or_equal',
      filters.resolutionMax,
    ));
  }
  if (filters.polymerType) {
    nodes.push(attribute(
      'rcsb_entry_info.selected_polymer_entity_types',
      'exact_match',
      filters.polymerType,
    ));
  }
  if (filters.organism) {
    nodes.push(attribute(
      'rcsb_entity_source_organism.ncbi_scientific_name',
      'contains_phrase',
      filters.organism,
    ));
  }
  if (filters.yearFrom !== null) {
    nodes.push(attribute(
      'rcsb_accession_info.initial_release_date',
      'greater_or_equal',
      `${filters.yearFrom}-01-01T00:00:00Z`,
    ));
  }

  // An entirely empty query is legal for browsing: it returns the whole PDB.
  const query: Node = nodes.length === 0
    ? attribute('rcsb_entry_info.structure_determination_methodology', 'exact_match', 'experimental')
    : nodes.length === 1
      ? nodes[0]
      : { type: 'group', logical_operator: 'and', nodes };

  const sortMap: Record<SearchFilters['sort'], Node[]> = {
    score: [{ sort_by: 'score', direction: 'desc' }],
    release_desc: [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' }],
    release_asc: [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'asc' }],
    resolution: [{ sort_by: 'rcsb_entry_info.resolution_combined', direction: 'asc' }],
  };

  const body = {
    query,
    return_type: 'entry',
    request_options: {
      paginate: { start, rows },
      sort: sortMap[filters.sort],
      results_content_type: ['experimental', 'computational'],
    },
  };

  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  // The search service answers 204 when nothing matches.
  if (res.status === 204) return { total: 0, ids: [] };
  if (!res.ok) throw new Error(`RCSB Search ${res.status} ${res.statusText}`);

  const json = await res.json();
  return {
    total: json.total_count ?? 0,
    ids: (json.result_set ?? []).map((r: { identifier: string }) => r.identifier),
  };
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

export interface DownloadProgress {
  loaded: number;
  total: number;
}

export async function fetchWithProgress(
  url: string,
  signal: AbortSignal | undefined,
  onProgress: (p: DownloadProgress) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({ loaded, total });
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

export interface CoordinateData {
  buffer: ArrayBuffer;
  format: 'bcif' | 'cif';
}

/**
 * BinaryCIF first — it is about half the bytes and skips text parsing
 * entirely. Text mmCIF is the fallback for anything models.rcsb.org will not
 * serve (some computed-structure models among them).
 */
export async function fetchCoordinates(
  id: string,
  signal: AbortSignal | undefined,
  onProgress: (p: DownloadProgress) => void,
): Promise<CoordinateData> {
  const lower = id.toLowerCase();
  try {
    const buffer = await fetchWithProgress(`${BCIF_ENDPOINT}/${lower}.bcif`, signal, onProgress);
    return { buffer, format: 'bcif' };
  } catch (err) {
    if (signal?.aborted) throw err;
    const buffer = await fetchWithProgress(
      `${CIF_ENDPOINT}/${id.toUpperCase()}.cif`,
      signal,
      onProgress,
    );
    return { buffer, format: 'cif' };
  }
}

export const RCSB_ENTRY_URL = (id: string) => `https://www.rcsb.org/structure/${id.toUpperCase()}`;
