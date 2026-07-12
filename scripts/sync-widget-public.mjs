import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const target = resolve(root, 'apps/checkout/public/tixkit-widget.js');
const check = process.argv.includes('--check');
const packageJson = JSON.parse(
  await readFile(resolve(root, 'packages/widget/package.json'), 'utf8'),
);
const targetMap = resolve(root, `apps/checkout/public/tixkit-widget-${packageJson.version}.js.map`);
const temporary = await mkdtemp(resolve(tmpdir(), 'tixkit-widget-public-'));

try {
  execFileSync('node', ['scripts/build-widget-release.mjs', temporary], {
    cwd: root,
    stdio: 'inherit',
  });
  const releaseName = `tixkit-widget-${packageJson.version}.js`;
  const output = await readFile(resolve(temporary, releaseName));
  const outputMap = await readFile(resolve(temporary, `${releaseName}.map`));
  if (check) {
    const current = await readFile(target).catch(() => Buffer.alloc(0));
    const currentMap = await readFile(targetMap).catch(() => Buffer.alloc(0));
    if (!current.equals(output) || !currentMap.equals(outputMap)) {
      console.error('Checkout public widget bundle is stale. Run bun run sync:widget-public.');
      process.exitCode = 1;
    } else {
      console.log('Checkout public widget bundle is byte-identical to the release artifact.');
    }
  } else {
    await writeFile(target, output);
    await writeFile(targetMap, outputMap);
    console.log('Updated checkout public widget from the verified release artifact.');
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
