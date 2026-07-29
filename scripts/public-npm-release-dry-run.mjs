#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPublicDistribution, validatePublicDistribution } from './lib/public-distribution.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check');
const manifest = validatePublicDistribution(loadPublicDistribution(root), root);
const packages = manifest.release.packages.filter(
  ({ ecosystem }) => ecosystem === 'npm' || ecosystem === 'npm-and-cdn',
);

if (checkOnly) {
  process.stdout.write(`Validated ${packages.length} manifest-driven npm release packages.\n`);
  process.exit(0);
}

const outputDirectory = resolve(root, 'public-release-provenance');
mkdirSync(outputDirectory, { recursive: true });

const build = spawnSync('bun', ['run', 'build'], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
writeFileSync(resolve(outputDirectory, 'workspace-build.log'), build.stdout || build.stderr);
if (build.status !== 0) {
  process.stderr.write(build.stderr);
  throw new Error('workspace build failed before npm pack dry-run');
}

for (const entry of packages) {
  const packageDirectory = resolve(root, entry.path);
  const packageManifest = JSON.parse(
    readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'),
  );
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageDirectory,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const artifactName = `${basename(entry.path)}-npm-pack.json`;
  writeFileSync(resolve(outputDirectory, artifactName), result.stdout || result.stderr);
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`npm pack dry-run failed for ${packageManifest.name} (${entry.path})`);
  }
  process.stdout.write(`Packed ${packageManifest.name} from ${entry.path}.\n`);
}
