#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  API_PROVENANCE_EXCLUSIONS,
  canonicalJson,
  collectCommittedApiReleaseProvenance,
  formatJson,
  sha256,
} from './lib/api-release-provenance.ts';
import {
  assertAuthoritativePublicRepository,
  authoritativeApiVersion,
} from './lib/authoritative-public-repository.mjs';

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return value;
}

export function publicRepositoryValidationCommands({ createSnapshot = false } = {}) {
  const repositoryPreparation = createSnapshot
    ? [
        ['git', ['init', '-q']],
        ['git', ['remote', 'add', 'origin', 'https://github.com/tixkithq/tixkit.git']],
        ['git', ['add', '-A']],
        [
          'git',
          [
            '-c',
            'user.name=Tixkit Public Rehearsal',
            '-c',
            'user.email=public-rehearsal@tixkit.invalid',
            'commit',
            '-qm',
            'Public repository rehearsal snapshot',
          ],
        ],
      ]
    : [
        ['git', ['rev-parse', '--verify', 'HEAD']],
        ['git', ['diff', '--quiet', 'HEAD', '--']],
        ['git', ['diff', '--cached', '--quiet', 'HEAD', '--']],
      ];
  const provenanceValidation = createSnapshot
    ? [
        'bun',
        [
          'scripts/validate-api-release-provenance.ts',
          '--allow-recorded-source',
          '--allow-derived-export',
        ],
      ]
    : ['bun', ['scripts/validate-api-release-provenance.ts']];
  return [
    ...repositoryPreparation,
    ['node', ['scripts/validate-public-distribution.mjs']],
    ['bun', ['install', '--frozen-lockfile']],
    ['bun', ['run', 'format:check']],
    ['bun', ['run', 'lint', '--force']],
    ['bun', ['run', 'typecheck', '--force']],
    ['bun', ['run', 'test:unit']],
    provenanceValidation,
    ['git', ['restore', '--worktree', '--', 'artifacts/api', 'apps/docs/public/contracts']],
    ['bun', ['run', 'build']],
    ['node', ['packages/cli/dist/index.js', '--help']],
    ['git', ['diff', '--exit-code', 'HEAD', '--']],
    ['git', ['diff', '--cached', '--exit-code', 'HEAD', '--']],
  ];
}

