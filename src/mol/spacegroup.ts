/**
 * Crystal symmetry: the operators that surround a chain with its lattice
 * neighbours.
 *
 * Needed because the assembly generators answer a different question. They
 * build the *biological* unit, so a monomeric entry like ubiquitin generates
 * one copy — itself — and reports no contacts at all, when in the crystal it is
 * packed against six neighbours. Telling crystal packing from a biological
 * interface means having both sets, and only one of them was reachable.
 *
 * RCSB ships the cell and the space group with the coordinates but not the
 * operators, so they have to be reconstructed. Rather than transcribe hundreds
 * of coordinate triplets — the kind of table where a typo produces a plausible
 * neighbour instead of an absent one — this stores two or three generators per
 * group and closes the group by composition. The expected order is stored
 * alongside as a checksum: a mistyped generator almost always generates the
 * wrong number of operators, and `spaceGroupOperators` returns null rather than
 * a subtly wrong lattice.
 *
 * Only the 65 Sohncke groups can hold a protein — a chiral molecule cannot sit
 * in a cell with an improper operation — so those are the ones listed. An entry
 * in any other group is refused rather than approximated.
 */

/** Centring translations, in fractional coordinates. */
const CENTRING: Record<string, [number, number, number][]> = {
  P: [[0, 0, 0]],
  A: [[0, 0, 0], [0, 0.5, 0.5]],
  B: [[0, 0, 0], [0.5, 0, 0.5]],
  C: [[0, 0, 0], [0.5, 0.5, 0]],
  I: [[0, 0, 0], [0.5, 0.5, 0.5]],
  F: [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]],
  R: [[0, 0, 0], [2 / 3, 1 / 3, 1 / 3], [1 / 3, 2 / 3, 2 / 3]],
};

interface GroupSpec {
  /** International Tables number, for messages. */
  number: number;
  centring: keyof typeof CENTRING;
  /** Generators as coordinate triplets; the identity is implicit. */
  gens: string[];
  /** General-position multiplicity, including centring. The checksum. */
  order: number;
}

/**
 * Keyed by Hermann-Mauguin symbol, not by International Tables number.
 *
 * The number is not enough and assuming it was produced a real bug: 1AKE is
 * `P 21 2 21`, a setting of #18 whose 2-fold runs along b, and looking up #18
 * returned the standard `P 21 21 2` with its 2-fold along c. Same group, same
 * order — so the multiplicity checksum passed — and every generated neighbour
 * in the wrong place. In a 300-entry sample of X-ray structures, 10 were in a
 * setting that number-only lookup gets wrong: `P 2 21 21`, `P 21 2 21` and
 * `I 1 2 1`. RCSB also writes monoclinic symbols in full (`P 1 21 1`,
 * `C 1 2 1`), which no number-keyed table would have matched either.
 *
 * Symbols are normalised by stripping spaces and upper-casing. Anything not
 * listed is refused rather than approximated.
 */
