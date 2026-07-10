import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'apps/checkout/public/tixkit-widget.js');
const check = process.argv.includes('--check');

const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/widget/src/index.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  write: false,
  legalComments: 'none',
});

const output = result.outputFiles.at(0)?.text;
if (!output) throw new Error('Widget build produced no JavaScript output.');

if (check) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== output) {
    console.error(
      'apps/checkout/public/tixkit-widget.js is stale. Run bun run sync:widget-public.',
    );
    process.exitCode = 1;
  } else {
    console.log('Checkout public widget bundle matches packages/widget/src/index.ts.');
  }
} else {
  await writeFile(target, output, 'utf8');
  console.log('Updated apps/checkout/public/tixkit-widget.js.');
}
