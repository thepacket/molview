import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = await mkdtemp(join(tmpdir(), 'molview-tests-'));
try {
  const outfile = join(directory, 'science.test.mjs');
  await build({
    entryPoints: ['tests/science.test.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    loader: { '.wgsl': 'text' },
    define: { 'import.meta.env.DEV': 'false' },
  });
  const result = spawnSync(process.execPath, ['--test', outfile], {
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
