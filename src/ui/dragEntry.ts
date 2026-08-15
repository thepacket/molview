/**
 * Dragging a listed structure onto a pane.
 *
 * A pane already accepts a file drop, and the lists already load into the
 * active pane on a click. Between them sits the thing neither does: putting a
 * specific entry into a specific pane in one gesture, which is what comparing
 * two structures side by side actually consists of. Clicking gets you the
 * active pane and nothing else, so the two-pane case is click, retarget,
 * click — and the retarget is the step people forget.
 *
 * The payload travels as a private MIME type rather than as `text/plain`
 * alone, so a pane can tell one of our rows from a stray text selection. The
 * plain-text copy rides along anyway: it makes the same drag drop an id into
 * the search box, or into another application entirely.
 */

import type { DragEvent as ReactDragEvent } from 'react';
import { viewer } from '../viewer/ViewerController';

export const ENTRY_MIME = 'application/x-molview-entry';

export type DragEntry = {
  /** Which archive the id belongs to — they are fetched from different places. */
  kind: 'pdb' | 'prediction';
  id: string;
};

/**
 * Ids are the only thing we act on, and a drag can in principle be started by
 * any page, so the shape is checked rather than trusted. Every id we mint is a
 * PDB code, a UniProt accession or an MGnify accession; none of them contain
 * anything but alphanumerics, and a dot or dash for a versioned accession.
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/**
 * What is currently being dragged, for the pane that wants to name it in its
 * drop overlay. `dragover` cannot read the data store — the drag data is
 * protected until the drop — and "Load 1UBQ into pane 2" is worth a module
 * variable, because a highlighted rectangle alone does not say which pane the
 * pointer is really over.
 */
let dragging: DragEntry | null = null;

export const draggingEntry = (): DragEntry | null => dragging;

/** Spread onto a list row to make it a drag source for `entry`. */
export function entryDragProps(entry: DragEntry) {
  return {
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      dragging = entry;
      e.dataTransfer.setData(ENTRY_MIME, JSON.stringify(entry));
      e.dataTransfer.setData('text/plain', entry.id);
      e.dataTransfer.effectAllowed = 'copy';
    },
    // Fires whether the drop landed, missed, or was cancelled with Escape.
    onDragEnd: () => { dragging = null; },
  };
}

/** The entry a drop is carrying, or null if it is carrying something else. */
export function readEntryDrag(data: DataTransfer): DragEntry | null {
  const raw = data.getData(ENTRY_MIME);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { kind, id } = parsed as Record<string, unknown>;
    if (kind !== 'pdb' && kind !== 'prediction') return null;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return { kind, id };
  } catch {
    return null;
  }
}

/** Whether a drag in flight is one of ours, without reading its payload. */
export const hasEntryDrag = (data: DataTransfer) => data.types.includes(ENTRY_MIME);

export const hasFileDrag = (data: DataTransfer) => data.types.includes('Files');

export function loadDraggedEntry(slot: number, entry: DragEntry): void {
  if (entry.kind === 'prediction') void viewer.loadPrediction(slot, entry.id);
  else void viewer.load(slot, entry.id);
}
