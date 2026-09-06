import { archiveResidueKey } from './residueMapping';
import type { Structure } from '../mol/structure';
/**
 * Per-residue wwPDB validation.
 *
 * The entry-level summary says "9.5% rotamer outliers"; this says which
 * residues. That is the difference between knowing a structure is imperfect
 * and knowing whether the part you are looking at is one of the imperfect
 * bits, and it is the natural companion to the density map — colour by fit,
 * find the worst residue, look at the evidence under it.
 *
 * RCSB publishes it as instance features rather than as a validation category,
 * which is why it is not obvious it exists. Two shapes come back:
 *
 * - **Continuous metrics** (RSRZ, RSCC, OWAB) arrive as one feature position
 *   whose `values` array runs along the entity sequence, one entry per
 *   residue.
 * - **Discrete faults** (clashes, bond and angle outliers, symmetry clashes)
 *   arrive as one position per affected residue.
 *
 * Both use entity sequence positions. The primary index preserves label_asym_id
 * and that position; author numbering is retained only as a compatibility view.
 * Duplicate author keys are removed from that view rather than silently merged.
 */

const GRAPHQL_ENDPOINT = 'https://data.rcsb.org/graphql';

export interface ResidueMetrics {
  /** Real-space R Z-score. Above 2 is conventionally an outlier. */
  rsrz: number | null;
  /** Real-space correlation with the density; 1 is perfect. */
  rscc: number | null;
  /** Occupancy-weighted average B-factor over the residue. */
  owab: number | null;
  /** Geometry faults of any kind counted together. */
  outliers: number;
}

export interface ResidueValidation {
  /** Keyed `${authAsymId}:${authSeqId}`. */
  byResidue: Map<string, ResidueMetrics>;
  /** Lossless label chain + entity position index. */
  byPosition: Map<string, ResidueMetrics>;
  /** Whether each metric exists anywhere in the entry. */
  hasDensityFit: boolean;
  hasGeometry: boolean;
}

/**
 * Feature types counted as geometry faults. Deliberately lumped: a residue
 * with a bond outlier and a residue with a clash are both "wrong here", and
 * separating them into five colour schemes would be five ways to ask the same
 * question.
 */
const FAULT_TYPES = new Set([
  'CLASHES',
  'SYMM_CLASHES',
  'BOND_OUTLIERS',
  'ANGLE_OUTLIERS',
  'STEREO_OUTLIERS',
  'RSRZ_OUTLIERS',
  'ROTAMER_OUTLIERS',
  'RAMACHANDRAN_OUTLIERS',
  'MOGUL_BOND_OUTLIERS',
  'MOGUL_ANGLE_OUTLIERS',
]);

