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
 * Both are numbered in *entity* sequence, which is not what a viewer or a user
 * says. `auth_to_entity_poly_seq_mapping` converts, and without it the colours
 * land on the wrong residues wherever a chain does not start at 1 — which is
 * most of the archive.
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
  'CLASHES', 'SYMM_CLASHES', 'BOND_OUTLIERS', 'ANGLE_OUTLIERS',
  'STEREO_OUTLIERS', 'RSRZ_OUTLIERS', 'ROTAMER_OUTLIERS',
  'RAMACHANDRAN_OUTLIERS', 'MOGUL_BOND_OUTLIERS', 'MOGUL_ANGLE_OUTLIERS',
]);

const QUERY = `query ResidueValidation($id: String!) {
  entry(entry_id: $id) {
    polymer_entities {
      polymer_entity_instances {
        rcsb_polymer_entity_instance_container_identifiers {
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
    body: JSON.stringify({ query: QUERY, variables: { id: entryId.toUpperCase() } }),
    signal,
  });
  if (!res.ok) throw new Error(`RCSB GraphQL ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e: any) => e.message).join('; '));
  }

  const byResidue = new Map<string, ResidueMetrics>();
  let hasDensityFit = false;
  let hasGeometry = false;

  for (const entity of json.data?.entry?.polymer_entities ?? []) {
    for (const instance of entity.polymer_entity_instances ?? []) {
      const ids = instance.rcsb_polymer_entity_instance_container_identifiers ?? {};
      const chain: string = ids.auth_asym_id;
      const mapping: string[] = ids.auth_to_entity_poly_seq_mapping ?? [];
      if (!chain || mapping.length === 0) continue;

      /** Entity sequence position (1-based) to the key a residue is known by. */
      const keyAt = (seqId: number): string | null => {
        const auth = mapping[seqId - 1];
        // A dot marks a sequence position with no modelled residue behind it.
        return auth === undefined || auth === '?' || auth === '.'
          ? null
          : `${chain}:${auth}`;
      };
      // Every residue the report covers gets a row up front, even a clean one.
      // Filling the map only from features would leave a residue with nothing
      // wrong with it indistinguishable from a residue nobody checked, and on
      // a well-refined structure that is almost all of them.
      for (let seq = 1; seq <= mapping.length; seq++) {
        const key = keyAt(seq);
        if (key) byResidue.set(key, { rsrz: null, rscc: null, owab: null, outliers: 0 });
      }
      const slot = (key: string): ResidueMetrics => {
        let m = byResidue.get(key);
        if (!m) {
          m = { rsrz: null, rscc: null, owab: null, outliers: 0 };
          byResidue.set(key, m);
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
              if (type === 'RSRZ') { m.rsrz = values[i]; hasDensityFit = true; } else if (type === 'RSCC') m.rscc = values[i];
              else m.owab = values[i];
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

  return { byResidue, hasDensityFit, hasGeometry };
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
