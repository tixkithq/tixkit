#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(argv[index + 1]);
}

export function publishPublicNpmArtifacts(manifest, artifactDirectory, run = spawnSync) {
  const expectedPins = new Map(
    manifest.core.packages.map((pin) => [`${pin.name}@${pin.version}`, pin.integrity]),
  );
  const published = [];
  const reused = [];
  const missingPublications = [];
  for (const filename of readdirSync(artifactDirectory)
    .filter((name) => name.endsWith('.tgz'))
    .sort()) {
    const artifact = resolve(artifactDirectory, filename);
    const packageManifest = JSON.parse(
      execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }),
    );
    const identity = `${packageManifest.name}@${packageManifest.version}`;
    const integrity = `sha512-${createHash('sha512').update(readFileSync(artifact)).digest('base64')}`;
    if (expectedPins.get(identity) !== integrity)
      throw new Error(`${identity} tarball does not match the public release manifest`);
    expectedPins.delete(identity);

    const lookup = run('npm', ['view', identity, 'dist.integrity'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (lookup.status === 0) {
      if (lookup.stdout.trim() !== integrity)
        throw new Error(`${identity} already exists with different immutable bytes`);
      reused.push(identity);
      continue;
    }
    if (!/E404|404 Not Found/u.test(lookup.stderr))
      throw new Error(`registry lookup failed for ${identity}: ${lookup.stderr.trim()}`);
    missingPublications.push({ artifact, identity });
  }
  if (expectedPins.size > 0)
    throw new Error(`missing npm tarballs: ${[...expectedPins.keys()].join(', ')}`);
  for (const { artifact, identity } of missingPublications) {
    const publication = run('npm', ['publish', artifact, '--provenance', '--access', 'public'], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (publication.status !== 0) throw new Error(`npm publication failed for ${identity}`);
    published.push(identity);
  }
  return { published, reused };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const manifestPath = argument(process.argv.slice(2), '--manifest');
  const artifactDirectory = argument(process.argv.slice(2), '--package-artifacts');
  const result = publishPublicNpmArtifacts(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    artifactDirectory,
  );
  process.stdout.write(
    `Published ${result.published.length} and reused ${result.reused.length} identical npm artifacts.\n`,
  );
}
