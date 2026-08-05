/**
 * Parsing the model's reply.
 *
 * The reply is meant to be one JSON object, but LaTeX and JSON disagree about
 * backslashes and providers routinely emit `\frac` where JSON demands `\\frac`.
 * That turns `\f` into a form feed, or invalidates the document outright, and
 * an otherwise good answer is lost. So the message is recovered with a small
 * hand-written scanner *before* JSON.parse is attempted, and that recovery wins
 * when the two disagree.
 */

import { isAction, type Action } from './actionTypes';

export interface ParsedReply {
  message: string;
  actions: Action[];
}

const JSON_ESCAPES: Record<string, string> = {
  '"': '"', '\\': '\\', '/': '/',
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
};

/**
 * Reads the `message` string directly out of the raw text, keeping LaTeX
 * intact. Returns null when there is no message field to find.
 */
function extractMessage(raw: string): string | null {
  const key = /"message"\s*:\s*"/.exec(raw);
  if (!key) return null;

  let i = key.index + key[0].length;
  let out = '';
  let inMath = false;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '"') break; // unescaped quote ends the string

    if (ch === '$') {
      // `$` or `$$` flips math mode; the count does not matter, only the flip.
      const double = raw[i + 1] === '$';
      out += double ? '$$' : '$';
      inMath = !inMath;
      i += double ? 2 : 1;
      continue;
    }

    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }

    const next = raw[i + 1];
    if (next === undefined) break;

    // \[ \] \( \) delimit math and are not valid JSON escapes either way.
    if (next === '[' || next === '(') { inMath = true; out += `\\${next}`; i += 2; continue; }
    if (next === ']' || next === ')') { inMath = false; out += `\\${next}`; i += 2; continue;

    }

    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
      i += 6;
      continue;
    }

    // A properly escaped backslash is always just a backslash.
    if (next === '\\') { out += '\\'; i += 2; continue; }

    // Inside math, `\` followed by a letter is a LaTeX command, not a JSON
    // escape — this is the whole reason the scanner exists.
    if (inMath && /[a-zA-Z]/.test(next)) { out += `\\${next}`; i += 2; continue; }

    const escaped = JSON_ESCAPES[next];
    if (escaped !== undefined) { out += escaped; i += 2; continue; }

    // Unknown escape: keep it rather than dropping information.
    out += `\\${next}`;
    i += 2;
  }

  return out;
}

export function parseReply(raw: string): ParsedReply {
  const trimmed = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  const recovered = extractMessage(trimmed);

  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; actions?: unknown };
    if (typeof parsed.message !== 'string') throw new Error('missing message');
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.filter(isAction).slice(0, 12)
      : [];
    return { message: recovered ?? parsed.message, actions };
  } catch {
    // Valid message, unusable envelope: show the answer, drop the actions.
    if (recovered != null) return { message: recovered, actions: [] };

    if (/^\s*\{\s*"message"\s*:/.test(trimmed)) {
      throw new Error(
        'The model returned an incomplete reply. Try again, or ask for something shorter.',
      );
    }

    // Models without structured output sometimes just answer in prose. That is
    // still useful, so render it rather than discarding it.
    return { message: raw, actions: [] };
  }
}
