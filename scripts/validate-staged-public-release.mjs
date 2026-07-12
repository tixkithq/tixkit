#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicReleaseManifestViolations } from './build-public-release-manifest.mjs';

function value(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return argv[index + 1];
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const REQUIRED_RELEASE_ASSETS = [
  'public-release-manifest.json',
  'images.json',
  'CHECKSUMS.sha256',
  'npm-packages.spdx.json',
  'image-admin.spdx.json',
  'image-api.spdx.json',
  'image-checkout.spdx.json',
  'image-worker.spdx.json',
];

export function classifyStagedPublicRelease(directory) {
  const files = readdirSync(directory).sort();
  if (REQUIRED_RELEASE_ASSETS.some((required) => !files.includes(required))) return 'incomplete';
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, 'public-release-manifest.json'), 'utf8'),
    );
    const packageCount = files.filter((name) => name.endsWith('.tgz')).length;
    if (packageCount < (manifest.core?.packages?.length ?? 0)) return 'incomplete';
    if (packageCount > (manifest.core?.packages?.length ?? 0)) return 'invalid';
    const checksumNames = readFileSync(resolve(directory, 'CHECKSUMS.sha256'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(/\s{2}/u)[1]);
    if (checksumNames.some((name) => !files.includes(name))) return 'incomplete';
    return 'complete';
  } catch {
    return 'invalid';
  }
}

export function validateStagedPublicRelease(directory, sourceCommit, releaseVersion) {
  const violations = [];
  const files = readdirSync(directory).sort();
  for (const required of REQUIRED_RELEASE_ASSETS)
    if (!files.includes(required)) violations.push(`staged release is missing ${required}`);
  if (violations.length > 0) return violations;

  const manifest = JSON.parse(
    readFileSync(resolve(directory, 'public-release-manifest.json'), 'utf8'),
  );
  violations.push(...publicReleaseManifestViolations(manifest));
  if (manifest.core?.sourceCommit !== sourceCommit)
    violations.push('staged release source commit does not match the tag commit');
  if (manifest.releaseVersion !== releaseVersion)
    violations.push('staged release version does not match the tag');
  const images = JSON.parse(readFileSync(resolve(directory, 'images.json'), 'utf8'));
  if (JSON.stringify(images) !== JSON.stringify(manifest.core?.images))
    violations.push('staged image metadata does not match the release manifest');
  for (const file of files.filter((name) => name.endsWith('.spdx.json'))) {
    const sbom = JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
    if (!sbom.spdxVersion?.startsWith('SPDX-') || !Array.isArray(sbom.packages))
      violations.push(`staged SBOM is not a package-bearing SPDX document: ${file}`);
  }

  const expectedChecksums = new Map(
    readFileSync(resolve(directory, 'CHECKSUMS.sha256'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, name] = line.split(/\s{2}/u);
        return [name, hash];
      }),
  );
  const checksummedFiles = files.filter((name) => name !== 'CHECKSUMS.sha256');
  for (const file of checksummedFiles) {
    if (expectedChecksums.get(file) !== sha256(resolve(directory, file)))
      violations.push(`staged checksum mismatch: ${file}`);
    expectedChecksums.delete(file);
  }
  for (const extra of expectedChecksums.keys())
    violations.push(`staged checksum names absent asset: ${extra}`);

  const packagePins = new Map(
    (manifest.core?.packages ?? []).map((pin) => [`${pin.name}@${pin.version}`, pin.integrity]),
  );
  for (const file of files.filter((name) => name.endsWith('.tgz'))) {
    const artifact = resolve(directory, file);
    const packageManifest = JSON.parse(
      execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }),
    );
    const identity = `${packageManifest.name}@${packageManifest.version}`;
    const integrity = `sha512-${createHash('sha512').update(readFileSync(artifact)).digest('base64')}`;
    if (packagePins.get(identity) !== integrity)
      violations.push(`staged package integrity mismatch: ${identity}`);
    packagePins.delete(identity);
  }
  for (const missing of packagePins.keys())
    violations.push(`staged package asset is missing: ${missing}`);
  return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const directory = resolve(value(process.argv, '--directory'));
  if (process.argv.includes('--classify')) {
    process.stdout.write(`${classifyStagedPublicRelease(directory)}\n`);
    process.exit(0);
  }
  const violations = validateStagedPublicRelease(
    directory,
    value(process.argv, '--source-commit'),
    value(process.argv, '--release-version'),
  );
  if (violations.length > 0)
    throw new Error(`staged public release validation failed:\n${violations.join('\n')}`);
  process.stdout.write(`Validated resumable staged public release ${directory}.\n`);
}
