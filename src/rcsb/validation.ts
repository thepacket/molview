/**
 * Reading the wwPDB validation summary.
 *
 * The archive is validated in full — geometry needs only coordinates, so every
 * entry has it — and MolView displays those numbers rather than computing
 * anything. Two rules follow from what the feature is *for*:
 *
 * - Show the numbers, never a grade. A single letter or a green tick invites
 *   exactly the uncritical reading this is meant to prevent.
 * - A missing metric is information, not a gap. 4HHB has no density fit
 *   because structure factors were not deposited in 1984, and saying so is
 *   more useful than a blank.
 *
 * The bands below are resolution-blind, which is a real simplification: a
 * 3.5 Å structure is judged more leniently in practice than a 1.5 Å one. The
 * honest version is wwPDB's percentile rank against comparable entries, which
 * is not exposed through the GraphQL schema.
 */

import type { EntryValidation } from './api';

export type Grade = 'good' | 'fair' | 'poor';

export interface ValidationRow {
  label: string;
  /** How the metric is named mid-sentence, which is not how it is labelled. */
  noun: string;
  /** Formatted for display, or null when the metric does not exist. */
  value: string | null;
  grade: Grade | null;
  /** Why the value is missing — shown on hover, so a dash is never mute. */
  absent?: string;
}

/** Ascending bands: below `good` is good, above `poor` is poor. */
function band(value: number, good: number, poor: number): Grade {
  if (value <= good) return 'good';
  return value <= poor ? 'fair' : 'poor';
}

/** Descending: higher is better, as for the fraction of backbone in the map. */
function bandDown(value: number, good: number, poor: number): Grade {
  if (value >= good) return 'good';
  return value >= poor ? 'fair' : 'poor';
}

export function validationRows(
  v: EntryValidation,
  method: string,
): ValidationRow[] {
  const rows: ValidationRow[] = [];
  const isXray = /X-RAY/i.test(method);
  const isEm = /ELECTRON MICROSCOPY|EM/i.test(method);

  if (v.clashscore !== null) {
    rows.push({
      label: 'Clashes',
      noun: 'steric clashes',
      value: v.clashscore.toFixed(1),
      grade: band(v.clashscore, 5, 20),
    });
  }
  if (v.ramaOutliers !== null) {
    rows.push({
      label: 'Ramachandran',
      noun: 'Ramachandran outliers',
      value: `${v.ramaOutliers.toFixed(1)}%`,
      grade: band(v.ramaOutliers, 0.2, 0.5),
    });
  }
  if (v.rotamerOutliers !== null) {
    rows.push({
      label: 'Rotamers',
      noun: 'rotamer outliers',
      value: `${v.rotamerOutliers.toFixed(1)}%`,
      grade: band(v.rotamerOutliers, 1, 3),
    });
  }

  if (v.rsrzOutliers !== null) {
    rows.push({
      label: 'Density fit',
      noun: 'fit to density',
      value: `${v.rsrzOutliers.toFixed(1)}%`,
      grade: band(v.rsrzOutliers, 2, 5),
    });
  } else if (isXray) {
    rows.push({
      label: 'Density fit',
      noun: 'fit to density',
      value: null,
      grade: null,
      absent: 'No structure factors were deposited, so fit to the '
        + 'experimental data cannot be measured.',
    });
  }

  if (v.emBackboneInclusion !== null) {
    rows.push({
      label: 'Backbone in map',
      noun: 'backbone coverage in the map',
      value: `${Math.round(v.emBackboneInclusion * 100)}%`,
      grade: bandDown(v.emBackboneInclusion, 0.9, 0.7),
    });
  } else if (isEm) {
    rows.push({
      label: 'Backbone in map',
      noun: 'backbone coverage in the map',
      value: null,
      grade: null,
      absent: 'The deposited map was not available for this comparison.',
    });
  }

  return rows;
}

export function hasValidation(v: EntryValidation): boolean {
  return Object.values(v).some((x) => x !== null);
}

/**
 * One sentence, and only when something is actually wrong. A clean structure
 * gets its numbers and silence — praise would be noise, and would blunt the
 * warning when it matters.
 */
export function validationNote(
  v: EntryValidation,
  method: string,
  releaseYear: number | null,
): string | null {
  const poor = validationRows(v, method).filter((r) => r.grade === 'poor');
  if (poor.length === 0) return null;

  const old = releaseYear !== null && releaseYear < 2000;
  const what = list(poor.map((r) => r.noun));

  return old
    ? `Poor ${what} by present standards — this is a ${releaseYear} model, `
      + 'refined before the methods that fix these existed. The fold is '
      + 'usually sound; atomic detail is not.'
    : `Poor ${what}. Treat local detail with caution.`;
}

/** "a", "a and b", "a, b and c" — three metrics joined by "and" reads badly. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A compact line for the assistant's scene context; null when unremarkable. */
export function validationForPrompt(
  v: EntryValidation,
  method: string,
): string | null {
  const rows = validationRows(v, method)
    .filter((r) => r.grade === 'poor' || r.grade === 'fair');
  if (rows.length === 0) return null;
  return rows.map((r) => `${r.label} ${r.value} (${r.grade})`).join(', ');
}
