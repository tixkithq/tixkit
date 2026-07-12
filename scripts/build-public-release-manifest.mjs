#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jsonSchemaViolations,
  loadPublicDistribution,
  validatePublicDistribution,
} from './lib/public-distribution.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function argument(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} is required`);
  return resolve(argv[index + 1]);
}

function digest(algorithm, content) {
  return createHash(algorithm)
    .update(content)
    .digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

function migrationRange() {
  const migrations = execFileSync('git', ['ls-files', 'packages/db/src/migrations'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .map((path) => basename(path).match(/^(\d{4}(?:_\d+)?)/u)?.[1])
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  return { minimum: migrations[0], maximum: migrations.at(-1) };
}

function contractPins(distribution) {
  const pins = [];
  for (const contractPath of distribution.release.contracts) {
    const absolutePath = resolve(root, contractPath);
    if (statSync(absolutePath).isDirectory()) {
      const version = basename(contractPath);
      const checksums = readFileSync(resolve(absolutePath, 'CHECKSUMS.sha256'), 'utf8');
      const checksum = checksums
        .split('\n')
        .find((line) => line.endsWith('  openapi.json'))
        ?.split(/\s+/u)[0];
      if (!checksum) throw new Error(`${contractPath} has no OpenAPI checksum`);
      pins.push({ name: 'openapi', version, sha256: checksum });
      continue;
    }
    const bytes = readFileSync(absolutePath);
    pins.push({ name: contractPath, version: '1', sha256: digest('sha256', bytes) });
  }
  return pins.sort((left, right) => left.name.localeCompare(right.name));
}

function packPublicPackages(distribution, sourceRoot, artifactDirectory) {
  const temporary = !artifactDirectory;
  const outputDirectory =
    artifactDirectory ?? mkdtempSync(join(tmpdir(), 'tixkit-public-packages-'));
  mkdirSync(outputDirectory, { recursive: true });
  try {
    return distribution.release.packages
      .filter(({ ecosystem }) => ecosystem === 'npm' || ecosystem === 'npm-and-cdn')
      .map((entry) => {
        const packageDirectory = resolve(sourceRoot, entry.path);
        const packageManifest = JSON.parse(
          readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'),
        );
        const result = JSON.parse(
          execFileSync('npm', ['pack', '--json', '--pack-destination', outputDirectory], {
            cwd: packageDirectory,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
          }),
        )[0];
        const bytes = readFileSync(resolve(outputDirectory, result.filename));
        const integrity = `sha512-${digest('sha512', bytes)}`;
        if (result.integrity !== integrity)
          throw new Error(`${packageManifest.name} npm integrity does not match packed bytes`);
        return { name: packageManifest.name, version: packageManifest.version, integrity };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } finally {
    if (temporary) rmSync(outputDirectory, { recursive: true, force: true });
  }
}

export function packFromSourceArchive(
  distribution,
  sourceArchive,
  artifactDirectory,
  { install = true } = {},
) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'tixkit-public-source-'));
  try {
    execFileSync('tar', ['-xf', '-', '-C', sourceRoot], {
      input: sourceArchive,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (install)
      execFileSync('bun', ['install', '--frozen-lockfile'], {
        cwd: sourceRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
    return packPublicPackages(distribution, sourceRoot, artifactDirectory);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

export function publicReleaseManifestViolations(manifest) {
  const schema = JSON.parse(
    readFileSync(resolve(root, 'distribution/public-release-manifest.schema.json'), 'utf8'),
  );
  const compatibilitySchema = JSON.parse(
    readFileSync(resolve(root, 'distribution/cloud-core-compatibility.schema.json'), 'utf8'),
  );
  schema.properties.core = compatibilitySchema.$defs.core;
  return jsonSchemaViolations(manifest, schema);
}

export function publicImageViolations(images, distribution) {
  const violations = [];
  const expectedImageNames = distribution.release.images.map(({ name }) => name).sort();
  const actualImageNames = images.map(({ name }) => name).sort();
  if (JSON.stringify(actualImageNames) !== JSON.stringify(expectedImageNames))
    violations.push('image metadata must exactly cover the public image release inventory');
  for (const image of images) {
    const expectedRepository = `ghcr.io/${distribution.authority.publicRepository}-${image.name}`;
    if (!/^sha256:[a-f0-9]{64}$/u.test(image.digest))
      violations.push(`${image.name} has an invalid immutable digest`);
    if (image.reference !== `${expectedRepository}@${image.digest}`)
      violations.push(
        `${image.name} must use authoritative image repository ${expectedRepository}`,
      );
  }
  return violations;
}

export function publicReleaseContextViolations(
  distribution,
  { origin, status, githubActions = false, githubRepository = '' },
) {
  const violations = [];
  if (distribution.licensing.status !== 'approved')
    violations.push('public artifact release is blocked until legal approval is recorded');
  if (
    distribution.classification.topLevel.privateCloud.length > 0 ||
    distribution.classification.topLevel.internalPlanning.length > 0 ||
    distribution.classification.docs.internalPlanning.length > 0
  )
    violations.push('public artifact release must run from the extracted public-only repository');
  const expectedRepository = distribution.authority.publicRepository;
  const acceptedOrigins = new Set([
    `https://github.com/${expectedRepository}`,
    `https://github.com/${expectedRepository}.git`,
    `git@github.com:${expectedRepository}`,
    `git@github.com:${expectedRepository}.git`,
  ]);
  if (!acceptedOrigins.has(origin))
    violations.push(`public artifact release requires exact GitHub origin ${expectedRepository}`);
  if (githubActions && githubRepository !== expectedRepository)
    violations.push(`GitHub release context must be ${expectedRepository}`);
  if (status !== '') violations.push('public release manifest requires a clean source checkout');
  return violations;
}

export function assertPublicReleaseContext() {
  const distribution = validatePublicDistribution(loadPublicDistribution(root), root);
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  const violations = publicReleaseContextViolations(distribution, {
    origin,
    status,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
    githubRepository: process.env.GITHUB_REPOSITORY,
  });
  if (violations.length > 0) throw new Error(violations.join('\n'));
  return distribution;
}

export function buildPublicReleaseManifest(images, releaseVersion, packageArtifactDirectory) {
  const distribution = assertPublicReleaseContext();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion))
    throw new Error('release version must be an exact semantic version');
  const imageViolations = publicImageViolations(images, distribution);
  if (imageViolations.length > 0) throw new Error(imageViolations.join('\n'));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const sourceArchive = execFileSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  const apiContract = distribution.release.contracts.find((path) =>
    path.startsWith('artifacts/api/'),
  );
  if (!apiContract) throw new Error('public distribution has no active API contract');
  const agentContract = distribution.release.contracts.find((path) =>
    path.includes('agent-protocol'),
  );
  const manifest = {
    schemaVersion: 1,
    releaseVersion,
    core: {
      sourceCommit,
      sourceTreeSha256: digest('sha256', sourceArchive),
      apiVersion: basename(apiContract),
      migrationRange: migrationRange(),
      agentProtocol: agentContract
        ? { status: 'supported', version: basename(agentContract) }
        : { status: 'unavailable', version: '' },
      packages: packFromSourceArchive(distribution, sourceArchive, packageArtifactDirectory),
      images: [...images].sort((left, right) => left.name.localeCompare(right.name)),
      contracts: contractPins(distribution),
    },
  };
  const violations = publicReleaseManifestViolations(manifest);
  if (violations.length > 0)
    throw new Error(`generated public release manifest is invalid:\n${violations.join('\n')}`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--preflight')) {
    assertPublicReleaseContext();
    process.stdout.write('Public artifact release context is authoritative and clean.\n');
    process.exit(0);
  }
  const imagesPath = argument(process.argv.slice(2), '--images');
  const outputPath = argument(process.argv.slice(2), '--out');
  const packageArtifactDirectory = argument(process.argv.slice(2), '--package-artifacts');
  const releaseVersionIndex = process.argv.indexOf('--release-version');
  const releaseVersion = process.argv[releaseVersionIndex + 1];
  if (!releaseVersion) throw new Error('--release-version is required');
  const images = JSON.parse(readFileSync(imagesPath, 'utf8'));
  const manifest = buildPublicReleaseManifest(images, releaseVersion, packageArtifactDirectory);
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Built public release manifest ${outputPath}.\n`);
}