const GROUPS: Record<string, GroupSpec> = {
  P1: { number: 1, centring: 'P', gens: [], order: 1 },

  // Monoclinic. RCSB writes the full three-position symbol.
  P121: { number: 3, centring: 'P', gens: ['-x,y,-z'], order: 2 },
  P1211: { number: 4, centring: 'P', gens: ['-x,y+1/2,-z'], order: 2 },
  C121: { number: 5, centring: 'C', gens: ['-x,y,-z'], order: 4 },
  I121: { number: 5, centring: 'I', gens: ['-x,y,-z'], order: 4 },

  // Orthorhombic. #18 and #17 appear in all three axis settings.
  P222: { number: 16, centring: 'P', gens: ['-x,-y,z', 'x,-y,-z'], order: 4 },
  P2221: { number: 17, centring: 'P', gens: ['-x,-y,z+1/2', 'x,-y,-z+1/2'], order: 4 },
  P21212: { number: 18, centring: 'P', gens: ['-x,-y,z', '-x+1/2,y+1/2,-z'], order: 4 },
  // The same group with the 2-fold along a, then along b.
  P22121: { number: 18, centring: 'P', gens: ['x,-y,-z', '-x,y+1/2,-z+1/2'], order: 4 },
  P21221: { number: 18, centring: 'P', gens: ['-x,y,-z', 'x+1/2,-y,-z+1/2'], order: 4 },
  P212121: { number: 19, centring: 'P', gens: ['-x+1/2,-y,z+1/2', '-x,y+1/2,-z+1/2'], order: 4 },
  C2221: { number: 20, centring: 'C', gens: ['-x,-y,z+1/2', 'x,-y,-z+1/2'], order: 8 },
  C222: { number: 21, centring: 'C', gens: ['-x,-y,z', 'x,-y,-z'], order: 8 },
  F222: { number: 22, centring: 'F', gens: ['-x,-y,z', 'x,-y,-z'], order: 16 },
  I222: { number: 23, centring: 'I', gens: ['-x,-y,z', 'x,-y,-z'], order: 8 },
  I212121: { number: 24, centring: 'I', gens: ['-x+1/2,-y,z+1/2', '-x,y+1/2,-z+1/2'], order: 8 },

  // Tetragonal.
  P4: { number: 75, centring: 'P', gens: ['-y,x,z'], order: 4 },
  P41: { number: 76, centring: 'P', gens: ['-y,x,z+1/4'], order: 4 },
  P42: { number: 77, centring: 'P', gens: ['-y,x,z+1/2'], order: 4 },
  P43: { number: 78, centring: 'P', gens: ['-y,x,z+3/4'], order: 4 },
  I4: { number: 79, centring: 'I', gens: ['-y,x,z'], order: 8 },
  I41: { number: 80, centring: 'I', gens: ['-y,x+1/2,z+1/4'], order: 8 },
  P422: { number: 89, centring: 'P', gens: ['-y,x,z', 'x,-y,-z'], order: 8 },
  P4212: { number: 90, centring: 'P', gens: ['-y+1/2,x+1/2,z', 'x+1/2,-y+1/2,-z'], order: 8 },
  P4122: { number: 91, centring: 'P', gens: ['-y,x,z+1/4', 'x,-y,-z'], order: 8 },
  P41212: { number: 92, centring: 'P', gens: ['-y+1/2,x+1/2,z+1/4', 'x+1/2,-y+1/2,-z+3/4'], order: 8 },
  P4222: { number: 93, centring: 'P', gens: ['-y,x,z+1/2', 'x,-y,-z'], order: 8 },
  P42212: { number: 94, centring: 'P', gens: ['-y+1/2,x+1/2,z+1/2', 'x+1/2,-y+1/2,-z+1/2'], order: 8 },
  P4322: { number: 95, centring: 'P', gens: ['-y,x,z+3/4', 'x,-y,-z'], order: 8 },
  P43212: { number: 96, centring: 'P', gens: ['-y+1/2,x+1/2,z+3/4', 'x+1/2,-y+1/2,-z+1/4'], order: 8 },
  I422: { number: 97, centring: 'I', gens: ['-y,x,z', 'x,-y,-z'], order: 16 },
  I4122: { number: 98, centring: 'I', gens: ['-y+1/2,x+1/2,z+1/4', 'x+1/2,-y+1/2,-z+3/4'], order: 16 },

  // Trigonal and hexagonal. R groups are deposited in the hexagonal setting
  // and written with an H, which is the centring this table already assumes.
  P3: { number: 143, centring: 'P', gens: ['-y,x-y,z'], order: 3 },
  P31: { number: 144, centring: 'P', gens: ['-y,x-y,z+1/3'], order: 3 },
  P32: { number: 145, centring: 'P', gens: ['-y,x-y,z+2/3'], order: 3 },
  H3: { number: 146, centring: 'R', gens: ['-y,x-y,z'], order: 9 },
  R3: { number: 146, centring: 'R', gens: ['-y,x-y,z'], order: 9 },
  P312: { number: 149, centring: 'P', gens: ['-y,x-y,z', '-y,-x,-z'], order: 6 },
  P321: { number: 150, centring: 'P', gens: ['-y,x-y,z', 'y,x,-z'], order: 6 },
  P3112: { number: 151, centring: 'P', gens: ['-y,x-y,z+1/3', '-y,-x,-z+2/3'], order: 6 },
  P3121: { number: 152, centring: 'P', gens: ['-y,x-y,z+1/3', 'y,x,-z'], order: 6 },
  P3212: { number: 153, centring: 'P', gens: ['-y,x-y,z+2/3', '-y,-x,-z+1/3'], order: 6 },
  P3221: { number: 154, centring: 'P', gens: ['-y,x-y,z+2/3', 'y,x,-z'], order: 6 },
  H32: { number: 155, centring: 'R', gens: ['-y,x-y,z', 'y,x,-z'], order: 18 },
  R32: { number: 155, centring: 'R', gens: ['-y,x-y,z', 'y,x,-z'], order: 18 },
  P6: { number: 168, centring: 'P', gens: ['x-y,x,z'], order: 6 },
  P61: { number: 169, centring: 'P', gens: ['x-y,x,z+1/6'], order: 6 },
  P65: { number: 170, centring: 'P', gens: ['x-y,x,z+5/6'], order: 6 },
  P62: { number: 171, centring: 'P', gens: ['x-y,x,z+1/3'], order: 6 },
  P64: { number: 172, centring: 'P', gens: ['x-y,x,z+2/3'], order: 6 },
  P63: { number: 173, centring: 'P', gens: ['x-y,x,z+1/2'], order: 6 },
  P622: { number: 177, centring: 'P', gens: ['x-y,x,z', 'y,x,-z'], order: 12 },
  P6122: { number: 178, centring: 'P', gens: ['x-y,x,z+1/6', 'y,x,-z+1/3'], order: 12 },
  P6522: { number: 179, centring: 'P', gens: ['x-y,x,z+5/6', 'y,x,-z+2/3'], order: 12 },
  P6222: { number: 180, centring: 'P', gens: ['x-y,x,z+1/3', 'y,x,-z+2/3'], order: 12 },
  P6422: { number: 181, centring: 'P', gens: ['x-y,x,z+2/3', 'y,x,-z+1/3'], order: 12 },
  P6322: { number: 182, centring: 'P', gens: ['x-y,x,z+1/2', 'y,x,-z'], order: 12 },

  // Cubic. P 42 3 2 is deliberately absent: the generators tried closed to the
  // wrong order, and the checksum caught it. An absent group is refused
  // loudly; a wrong one would have produced neighbours that look real.
  P23: { number: 195, centring: 'P', gens: ['-x,-y,z', 'x,-y,-z', 'z,x,y'], order: 12 },
  F23: { number: 196, centring: 'F', gens: ['-x,-y,z', 'x,-y,-z', 'z,x,y'], order: 48 },
  I23: { number: 197, centring: 'I', gens: ['-x,-y,z', 'x,-y,-z', 'z,x,y'], order: 24 },
  P213: { number: 198, centring: 'P', gens: ['-x+1/2,-y,z+1/2', '-x,y+1/2,-z+1/2', 'z,x,y'], order: 12 },
  I213: { number: 199, centring: 'I', gens: ['-x+1/2,-y,z+1/2', '-x,y+1/2,-z+1/2', 'z,x,y'], order: 24 },
  P432: { number: 207, centring: 'P', gens: ['-y,x,z', 'z,x,y', 'y,x,-z'], order: 24 },
  F432: { number: 209, centring: 'F', gens: ['-y,x,z', 'z,x,y', 'y,x,-z'], order: 96 },
  I432: { number: 211, centring: 'I', gens: ['-y,x,z', 'z,x,y', 'y,x,-z'], order: 48 },
};

