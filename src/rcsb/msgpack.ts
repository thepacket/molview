/**
 * Minimal MessagePack decoder — covers the subset BinaryCIF emits:
 * maps, arrays, str, bin, ints, floats, bool, nil.
 */

export type MsgPackValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | MsgPackValue[]
  | { [key: string]: MsgPackValue };

class Reader {
  private view: DataView;
  private pos = 0;
  private decoder = new TextDecoder('utf-8');

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private str(len: number): string {
    const s = this.decoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  private bin(len: number): Uint8Array {
    // Copy so the slice is independent of the (possibly large) source buffer.
    const out = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  private array(len: number): MsgPackValue[] {
    const out: MsgPackValue[] = new Array(len);
    for (let i = 0; i < len; i++) out[i] = this.value();
    return out;
  }

  private map(len: number): Record<string, MsgPackValue> {
    const out: Record<string, MsgPackValue> = {};
    for (let i = 0; i < len; i++) {
      const k = this.value();
      out[String(k)] = this.value();
    }
    return out;
  }

  value(): MsgPackValue {
    const b = this.view.getUint8(this.pos++);

    // positive fixint
    if (b < 0x80) return b;
    // fixmap
    if (b < 0x90) return this.map(b & 0x0f);
    // fixarray
    if (b < 0xa0) return this.array(b & 0x0f);
    // fixstr
    if (b < 0xc0) return this.str(b & 0x1f);
    // negative fixint
    if (b >= 0xe0) return b - 0x100;

    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;

      case 0xc4: { const n = this.view.getUint8(this.pos); this.pos += 1; return this.bin(n); }
      case 0xc5: { const n = this.view.getUint16(this.pos); this.pos += 2; return this.bin(n); }
      case 0xc6: { const n = this.view.getUint32(this.pos); this.pos += 4; return this.bin(n); }

      case 0xca: { const v = this.view.getFloat32(this.pos); this.pos += 4; return v; }
      case 0xcb: { const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }

      case 0xcc: { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
      case 0xcd: { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
      case 0xce: { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
      case 0xcf: { const v = Number(this.view.getBigUint64(this.pos)); this.pos += 8; return v; }

      case 0xd0: { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
      case 0xd1: { const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
      case 0xd2: { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
      case 0xd3: { const v = Number(this.view.getBigInt64(this.pos)); this.pos += 8; return v; }

      case 0xd9: { const n = this.view.getUint8(this.pos); this.pos += 1; return this.str(n); }
      case 0xda: { const n = this.view.getUint16(this.pos); this.pos += 2; return this.str(n); }
      case 0xdb: { const n = this.view.getUint32(this.pos); this.pos += 4; return this.str(n); }

      case 0xdc: { const n = this.view.getUint16(this.pos); this.pos += 2; return this.array(n); }
      case 0xdd: { const n = this.view.getUint32(this.pos); this.pos += 4; return this.array(n); }

      case 0xde: { const n = this.view.getUint16(this.pos); this.pos += 2; return this.map(n); }
      case 0xdf: { const n = this.view.getUint32(this.pos); this.pos += 4; return this.map(n); }

      default:
        throw new Error(`msgpack: unsupported type 0x${b.toString(16)}`);
    }
  }
}

export function decodeMsgPack(buf: Uint8Array): MsgPackValue {
  return new Reader(buf).value();
}
