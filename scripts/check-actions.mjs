/**
 * Fails the build when the README's account of the assistant's vocabulary no
 * longer matches the vocabulary.
 *
 * This exists because it drifted. The README claimed "Twenty action types" and
 * named sixteen categories while ACTION_REFERENCE held thirty entries — density
 * maps, real-space fit, surfaces, pockets, ligand contacts, validation,
 * annotations, similarity search, predicted structures, palette, clipping,
 * spin and pane had all been added without the sentence describing them being
 * touched. Nothing fails when documentation goes stale, which is exactly why it
 * needs a check rather than a habit.
 *
 * The reference list is what the model is handed, so it is the authority. Two
 * things are verified: that every declared action type has an entry describing
 * it, and that the README's count is that number.
 */

import { existsSync, readFileSync } from 'node:fs';

const NUMBER_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23, 'twenty-four': 24,
  'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27, 'twenty-eight': 28,
  'twenty-nine': 29, thirty: 30, 'thirty-one': 31, 'thirty-two': 32,
  'thirty-three': 33, 'thirty-four': 34, 'thirty-five': 35, 'thirty-six': 36,
  'thirty-seven': 37, 'thirty-eight': 38, 'thirty-nine': 39, forty: 40,
};

const source = readFileSync('src/ai/actionTypes.ts', 'utf8');


const typesBlock = source.slice(
  source.indexOf('ACTION_TYPES = ['),
  source.indexOf('] as const;'),
);
const types = new Set([...typesBlock.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));

const referenceBlock = source.slice(source.indexOf('ACTION_REFERENCE'));
const documented = [...referenceBlock.matchAll(/\{ type: '([a-z-]+)'/g)].map((m) => m[1]);
const documentedSet = new Set(documented);

let failed = false;

const undocumented = [...types].filter((t) => !documentedSet.has(t));
if (undocumented.length > 0) {
  console.error('Actions: declared in ACTION_TYPES but absent from ACTION_REFERENCE.');
  console.error('The model is never told these exist, so they cannot be used:\n');
  for (const t of undocumented) console.error(`  ${t}`);
  failed = true;
}

const orphaned = documented.filter((t) => !types.has(t));
if (orphaned.length > 0) {
  console.error('\nActions: described in ACTION_REFERENCE but not a declared type:\n');
  for (const t of orphaned) console.error(`  ${t}`);
  failed = true;
}

/**
 * The README half is skipped when there is no README, which is the case inside
 * the Docker build: `.dockerignore` excludes `*.md` on purpose, so that editing
 * documentation neither enters the image nor invalidates its layer cache.
 *
 * Skipping rather than failing is the right way round. This check exists to
 * catch prose drifting away from code, and prose is edited in a working tree,
 * where the file is present and the check runs. A deployment build has no
 * README to disagree with the code, so there is nothing there to catch — but it
 * says so rather than passing silently, because a check that quietly does
 * nothing is worse than no check at all.
 */
if (!existsSync('README.md')) {
  console.log(`Actions: ${documented.length} types, all described. `
    + 'README count not checked — no README in this build context.');
  process.exit(failed ? 1 : 0);
}

const readme = readFileSync('README.md', 'utf8');
const claim = /\b([A-Za-z][a-z-]+|\d+) action types cover/.exec(readme);
if (!claim) {
  console.error('\nActions: README no longer states an action count in the form '
    + '"<N> action types cover ...", so it cannot be checked.');
  failed = true;
} else {
  const word = claim[1].toLowerCase();
  const stated = NUMBER_WORDS[word] ?? Number(word);
  if (stated !== documented.length) {
    console.error(`\nActions: README says "${claim[1]} action types" but `
      + `ACTION_REFERENCE has ${documented.length}.`);
    console.error('Update the sentence in README.md, including the list of categories.');
    failed = true;
  }
}

if (failed) process.exit(1);

console.log(`Actions: ${documented.length} types, all described and counted.`);
