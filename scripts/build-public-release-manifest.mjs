#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  jsonSchemaViolations,
  agentIntegrationSkillViolations,
  loadPublicDistribution,
  validatePublicDistribution,
} from './lib/public-distribution.mjs';
import { packageContentDigest } from './lib/package-content-digest.mjs';
import { assertSecureGitProvenanceRoot } from './lib/authoritative-public-repository.mjs';

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

function git(arguments_, options = {}) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd: root,
    ...options,
    env: { ...process.env, ...options.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function migrationRange(sourceRoot) {
  const migrations = readdirSync(resolve(sourceRoot, 'packages/db/src/migrations'))
    .map((name) => name.match(/^(\d{4}(?:_\d+)?)/u)?.[1])
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
  return { minimum: migrations[0], maximum: migrations.at(-1) };
}

export function publicContractPins(distribution, activeApiContract, sourceRoot = root) {
  const pins = [];
  for (const contractPath of distribution.release.contracts) {
    const absolutePath = resolve(sourceRoot, contractPath);
    if (statSync(absolutePath).isDirectory()) {
      const version = basename(contractPath);
      const checksums = readFileSync(resolve(absolutePath, 'CHECKSUMS.sha256'), 'utf8');
      const checksum = checksums
        .split('\n')
        .find((line) => line.endsWith('  openapi.json'))
        ?.split(/\s+/u)[0];
      if (!checksum) throw new Error(`${contractPath} has no OpenAPI checksum`);
      pins.push({
        name: contractPath === activeApiContract ? 'openapi' : contractPath,
        version,
        sha256: checksum,
      });
      continue;
    }
    const bytes = readFileSync(absolutePath);
    pins.push({
      name: contractPath,
      version: '1',
      sha256: digest('sha256', bytes),
    });
  }
  return pins.sort((left, right) => left.name.localeCompare(right.name));
}

export function stagePublicContractArtifacts(
  distribution,
  manifest,
  artifactDirectory,
  sourceRoot = root,
) {
  const apiContract = distribution.release.contracts.find((path) =>
    path.startsWith('artifacts/api/'),
  );
  const sources = new Map(
    manifest.core.contracts.map((pin) => {
      const contractPath = pin.name === 'openapi' ? apiContract : pin.name;
      if (!contractPath || !distribution.release.contracts.includes(contractPath))
        throw new Error(`public contract pin has no distribution source: ${pin.name}`);
      const absolutePath = resolve(sourceRoot, contractPath);
      const sourcePath = statSync(absolutePath).isDirectory()
        ? resolve(absolutePath, 'openapi.json')
        : absolutePath;
      return [pin.sha256, sourcePath];
    }),
  );
  mkdirSync(artifactDirectory, { recursive: true });
  for (const [sha256, sourcePath] of sources) {
    const bytes = readFileSync(sourcePath);
    if (digest('sha256', bytes) !== sha256)
      throw new Error(`public contract source does not match its pin: ${sourcePath}`);
    const outputPath = resolve(artifactDirectory, `contract-${sha256}.json`);
    const existing = statSync(outputPath, { throwIfNoEntry: false });
    if (existing && !readFileSync(outputPath).equals(bytes))
      throw new Error(`public contract asset path contains different bytes: ${outputPath}`);
    writeFileSync(outputPath, bytes);
  }
  return [...sources.keys()].sort().map((sha256) => `contract-${sha256}.json`);
}

export function stageAgentIntegrationSkillArtifacts(
  distribution,
  artifactDirectory,
  sourceRoot = root,
) {
  const declaredSkills = distribution.release.agentIntegrationSkills;
  if (
    declaredSkills === undefined ||
    (Array.isArray(declaredSkills) && declaredSkills.length === 0)
  )
    return [];
  const violations = agentIntegrationSkillViolations(distribution, sourceRoot);
  if (violations.length > 0) {
    throw new Error(`agent integration skill validation failed:\n${violations.join('\n')}`);
  }
  mkdirSync(artifactDirectory, { recursive: true });
  const staged = [];
  for (const entry of declaredSkills) {
    const directory = resolve(sourceRoot, entry.path);
    const manifestBytes = readFileSync(resolve(directory, 'artifact-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const artifactNames = new Set();
    for (const artifact of manifest.artifacts) {
      if (
        !artifact ||
        typeof artifact.name !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(artifact.name) ||
        artifact.name.split('/').some((segment) => segment === '.' || segment === '..') ||
        artifactNames.has(artifact.name)
      ) {
        throw new Error('agent integration skill contains an unsafe or duplicate artifact name');
      }
      artifactNames.add(artifact.name);
    }
    const files = [
      ...manifest.artifacts.map(({ name }) => name),
      'artifact-manifest.json',
      'CHECKSUMS.sha256',
    ].sort();
    const envelope = `${JSON.stringify(
      {
        schemaVersion: 1,
        apiVersion: entry.apiVersion,
        sourceReleaseManifestSha256: entry.releaseManifestSha256,
        artifactManifestSha256: digest('sha256', manifestBytes),
        files: files.map((name) => {
          const bytes = readFileSync(resolve(directory, name));
          return {
            name,
            sha256: digest('sha256', bytes),
            size: bytes.byteLength,
            base64: bytes.toString('base64'),
          };
        }),
      },
      null,
      2,
    )}\n`;
    const envelopeSha256 = digest('sha256', envelope);
    const name = `contract-agent-skill-${entry.apiVersion}-${envelopeSha256}.json`;
    writeFileSync(resolve(artifactDirectory, name), envelope, { flag: 'wx' });
    staged.push(name);
  }
  return staged.sort();
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
        const extractedPackage = mkdtempSync(join(tmpdir(), 'tixkit-packed-package-'));
        try {
          execFileSync(
            'tar',
            ['-xzf', resolve(outputDirectory, result.filename), '-C', extractedPackage],
            { stdio: ['ignore', 'ignore', 'pipe'] },
          );
          const content = packageContentDigest(resolve(extractedPackage, 'package'));
          return {
            name: packageManifest.name,
            version: packageManifest.version,
            integrity,
            ...content,
          };
        } finally {
          rmSync(extractedPackage, { recursive: true, force: true });
        }
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
    if (install)
      execFileSync('bun', ['run', 'build'], {
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
  assertSecureGitProvenanceRoot(root);
  const distribution = validatePublicDistribution(loadPublicDistribution(root), root);
  const origin = git(['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
  }).trim();
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'], {
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

export function buildPublicReleaseManifestFromArchive({
  distribution,
  images,
  releaseVersion,
  sourceCommit,
  sourceArchive,
  packageArtifactDirectory,
  contractArtifactDirectory,
  install = true,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseVersion))
    throw new Error('release version must be an exact semantic version');
  const imageViolations = publicImageViolations(images, distribution);
  if (imageViolations.length > 0) throw new Error(imageViolations.join('\n'));
  const apiContract = distribution.release.contracts.find((path) =>
    path.startsWith('artifacts/api/'),
  );
  if (!apiContract) throw new Error('public distribution has no active API contract');
  const agentContract = distribution.release.contracts.find((path) =>
    path.includes('agent-protocol'),
  );
  const sourceRoot = mkdtempSync(join(tmpdir(), 'tixkit-public-release-source-'));
  try {
    execFileSync('/usr/bin/tar', ['-xf', '-', '-C', sourceRoot], {
      input: sourceArchive,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (install)
      execFileSync('bun', ['install', '--frozen-lockfile'], {
        cwd: sourceRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
    const packages = packPublicPackages(distribution, sourceRoot, packageArtifactDirectory);
    const unsynchronizedPackages = packages.filter(({ version }) => version !== releaseVersion);
    if (unsynchronizedPackages.length > 0)
      throw new Error(
        `public npm package versions must equal release ${releaseVersion}: ${unsynchronizedPackages
          .map(({ name, version }) => `${name}@${version}`)
          .join(', ')}`,
      );
    const manifest = {
      schemaVersion: 1,
      releaseVersion,
      core: {
        sourceCommit,
        sourceTreeSha256: digest('sha256', sourceArchive),
        apiVersion: basename(apiContract),
        migrationRange: migrationRange(sourceRoot),
        agentProtocol: agentContract
          ? {
              status: 'supported',
              version: basename(agentContract, '.json').replace(/^agent-protocol-/u, ''),
            }
          : { status: 'unavailable', version: '' },
        packages,
        images: [...images].sort((left, right) => left.name.localeCompare(right.name)),
        contracts: publicContractPins(distribution, apiContract, sourceRoot),
      },
    };
    const violations = publicReleaseManifestViolations(manifest);
    if (violations.length > 0)
      throw new Error(`generated public release manifest is invalid:\n${violations.join('\n')}`);
    if (contractArtifactDirectory)
      stagePublicContractArtifacts(distribution, manifest, contractArtifactDirectory, sourceRoot);
    if (contractArtifactDirectory)
      stageAgentIntegrationSkillArtifacts(distribution, contractArtifactDirectory, sourceRoot);
    return manifest;
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

export function buildPublicReleaseManifest(
  images,
  releaseVersion,
  packageArtifactDirectory,
  contractArtifactDirectory,
) {
  const distribution = assertPublicReleaseContext();
  const sourceCommit = git(['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const sourceArchive = git(['archive', '--format=tar', sourceCommit], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });
  return buildPublicReleaseManifestFromArchive({
    distribution,
    images,
    releaseVersion,
    sourceCommit,
    sourceArchive,
    packageArtifactDirectory,
    contractArtifactDirectory,
  });
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
  const manifest = buildPublicReleaseManifest(
    images,
    releaseVersion,
    packageArtifactDirectory,
    dirname(outputPath),
  );
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Built public release manifest ${outputPath}.\n`);
}
