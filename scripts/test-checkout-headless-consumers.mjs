#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packageDirectory = join(root, 'packages/checkout-headless');
const examplesDirectory = join(root, 'examples/checkout-headless');
const output = mkdtempSync(join(tmpdir(), 'tixkit-headless-consumers-'));
const consumers = ['react', 'next', 'vue', 'nuxt', 'svelte', 'sveltekit', 'remix', 'astro'];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  run('bun', ['run', 'clean'], packageDirectory);
  run('bun', ['run', 'build'], packageDirectory);
  const pack = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', output], packageDirectory),
  );
  const tarball = join(output, pack[0].filename);

  for (const consumer of consumers) {
    const source = join(examplesDirectory, consumer);
    const directory = join(output, consumer);
    cpSync(source, directory, { recursive: true });
    const packagePath = join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    manifest.dependencies['@tixkit/checkout-headless'] = `file:${tarball}`;
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    run('bun', ['install'], directory);
    run('bun', ['run', 'build'], directory);
    const installed = JSON.parse(
      readFileSync(join(directory, 'node_modules/@tixkit/checkout-headless/package.json'), 'utf8'),
    );
    if (installed.version !== '1.0.0') {
      throw new Error(`${consumer} resolved unexpected headless version ${installed.version}.`);
    }
  }
  process.stdout.write(`Built ${consumers.length} clean packed-artifact framework examples.\n`);
} finally {
  rmSync(output, { recursive: true, force: true });
}
