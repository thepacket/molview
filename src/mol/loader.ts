/** Main-thread handle for the structure loading worker. */

import type { BondList } from './bonds';
import type { Structure } from './structure';
import type { LoadRequest, WorkerRequest, WorkerResponse } from './loader.worker';

export interface LoadProgress {
  stage: string;
  loaded: number;
  total: number;
}

export interface LoadResult {
  structure: Structure;
  ligandBonds: BondList;
}

interface Pending {
  resolve: (r: LoadResult) => void;
  reject: (e: Error) => void;
  onProgress: (p: LoadProgress) => void;
}

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./loader.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;
    const entry = pending.get(msg.requestId);
    if (!entry) return;

    if (msg.type === 'progress') {
      entry.onProgress({ stage: msg.stage, loaded: msg.loaded, total: msg.total });
    } else if (msg.type === 'done') {
      pending.delete(msg.requestId);
      entry.resolve({ structure: msg.structure, ligandBonds: msg.ligandBonds });
    } else {
      pending.delete(msg.requestId);
      entry.reject(new Error(msg.message));
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Structure worker failed');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  return worker;
}

export interface LoadHandle {
  promise: Promise<LoadResult>;
  cancel: () => void;
}

export interface LoadOptions {
  file?: { buffer: ArrayBuffer; name: string };
  modelNum?: number;
  allModels?: boolean;
  /** Which alternate conformation to build; defaults to the file's first. */
  altLoc?: string;
  /** Fetch from here rather than from the PDB, as AlphaFold models do. */
  sourceUrl?: string;
}

export function loadStructure(
  entryId: string,
  onProgress: (p: LoadProgress) => void,
  options: LoadOptions = {},
): LoadHandle {
  const w = ensureWorker();
  const requestId = nextId++;

  const promise = new Promise<LoadResult>((resolve, reject) => {
    pending.set(requestId, { resolve, reject, onProgress });
    const req: LoadRequest = { type: 'load', requestId, entryId, ...options };
    w.postMessage(req, options.file ? [options.file.buffer] : []);
  });

  return {
    promise,
    cancel: () => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      const req: WorkerRequest = { type: 'cancel', requestId };
      w.postMessage(req);
    },
  };
}