/** Strips spaces and upper-cases, so "P 21 2 21" and "p212221" both key. */
export function normaliseSpaceGroup(symbol: string): string {
  return symbol.replace(/\s+/g, '').toUpperCase();
}

/** A symmetry operation in fractional space: 3x3 rotation and a translation. */
export interface SymOp {
  /** Row-major 3x3. */
  rot: Float64Array;
  trans: Float64Array;
}

/**
 * Parses one coordinate triplet, e.g. `-y,x-y,z+1/2`.
 *
 * Deliberately strict: anything it does not understand throws rather than
 * silently contributing a zero row, which would be an operator that collapses
 * the cell onto a plane and still looks like a matrix.
 */
export function parseSymOp(triplet: string): SymOp {
  const rot = new Float64Array(9);
  const trans = new Float64Array(3);
  const parts = triplet.split(',');
  if (parts.length !== 3) throw new Error(`symop needs three parts: ${triplet}`);

  parts.forEach((part, row) => {
    const text = part.replace(/\s+/g, '').toLowerCase();
    // Split into signed terms: -y, +1/2, x, 2/3 ...
    const terms = text.match(/[+-]?[^+-]+/g);
    if (!terms) throw new Error(`empty symop component: ${triplet}`);
    for (const term of terms) {
      const sign = term.startsWith('-') ? -1 : 1;
      const body = term.replace(/^[+-]/, '');
      const axis = body === 'x' ? 0 : body === 'y' ? 1 : body === 'z' ? 2 : -1;
      if (axis >= 0) {
        rot[row * 3 + axis] += sign;
        continue;
      }
      const fraction = /^(\d+)\/(\d+)$/.exec(body);
      if (fraction) {
        trans[row] += sign * (Number(fraction[1]) / Number(fraction[2]));
        continue;
      }
      if (/^\d+(\.\d+)?$/.test(body)) {
        trans[row] += sign * Number(body);
        continue;
      }
      throw new Error(`unrecognised symop term "${term}" in ${triplet}`);
    }
  });

  return { rot, trans };
}

