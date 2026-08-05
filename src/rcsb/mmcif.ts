/**
 * mmCIF text parser — the fallback path when BinaryCIF is unavailable, and the
 * path used for user-supplied .cif files.
 *
 * Only the categories in `wanted` are retained; a large text mmCIF is mostly
 * metadata we never touch, and keeping all of it is pure memory pressure.
 */

import { ArrayColumn, MapBlock, MapCategory, type CifBlock, type CifColumn } from './cif';

const enum Tok {
  Value,
  Loop,
  Tag,
  DataBlock,
  Stop,
  EOF,
}

class Tokenizer {
  private pos = 0;
  /** Set when the current token was written as `.` or `?` rather than quoted. */
  nullKind = 0;
  value = '';

  constructor(private text: string) {}

  private skipWhitespaceAndComments(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 35 /* # */) {
        while (this.pos < t.length && t.charCodeAt(this.pos) !== 10) this.pos++;
      } else if (c === 32 || c === 9 || c === 10 || c === 13) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private atLineStart(): boolean {
    return this.pos === 0 || this.text.charCodeAt(this.pos - 1) === 10;
  }

  next(): Tok {
    this.nullKind = 0;
    this.skipWhitespaceAndComments();
    const t = this.text;
    if (this.pos >= t.length) return Tok.EOF;

    const c = t.charCodeAt(this.pos);

    // Multi-line text field: a semicolon in column 1 through `\n;`.
    if (c === 59 /* ; */ && this.atLineStart()) {
      const start = ++this.pos;
      let end = t.indexOf('\n;', start);
      if (end < 0) end = t.length;
      this.value = t.substring(start, end).replace(/\r?\n$/, '');
      this.pos = Math.min(end + 2, t.length);
      return Tok.Value;
    }

    // Quoted value.
    if (c === 39 /* ' */ || c === 34 /* " */) {
      const quote = c;
      const start = ++this.pos;
      while (this.pos < t.length) {
        if (t.charCodeAt(this.pos) === quote) {
          const after = this.pos + 1 < t.length ? t.charCodeAt(this.pos + 1) : 32;
          // A closing quote must be followed by whitespace; apostrophes inside
          // words (e.g. 5'-end) are ordinary characters.
          if (after === 32 || after === 9 || after === 10 || after === 13) break;
        }
        this.pos++;
      }
      this.value = t.substring(start, this.pos);
      this.pos++;
      return Tok.Value;
    }

    // Bare token.
    const start = this.pos;
    while (this.pos < t.length) {
      const k = t.charCodeAt(this.pos);
      if (k === 32 || k === 9 || k === 10 || k === 13) break;
      this.pos++;
    }
    const raw = t.substring(start, this.pos);
    const lower = raw.toLowerCase();

    if (lower === 'loop_') return Tok.Loop;
    if (lower === 'stop_') return Tok.Stop;
    if (lower.startsWith('data_')) {
      this.value = raw.substring(5);
      return Tok.DataBlock;
    }
    if (raw.charCodeAt(0) === 95 /* _ */) {
      this.value = raw;
      return Tok.Tag;
    }
    if (raw === '.') this.nullKind = 1;
    else if (raw === '?') this.nullKind = 2;
    this.value = raw;
    return Tok.Value;
  }
}

function splitTag(tag: string): [string, string] {
  const dot = tag.indexOf('.');
  if (dot < 0) return [tag.substring(1), ''];
  return [tag.substring(1, dot), tag.substring(dot + 1)];
}

interface Pending {
  fields: string[];
  rows: string[][];
  masks: number[][];
}

export function parseMmCif(text: string, wanted: ReadonlySet<string>): CifBlock {
  const tk = new Tokenizer(text);
  const pending = new Map<string, Pending>();
  let header = '';

  const ensure = (cat: string, fields: string[]): Pending => {
    let p = pending.get(cat);
    if (!p) {
      p = { fields, rows: [], masks: [] };
      pending.set(cat, p);
    }
    return p;
  };

  let tok = tk.next();
  while (tok !== Tok.EOF) {
    if (tok === Tok.DataBlock) {
      header = tk.value;
      tok = tk.next();
      continue;
    }

    if (tok === Tok.Loop) {
      // Collect the tag list, then read values row-major until the next tag.
      const tags: string[] = [];
      tok = tk.next();
      while (tok === Tok.Tag) {
        tags.push(tk.value);
        tok = tk.next();
      }
      if (tags.length === 0) continue;

      const [cat] = splitTag(tags[0]);
      const fields = tags.map((t) => splitTag(t)[1]);
      const keep = wanted.has(cat);
      const p = keep ? ensure(cat, fields) : null;

      let row: string[] = [];
      let mask: number[] = [];
      while (tok === Tok.Value) {
        if (keep) {
          row.push(tk.value);
          mask.push(tk.nullKind);
          if (row.length === fields.length) {
            p!.rows.push(row);
            p!.masks.push(mask);
            row = [];
            mask = [];
          }
        }
        tok = tk.next();
      }
      continue;
    }

    if (tok === Tok.Tag) {
      // Single key/value pair — modelled as a one-row category.
      const tag = tk.value;
      const [cat, field] = splitTag(tag);
      tok = tk.next();
      if (tok !== Tok.Value) continue;
      if (wanted.has(cat)) {
        const p = ensure(cat, []);
        if (p.rows.length === 0) {
          p.rows.push([]);
          p.masks.push([]);
        }
        p.fields.push(field);
        p.rows[0].push(tk.value);
        p.masks[0].push(tk.nullKind);
      }
      tok = tk.next();
      continue;
    }

    tok = tk.next();
  }

  const categories = new Map<string, MapCategory>();
  for (const [name, p] of pending) {
    const rowCount = p.rows.length;
    const columns = new Map<string, CifColumn>();
    for (let f = 0; f < p.fields.length; f++) {
      const values: string[] = new Array(rowCount);
      const mask = new Uint8Array(rowCount);
      let anyNull = false;
      for (let r = 0; r < rowCount; r++) {
        values[r] = p.rows[r][f] ?? '';
        mask[r] = p.masks[r][f] ?? 0;
        if (mask[r]) anyNull = true;
      }
      columns.set(p.fields[f], new ArrayColumn(rowCount, values, anyNull ? mask : null, false));
    }
    categories.set(name, new MapCategory(name, rowCount, columns));
  }

  return new MapBlock(header, categories);
}

/** Categories the structure builder reads. */
export const STRUCTURE_CATEGORIES: ReadonlySet<string> = new Set([
  'atom_site',
  'struct_conf',
  'struct_sheet_range',
  'entity',
  'struct_asym',
  'chem_comp',
  'entry',
  'struct',
]);
