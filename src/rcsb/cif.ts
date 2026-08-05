/**
 * A tiny, format-agnostic CIF surface. Both the BinaryCIF decoder and the
 * mmCIF text parser produce these, so the structure builder never has to care
 * which wire format the coordinates arrived in.
 */

export interface CifColumn {
  /** True when the category actually carries this field. */
  readonly isDefined: boolean;
  readonly rowCount: number;
  str(row: number): string;
  num(row: number): number;
  /** True for CIF `.` (not applicable) or `?` (unknown). */
  isNull(row: number): boolean;
}

export interface CifCategory {
  readonly name: string;
  readonly rowCount: number;
  field(name: string): CifColumn;
  hasField(name: string): boolean;
}

export interface CifBlock {
  readonly header: string;
  category(name: string): CifCategory;
  hasCategory(name: string): boolean;
}

const EMPTY_COLUMN: CifColumn = {
  isDefined: false,
  rowCount: 0,
  str: () => '',
  num: () => Number.NaN,
  isNull: () => true,
};

export function emptyColumn(): CifColumn {
  return EMPTY_COLUMN;
}

export const EMPTY_CATEGORY: CifCategory = {
  name: '',
  rowCount: 0,
  field: () => EMPTY_COLUMN,
  hasField: () => false,
};

/** Column backed by parallel value arrays (used by both parsers). */
export class ArrayColumn implements CifColumn {
  readonly isDefined = true;

  constructor(
    readonly rowCount: number,
    private values: ArrayLike<number> | ArrayLike<string>,
    /** mask[i]: 0 = present, 1 = `.`, 2 = `?` */
    private mask: Uint8Array | null,
    private numeric: boolean,
  ) {}

  str(row: number): string {
    if (this.mask && this.mask[row]) return '';
    const v = this.values[row];
    return typeof v === 'string' ? v : String(v);
  }

  num(row: number): number {
    if (this.mask && this.mask[row]) return Number.NaN;
    const v = this.values[row];
    if (this.numeric) return v as number;
    const n = Number.parseFloat(v as string);
    return Number.isNaN(n) ? Number.NaN : n;
  }

  isNull(row: number): boolean {
    return this.mask ? this.mask[row] !== 0 : false;
  }
}

export class MapCategory implements CifCategory {
  constructor(
    readonly name: string,
    readonly rowCount: number,
    private columns: Map<string, CifColumn>,
  ) {}

  field(name: string): CifColumn {
    return this.columns.get(name) ?? EMPTY_COLUMN;
  }

  hasField(name: string): boolean {
    return this.columns.has(name);
  }
}

export class MapBlock implements CifBlock {
  constructor(
    readonly header: string,
    private categories: Map<string, CifCategory>,
  ) {}

  category(name: string): CifCategory {
    return this.categories.get(name) ?? EMPTY_CATEGORY;
  }

  hasCategory(name: string): boolean {
    return this.categories.has(name);
  }
}