function compose(a: SymOp, b: SymOp): SymOp {
  const rot = new Float64Array(9);
  const trans = new Float64Array(3);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a.rot[i * 3 + k] * b.rot[k * 3 + j];
      rot[i * 3 + j] = sum;
    }
    let t = a.trans[i];
    for (let k = 0; k < 3; k++) t += a.rot[i * 3 + k] * b.trans[k];
    // Lattice translations are handled separately, so operators live in one cell.
    trans[i] = ((t % 1) + 1) % 1;
  }
  return { rot, trans };
}

function opKey(op: SymOp): string {
  const r = [...op.rot].map((v) => Math.round(v)).join(',');
  // 1/12 is the finest translation any space group uses; rounding to 1/24
  // separates distinct operators without letting float drift split one in two.
  const t = [...op.trans].map((v) => Math.round(((v % 1) + 1) % 1 * 24) % 24).join(',');
  return `${r}|${t}`;
}

const identity: SymOp = {
  rot: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  trans: new Float64Array(3),
};

/**
 * Every general-position operator of a space group, or null if the number is
 * not one this can build.
 *
 * Null covers three cases that all deserve the same treatment — a group a
 * protein cannot occupy, one whose generators are not listed, and one whose
 * closure disagrees with its known multiplicity. The last is the one worth
 * having: it means a generator here is wrong, and half a lattice is more
 * dangerous than none.
 */
export function spaceGroupOperators(symbol: string): SymOp[] | null {
  const spec = GROUPS[normaliseSpaceGroup(symbol)];
  if (!spec) return null;

  const seeds = [identity, ...spec.gens.map(parseSymOp)];
  for (const [x, y, z] of CENTRING[spec.centring]) {
    if (x === 0 && y === 0 && z === 0) continue;
    seeds.push({ rot: identity.rot, trans: new Float64Array([x, y, z]) });
  }

  const found = new Map<string, SymOp>();
  for (const op of seeds) found.set(opKey(op), op);

  // Close under composition. Bounded: the largest Sohncke group has 96
  // operators, so anything past a few hundred means the generators are wrong.
  for (let pass = 0; pass < 12; pass++) {
    const before = found.size;
    for (const a of [...found.values()]) {
      for (const b of [...found.values()]) {
        const c = compose(a, b);
        const key = opKey(c);
        if (!found.has(key)) found.set(key, c);
        if (found.size > 400) return null;
      }
    }
    if (found.size === before) break;
  }

  if (found.size !== spec.order) return null;
  return [...found.values()];
}

/** True when this symbol's operators can be built. */
export function spaceGroupKnown(symbol: string): boolean {
  return normaliseSpaceGroup(symbol) in GROUPS;
}

/**
 * International Tables number for a Hermann-Mauguin symbol, or null.
 *
 * Needed by the PDB reader, whose CRYST1 record carries the symbol and not the
 * number, while everything downstream keys on the number. Going through this
 * table rather than a symbol-to-number list of its own means a symbol nobody
 * has entered operators for produces no cell at all, instead of a cell whose
 * lattice cannot be built.
 */
