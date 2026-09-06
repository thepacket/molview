import { parseAuthorPosition, type MappedResidue } from './residueMapping';
/**
 * What the residues are for: UniProt's functional annotations, landed on the
 * residues of the loaded structure.
 *
 * MolView could already say a great deal about a structure's geometry and
 * almost nothing about its function. The active site, the catalytic residues,
 * the glycosylation, the disease variants are all annotation rather than
 * coordinates, all of it keyed to UniProt, and none of it was on screen.
 *
 * The whole difficulty is the numbering, and it is a three-step chain that has
 * to be right end to end:
 *
 *   UniProt position
 *     → entity sequence position, via `rcsb_polymer_entity_align`
 *     → label_asym_id + entity position
 *     → a residue in the pane (author numbering is display metadata)
 *
 * Skipping the first step is the classic error and it is silent: 1CBS is
 * offset by one, so an active site drawn without it lands on the neighbour.
 * An annotation on the wrong residue is worse than no annotation, because it
 * looks like an answer.
 */

const GRAPHQL_ENDPOINT = 'https://data.rcsb.org/graphql';

export interface Annotation {
  /** The UniProt feature type, e.g. BINDING_SITE. */
  type: string;
  /** Type rendered for a person. */
  label: string;
  /** The feature's own name or description; often empty for binding sites. */
  detail: string;
  /** Residues in the loaded structure, ordered. */
  residues: MappedResidue[];
  /** Ready to pass to a component or focus action. */
  selection: string;
  /** The UniProt entry the annotation came from. */
  accession: string;
}

/**
 * Types worth drawing, and what to call them. Deliberately a whitelist: the
 * feature vocabulary is large and much of it — `CHAIN`, `SIGNAL`, database
 * bookkeeping — either covers the whole sequence or says nothing about a place
 * on the molecule, and a list where the first row is "the whole chain" trains
 * people to ignore the rest.
 */
const TYPE_LABELS: Record<string, string> = {
  ACTIVE_SITE: 'Active site',
  BINDING_SITE: 'Binding site',
  METAL_ION_BINDING_SITE: 'Metal binding',
  SITE: 'Site of interest',
  MODIFIED_RESIDUE: 'Modified residue',
  GLYCOSYLATION_SITE: 'Glycosylation',
  DISULFIDE_BOND: 'Disulfide bond',
  CROSS_LINK: 'Cross-link',
  LIPID_MOIETY_BINDING_REGION: 'Lipidation',
  MUTAGENESIS_SITE: 'Mutagenesis',
  NATURAL_VARIANT: 'Natural variant',
  REGION_OF_INTEREST: 'Region',
  SHORT_SEQUENCE_MOTIF: 'Motif',
  DNA_BINDING_REGION: 'DNA binding',
  NUCLEOTIDE_PHOSPHATE_BINDING_REGION: 'Nucleotide binding',
  CALCIUM_BINDING_REGION: 'Calcium binding',
  ZINC_FINGER_REGION: 'Zinc finger',
  TRANSMEMBRANE_REGION: 'Transmembrane',
  COILED_COIL_REGION: 'Coiled coil',
  REPEAT: 'Repeat',
  DOMAIN: 'Domain',
};

/** Rows this many kinds deep, so the ones that place a function come first. */
const TYPE_ORDER = Object.keys(TYPE_LABELS);

const QUERY = `query Annotations($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      rcsb_polymer_entity_align {
        reference_database_name
        reference_database_accession
        aligned_regions { entity_beg_seq_id ref_beg_seq_id length }
      }
      polymer_entity_instances {
        rcsb_polymer_entity_instance_container_identifiers {
          asym_id
          auth_asym_id
          auth_to_entity_poly_seq_mapping
        }
      }
      uniprots {
        rcsb_id
        rcsb_uniprot_feature {
          type
          name
          description
          feature_positions { beg_seq_id end_seq_id }
        }
      }
    }
  }
}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchAnnotations(
  entryId: string,
  signal?: AbortSignal,
): Promise<Annotation[]> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: QUERY,
      variables: { id: entryId.toUpperCase() },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`RCSB GraphQL ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e: any) => e.message).join('; '));
  }

  return parseAnnotations(json);
}

