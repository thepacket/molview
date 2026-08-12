/**
 * Fails the build when the source talks to a host the production CSP forbids.
 *
 * This exists because three features shipped broken. Density maps, AlphaFold
 * and UniProt search were each added, each verified against the dev server —
 * where no CSP applies — and each silently blocked in production, surfacing as
 * "the density server could not be reached". The dev/prod asymmetry means
 * testing cannot catch it; only a check can.
 *
 * Hosts that are only ever link targets are listed below rather than added to
 * connect-src, because a navigation is not a fetch and widening the policy for
 * one would be wrong.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LINK_ONLY = new Set([
  'https://doi.org',
  'https://github.com',
  'https://www.rcsb.org',
  // The Atlas entry page. Coordinates come from api.esmatlas.com, which is a
  // fetch and is in connect-src; this is only ever an href.
  'https://esmatlas.com',
]);

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const hosts = new Set();
for (const file of sourceFiles('src')) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/https:\/\/[a-zA-Z0-9.-]+/g)) hosts.add(match[0]);
}

const conf = readFileSync('security-headers.conf', 'utf8');
// The policy value first, then the directive inside it. Matching `connect-src`
// against the whole file finds the word in this file's own comments, which is
// how the first version of this check passed on nothing at all.
const policy = /Content-Security-Policy\s+"([^"]*)"/.exec(conf)?.[1];
if (!policy) {
  console.error('CSP: no Content-Security-Policy header found in security-headers.conf');
  process.exit(1);
}
const connectSrc = /(?:^|;)\s*connect-src([^;]*)/.exec(policy)?.[1] ?? '';
const allowed = new Set(connectSrc.match(/https:\/\/[a-zA-Z0-9.-]+/g) ?? []);
if (allowed.size === 0) {
  console.error('CSP: connect-src parsed as empty — the check would pass vacuously.');
  process.exit(1);
}

const missing = [...hosts].filter((h) => !LINK_ONLY.has(h) && !allowed.has(h)).sort();
const unused = [...allowed].filter((h) => !hosts.has(h)).sort();

if (missing.length > 0) {
  console.error('CSP: the source fetches hosts that connect-src does not allow.');
  console.error('These will fail in production and work in dev:\n');
  for (const host of missing) console.error(`  ${host}`);
  console.error('\nAdd them to connect-src in security-headers.conf, or to');
  console.error('LINK_ONLY in scripts/check-csp.mjs if they are only ever hrefs.');
  process.exit(1);
}

if (unused.length > 0) {
  console.warn(`CSP: allowed but no longer used — ${unused.join(' ')}`);
}

console.log(`CSP: ${hosts.size - LINK_ONLY.size} fetched hosts, all allowed.`);
