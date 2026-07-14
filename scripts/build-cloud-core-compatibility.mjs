#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPublicReleaseAttestation } from './lib/public-release-attestation.mjs';
import {
  cloudRepositoryReleaseViolations,
  parseBunLock,
  resolvedPackageTuple,
  validateCloudCoreConsumer,
} from './validate-cloud-core-consumer.mjs';
import { cloudCoreInstallationInventory } from './verify-cloud-core-install.mjs';

const publicRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const gitExecutable = '/usr/bin/git';

function pathArgument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(argv[index + 1]);
}

function valueArgument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return argv[index + 1];
}

function privateHead(cloudRoot) {
  return execFileSync(gitExecutable, ['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: cloudRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
}

function consumedPublicPackages(publicRelease, lock) {
  const publicNames = new Set(publicRelease.core.packages.map(({ name }) => name));
  return [
    ...new Set(
      Object.values(lock.packages ?? {})
        .map(resolvedPackageTuple)
        .filter((resolution) => resolution && publicNames.has(resolution.name))
        .map(({ name }) => name),
    ),
  ].sort();
}

export function buildCloudCoreCompatibility({
  publicRelease,
  cloudRoot,
  cloudVersion,
  allowedPaths = [],
}) {
  if (typeof cloudVersion !== 'string' || cloudVersion.trim() !== cloudVersion || !cloudVersion)
    throw new Error('Cloud release version must be a non-empty trimmed string');
  const sourceCommit = privateHead(cloudRoot);
  const repositoryViolations = cloudRepositoryReleaseViolations(cloudRoot, sourceCommit, {
    allowedPaths,
  });
  if (repositoryViolations.length > 0)
    throw new Error(
      `Cloud/core compatibility generation failed:\n${repositoryViolations.join('\n')}`,
    );
  const lockPath = resolve(cloudRoot, 'bun.lock');
  const lock = parseBunLock(readFileSync(lockPath, 'utf8'));
  const manifest = {
    schemaVersion: 1,
    cloudRelease: {
      version: cloudVersion,
      sourceCommit,
      consumedPackages: consumedPublicPackages(publicRelease, lock),
      installations: [],
    },
    core: structuredClone(publicRelease.core),
  };
  manifest.cloudRelease.installations = cloudCoreInstallationInventory(manifest, cloudRoot);
  const violations = validateCloudCoreConsumer(manifest, publicRelease, cloudRoot, {
    allowedPaths,
  });
  if (violations.length > 0)
    throw new Error(`Cloud/core compatibility generation failed:\n${violations.join('\n')}`);
  return manifest;
}

function writeExclusive(path, bytes) {
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw new Error(`refusing to replace an existing compatibility manifest: ${path}`);
  const temporary = resolve(dirname(path), `.${process.pid}.cloud-core-compatibility.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
    rmSync(temporary);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const options = process.argv.slice(2);
  const cloudRoot = pathArgument(options, '--cloud-root');
  const publicReleasePath = pathArgument(options, '--public-release-manifest');
  const outputPath = pathArgument(options, '--out');
  const cloudVersion = valueArgument(options, '--cloud-version');
  const publicRelease = verifyPublicReleaseAttestation(publicRoot, publicReleasePath);
  const manifest = buildCloudCoreCompatibility({
    publicRelease,
    cloudRoot,
    cloudVersion,
    allowedPaths: [publicReleasePath, outputPath],
  });
  writeExclusive(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Built Cloud/core compatibility manifest ${outputPath}.\n`);
}