export function parseAnnotations(json: any): Annotation[] {
  // Merged across chains and entities: a binding site on a homodimer is one
  // annotation covering both copies, not two rows saying the same thing.
  const merged = new Map<string, Annotation>();

  for (const entity of json.data?.entry?.polymer_entities ?? []) {
    const chains: { chain: string; labelChain: string; mapping: string[] }[] =
      [];
    for (const instance of entity.polymer_entity_instances ?? []) {
      const ids =
        instance.rcsb_polymer_entity_instance_container_identifiers ?? {};
      if (ids.auth_asym_id && ids.auth_to_entity_poly_seq_mapping) {
        chains.push({
          chain: ids.auth_asym_id,
          labelChain: ids.asym_id,
          mapping: ids.auth_to_entity_poly_seq_mapping,
        });
      }
    }
    if (chains.length === 0) continue;

    for (const uniprot of entity.uniprots ?? []) {
      const aligns = (entity.rcsb_polymer_entity_align ?? []).filter(
        (a: any) =>
          a.reference_database_name === 'UniProt' &&
          a.reference_database_accession === uniprot.rcsb_id,
      );
      if (!aligns.length) continue;
      const toEntity = (ref: number): number[] => [
        ...new Set<number>(
          aligns.flatMap((a: any) =>
            (a.aligned_regions ?? []).flatMap((region: any) => {
              const offset = ref - region.ref_beg_seq_id;
              return offset >= 0 && offset < region.length
                ? [region.entity_beg_seq_id + offset]
                : [];
            }),
          ),
        ),
      ];
      for (const feature of uniprot.rcsb_uniprot_feature ?? []) {
        const label = TYPE_LABELS[feature.type];
        if (!label) continue;

        const detail = (feature.name || feature.description || '').trim();
        const key = `${uniprot.rcsb_id}|${feature.type}|${detail}`;
        let entry = merged.get(key);
        if (!entry) {
          entry = {
            type: feature.type,
            label,
            detail,
            residues: [],
            selection: '',
            accession: uniprot.rcsb_id,
          };
          merged.set(key, entry);
        }

        for (const position of feature.feature_positions ?? []) {
          const begin = position.beg_seq_id;
          const end = position.end_seq_id ?? begin;
          if (!Number.isFinite(begin)) continue;
          for (let ref = begin; ref <= end; ref++) {
            for (const entitySeq of toEntity(ref)) {
              for (const { chain, labelChain, mapping } of chains) {
                const auth = mapping[entitySeq - 1];
                if (auth === undefined || auth === '?' || auth === '.')
                  continue;
                const author = parseAuthorPosition(auth);
                if (!author || !labelChain) continue;
                entry.residues.push({
                  chain,
                  ...author,
                  labelChain,
                  labelSeq: entitySeq,
                });
              }
            }
          }
        }
      }
    }
  }

  const out: Annotation[] = [];
  for (const entry of merged.values()) {
    // A feature can name the same residue twice through overlapping regions.
    const seen = new Set<string>();
    entry.residues = entry.residues
      .filter((r) => {
        const key = `${r.labelChain}:${r.labelSeq}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.chain.localeCompare(b.chain) || a.seq - b.seq);
    if (entry.residues.length === 0) continue;
    entry.selection = annotationSelection(entry);
    out.push(entry);
  }

  out.sort((a, b) => {
    const rank = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
    return rank !== 0 ? rank : a.detail.localeCompare(b.detail);
  });
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function annotationSelection(annotation: Annotation): string {
  const byChain = new Map<string, number[]>();
  for (const r of annotation.residues) {
    const list = byChain.get(r.labelChain);
    if (list) list.push(r.labelSeq);
    else byChain.set(r.labelChain, [r.labelSeq]);
  }
  return [...byChain]
    .map(
      ([chain, seqs]) => `(labelchain ${chain} and labelseq ${collapse(seqs)})`,
    )
    .join(' or ');
}

/** Consecutive numbers as ranges; a domain is forty residues, not forty terms. */
function collapse(values: number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const value = sorted[i];
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  return parts.join(',');
}