export function rebindPublicApiReleaseProvenance(repository) {
  assertAuthoritativePublicRepository(repository);
  execFileSync('node', ['scripts/validate-public-distribution.mjs'], {
    cwd: repository,
    stdio: 'inherit',
  });
  const distributionPath = resolve(repository, 'distribution/public-distribution.json');
  const originalDistribution = readFileSync(distributionPath);
  const distribution = JSON.parse(originalDistribution.toString('utf8'));
  const version = authoritativeApiVersion(repository);
  const contract = `artifacts/api/${version}`;
  if (!distribution.release.contracts.includes(contract))
    throw new Error(`authoritative public distribution omits its active API contract: ${contract}`);
  const provenance = collectCommittedApiReleaseProvenance(repository, 'HEAD');
  const artifactDirectory = resolve(repository, contract);
  const docsDirectory = resolve(repository, 'apps/docs/public/contracts', version);
  const artifactManifest = JSON.parse(
    readFileSync(resolve(artifactDirectory, 'release-manifest.json'), 'utf8'),
  );
  const artifactManifestSha256 = sha256(
    readFileSync(resolve(artifactDirectory, 'release-manifest.json')),
  );
  const docsManifest = JSON.parse(
    readFileSync(resolve(docsDirectory, 'release-manifest.json'), 'utf8'),
  );
  if (canonicalJson(artifactManifest) !== canonicalJson(docsManifest))
    throw new Error('API provenance rebinding requires identical artifact and docs manifests');
  if (artifactManifest.apiVersion !== version || artifactManifest.releaseVersion !== version)
    throw new Error('API provenance rebinding contract version does not match its manifest');
  for (const name of [
    ...artifactManifest.artifacts.map(({ name }) => name),
    'release-manifest.json',
    'CHECKSUMS.sha256',
  ])
    if (
      !readFileSync(resolve(artifactDirectory, name)).equals(
        readFileSync(resolve(docsDirectory, name)),
      )
    )
      throw new Error(`API provenance rebinding found artifact/docs drift: ${name}`);
  const reboundManifest = {
    ...artifactManifest,
    commit: provenance.headCommit,
    timestamp: provenance.headTimestamp,
    provenance: {
      sourceCommit: provenance.headCommit,
      headTreeHash: provenance.headTreeHash,
      sourceTreeHash: provenance.sourceTreeHash,
      trackedFileCount: provenance.inputCount,
      excludedGeneratedPaths: API_PROVENANCE_EXCLUSIONS,
      worktreeState: 'clean',
      reproducible: true,
      publishable: true,
    },
  };
  const manifestBytes = canonicalJson(reboundManifest);
  const checksums = [
    ...artifactManifest.artifacts.map(({ name, sha256: digest }) => `${digest}  ${name}`),
    `${sha256(manifestBytes)}  release-manifest.json`,
  ].join('\n');
  for (const directory of [artifactDirectory, docsDirectory]) {
    writeFileSync(resolve(directory, 'release-manifest.json'), manifestBytes);
    writeFileSync(resolve(directory, 'CHECKSUMS.sha256'), `${checksums}\n`);
  }
  const integrationSkill = distribution.release.agentIntegrationSkills?.find(
    (entry) => entry.apiVersion === version,
  );
  if (!integrationSkill)
    throw new Error(
      `API provenance rebinding cannot find integration-skill binding for ${version}`,
    );
  integrationSkill.releaseManifestSha256 = sha256(manifestBytes);
  writeFileSync(distributionPath, `${formatJson(distribution)}\n`);
  const skillDirectory = resolve(repository, integrationSkill.path);
  const skillContractPath = resolve(skillDirectory, 'references/contract.json');
  const skillManifestPath = resolve(skillDirectory, 'artifact-manifest.json');
  const skillChecksumsPath = resolve(skillDirectory, 'CHECKSUMS.sha256');
  const originalSkillContract = readFileSync(skillContractPath);
  const originalSkillManifest = readFileSync(skillManifestPath);
  const originalSkillChecksums = readFileSync(skillChecksumsPath);
  try {
    const skillContract = JSON.parse(originalSkillContract.toString('utf8'));
    const skillManifest = JSON.parse(originalSkillManifest.toString('utf8'));
    if (
      skillContract.apiVersion !== version ||
      skillContract.source?.releaseManifestSha256 !== artifactManifestSha256 ||
      skillManifest.apiVersion !== version ||
      skillManifest.generationMode !== 'local-evaluation' ||
      skillManifest.sourceReleaseManifestSha256 !== artifactManifestSha256
    )
      throw new Error('API provenance rebinding found an unexpected integration-skill binding');
    skillContract.source.releaseManifestSha256 = integrationSkill.releaseManifestSha256;
    const skillContractBytes = `${JSON.stringify(skillContract, null, 2)}\n`;
    const contractArtifact = skillManifest.artifacts.find(
      (artifact) => artifact.name === 'references/contract.json',
    );
    if (!contractArtifact)
      throw new Error('API provenance rebinding cannot find the skill contract artifact');
    contractArtifact.sha256 = sha256(skillContractBytes);
    contractArtifact.size = Buffer.byteLength(skillContractBytes);
    skillManifest.sourceReleaseManifestSha256 = integrationSkill.releaseManifestSha256;
    const skillManifestBytes = `${JSON.stringify(skillManifest, null, 2)}\n`;
    const skillChecksums = [
      ...skillManifest.artifacts.map(({ name, sha256: digest }) => `${digest}  ${name}`),
      `${sha256(skillManifestBytes)}  artifact-manifest.json`,
    ].join('\n');
    writeFileSync(skillContractPath, skillContractBytes);
    writeFileSync(skillManifestPath, skillManifestBytes);
    writeFileSync(skillChecksumsPath, `${skillChecksums}\n`);
  } catch (error) {
    writeFileSync(distributionPath, originalDistribution);
    writeFileSync(skillContractPath, originalSkillContract);
    writeFileSync(skillManifestPath, originalSkillManifest);
    writeFileSync(skillChecksumsPath, originalSkillChecksums);
    throw error;
  }
  const changedPaths = execFileSync(
    '/usr/bin/git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: repository },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  const bindings = new Map();
  const skillPrefix = `${integrationSkill.path}/`;
  for (const path of changedPaths) {
    const match = path.match(
      /^(artifacts\/api|apps\/docs\/public\/contracts)\/(\d{4}-\d{2}-\d{2})\/(release-manifest\.json|CHECKSUMS\.sha256)$/u,
    );
    if (path === 'distribution/public-distribution.json' || path.startsWith(skillPrefix)) continue;
    if (!match) throw new Error(`API provenance rebinding changed an unauthorized path: ${path}`);
    const [, root, version, name] = match;
    const key = `${version}/${name}`;
    const paths = bindings.get(key) ?? new Set();
    paths.add(root);
    bindings.set(key, paths);
  }
  if (
    bindings.size !== 2 ||
    [...bindings.values()].some(
      (paths) =>
        paths.size !== 2 || !paths.has('artifacts/api') || !paths.has('apps/docs/public/contracts'),
    )
  )
    throw new Error('API provenance rebinding did not update one exact release manifest pair');
  execFileSync('/usr/bin/git', ['add', '--', ...changedPaths], { cwd: repository });
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Tixkit Public Cutover',
      '-c',
      'user.email=public-cutover@tixkit.invalid',
      'commit',
      '-qm',
      'Bind API release provenance to authoritative public root',
    ],
    { cwd: repository },
  );
  execFileSync('bun', ['scripts/validate-api-release-provenance.ts'], {
    cwd: repository,
    stdio: 'inherit',
  });
  return execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
}

