/**
 * Structure loading worker.
 *
 * Fetching, BinaryCIF decoding and model building all happen here so the UI
 * thread never stalls — a large capsid can take several seconds to decode and
 * a frozen interface during that window is the difference between a viewer
 * that feels like an application and one that feels like a web page.
 */

import { fetchCoordinates } from '../rcsb/api';
import { parseBinaryCif } from '../rcsb/bcif';
import { parseMmCif, STRUCTURE_CATEGORIES } from '../rcsb/mmcif';
import { buildStructure, type Structure } from './structure';
import { computeBonds, nonPolymerMask } from './bonds';
import type { BondList } from './bonds';

export interface LoadRequest {
  type: 'load';
  requestId: number;
  entryId: string;
  /** Raw file contents for locally opened structures. */
  file?: { buffer: ArrayBuffer; name: string };
  /** Which model of an NMR ensemble to build; defaults to the first. */
  modelNum?: number;
  /** Build every model at once, for an ensemble overlay. */
  allModels?: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

export type WorkerRequest = LoadRequest | CancelRequest;

export type WorkerResponse =
  | { type: 'progress'; requestId: number; stage: string; loaded: number; total: number }
  | { type: 'done'; requestId: number; structure: Structure; ligandBonds: BondList }
  | { type: 'error'; requestId: number; message: string };

const controllers = new Map<number, AbortController>();

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Every typed array in the model, so the main thread receives it zero-copy. */
function transferablesOf(s: Structure, bonds: BondList): Transferable[] {
  return [
    s.x.buffer, s.y.buffer, s.z.buffer, s.element.buffer, s.bFactor.buffer,
    s.atomNameId.buffer, s.atomResidue.buffer, s.resNameId.buffer, s.resSeq.buffer,
    s.resChain.buffer, s.resSS.buffer, s.resKind.buffer, s.resAtomStart.buffer,
    s.resAnchor.buffer, s.resOrient.buffer, s.chainKind.buffer,
    s.chainResStart.buffer, s.chainModel.buffer, s.center.buffer, bonds.indices.buffer,
  ] as Transferable[];
}

async function handleLoad(req: LoadRequest): Promise<void> {
  const controller = new AbortController();
  controllers.set(req.requestId, controller);

  try {
    let buffer: ArrayBuffer;
    let format: 'bcif' | 'cif';

    if (req.file) {
      buffer = req.file.buffer;
      format = req.file.name.toLowerCase().endsWith('.bcif') ? 'bcif' : 'cif';
    } else {
      post({ type: 'progress', requestId: req.requestId, stage: 'Fetching', loaded: 0, total: 0 });
      const coords = await fetchCoordinates(req.entryId, controller.signal, (p) => {
        post({
          type: 'progress',
          requestId: req.requestId,
          stage: 'Fetching',
          loaded: p.loaded,
          total: p.total,
        });
      });
      buffer = coords.buffer;
      format = coords.format;
    }

    post({ type: 'progress', requestId: req.requestId, stage: 'Decoding', loaded: 0, total: 0 });
    const block = format === 'bcif'
      ? parseBinaryCif(buffer)
      : parseMmCif(new TextDecoder().decode(buffer), STRUCTURE_CATEGORIES);

    if (controller.signal.aborted) return;

    post({ type: 'progress', requestId: req.requestId, stage: 'Building', loaded: 0, total: 0 });
    const title = block.category('struct').field('title').str(0) || req.entryId;
    const structure = buildStructure(block, req.entryId.toUpperCase(), title, {
      modelNum: req.modelNum,
      allModels: req.allModels,
    });

    if (controller.signal.aborted) return;

    // Ligand connectivity is always wanted; whole-structure bonding is derived
    // lazily on demand because it is only needed by ball-and-stick.
    post({ type: 'progress', requestId: req.requestId, stage: 'Bonding', loaded: 0, total: 0 });
    const ligandBonds = computeBonds(structure, nonPolymerMask(structure, false));

    post(
      { type: 'done', requestId: req.requestId, structure, ligandBonds },
      transferablesOf(structure, ligandBonds),
    );
  } catch (err) {
    if (controller.signal.aborted) return;
    post({
      type: 'error',
      requestId: req.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    controllers.delete(req.requestId);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === 'cancel') {
    controllers.get(req.requestId)?.abort();
    controllers.delete(req.requestId);
    return;
  }
  void handleLoad(req);
};