export function spaceGroupNumber(symbol: string): number | null {
  return GROUPS[normaliseSpaceGroup(symbol)]?.number ?? null;
}

export interface UnitCell {
  a: number; b: number; c: number;
  alpha: number; beta: number; gamma: number;
}

/**
 * Fractional to Cartesian, in the standard PDB convention: a along x, b in the
 * xy plane, c wherever the angles put it. Column-major 3x3, so column j is the
 * Cartesian vector of fractional axis j.
 */
export function cellToCartesian(cell: UnitCell): Float64Array {
  const rad = Math.PI / 180;
  const ca = Math.cos(cell.alpha * rad);
  const cb = Math.cos(cell.beta * rad);
  const cg = Math.cos(cell.gamma * rad);
  const sg = Math.sin(cell.gamma * rad);
  const volume = Math.sqrt(
    Math.max(0, 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg),
  );

  const m = new Float64Array(9);
  m[0] = cell.a; m[3] = cell.b * cg; m[6] = cell.c * cb;
  m[1] = 0; m[4] = cell.b * sg; m[7] = cell.c * (ca - cb * cg) / sg;
  m[2] = 0; m[5] = 0; m[8] = cell.c * volume / sg;
  return m;
}

function invert3(m: Float64Array): Float64Array | null {
  const [a, b, c, d, e, f, g, h, i] = [
    m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8],
  ];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = new Float64Array(9);
  // Column-major out, same as in.
  inv[0] = (e * i - f * h) / det; inv[3] = (c * h - b * i) / det; inv[6] = (b * f - c * e) / det;
  inv[1] = (f * g - d * i) / det; inv[4] = (a * i - c * g) / det; inv[7] = (c * d - a * f) / det;
  inv[2] = (d * h - e * g) / det; inv[5] = (b * g - a * h) / det; inv[8] = (a * e - b * d) / det;
  return inv;
}

/**
 * The lattice neighbourhood: every symmetry operator in the reference cell and
 * in the 26 cells around it, as column-major 4x4 Cartesian matrices.
 *
 * The identity is dropped — that is the deposited coordinates, already
 * present — but the other operators of the home cell are kept, since those are
 * the neighbours sharing it.
 */
export function latticeOperators(
  symbol: string, cell: UnitCell, range = 1,
): Float32Array[] | null {
  const ops = spaceGroupOperators(symbol);
  if (!ops) return null;
  const toCart = cellToCartesian(cell);
  const toFrac = invert3(toCart);
  if (!toFrac) return null;

  const out: Float32Array[] = [];
  for (const op of ops) {
    for (let sa = -range; sa <= range; sa++) {
      for (let sb = -range; sb <= range; sb++) {
        for (let sc = -range; sc <= range; sc++) {
          const isIdentity = op.rot[0] === 1 && op.rot[4] === 1 && op.rot[8] === 1
            && op.rot[1] === 0 && op.rot[2] === 0 && op.rot[3] === 0
            && op.rot[5] === 0 && op.rot[6] === 0 && op.rot[7] === 0
            && Math.abs(op.trans[0]) < 1e-6 && Math.abs(op.trans[1]) < 1e-6
            && Math.abs(op.trans[2]) < 1e-6
            && sa === 0 && sb === 0 && sc === 0;
          if (isIdentity) continue;

          // Cartesian rotation is M R M-inverse; the translation is the
          // fractional shift carried through M.
          const m = new Float32Array(16);
          for (let col = 0; col < 3; col++) {
            for (let row = 0; row < 3; row++) {
              let sum = 0;
              for (let k = 0; k < 3; k++) {
                for (let l = 0; l < 3; l++) {
                  sum += toCart[k * 3 + row] * op.rot[k * 3 + l] * toFrac[col * 3 + l];
                }
              }
              m[col * 4 + row] = sum;
            }
          }
          const fx = op.trans[0] + sa, fy = op.trans[1] + sb, fz = op.trans[2] + sc;
          m[12] = toCart[0] * fx + toCart[3] * fy + toCart[6] * fz;
          m[13] = toCart[1] * fx + toCart[4] * fy + toCart[7] * fz;
          m[14] = toCart[2] * fx + toCart[5] * fy + toCart[8] * fz;
          m[15] = 1;
          out.push(m);
        }
      }
    }
  }
  return out;
}
