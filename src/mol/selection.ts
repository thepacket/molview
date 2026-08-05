/**
 * Atom-specification language.
 *
 * Selections are the difference between "one style per pane" and a scene you
 * can compose. The grammar borrows ChimeraX's shape — `/A:1-140@CA` — because
 * it is compact enough to type into a palette and reads unambiguously:
 *
 *   /A,B          chains A and B (auth ids)
 *   :1-140,200    residues by sequence number
 *   :HEM          residues by component name
 *   @CA,N,C,O     atoms by name
 *   /A:1-140@CA   all three, intersected
 *
 * Combined with `and` / `or` / `not`, parentheses, and the category keywords
 * below (`protein`, `ligand`, `water`, `helix`, `backbone`, …).
 */

import { MolKind, SS, atomNameOf, resNameOf, type Structure } from './structure';
import { elementIndex } from './elements';

export class SelectionError extends Error {}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'chain'; values: string[] }
  | { kind: 'residue'; values: string[] }
  | { kind: 'atom'; values: string[] }
  | { kind: 'word'; value: string };

const WORD_OPERATORS: Record<string, Token['kind']> = {
  and: 'and', '&': 'and',
  or: 'or', '|': 'or',
  not: 'not', '~': 'not', '!': 'not',
};

/** Reads a comma-separated list following `/`, `:` or `@`. */
function readList(text: string, start: number): { values: string[]; next: number } {
  let i = start;
  const values: string[] = [];
  let current = '';

  while (i < text.length) {
    const c = text[i];
    if (c === ',') {
      values.push(current);
      current = '';
      i++;
      continue;
    }
    // A list ends at whitespace, a bracket, or the start of another part.
    if (/[\s()/:@]/.test(c)) break;
    current += c;
    i++;
  }
  if (current) values.push(current);

  return { values: values.filter(Boolean), next: i };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ kind: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ kind: 'rparen' }); i++; continue; }

    if (c === '/' || c === ':' || c === '@') {
      const { values, next } = readList(source, i + 1);
      if (values.length === 0) {
        throw new SelectionError(`Nothing follows "${c}" at position ${i + 1}`);
      }
      const kind = c === '/' ? 'chain' : c === ':' ? 'residue' : 'atom';
      tokens.push({ kind, values } as Token);
      i = next;
      continue;
    }

    if (c === '&' || c === '|' || c === '~' || c === '!') {
      tokens.push({ kind: WORD_OPERATORS[c] } as Token);
      i++;
      continue;
    }

    const word = /^[A-Za-z0-9_'*.-]+/.exec(source.slice(i));
    if (!word) throw new SelectionError(`Unexpected character "${c}" at position ${i}`);
    const value = word[0];
    i += value.length;

    const op = WORD_OPERATORS[value.toLowerCase()];
    if (op) tokens.push({ kind: op } as Token);
    else tokens.push({ kind: 'word', value });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Node =
  | { type: 'all' }
  | { type: 'none' }
  | { type: 'and'; left: Node; right: Node }
  | { type: 'or'; left: Node; right: Node }
  | { type: 'not'; operand: Node }
  | { type: 'kind'; kinds: number[] }
  | { type: 'ss'; values: number[] }
  | { type: 'chain'; values: string[] }
  | { type: 'residue'; values: string[] }
  | { type: 'atom'; values: string[] }
  | { type: 'element'; values: string[] }
  | { type: 'backbone' }
  | { type: 'sidechain' }
  | { type: 'hydrogen' }
  | { type: 'polymer' };

/** Keywords taking an argument, e.g. `chain A`, `element Fe`. */
const ARGUMENT_KEYWORDS: Record<string, 'chain' | 'residue' | 'atom' | 'element'> = {
  chain: 'chain',
  resname: 'residue',
  resid: 'residue',
  residue: 'residue',
  name: 'atom',
  atom: 'atom',
  element: 'element',
};

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  parse(): Node {
    if (this.tokens.length === 0) return { type: 'all' };
    const node = this.parseOr();
    if (this.pos < this.tokens.length) {
      throw new SelectionError('Unexpected trailing input in selection');
    }
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.pos++;
      left = { type: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    for (;;) {
      const token = this.peek();
      if (!token) break;
      if (token.kind === 'and') {
        this.pos++;
        left = { type: 'and', left, right: this.parseNot() };
        continue;
      }
      // Juxtaposition means intersection: "protein /A" is "protein and /A".
      if (token.kind === 'rparen' || token.kind === 'or') break;
      left = { type: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.peek()?.kind === 'not') {
      this.pos++;
      return { type: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (!token) throw new SelectionError('Selection ended unexpectedly');

    if (token.kind === 'lparen') {
      this.pos++;
      const inner = this.parseOr();
      if (this.peek()?.kind !== 'rparen') throw new SelectionError('Missing ")"');
      this.pos++;
      return inner;
    }

    if (token.kind === 'chain' || token.kind === 'residue' || token.kind === 'atom') {
      return this.parseSpec();
    }

    if (token.kind === 'word') {
      this.pos++;
      return this.parseWord(token.value);
    }

    throw new SelectionError('Expected a selection term');
  }

  /** `/A:1-50@CA` — each part appears at most once and they intersect. */
  private parseSpec(): Node {
    let node: Node | null = null;
    const seen = new Set<string>();

    for (;;) {
      const token = this.peek();
      if (!token) break;
      if (token.kind !== 'chain' && token.kind !== 'residue' && token.kind !== 'atom') break;
      if (seen.has(token.kind)) break;
      seen.add(token.kind);
      this.pos++;

      const part: Node = { type: token.kind, values: token.values } as Node;
      node = node ? { type: 'and', left: node, right: part } : part;
    }

    if (!node) throw new SelectionError('Empty selection specifier');
    return node;
  }

  private parseWord(rawWord: string): Node {
    const word = rawWord.toLowerCase();

    const argKind = ARGUMENT_KEYWORDS[word];
    if (argKind) {
      const next = this.peek();
      if (!next || next.kind !== 'word') {
        throw new SelectionError(`"${rawWord}" needs a value, e.g. "${word} A"`);
      }
      this.pos++;
      return { type: argKind, values: next.value.split(',').filter(Boolean) } as Node;
    }

    switch (word) {
      case 'all': case '*': return { type: 'all' };
      case 'none': return { type: 'none' };
      case 'protein': return { type: 'kind', kinds: [MolKind.Protein] };
      case 'nucleic': case 'dna': case 'rna':
        return { type: 'kind', kinds: [MolKind.Nucleic] };
      case 'polymer': return { type: 'polymer' };
      case 'water': case 'solvent': return { type: 'kind', kinds: [MolKind.Water] };
      case 'ion': case 'ions': return { type: 'kind', kinds: [MolKind.Ion] };
      case 'ligand': return { type: 'kind', kinds: [MolKind.Ligand] };
      case 'hetero': case 'het':
        return { type: 'kind', kinds: [MolKind.Ligand, MolKind.Ion, MolKind.Water] };
      case 'helix': case 'helices': return { type: 'ss', values: [SS.Helix] };
      case 'sheet': case 'strand': return { type: 'ss', values: [SS.Sheet] };
      case 'coil': case 'loop': return { type: 'ss', values: [SS.Coil, SS.Turn] };
      case 'backbone': case 'mainchain': return { type: 'backbone' };
      case 'sidechain': return { type: 'sidechain' };
      case 'hydrogen': case 'hydrogens': return { type: 'hydrogen' };
      case 'heavy': return { type: 'not', operand: { type: 'hydrogen' } };
      default:
        throw new SelectionError(`Unknown selection keyword "${rawWord}"`);
    }
  }
}

export interface ParsedSelection {
  readonly source: string;
  readonly node: Node;
}

export function parseSelection(source: string): ParsedSelection {
  return { source, node: new Parser(tokenize(source)).parse() };
}

/** Validates without evaluating; returns null when the expression is good. */
export function selectionError(source: string): string | null {
  try {
    parseSelection(source);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const PROTEIN_BACKBONE = new Set(['N', 'CA', 'C', 'O', 'OXT']);
const NUCLEIC_BACKBONE = new Set([
  'P', 'OP1', 'OP2', "O5'", "C5'", "C4'", "C3'", "O3'", "C2'", "C1'", "O4'", "O2'",
]);

function matchesRange(spec: string, seq: number, name: string): boolean {
  const range = /^(-?\d+)-(-?\d+)$/.exec(spec);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return seq >= from && seq <= to;
  }
  if (/^-?\d+$/.test(spec)) return seq === Number(spec);
  return name === spec.toUpperCase();
}

function evaluate(node: Node, s: Structure, out: Uint8Array): Uint8Array {
  const n = s.atomCount;

  switch (node.type) {
    case 'all':
      out.fill(1);
      return out;

    case 'none':
      out.fill(0);
      return out;

    case 'and': {
      evaluate(node.left, s, out);
      const right = evaluate(node.right, s, new Uint8Array(n));
      for (let i = 0; i < n; i++) out[i] &= right[i];
      return out;
    }

    case 'or': {
      evaluate(node.left, s, out);
      const right = evaluate(node.right, s, new Uint8Array(n));
      for (let i = 0; i < n; i++) out[i] |= right[i];
      return out;
    }

    case 'not': {
      evaluate(node.operand, s, out);
      for (let i = 0; i < n; i++) out[i] = out[i] ? 0 : 1;
      return out;
    }

    case 'hydrogen':
      for (let i = 0; i < n; i++) out[i] = s.element[i] === 1 ? 1 : 0;
      return out;

    case 'element': {
      const wanted = new Set(node.values.map((v) => elementIndex(v)));
      for (let i = 0; i < n; i++) out[i] = wanted.has(s.element[i]) ? 1 : 0;
      return out;
    }

    case 'atom': {
      const wanted = new Set(node.values.map((v) => v.toUpperCase()));
      for (let i = 0; i < n; i++) {
        out[i] = wanted.has(atomNameOf(s, i).toUpperCase()) ? 1 : 0;
      }
      return out;
    }

    case 'backbone':
    case 'sidechain': {
      const backboneWanted = node.type === 'backbone';
      for (let r = 0; r < s.residueCount; r++) {
        const kind = s.resKind[r];
        const polymer = kind === MolKind.Protein || kind === MolKind.Nucleic;
        const table = kind === MolKind.Nucleic ? NUCLEIC_BACKBONE : PROTEIN_BACKBONE;
        for (let a = s.resAtomStart[r], e = s.resAtomStart[r + 1]; a < e; a++) {
          if (!polymer) { out[a] = 0; continue; }
          const isBackbone = table.has(atomNameOf(s, a).toUpperCase());
          out[a] = isBackbone === backboneWanted ? 1 : 0;
        }
      }
      return out;
    }

    // Residue- and chain-level predicates: decide once per residue, then fill.
    default: {
      for (let r = 0; r < s.residueCount; r++) {
        let hit = false;
        switch (node.type) {
          case 'kind':
            hit = node.kinds.includes(s.resKind[r]);
            break;
          case 'polymer': {
            const k = s.resKind[r];
            hit = k === MolKind.Protein || k === MolKind.Nucleic;
            break;
          }
          case 'ss':
            hit = s.resKind[r] === MolKind.Protein && node.values.includes(s.resSS[r]);
            break;
          case 'chain': {
            const auth = s.chainAuthId[s.resChain[r]];
            hit = node.values.includes(auth)
              || node.values.some((v) => v.toUpperCase() === auth.toUpperCase());
            break;
          }
          case 'residue': {
            const name = resNameOf(s, r);
            const seq = s.resSeq[r];
            hit = node.values.some((v) => matchesRange(v, seq, name));
            break;
          }
          default:
            hit = false;
        }
        out.fill(hit ? 1 : 0, s.resAtomStart[r], s.resAtomStart[r + 1]);
      }
      return out;
    }
  }
}

/** Evaluates a parsed selection to a per-atom mask. */
export function evaluateSelection(selection: ParsedSelection, s: Structure): Uint8Array {
  return evaluate(selection.node, s, new Uint8Array(s.atomCount));
}

export function countSelected(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count;
}

/** Suggestions offered in the selection input. */
export const SELECTION_KEYWORDS = [
  'all', 'protein', 'nucleic', 'polymer', 'ligand', 'ion', 'water', 'hetero',
  'helix', 'sheet', 'coil', 'backbone', 'sidechain', 'hydrogen', 'heavy',
  'and', 'or', 'not',
];

export const SELECTION_EXAMPLES: { label: string; value: string }[] = [
  { label: 'Everything', value: 'all' },
  { label: 'Protein only', value: 'protein' },
  { label: 'Ligands and ions', value: 'ligand or ion' },
  { label: 'Chain A', value: '/A' },
  { label: 'Residues 1–140 of chain A', value: '/A:1-140' },
  { label: 'Cα trace', value: '@CA' },
  { label: 'Helices, backbone only', value: 'helix and backbone' },
  { label: 'Haem groups', value: ':HEM' },
  { label: 'Everything but water', value: 'not water' },
];