export function verifyPackedNpmRelease(repository, environment = process.env) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'tixkit-public-cli-'));
  const packDirectory = join(temporaryRoot, 'pack');
  const consumerDirectory = join(temporaryRoot, 'consumer');
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(repository, 'distribution/public-distribution.json'), 'utf8'),
    );
    const dependencies = {};
    for (const entry of manifest.release.packages.filter(({ ecosystem }) =>
      ['npm', 'npm-and-cdn'].includes(ecosystem),
    )) {
      const packageDirectory = resolve(repository, entry.path);
      const packageManifest = JSON.parse(
        readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'),
      );
      const before = new Set(readdirSync(packDirectory));
      execFileSync('bun', ['pm', 'pack', '--destination', packDirectory], {
        cwd: packageDirectory,
        env: environment,
        stdio: 'inherit',
      });
      const archives = readdirSync(packDirectory).filter(
        (name) => name.endsWith('.tgz') && !before.has(name),
      );
      if (archives.length !== 1)
        throw new Error(`${entry.path} must produce exactly one unique tarball`);
      dependencies[packageManifest.name] = `file:${join(packDirectory, archives[0])}`;
    }
    writeFileSync(
      join(consumerDirectory, 'package.json'),
      `${JSON.stringify(
        { name: 'tixkit-public-consumer', private: true, dependencies, overrides: dependencies },
        null,
        2,
      )}\n`,
    );
    execFileSync('bun', ['install'], {
      cwd: consumerDirectory,
      env: environment,
      stdio: 'inherit',
    });
    execFileSync(resolve(consumerDirectory, 'node_modules/.bin/tixkit'), ['--help'], {
      cwd: consumerDirectory,
      env: environment,
      stdio: 'inherit',
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function rehearsePublicRepository(argv = process.argv.slice(2)) {
  const requestedExport = valueAfter(argv, '--export');
  const requestedRepository = valueAfter(argv, '--repository');
  if (requestedExport && requestedRepository) {
    throw new Error('Use either --export or --repository, not both');
  }
  if (!requestedExport && !requestedRepository) {
    throw new Error('Use --export <path> during transition or --repository <clone> after cutover');
  }

  const repository = resolve(requestedExport ?? requestedRepository);
  if (requestedExport) {
    const { exportOss } = await import('./export-oss.mjs');
    await exportOss(['--out', repository]);
  }

  const environment = { ...process.env, CI: '1' };
  delete environment.DATABASE_URL;
  delete environment.DATABASE_URL_MYSQL;
  for (const [command, args] of publicRepositoryValidationCommands({
    createSnapshot: Boolean(requestedExport),
  })) {
    execFileSync(command, args, { cwd: repository, env: environment, stdio: 'inherit' });
  }
  verifyPackedNpmRelease(repository, environment);
  process.stdout.write(`Validated independent public repository at ${repository}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  rehearsePublicRepository().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