const QUERY = `query ResidueValidation($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      polymer_entity_instances {
        rcsb_polymer_entity_instance_container_identifiers {
          asym_id
          auth_asym_id
          auth_to_entity_poly_seq_mapping
        }
        rcsb_polymer_instance_feature {
          type
          feature_positions { beg_seq_id end_seq_id values }
        }
      }
    }
  }
}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchResidueValidation(
  entryId: string,
  signal?: AbortSignal,
): Promise<ResidueValidation> {
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

  return parseResidueValidation(json);
}

export function parseResidueValidation(json: any): ResidueValidation {
  const byResidue = new Map<string, ResidueMetrics>();
  const byPosition = new Map<string, ResidueMetrics>();
  const duplicates = new Set<string>();
  let hasDensityFit = false;
  let hasGeometry = false;

  for (const entity of json.data?.entry?.polymer_entities ?? []) {
    for (const instance of entity.polymer_entity_instances ?? []) {
      const ids =
        instance.rcsb_polymer_entity_instance_container_identifiers ?? {};
      const chain: string = ids.auth_asym_id;
      const labelChain: string = ids.asym_id;
      const mapping: string[] = ids.auth_to_entity_poly_seq_mapping ?? [];
      if (!chain || !labelChain || mapping.length === 0) continue;

      /** Entity sequence position (1-based) to the key a residue is known by. */
      const keyAt = (seqId: number): string | null => {
        const auth = mapping[seqId - 1];
        // A dot marks a sequence position with no modelled residue behind it.
        return auth === undefined || auth === '?' || auth === '.'
          ? null
          : archiveResidueKey(labelChain, seqId);
      };
      // Every residue the report covers gets a row up front, even a clean one.
      // Filling the map only from features would leave a residue with nothing
      // wrong with it indistinguishable from a residue nobody checked, and on
      // a well-refined structure that is almost all of them.
      for (let seq = 1; seq <= mapping.length; seq++) {
        const key = keyAt(seq);
        if (key) {
          const metric = { rsrz: null, rscc: null, owab: null, outliers: 0 };
          byPosition.set(key, metric);
          const legacy = `${chain}:${mapping[seq - 1]}`;
          if (byResidue.has(legacy)) duplicates.add(legacy);
          byResidue.set(legacy, metric);
        }
      }
      const slot = (key: string): ResidueMetrics => {
        let m = byPosition.get(key);
        if (!m) {
          m = { rsrz: null, rscc: null, owab: null, outliers: 0 };
          byPosition.set(key, m);
        }
        return m;
      };

      for (const feature of instance.rcsb_polymer_instance_feature ?? []) {
        const type: string = feature.type;
        const positions: any[] = feature.feature_positions ?? [];

        if (type === 'RSRZ' || type === 'RSCC' || type === 'OWAB') {
          for (const position of positions) {
            const values: number[] = position.values ?? [];
            const start: number = position.beg_seq_id ?? 1;
            for (let i = 0; i < values.length; i++) {
              const key = keyAt(start + i);
              if (!key) continue;
              const m = slot(key);
              if (type === 'RSRZ') {
                m.rsrz = values[i];
                hasDensityFit = true;
              } else if (type === 'RSCC') {
                m.rscc = values[i];
                hasDensityFit = true;
              } else m.owab = values[i];
            }
          }
          continue;
        }

        if (!FAULT_TYPES.has(type)) continue;
        for (const position of positions) {
          const begin: number = position.beg_seq_id;
          const end: number = position.end_seq_id ?? begin;
          if (!Number.isFinite(begin)) continue;
          // A count in `values` means several faults on one residue; its
          // absence means one.
          const count = position.values?.[0] ?? 1;
          for (let seq = begin; seq <= end; seq++) {
            const key = keyAt(seq);
            if (!key) continue;
            slot(key).outliers += count;
            hasGeometry = true;
          }
        }
      }
    }
  }

  for (const key of duplicates) byResidue.delete(key);
  return { byResidue, byPosition, hasDensityFit, hasGeometry };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The residues that come off worst, for a "show me the problems" list. */
export function worstResidues(
  validation: ResidueValidation,
  metric: 'rsrz' | 'outliers',
  limit = 10,
): { key: string; value: number }[] {
  const rows: { key: string; value: number }[] = [];
  for (const [key, m] of validation.byResidue) {
    const value = metric === 'rsrz' ? m.rsrz : m.outliers;
    if (value === null || value <= 0) continue;
    rows.push({ key, value });
  }
  rows.sort((a, b) => b.value - a.value);
  return rows.slice(0, limit);
}

/** Instance features are shared across NMR models; they are not model-specific scores. */
export function residueMetrics(
  validation: ResidueValidation | null | undefined,
  s: Structure,
  r: number,
): ResidueMetrics | null {
  if (!validation || s.resLabelSeq[r] <= 0) return null;
  return (
    validation.byPosition.get(
      archiveResidueKey(s.chainLabelId[s.resChain[r]], s.resLabelSeq[r]),
    ) ?? null
  );
}

export function worstMappedResidues(
  validation: ResidueValidation,
  s: Structure,
  metric: 'rsrz' | 'outliers',
  limit = 10,
) {
  return Array.from({ length: s.residueCount }, (_, residue) => {
    const m = residueMetrics(validation, s, residue),
      c = s.resChain[residue];
    return {
      residue,
      chain: s.chainAuthId[c],
      seq: s.resSeq[residue],
      insertionCode: s.resInsCode[residue],
      selection: `(labelchain ${s.chainLabelId[c]} and labelseq ${s.resLabelSeq[residue]} and model ${s.chainModel[c]})`,
      value: m ? (metric === 'rsrz' ? m.rsrz : m.outliers) : null,
    };
  })
    .filter(
      (r): r is typeof r & { value: number } =>
        r.value !== null && Number.isFinite(r.value) && r.value > 0,
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
