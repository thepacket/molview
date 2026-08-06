/**
 * BinaryCIF decoder (https://github.com/molstar/BinaryCIF).
 *
 * Coordinates come from models.rcsb.org as .bcif — roughly half the bytes of
 * text mmCIF and no per-token string parsing, which matters a lot once you are
 * loading structures with a few hundred thousand atoms.
 */

import { decodeMsgPack, type MsgPackValue } from './msgpack';
import { ArrayColumn, MapBlock, MapCategory, type CifBlock, type CifColumn } from './cif';

type Encoding = Record<string, MsgPackValue>;

const enum ByteArrayType {
  Int8 = 1,
  Int16 = 2,
  Int32 = 3,
  Uint8 = 4,
  Uint16 = 5,
  Uint32 = 6,
  Float32 = 32,
  Float64 = 33,
}

function typedArrayFor(type: number, buf: Uint8Array): ArrayLike<number> {
  // .slice() gives us a correctly aligned copy; bcif payloads are not
  // guaranteed to start on the element boundary the view requires.
  const b = buf.slice().buffer;
  switch (type) {
    case ByteArrayType.Int8: return new Int8Array(b);
    case ByteArrayType.Int16: return new Int16Array(b);
    case ByteArrayType.Int32: return new Int32Array(b);
    case ByteArrayType.Uint8: return new Uint8Array(b);
    case ByteArrayType.Uint16: return new Uint16Array(b);
    case ByteArrayType.Uint32: return new Uint32Array(b);
    case ByteArrayType.Float32: return new Float32Array(b);
    case ByteArrayType.Float64: return new Float64Array(b);
    default: throw new Error(`bcif: unknown byte array type ${type}`);
  }
}

function intArrayFor(type: number, size: number): Int32Array | Float64Array {
  return type === ByteArrayType.Float32 || type === ByteArrayType.Float64
    ? new Float64Array(size)
    : new Int32Array(size);
}

/** Applies one encoding step in reverse. */
function decodeStep(data: unknown, enc: Encoding): unknown {
  switch (enc.kind) {
    case 'ByteArray':
      return typedArrayFor(enc.type as number, data as Uint8Array);

    case 'FixedPoint': {
      const src = data as ArrayLike<number>;
      const factor = enc.factor as number;
      const out = new Float64Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = src[i] / factor;
      return out;
    }

    case 'IntervalQuantization': {
      const src = data as ArrayLike<number>;
      const min = enc.min as number;
      const max = enc.max as number;
      const steps = enc.numSteps as number;
      const delta = (max - min) / (steps - 1);
      const out = new Float64Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = min + delta * src[i];
      return out;
    }

    case 'RunLength': {
      const src = data as ArrayLike<number>;
      const out = intArrayFor(enc.srcType as number, enc.srcSize as number);
      let o = 0;
      for (let i = 0; i < src.length; i += 2) {
        const value = src[i];
        for (let j = 0, n = src[i + 1]; j < n; j++) out[o++] = value;
      }
      return out;
    }

    case 'Delta': {
      const src = data as ArrayLike<number>;
      const out = intArrayFor(enc.srcType as number, src.length);
      if (src.length === 0) return out;
      out[0] = src[0] + ((enc.origin as number) || 0);
      for (let i = 1; i < src.length; i++) out[i] = src[i] + out[i - 1];
      return out;
    }

    case 'IntegerPacking': {
      // Values too large for the packed width are split across several
      // elements: consecutive max/min sentinels accumulate into one value.
      const src = data as ArrayLike<number>;
      const size = enc.srcSize as number;
      const unsigned = enc.isUnsigned as boolean;
      const byteCount = enc.byteCount as number;
      const out = new Int32Array(size);
      const upper = unsigned
        ? (byteCount === 1 ? 0xff : 0xffff)
        : (byteCount === 1 ? 0x7f : 0x7fff);
      // Unsigned streams have only an upper sentinel. Treating 0 as a lower
      // sentinel would swallow every legitimate zero in the data.
      const lower = unsigned ? Number.NaN : -upper - 1;

      let i = 0;
      let o = 0;
      while (i < src.length) {
        let value = 0;
        let t = src[i];
        while (t === upper || t === lower) {
          value += t;
          i++;
          if (i >= src.length) break;
          t = src[i];
        }
        if (i < src.length) {
          value += t;
          i++;
        }
        out[o++] = value;
      }
      return out;
    }

    case 'StringArray': {
      const offsets = decodeEncoded(
        enc.offsets as Uint8Array,
        enc.offsetEncoding as Encoding[],
      ) as ArrayLike<number>;
      const indices = decodeEncoded(
        data as Uint8Array,
        enc.dataEncoding as Encoding[],
      ) as ArrayLike<number>;
      const stringData = enc.stringData as string;

      // Materialise the unique-string table once, then index into it.
      const table: string[] = new Array(offsets.length - 1);
      for (let i = 0; i < table.length; i++) {
        table[i] = stringData.substring(offsets[i], offsets[i + 1]);
      }

      const out: string[] = new Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        out[i] = idx < 0 ? '' : table[idx];
      }
      return out;
    }

    default:
      throw new Error(`bcif: unknown encoding ${String(enc.kind)}`);
  }
}

function decodeEncoded(data: unknown, encodings: Encoding[]): unknown {
  let current = data;
  // Encodings are listed outermost-first, so unwind from the end.
  for (let i = encodings.length - 1; i >= 0; i--) {
    current = decodeStep(current, encodings[i]);
  }
  return current;
}

interface EncodedData {
  data: Uint8Array;
  encoding: Encoding[];
}

function decodeColumn(col: Record<string, MsgPackValue>, rowCount: number): CifColumn {
  const d = col.data as unknown as EncodedData;
  const values = decodeEncoded(d.data, d.encoding) as ArrayLike<number> | ArrayLike<string>;

  let mask: Uint8Array | null = null;
  if (col.mask) {
    const m = col.mask as unknown as EncodedData;
    const decoded = decodeEncoded(m.data, m.encoding) as ArrayLike<number>;
    mask = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) mask[i] = decoded[i];
  }

  const numeric = typeof values[0] !== 'string';
  return new ArrayColumn(rowCount, values, mask, numeric);
}

/**
 * Every data block in the file.
 *
 * Coordinate files carry one and `parseBinaryCif` is the right door for them.
 * Volume files carry three — a server-status block, then one per map — so the
 * block header is data rather than decoration and the caller has to see them
 * all.
 */
export function parseBinaryCifBlocks(buffer: ArrayBuffer): CifBlock[] {
  const root = decodeMsgPack(new Uint8Array(buffer)) as Record<string, MsgPackValue>;
  const blocks = root.dataBlocks as Record<string, MsgPackValue>[];
  if (!blocks?.length) throw new Error('bcif: file contains no data blocks');

  return blocks.map((block) => {
    const categories = new Map<string, MapCategory>();

    for (const cat of (block.categories as Record<string, MsgPackValue>[]) ?? []) {
      // Coordinate files name categories bare, volume files with the CIF
      // leading underscore. Normalising here means neither caller has to know.
      const name = (cat.name as string).replace(/^_/, '');
      const rowCount = cat.rowCount as number;
      const columns = new Map<string, CifColumn>();

      for (const col of (cat.columns as Record<string, MsgPackValue>[]) ?? []) {
        try {
          columns.set(col.name as string, decodeColumn(col, rowCount));
        } catch {
          // A single unreadable column should not sink the whole structure.
        }
      }
      categories.set(name, new MapCategory(name, rowCount, columns));
    }

    return new MapBlock((block.header as string) ?? '', categories);
  });
}

export function parseBinaryCif(buffer: ArrayBuffer): CifBlock {
  return parseBinaryCifBlocks(buffer)[0];
}
