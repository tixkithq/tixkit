import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test, { after } from 'node:test';
import {
  assertPublicReleaseContext,
  buildPublicReleaseManifestFromArchive,
  packFromSourceArchive,
  publicContractPins,
  publicImageViolations,
  publicReleaseContextViolations,
  publicReleaseManifestViolations,
  stagePublicContractArtifacts,
} from '../build-public-release-manifest.mjs';
import { buildCloudCoreCompatibility } from '../build-cloud-core-compatibility.mjs';
import {
  cloudRepositoryReleaseViolations,
  parseBunLock,
  privateCloudSourceBoundaryViolations,
  validateCloudCoreConsumer,
} from '../validate-cloud-core-consumer.mjs';
import { publishPublicNpmArtifacts } from '../publish-public-npm-artifacts.mjs';
import {
  finalizePublicGithubRelease,
  stagePublicGithubRelease,
} from '../publish-public-github-release.mjs';
import { verifyCloudCoreInstall } from '../verify-cloud-core-install.mjs';
import {
  classifyStagedPublicRelease,
  inspectStagedPackageArchive,
  validateStagedPublicRelease,
} from '../validate-staged-public-release.mjs';
import { SDK_API_VERSION } from '../lib/sdk-parity.mjs';
import { directoryContentDigest, packageContentDigest } from '../lib/package-content-digest.mjs';

const root = resolve(import.meta.dirname, '../..');
const distribution = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);
const generatedOpenApiVersion = JSON.parse(
  readFileSync(resolve(root, 'apps/docs/public/openapi.json'), 'utf8'),
).info.version;
assert.equal(SDK_API_VERSION, generatedOpenApiVersion);
const activeApiVersion = generatedOpenApiVersion;
const activeApiContract = `artifacts/api/${activeApiVersion}`;
assert.equal(
  distribution.release.contracts.find((path) => path.startsWith('artifacts/api/')),
  activeApiContract,
);
const migrationIds = readdirSync(resolve(root, 'packages/db/src/migrations'))
  .map((name) => name.match(/^(\d{4}(?:_\d+)?)/u)?.[1])
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
const currentMigrationRange = {
  minimum: migrationIds[0],
  maximum: migrationIds.at(-1),
};
const externalAttestationRoots = [];
after(() => {
  for (const path of externalAttestationRoots) rmSync(path, { recursive: true, force: true });
});

function compatibilityManifest() {
  const agentContract = distribution.release.contracts.find((path) =>
    path.includes('agent-protocol'),
  );
  const agentVersion = agentContract
    ? agentContract
        .split('/')
        .at(-1)
        .replace(/^agent-protocol-|\.json$/gu, '')
    : '';
  const packages = distribution.release.packages
    .filter(({ ecosystem }) => ecosystem === 'npm' || ecosystem === 'npm-and-cdn')
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(resolve(root, entry.path, 'package.json'), 'utf8'));
      return {
        name: manifest.name,
        version: manifest.version,
        integrity: 'sha512-YQ==',
        contentSha256: 'e'.repeat(64),
        fileCount: 2,
      };
    });
  return {
    schemaVersion: 1,
    cloudRelease: {
      version: '0.1.0-private.1',
      sourceCommit: 'a'.repeat(40),
      consumedPackages: packages.map(({ name }) => name),
      installations: [],
    },
    core: {
      sourceCommit: 'b'.repeat(40),
      sourceTreeSha256: 'c'.repeat(64),
      apiVersion: activeApiVersion,
      migrationRange: { ...currentMigrationRange },
      agentProtocol: agentContract
        ? { status: 'supported', version: agentVersion }
        : { status: 'unavailable', version: '' },
      packages,
      images: distribution.release.images.map(({ name }) => ({
        name,
        reference: `ghcr.io/tixkit/tixkit-${name}@sha256:${'d'.repeat(64)}`,
        digest: `sha256:${'d'.repeat(64)}`,
      })),
      contracts: [
        {
          name: 'openapi',
          version: activeApiVersion,
          sha256: readFileSync(
            [
              resolve(root, activeApiContract, 'CHECKSUMS.sha256'),
              resolve(root, 'apps/docs/public/contracts', activeApiVersion, 'CHECKSUMS.sha256'),
            ].find(existsSync),
            'utf8',
          )
            .split('\n')
            .find((line) => line.endsWith('  openapi.json'))
            .split(/\s+/u)[0],
        },
        ...(agentContract
          ? [
              {
                name: agentContract,
                version: '1',
                sha256: createHash('sha256')
                  .update(readFileSync(resolve(root, agentContract)))
                  .digest('hex'),
              },
            ]
          : []),
      ],
    },
  };
}

function cloudFixture(releaseManifest = compatibilityManifest()) {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-consumer-'));
  mkdirSync(resolve(directory, 'packages/control-plane'), { recursive: true });
  writeFileSync(
    resolve(directory, 'packages/control-plane/package.json'),
    `${JSON.stringify(
      {
        name: '@tixkit-cloud/control-plane',
        private: true,
        dependencies: {
          '@tixkit/domain': releaseManifest.core.packages.find(
            ({ name }) => name === '@tixkit/domain',
          ).version,
        },
      },
      null,
      2,
    )}\n`,
  );
  const domainPin = releaseManifest.core.packages.find(({ name }) => name === '@tixkit/domain');
  writeFileSync(
    resolve(directory, 'bun.lock'),
    `${JSON.stringify({
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        'packages/control-plane': {
          name: '@tixkit-cloud/control-plane',
          dependencies: { '@tixkit/domain': domainPin.version },
        },
      },
      packages: Object.fromEntries(
        releaseManifest.core.packages
          .filter(({ name }) => releaseManifest.cloudRelease.consumedPackages.includes(name))
          .map((pin) => [pin.name, [`${pin.name}@${pin.version}`, '', {}, pin.integrity]]),
      ),
    })}\n`,
  );
  writeFileSync(
    resolve(directory, 'bunfig.toml'),
    '[install]\nlinker = "isolated"\nbackend = "copyfile"\n',
  );
  writeFileSync(
    resolve(directory, '.gitignore'),
    'node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.*\n',
  );
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', '-A'], { cwd: directory });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Tixkit Cloud Test',
      '-c',
      'user.email=cloud-test@tixkit.invalid',
      'commit',
      '-qm',
      'Cloud fixture',
    ],
    { cwd: directory },
  );
  bindCloudRelease(releaseManifest, directory);
  return directory;
}

function bindCloudRelease(manifest, cloudRoot) {
  manifest.cloudRelease.sourceCommit = execFileSync(
    'git',
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    { cwd: cloudRoot, encoding: 'utf8' },
  ).trim();
  return manifest;
}

function commitCloudFixture(cloudRoot) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: cloudRoot,
      stdio: 'ignore',
    });
  } catch {
    execFileSync('git', ['add', '-u'], { cwd: cloudRoot });
  }
  const changed = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], {
    cwd: cloudRoot,
    stdio: 'ignore',
  }).status;
  const staged = spawnSync('git', ['diff', '--cached', '--quiet', 'HEAD', '--'], {
    cwd: cloudRoot,
    stdio: 'ignore',
  }).status;
  if (changed !== 0 || staged !== 0) {
    execFileSync('git', ['add', '-u'], { cwd: cloudRoot });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Cloud fixture mutation',
      ],
      { cwd: cloudRoot },
    );
  }
}

function publicRelease(manifest) {
  return {
    schemaVersion: 1,
    releaseVersion: '0.1.0',
    core: structuredClone(manifest.core),
  };
}

function installFixturePackages(directory, manifest) {
  for (const pin of manifest.core.packages.filter(({ name }) =>
    manifest.cloudRelease.consumedPackages.includes(name),
  )) {
    const packagePath = resolve(directory, 'node_modules', ...pin.name.split('/'));
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(resolve(packagePath, 'index.js'), 'export const state = "public";\n');
    writeFileSync(
      resolve(packagePath, 'package.json'),
      `${JSON.stringify({ name: pin.name, version: pin.version, type: 'module' })}\n`,
    );
    Object.assign(pin, packageContentDigest(packagePath));
  }
  bindCloudInstallations(manifest, directory);
}

function bindCloudInstallations(manifest, cloudRoot) {
  const lock = parseBunLock(readFileSync(resolve(cloudRoot, 'bun.lock'), 'utf8'));
  const roots = [
    resolve(cloudRoot, 'node_modules'),
    ...Object.keys(lock.workspaces ?? {})
      .filter(Boolean)
      .map((workspace) => resolve(cloudRoot, workspace, 'node_modules')),
  ].filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory());
  manifest.cloudRelease.installations = roots
    .map((path) => ({
      path: relative(cloudRoot, path).replaceAll('\\', '/'),
      ...directoryContentDigest(path, cloudRoot),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function attestedReleaseFixture(_directory, release) {
  const externalRoot = mkdtempSync(join(tmpdir(), 'tixkit-cloud-attestation-'));
  externalAttestationRoots.push(externalRoot);
  const releasePath = resolve(externalRoot, 'public-release.json');
  writeFileSync(releasePath, `${JSON.stringify(release)}\n`);
  const bin = resolve(externalRoot, '.test-bin');
  mkdirSync(bin);
  const gh = resolve(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const digest = createHash('sha256').update(readFileSync(process.argv[4])).digest('hex');
process.stdout.write(JSON.stringify([{verificationResult:{statement:{subject:[{digest:{sha256:digest}}]}}}]));
`,
  );
  chmodSync(gh, 0o755);
  return { releasePath, bin };
}

function runVerifiedCommand({ manifest, releasePath, cloudRoot, bin, command, writable = [] }) {
  commitCloudFixture(cloudRoot);
  bindCloudRelease(manifest, cloudRoot);
  const manifestPath = resolve(cloudRoot, 'cloud-core-compatibility.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return spawnSync(
    process.execPath,
    [
      resolve(root, 'scripts/verify-cloud-core-install.mjs'),
      '--manifest',
      manifestPath,
      '--public-release-manifest',
      releasePath,
      '--cloud-root',
      cloudRoot,
      ...writable.flatMap((path) => ['--writable-path', path]),
      '--',
      ...command,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    },
  );
}

test('accepts immutable public pins without copied or patched core source', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    bindCloudRelease(manifest, cloudRoot);
    assert.deepEqual(validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot), []);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('Cloud verifies an explicit consumed subset while retaining the full public inventory', () => {
  const manifest = compatibilityManifest();
  manifest.cloudRelease.consumedPackages = ['@tixkit/domain'];
  const cloudRoot = cloudFixture(manifest);
  try {
    assert.ok(manifest.core.packages.length > manifest.cloudRelease.consumedPackages.length);
    assert.deepEqual(validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot), []);
    installFixturePackages(cloudRoot, manifest);
    const { releasePath, bin } = attestedReleaseFixture(cloudRoot, publicRelease(manifest));
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot,
      bin,
      command: [process.execPath, '--version'],
    });
    assert.equal(result.status, 0, result.stderr);

    const duplicate = structuredClone(manifest);
    duplicate.cloudRelease.consumedPackages.push('@tixkit/domain');
    assert.ok(
      validateCloudCoreConsumer(duplicate, publicRelease(manifest), cloudRoot).includes(
        'duplicate consumed public package: @tixkit/domain',
      ),
    );
    const empty = structuredClone(manifest);
    empty.cloudRelease.consumedPackages = [];
    assert.ok(
      validateCloudCoreConsumer(empty, publicRelease(manifest), cloudRoot).some((violation) =>
        violation.includes('cloudRelease.consumedPackages'),
      ),
    );
    const unknown = structuredClone(manifest);
    unknown.cloudRelease.consumedPackages.push('@tixkit/not-released');
    assert.ok(
      validateCloudCoreConsumer(unknown, publicRelease(manifest), cloudRoot).includes(
        'unknown consumed public package: @tixkit/not-released',
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('verified Cloud commands reject private workspace shadows at public package paths', () => {
  const manifest = compatibilityManifest();
  manifest.cloudRelease.consumedPackages = ['@tixkit/domain'];
  const cloudRoot = cloudFixture(manifest);
  try {
    installFixturePackages(cloudRoot, manifest);
    const publicInstall = resolve(cloudRoot, 'node_modules/@tixkit/domain');
    const nestedPublicInstall = resolve(
      cloudRoot,
      'node_modules/.bun/authentic/node_modules/@tixkit/domain',
    );
    mkdirSync(dirname(nestedPublicInstall), { recursive: true });
    cpSync(publicInstall, nestedPublicInstall, { recursive: true });
    rmSync(publicInstall, { recursive: true });
    symlinkSync('../../packages/control-plane', publicInstall);
    bindCloudInstallations(manifest, cloudRoot);

    const { releasePath, bin } = attestedReleaseFixture(cloudRoot, publicRelease(manifest));
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot,
      bin,
      command: [process.execPath, '--version'],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /public package install path is shadowed: @tixkit\/domain/u);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('builds the private compatibility manifest from one attested public release and install', () => {
  const fixtureManifest = compatibilityManifest();
  fixtureManifest.cloudRelease.consumedPackages = ['@tixkit/domain'];
  const cloudRoot = cloudFixture(fixtureManifest);
  try {
    installFixturePackages(cloudRoot, fixtureManifest);
    const release = publicRelease(fixtureManifest);
    const built = buildCloudCoreCompatibility({
      publicRelease: release,
      cloudRoot,
      cloudVersion: '0.1.0-private.2',
    });
    assert.deepEqual(built.core, release.core);
    assert.deepEqual(built.cloudRelease.consumedPackages, ['@tixkit/domain']);
    assert.equal(built.cloudRelease.sourceCommit, fixtureManifest.cloudRelease.sourceCommit);
    assert.deepEqual(validateCloudCoreConsumer(built, release, cloudRoot), []);

    const { releasePath, bin } = attestedReleaseFixture(cloudRoot, release);
    const outputPath = resolve(cloudRoot, 'generated-cloud-core-compatibility.json');
    const buildResult = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/build-cloud-core-compatibility.mjs'),
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        cloudRoot,
        '--cloud-version',
        '0.1.0-private.2',
        '--out',
        outputPath,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(buildResult.status, 0, buildResult.stderr);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), built);

    const verifiedResult = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/verify-cloud-core-install.mjs'),
        '--manifest',
        outputPath,
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        cloudRoot,
        '--',
        process.execPath,
        '--version',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(verifiedResult.status, 0, verifiedResult.stderr);

    const replacement = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/build-cloud-core-compatibility.mjs'),
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        cloudRoot,
        '--cloud-version',
        '0.1.0-private.2',
        '--out',
        outputPath,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(replacement.status, 1);
    assert.match(replacement.stderr, /refusing to replace an existing compatibility manifest/u);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('compatibility generation rejects a nested directory as the private repository root', () => {
  const fixtureManifest = compatibilityManifest();
  fixtureManifest.cloudRelease.consumedPackages = ['@tixkit/domain'];
  const cloudRoot = cloudFixture(fixtureManifest);
  try {
    const nestedRoot = resolve(cloudRoot, 'packages/control-plane');
    const release = publicRelease(fixtureManifest);
    const { releasePath, bin } = attestedReleaseFixture(cloudRoot, release);
    const outputPath = resolve(cloudRoot, 'nested-root-compatibility.json');
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/build-cloud-core-compatibility.mjs'),
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        nestedRoot,
        '--cloud-version',
        '0.1.0-private.2',
        '--out',
        outputPath,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private Cloud release root must equal Git worktree top level/u);
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test(
  'clean private consumer generates compatibility from a real packed public artifact',
  { timeout: 60_000 },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-real-public-artifact-'));
    const publicArtifacts = resolve(directory, 'public-artifacts');
    const cloudRoot = resolve(directory, 'cloud');
    try {
      const sourceCommit = execFileSync(
        '/usr/bin/git',
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
        },
      ).trim();
      const sourceArchive = execFileSync(
        '/usr/bin/git',
        ['archive', '--format=tar', sourceCommit],
        {
          cwd: root,
          maxBuffer: 512 * 1024 * 1024,
          env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
        },
      );
      const realDistribution = {
        authority: { publicRepository: 'tixkit/tixkit' },
        release: {
          packages: [{ path: 'packages/domain', ecosystem: 'npm' }],
          images: distribution.release.images,
          contracts: [activeApiContract],
        },
      };
      const images = realDistribution.release.images.map(({ name }, index) => {
        const digest = `sha256:${String(index + 1).repeat(64)}`;
        return {
          name,
          digest,
          reference: `ghcr.io/tixkit/tixkit-${name}@${digest}`,
        };
      });
      const release = buildPublicReleaseManifestFromArchive({
        distribution: realDistribution,
        images,
        releaseVersion: '0.1.0',
        sourceCommit,
        sourceArchive,
        packageArtifactDirectory: publicArtifacts,
        install: true,
      });
      const domainPin = release.core.packages.find(({ name }) => name === '@tixkit/domain');
      assert.ok(domainPin);
      const tarballName = readdirSync(publicArtifacts).find((name) => name.endsWith('.tgz'));
      assert.ok(tarballName);
      const tarball = resolve(publicArtifacts, tarballName);

      mkdirSync(cloudRoot);
      writeFileSync(
        resolve(cloudRoot, 'package.json'),
        `${JSON.stringify({ name: '@tixkit-cloud/artifact-proof', private: true, type: 'module' })}\n`,
      );
      writeFileSync(
        resolve(cloudRoot, 'bunfig.toml'),
        '[install]\nlinker = "isolated"\nbackend = "copyfile"\n',
      );
      writeFileSync(resolve(cloudRoot, '.gitignore'), 'node_modules/\n');
      writeFileSync(
        resolve(cloudRoot, 'verify-artifact.mjs'),
        "await import('@tixkit/domain');\nprocess.stdout.write('public artifact loaded');\n",
      );
      execFileSync('bun', ['add', '--ignore-scripts', tarball], {
        cwd: cloudRoot,
        stdio: 'pipe',
      });
      const packagePath = resolve(cloudRoot, 'package.json');
      const privatePackage = JSON.parse(readFileSync(packagePath, 'utf8'));
      privatePackage.dependencies = { '@tixkit/domain': domainPin.version };
      writeFileSync(packagePath, `${JSON.stringify(privatePackage, null, 2)}\n`);
      const lockPath = resolve(cloudRoot, 'bun.lock');
      const lock = parseBunLock(readFileSync(lockPath, 'utf8'));
      lock.workspaces[''].dependencies['@tixkit/domain'] = domainPin.version;
      const resolution = Object.values(lock.packages).find(
        (entry) => Array.isArray(entry) && entry[0].startsWith('@tixkit/domain@'),
      );
      assert.ok(resolution);
      resolution[0] = `@tixkit/domain@${domainPin.version}`;
      resolution[3] = domainPin.integrity;
      writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
      execFileSync('/usr/bin/git', ['init', '-q'], { cwd: cloudRoot });
      execFileSync('/usr/bin/git', ['add', '-A'], { cwd: cloudRoot });
      execFileSync(
        '/usr/bin/git',
        [
          '-c',
          'user.name=Tixkit Cloud Test',
          '-c',
          'user.email=cloud-test@tixkit.invalid',
          'commit',
          '-qm',
          'Consume real public artifact',
        ],
        { cwd: cloudRoot },
      );

      const { releasePath, bin } = attestedReleaseFixture(cloudRoot, release);
      const outputPath = resolve(cloudRoot, 'cloud-core-compatibility.json');
      const buildResult = spawnSync(
        process.execPath,
        [
          resolve(root, 'scripts/build-cloud-core-compatibility.mjs'),
          '--public-release-manifest',
          releasePath,
          '--cloud-root',
          cloudRoot,
          '--cloud-version',
          '0.1.0-private.1',
          '--out',
          outputPath,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      assert.equal(buildResult.status, 0, buildResult.stderr);
      const compatibility = JSON.parse(readFileSync(outputPath, 'utf8'));
      assert.deepEqual(compatibility.core, release.core);
      assert.deepEqual(compatibility.cloudRelease.consumedPackages, ['@tixkit/domain']);
      const verified = spawnSync(
        process.execPath,
        [
          resolve(root, 'scripts/verify-cloud-core-install.mjs'),
          '--manifest',
          outputPath,
          '--public-release-manifest',
          releasePath,
          '--cloud-root',
          cloudRoot,
          '--',
          process.execPath,
          'verify-artifact.mjs',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      assert.equal(verified.status, 0, verified.stderr);
      assert.match(verified.stdout, /public artifact loaded/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('binds the Cloud release identity to the clean private repository commit', () => {
  const manifest = compatibilityManifest();
  const cloudRoot = cloudFixture(manifest);
  try {
    assert.deepEqual(
      cloudRepositoryReleaseViolations(cloudRoot, manifest.cloudRelease.sourceCommit),
      [],
    );
    const blob = execFileSync('git', ['hash-object', 'bunfig.toml'], {
      cwd: cloudRoot,
      encoding: 'utf8',
    }).trim();
    const nonCommit = cloudRepositoryReleaseViolations(cloudRoot, blob);
    assert.ok(
      nonCommit.includes(
        'cloudRelease.sourceCommit is not a commit in the private Cloud repository',
      ),
    );
    assert.ok(nonCommit.some((violation) => violation.includes('must equal private Cloud HEAD')));

    writeFileSync(
      resolve(cloudRoot, 'packages/control-plane/package.json'),
      '{"name":"@tixkit-cloud/changed","private":true}\n',
    );
    assert.ok(
      cloudRepositoryReleaseViolations(cloudRoot, manifest.cloudRelease.sourceCommit).includes(
        'private Cloud release tree has uncommitted tracked changes',
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects staged, untracked, ignored, and index-hidden private release changes', () => {
  const cases = [
    {
      expected: 'private Cloud release tree has uncommitted tracked changes',
      mutate(cloudRoot) {
        writeFileSync(resolve(cloudRoot, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
        execFileSync('git', ['add', 'bunfig.toml'], { cwd: cloudRoot });
      },
    },
    {
      expected: 'private Cloud release tree has unbound untracked paths',
      mutate(cloudRoot) {
        mkdirSync(resolve(cloudRoot, 'packages/control-plane/src'), { recursive: true });
        writeFileSync(
          resolve(cloudRoot, 'packages/control-plane/src/untracked.ts'),
          'export const unboundPrivateReleaseCode = true;\n',
        );
      },
    },
    {
      expected: 'private Cloud release tree has unbound ignored paths',
      mutate(cloudRoot) {
        mkdirSync(resolve(cloudRoot, 'dist'));
        writeFileSync(
          resolve(cloudRoot, 'dist/unbound-wrapper.js'),
          'export const unboundGeneratedWrapper = true;\n',
        );
      },
    },
    {
      expected: 'private Cloud release tree has unbound ignored paths',
      mutate(cloudRoot, manifest) {
        writeFileSync(
          resolve(cloudRoot, '.gitignore'),
          `${readFileSync(resolve(cloudRoot, '.gitignore'), 'utf8')}private-cache/\n`,
        );
        execFileSync('git', ['add', '.gitignore'], { cwd: cloudRoot });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Tixkit Cloud Test',
            '-c',
            'user.email=cloud-test@tixkit.invalid',
            'commit',
            '-qm',
            'Ignore private cache',
          ],
          { cwd: cloudRoot },
        );
        bindCloudRelease(manifest, cloudRoot);
        mkdirSync(resolve(cloudRoot, 'private-cache'));
        writeFileSync(
          resolve(cloudRoot, 'private-cache/rogue.ts'),
          'export const ignoredPrivateReleaseCode = true;\n',
        );
      },
    },
    {
      expected: 'private Cloud repository has assume-unchanged or skip-worktree paths',
      mutate(cloudRoot) {
        execFileSync('git', ['update-index', '--assume-unchanged', 'bunfig.toml'], {
          cwd: cloudRoot,
        });
        writeFileSync(resolve(cloudRoot, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
      },
    },
    {
      expected: 'private Cloud repository has assume-unchanged or skip-worktree paths',
      mutate(cloudRoot) {
        execFileSync('git', ['update-index', '--skip-worktree', 'bunfig.toml'], {
          cwd: cloudRoot,
        });
      },
    },
  ];
  for (const { expected, mutate } of cases) {
    const manifest = compatibilityManifest();
    const cloudRoot = cloudFixture(manifest);
    try {
      mutate(cloudRoot, manifest);
      assert.ok(
        cloudRepositoryReleaseViolations(cloudRoot, manifest.cloudRelease.sourceCommit).some(
          (violation) => violation.startsWith(expected),
        ),
        expected,
      );
    } finally {
      rmSync(cloudRoot, { recursive: true, force: true });
    }
  }
});

test('rejects pre-existing output and environment files as unbound executable input', () => {
  const manifest = compatibilityManifest();
  const cloudRoot = cloudFixture(manifest);
  try {
    mkdirSync(resolve(cloudRoot, 'dist'));
    writeFileSync(resolve(cloudRoot, 'dist/wrapper.js'), 'export const wrapper = true;\n');
    writeFileSync(resolve(cloudRoot, '.env'), 'SECRET_COMMAND=./dist/wrapper.js\n');
    const violations = cloudRepositoryReleaseViolations(
      cloudRoot,
      manifest.cloudRelease.sourceCommit,
    );
    assert.ok(
      violations.some(
        (violation) =>
          violation.includes('unbound ignored paths') &&
          violation.includes('.env') &&
          violation.includes('dist/'),
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects replacement refs and dirty submodules from the private release tree', () => {
  const replacementManifest = compatibilityManifest();
  const replacementRoot = cloudFixture(replacementManifest);
  try {
    const replacementCommit = execFileSync(
      'git',
      ['commit-tree', 'HEAD^{tree}', '-m', 'replacement'],
      { cwd: replacementRoot, encoding: 'utf8' },
    ).trim();
    execFileSync(
      'git',
      ['replace', replacementManifest.cloudRelease.sourceCommit, replacementCommit],
      { cwd: replacementRoot },
    );
    assert.ok(
      cloudRepositoryReleaseViolations(
        replacementRoot,
        replacementManifest.cloudRelease.sourceCommit,
      ).includes('private Cloud repository must not contain Git replacement references'),
    );
  } finally {
    rmSync(replacementRoot, { recursive: true, force: true });
  }

  const submoduleSource = mkdtempSync(join(tmpdir(), 'tixkit-cloud-private-submodule-'));
  const submoduleManifest = compatibilityManifest();
  const submoduleRoot = cloudFixture(submoduleManifest);
  try {
    execFileSync('git', ['init', '-q'], { cwd: submoduleSource });
    writeFileSync(
      resolve(submoduleSource, 'index.ts'),
      'export const managedPrivateCode = true;\n',
    );
    execFileSync('git', ['add', 'index.ts'], { cwd: submoduleSource });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Private submodule',
      ],
      { cwd: submoduleSource },
    );
    execFileSync(
      'git',
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        submoduleSource,
        'vendor/private',
      ],
      { cwd: submoduleRoot },
    );
    execFileSync('git', ['add', '.gitmodules', 'vendor/private'], { cwd: submoduleRoot });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Pin private submodule',
      ],
      { cwd: submoduleRoot },
    );
    bindCloudRelease(submoduleManifest, submoduleRoot);
    writeFileSync(
      resolve(submoduleRoot, 'vendor/private/index.ts'),
      'export const managedPrivateCode = false;\n',
    );
    assert.ok(
      cloudRepositoryReleaseViolations(
        submoduleRoot,
        submoduleManifest.cloudRelease.sourceCommit,
      ).includes('private Cloud release tree has uncommitted tracked changes'),
    );
  } finally {
    rmSync(submoduleRoot, { recursive: true, force: true });
    rmSync(submoduleSource, { recursive: true, force: true });
  }
});

test('parses the repository Bun JSONC lock with real importers and package tuples', () => {
  const lock = parseBunLock(readFileSync(resolve(root, 'bun.lock'), 'utf8'));
  assert.equal(lock.lockfileVersion, 1);
  assert.equal(lock.workspaces[''].devDependencies.oxfmt, '0.58.0');
  assert.match(lock.packages.oxfmt[0], /^oxfmt@/u);
  assert.match(lock.packages.oxfmt[3], /^sha512-/u);
});

test('standalone private extraction boundary rejects renamed public source copies', () => {
  const cloudRoot = cloudFixture();
  try {
    const copied = resolve(cloudRoot, 'packages/control-plane/src/copied-domain.ts');
    mkdirSync(resolve(cloudRoot, 'packages/control-plane/src'), {
      recursive: true,
    });
    writeFileSync(copied, readFileSync(resolve(root, 'packages/domain/src/index.ts')));
    assert.ok(
      privateCloudSourceBoundaryViolations(cloudRoot).some((violation) =>
        violation.includes('copies public source content'),
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('public release schema rejects an unconstrained core envelope', () => {
  assert.ok(
    publicReleaseManifestViolations({
      schemaVersion: 1,
      releaseVersion: '0.1.0',
      core: {},
    }).length > 0,
  );
});

test('public release preflight remains blocked while legal approval is pending', () => {
  assert.throws(() => assertPublicReleaseContext(), /blocked until legal approval is recorded/u);
});

test('approved public-only exported repository passes release-context policy', () => {
  const publicDistribution = structuredClone(distribution);
  publicDistribution.licensing = {
    intendedPublicLicense: 'MIT',
    status: 'approved',
    mayClaimLegalApproval: true,
    legalReviewEvidence: 'LEGAL_APPROVAL.md',
  };
  publicDistribution.classification.topLevel.privateCloud = [];
  publicDistribution.classification.topLevel.internalPlanning = [];
  publicDistribution.classification.docs.internalPlanning = [];
  assert.deepEqual(
    publicReleaseContextViolations(publicDistribution, {
      origin: 'https://github.com/tixkit/tixkit.git',
      status: '',
      githubActions: true,
      githubRepository: 'tixkit/tixkit',
    }),
    [],
  );
});

test('public image contract rejects a self-consistent digest in a foreign registry', () => {
  const images = compatibilityManifest().core.images;
  images[0].reference = images[0].reference.replace('ghcr.io/tixkit/', 'evil.example/');
  assert.ok(
    publicImageViolations(images, distribution).some((message) =>
      message.includes('must use authoritative image repository'),
    ),
  );
});

test('public contract pins distinguish the active OpenAPI from historical releases', () => {
  const pins = publicContractPins(distribution, activeApiContract);
  const activePins = pins.filter(({ name }) => name === 'openapi');
  assert.deepEqual(
    activePins.map(({ version }) => version),
    [activeApiVersion],
  );
  for (const contract of distribution.release.contracts.filter(
    (path) => path.startsWith('artifacts/api/') && path !== activeApiContract,
  )) {
    assert.ok(
      pins.some(({ name, version }) => name === contract && version === contract.split('/').at(-1)),
      contract,
    );
  }
});

test('Cloud accepts the release builder contract inventory without fixture filtering', () => {
  const manifest = compatibilityManifest();
  manifest.core.contracts = publicContractPins(distribution, activeApiContract);
  const cloudRoot = cloudFixture(manifest);
  try {
    assert.deepEqual(validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot), []);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('public packages are packed from the Git archive, excluding stale working outputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-public-archive-pack-'));
  const source = resolve(directory, 'source');
  const artifacts = resolve(directory, 'artifacts');
  try {
    mkdirSync(resolve(source, 'packages/example/dist'), { recursive: true });
    writeFileSync(resolve(source, 'package.json'), '{"private":true}\n');
    writeFileSync(
      resolve(source, 'packages/example/package.json'),
      '{"name":"@tixkit/example","version":"1.0.0","files":["dist"]}\n',
    );
    writeFileSync(
      resolve(source, 'packages/example/dist/index.js'),
      'export const clean = true;\n',
    );
    mkdirSync(resolve(source, 'packages/db/src/migrations'), { recursive: true });
    writeFileSync(resolve(source, 'packages/db/src/migrations/0001_initial.ts'), 'export {};\n');
    writeFileSync(resolve(source, 'packages/db/src/migrations/0010_2_current.ts'), 'export {};\n');
    const apiContract = 'artifacts/api/2026-07-18';
    mkdirSync(resolve(source, apiContract), { recursive: true });
    const openApiBytes = Buffer.from('{"info":{"version":"2026-07-18"}}\n');
    writeFileSync(resolve(source, apiContract, 'openapi.json'), openApiBytes);
    writeFileSync(
      resolve(source, apiContract, 'CHECKSUMS.sha256'),
      `${createHash('sha256').update(openApiBytes).digest('hex')}  openapi.json\n`,
    );
    const archive = execFileSync('tar', ['-cf', '-', '.'], { cwd: source });
    writeFileSync(resolve(source, 'packages/example/dist/stale.js'), 'throw new Error("stale");\n');
    const packages = packFromSourceArchive(
      {
        release: { packages: [{ path: 'packages/example', ecosystem: 'npm' }] },
      },
      archive,
      artifacts,
      { install: false },
    );
    const candidateDirectory = resolve(directory, 'candidate');
    const packageArtifacts = resolve(candidateDirectory, 'packages');
    const syntheticDistribution = {
      authority: { publicRepository: 'tixkit/tixkit' },
      release: {
        packages: [{ path: 'packages/example', ecosystem: 'npm' }],
        images: ['admin', 'api', 'checkout', 'worker'].map((name) => ({ name })),
        contracts: [apiContract],
      },
    };
    const syntheticImages = syntheticDistribution.release.images.map(({ name }, index) => {
      const imageDigest = `sha256:${String(index + 1).repeat(64)}`;
      return {
        name,
        digest: imageDigest,
        reference: `ghcr.io/tixkit/tixkit-${name}@${imageDigest}`,
      };
    });
    const assembled = buildPublicReleaseManifestFromArchive({
      distribution: syntheticDistribution,
      images: syntheticImages,
      releaseVersion: '1.0.0',
      sourceCommit: 'a'.repeat(40),
      sourceArchive: archive,
      packageArtifactDirectory: packageArtifacts,
      contractArtifactDirectory: candidateDirectory,
      install: false,
    });
    assert.deepEqual(assembled.core.migrationRange, { minimum: '0001', maximum: '0010_2' });
    assert.deepEqual(
      assembled.core.contracts.map(({ name }) => name),
      ['openapi'],
    );
    assert.equal(
      readFileSync(
        resolve(candidateDirectory, `contract-${assembled.core.contracts[0].sha256}.json`),
      ).toString(),
      openApiBytes.toString(),
    );
    const tarball = resolve(
      artifacts,
      readdirSync(artifacts).find((name) => name.endsWith('.tgz')),
    );
    const entries = execFileSync('tar', ['-tzf', tarball], {
      encoding: 'utf8',
    });
    assert.match(entries, /package\/dist\/index\.js/u);
    assert.doesNotMatch(entries, /stale\.js/u);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    assert.throws(
      () => inspectStagedPackageArchive(tarball, { expandedBytes: 1 }),
      /expanded byte limit/u,
    );
    const unsafePackage = resolve(directory, 'unsafe-package');
    mkdirSync(resolve(unsafePackage, 'package'), { recursive: true });
    writeFileSync(resolve(unsafePackage, 'package/target'), 'target\n');
    symlinkSync('target', resolve(unsafePackage, 'package/link'));
    const unsafeTarball = resolve(directory, 'unsafe.tgz');
    execFileSync('/usr/bin/tar', ['-czf', unsafeTarball, '-C', unsafePackage, 'package']);
    assert.throws(() => inspectStagedPackageArchive(unsafeTarball), /link or unsupported entry/u);
    assert.match(packages[0].contentSha256, /^[a-f0-9]{64}$/u);
    assert.equal(packages[0].fileCount, 2);
    const consumer = resolve(directory, 'consumer');
    mkdirSync(consumer);
    writeFileSync(resolve(consumer, 'package.json'), '{"name":"consumer","private":true}\n');
    writeFileSync(
      resolve(consumer, 'bunfig.toml'),
      '[install]\nlinker = "isolated"\nbackend = "copyfile"\n',
    );
    execFileSync('bun', ['add', '--ignore-scripts', tarball], {
      cwd: consumer,
      stdio: 'pipe',
    });
    const installedPackage = resolve(consumer, 'node_modules/@tixkit/example');
    assert.equal(lstatSync(installedPackage).isSymbolicLink(), true);
    assert.equal(statSync(resolve(installedPackage, 'dist/index.js')).nlink, 1);
    assert.deepEqual(packageContentDigest(installedPackage), {
      contentSha256: packages[0].contentSha256,
      fileCount: packages[0].fileCount,
    });
    chmodSync(resolve(installedPackage, 'dist/index.js'), 0o755);
    assert.notEqual(
      packageContentDigest(installedPackage).contentSha256,
      packages[0].contentSha256,
    );
    chmodSync(resolve(installedPackage, 'dist/index.js'), 0o644);
    const consumerManifestPath = resolve(consumer, 'package.json');
    const consumerManifest = JSON.parse(readFileSync(consumerManifestPath, 'utf8'));
    consumerManifest.dependencies = { '@tixkit/example': packages[0].version };
    writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest)}\n`);
    const lockPath = resolve(consumer, 'bun.lock');
    const lock = parseBunLock(readFileSync(lockPath, 'utf8'));
    lock.workspaces[''].dependencies['@tixkit/example'] = packages[0].version;
    const lockEntry = Object.values(lock.packages).find(
      (entry) => Array.isArray(entry) && entry[0].startsWith('@tixkit/example@'),
    );
    assert.ok(lockEntry);
    lockEntry[0] = `@tixkit/example@${packages[0].version}`;
    lockEntry[3] = packages[0].integrity;
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
    execFileSync('git', ['init', '-q'], { cwd: consumer });
    execFileSync('git', ['add', 'package.json', 'bunfig.toml', 'bun.lock'], { cwd: consumer });
    const cloudManifest = compatibilityManifest();
    cloudManifest.core.packages = packages;
    cloudManifest.cloudRelease.consumedPackages = packages.map(({ name }) => name);
    bindCloudInstallations(cloudManifest, consumer);
    const stagedManifest = publicRelease(cloudManifest);
    writeFileSync(
      resolve(artifacts, 'public-release-manifest.json'),
      `${JSON.stringify(stagedManifest)}\n`,
    );
    writeFileSync(
      resolve(artifacts, 'images.json'),
      `${JSON.stringify(stagedManifest.core.images)}\n`,
    );
    const sbom = `${JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [{}] })}\n`;
    for (const name of [
      'npm-packages.spdx.json',
      'image-admin.spdx.json',
      'image-api.spdx.json',
      'image-checkout.spdx.json',
      'image-worker.spdx.json',
    ])
      writeFileSync(resolve(artifacts, name), sbom);
    const stagedContracts = stagePublicContractArtifacts(distribution, stagedManifest, artifacts);
    const writeStagedChecksums = () =>
      writeFileSync(
        resolve(artifacts, 'CHECKSUMS.sha256'),
        `${readdirSync(artifacts)
          .filter((name) => name !== 'CHECKSUMS.sha256')
          .sort()
          .map(
            (name) =>
              `${createHash('sha256')
                .update(readFileSync(resolve(artifacts, name)))
                .digest('hex')}  ${name}`,
          )
          .join('\n')}\n`,
      );
    writeStagedChecksums();
    assert.deepEqual(
      validateStagedPublicRelease(artifacts, stagedManifest.core.sourceCommit, '0.1.0'),
      [],
    );
    const originalContentSha256 = stagedManifest.core.packages[0].contentSha256;
    stagedManifest.core.packages[0].contentSha256 = 'f'.repeat(64);
    writeFileSync(
      resolve(artifacts, 'public-release-manifest.json'),
      `${JSON.stringify(stagedManifest)}\n`,
    );
    writeStagedChecksums();
    assert.ok(
      validateStagedPublicRelease(artifacts, stagedManifest.core.sourceCommit, '0.1.0').includes(
        'staged package content mismatch: @tixkit/example@1.0.0',
      ),
    );
    stagedManifest.core.packages[0].contentSha256 = originalContentSha256;
    writeFileSync(
      resolve(artifacts, 'public-release-manifest.json'),
      `${JSON.stringify(stagedManifest)}\n`,
    );
    writeStagedChecksums();
    const contractPath = resolve(artifacts, stagedContracts[0]);
    const contractBytes = readFileSync(contractPath);
    writeFileSync(contractPath, Buffer.concat([contractBytes, Buffer.from('\n')]));
    writeStagedChecksums();
    assert.ok(
      validateStagedPublicRelease(artifacts, stagedManifest.core.sourceCommit, '0.1.0').some(
        (violation) => violation.startsWith('staged contract checksum mismatch:'),
      ),
    );
    writeFileSync(contractPath, contractBytes);
    writeStagedChecksums();
    const { releasePath, bin } = attestedReleaseFixture(consumer, publicRelease(cloudManifest));
    const verifiedCommand = runVerifiedCommand({
      manifest: cloudManifest,
      releasePath,
      cloudRoot: consumer,
      bin,
      command: [process.execPath, '--version'],
    });
    assert.equal(verifiedCommand.status, 0, verifiedCommand.stderr);
    const release = { core: { packages } };
    assert.deepEqual(
      publishPublicNpmArtifacts(release, artifacts, () => ({
        status: 0,
        stdout: `${integrity}\n`,
        stderr: '',
      })),
      { published: [], reused: ['@tixkit/example@1.0.0'] },
    );
    const calls = [];
    assert.deepEqual(
      publishPublicNpmArtifacts(release, artifacts, (command, arguments_) => {
        calls.push([command, arguments_]);
        return calls.length === 1
          ? { status: 1, stdout: '', stderr: 'npm error E404' }
          : { status: 0, stdout: '', stderr: '' };
      }),
      { published: ['@tixkit/example@1.0.0'], reused: [] },
    );
    assert.deepEqual(calls[1][1].slice(0, 2), ['publish', tarball]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GitHub release reconciliation stages a draft before finalization', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-github-release-stage-'));
  try {
    writeFileSync(resolve(directory, 'public-release-manifest.json'), '{}\n');
    writeFileSync(resolve(directory, 'CHECKSUMS.sha256'), 'abc  public-release-manifest.json\n');
    const calls = [];
    const run = (command, arguments_) => {
      calls.push([command, arguments_]);
      return calls.length === 1
        ? { status: 1, stdout: '', stderr: 'release not found' }
        : { status: 0, stdout: '', stderr: '' };
    };
    assert.deepEqual(stagePublicGithubRelease('v1.0.0', 'tixkit/tixkit', directory, run), {
      created: true,
      uploaded: ['CHECKSUMS.sha256', 'public-release-manifest.json'],
    });
    assert.ok(calls[1][1].includes('--draft'));
    finalizePublicGithubRelease('v1.0.0', 'tixkit/tixkit', run);
    assert.ok(calls[2][1].includes('--draft=false'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GitHub release reconciliation rejects a rebuilt candidate after staging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-github-release-retry-'));
  try {
    writeFileSync(resolve(directory, 'public-release-manifest.json'), 'attempt-two\n');
    const run = () => ({
      status: 0,
      stdout: JSON.stringify({
        isDraft: true,
        assets: [{ name: 'public-release-manifest.json' }],
      }),
      stderr: '',
    });
    const download = (_command, arguments_) => {
      const destination = arguments_[arguments_.indexOf('--dir') + 1];
      writeFileSync(resolve(destination, 'public-release-manifest.json'), 'attempt-one\n');
    };
    assert.throws(
      () => stagePublicGithubRelease('v1.0.0', 'tixkit/tixkit', directory, run, download),
      /published GitHub release asset differs/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release workflow resumes staged bytes instead of rebuilding image candidates', () => {
  const workflow = readFileSync(
    resolve(root, '.github/workflows/public-artifact-release.yml'),
    'utf8',
  );
  assert.match(workflow, /validate-staged-public-release\.mjs/u);
  assert.ok(
    workflow.indexOf('gh attestation verify "$asset"') <
      workflow.indexOf('validate-staged-public-release.mjs'),
  );
  assert.match(workflow, /if: needs\.validate\.outputs\.resume != 'true'/u);
  assert.match(workflow, /name: resumed-public-release/u);
  assert.match(workflow, /image-\{admin,api,checkout,worker\}\.json/u);
  assert.match(workflow, /validate:public-repository -- --repository \./u);
  assert.match(workflow, /assets=\(resumed-public-release\/\*\)/u);
  assert.match(workflow, /for asset in "\$\{assets\[@\]\}"/u);
  assert.match(workflow, /gh attestation verify "oci:\/\/\$\{reference\}"/u);
  assert.ok(
    workflow.indexOf('subject-path: public-release/public-release-manifest.json') <
      workflow.indexOf('name: Stage or reconcile the immutable draft release'),
  );
  assert.match(
    workflow,
    /gh release delete "\$GITHUB_REF_NAME" --repo "\$GITHUB_REPOSITORY" --yes/u,
  );
  assert.doesNotMatch(workflow, /gh release delete[^\n]+--cleanup-tag/u);
});

test('incomplete staged drafts are classified for safe rebuild before publication', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-incomplete-draft-'));
  try {
    writeFileSync(resolve(directory, 'public-release-manifest.json'), '{}\n');
    assert.equal(classifyStagedPublicRelease(directory), 'incomplete');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects ranges, copied core source, private patches, and inconsistent image pins', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const controlPlanePath = resolve(cloudRoot, 'packages/control-plane/package.json');
    const controlPlane = JSON.parse(readFileSync(controlPlanePath, 'utf8'));
    controlPlane.dependencies['@tixkit/domain'] = 'workspace:*';
    controlPlane.patchedDependencies = {
      '@tixkit/domain': 'patches/domain.patch',
    };
    writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane, null, 2)}\n`);
    writeFileSync(resolve(cloudRoot, 'bunfig.toml'), '[install]\nlinker = "hoisted"\n');
    mkdirSync(resolve(cloudRoot, 'packages/domain'), { recursive: true });
    manifest.core.images[0].reference = `ghcr.io/tixkit/tixkit-api@sha256:${'f'.repeat(64)}`;

    const violations = validateCloudCoreConsumer(
      manifest,
      publicRelease(compatibilityManifest()),
      cloudRoot,
    );
    assert.ok(violations.includes('private Cloud tree copies public source path: packages/domain'));
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: @tixkit/domain must use exact compatibility version',
      ),
    );
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: private patching of @tixkit/domain is forbidden',
      ),
    );
    assert.ok(violations.some((message) => message.endsWith('reference and digest disagree')));
    assert.ok(violations.includes('private Cloud bunfig.toml must set install.linker to isolated'));
    assert.ok(
      violations.includes('private Cloud bunfig.toml must set install.backend to copyfile'),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects renamed source copies, artifact rewriting, and API contract drift', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const publicSource = readFileSync(resolve(root, 'packages/domain/src/index.ts'), 'utf8');
    const modifiedPublicSource = publicSource.replace("'./events", "'./private-events");
    assert.notEqual(modifiedPublicSource, publicSource);
    writeFileSync(
      resolve(cloudRoot, 'packages/control-plane/copied-core.ts'),
      `// reformatted private copy\n${modifiedPublicSource}`,
    );
    const controlPlanePath = resolve(cloudRoot, 'packages/control-plane/package.json');
    const controlPlane = JSON.parse(readFileSync(controlPlanePath, 'utf8'));
    controlPlane.scripts = {
      postinstall: "sed -i 's/private/public/' node_modules/@tixkit/domain/dist/index.js",
    };
    writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane, null, 2)}\n`);
    manifest.core.contracts[0].sha256 = 'e'.repeat(64);

    const violations = validateCloudCoreConsumer(
      manifest,
      publicRelease(compatibilityManifest()),
      cloudRoot,
    );
    assert.ok(
      violations.some((message) =>
        message.includes(
          'structurally copies public source content from packages/domain/src/index.ts',
        ),
      ),
    );
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: script postinstall modifies public Tixkit artifacts',
      ),
    );
    assert.ok(
      violations.includes('core pins must exactly match the verified public release manifest'),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects indirect build helpers that can rewrite installed artifacts', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const controlPlanePath = resolve(cloudRoot, 'packages/control-plane/package.json');
    const controlPlane = JSON.parse(readFileSync(controlPlanePath, 'utf8'));
    controlPlane.scripts = { build: 'node scripts/setup.mjs' };
    writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane, null, 2)}\n`);
    mkdirSync(resolve(cloudRoot, 'packages/control-plane/scripts'), {
      recursive: true,
    });
    writeFileSync(
      resolve(cloudRoot, 'packages/control-plane/scripts/setup.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(['node_modules', '@tixkit', 'domain', 'dist', 'index.js'].join('/'), 'patched');\n",
    );
    const violations = validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot);
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: build script build invokes a mutable local helper',
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test(
  'verified Cloud commands reject preinstalled byte and mode changes',
  { timeout: 15_000 },
  () => {
    const directory = cloudFixture();
    try {
      const manifest = compatibilityManifest();
      installFixturePackages(directory, manifest);
      const domainPath = resolve(directory, 'node_modules/@tixkit/domain/index.js');
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      writeFileSync(domainPath, 'export const state = "patched";\n');
      let result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /(?:installed dependency inventory does not match|installed public package does not match release content: @tixkit\/domain)/u,
      );
      chmodSync(domainPath, 0o644);
      const sharedPath = resolve(directory, 'node_modules/shared-index.js');
      writeFileSync(sharedPath, 'export const state = "public";\n');
      rmSync(domainPath);
      linkSync(sharedPath, domainPath);
      result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not use the required copyfile backend: @tixkit\/domain/u);
      rmSync(domainPath);
      writeFileSync(domainPath, 'export const state = "public";\n');
      chmodSync(domainPath, 0o755);
      result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /(?:installed dependency inventory does not match|installed public package does not match release content: @tixkit\/domain)/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'verified Cloud commands bind every installed dependency and executable shim',
  { timeout: 15_000 },
  () => {
    const directory = cloudFixture();
    try {
      const manifest = compatibilityManifest();
      installFixturePackages(directory, manifest);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      const run = () =>
        runVerifiedCommand({
          manifest,
          releasePath,
          cloudRoot: directory,
          bin,
          command: [process.execPath, '--version'],
        });

      const extra = resolve(directory, 'node_modules/evil/index.js');
      mkdirSync(dirname(extra), { recursive: true });
      writeFileSync(extra, 'export const evil = true;\n');
      let result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /installed dependency inventory does not match/u);
      rmSync(resolve(directory, 'node_modules/evil'), { recursive: true });

      const privateDependency = resolve(directory, 'node_modules/private-dependency/index.js');
      mkdirSync(dirname(privateDependency), { recursive: true });
      writeFileSync(privateDependency, 'export const state = "authentic";\n');
      bindCloudInstallations(manifest, directory);
      writeFileSync(privateDependency, 'export const state = "patched";\n');
      result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /installed dependency inventory does not match/u);
      writeFileSync(privateDependency, 'export const state = "authentic";\n');

      const executableShim = resolve(directory, 'node_modules/.bin/private-tool');
      mkdirSync(dirname(executableShim), { recursive: true });
      writeFileSync(executableShim, '#!/bin/sh\nexit 0\n');
      chmodSync(executableShim, 0o755);
      bindCloudInstallations(manifest, directory);
      writeFileSync(executableShim, '#!/bin/sh\nexit 1\n');
      result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /installed dependency inventory does not match/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  'verified Cloud commands reject dependency mutation during materialization',
  { timeout: 15_000 },
  () => {
    const directory = cloudFixture();
    const attackDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-dependency-race-'));
    let mutationService;
    try {
      const manifest = compatibilityManifest();
      writeFileSync(resolve(directory, 'dependency-copy-marker'), 'exact fixture\n');
      execFileSync('git', ['add', 'dependency-copy-marker'], { cwd: directory });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Tixkit Cloud Test',
          '-c',
          'user.email=cloud-test@tixkit.invalid',
          'commit',
          '-qm',
          'Add dependency race marker',
        ],
        { cwd: directory },
      );
      bindCloudRelease(manifest, directory);
      installFixturePackages(directory, manifest);
      const payload = resolve(directory, 'node_modules/private-dependency/payload.bin');
      mkdirSync(dirname(payload), { recursive: true });
      writeFileSync(payload, Buffer.alloc(8 * 1024 * 1024, 0x61));
      bindCloudInstallations(manifest, directory);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      const service = resolve(attackDirectory, 'dependency-service.mjs');
      writeFileSync(
        service,
        `import { readdirSync, writeFileSync } from 'node:fs';
const [payload, parent, baselineJson] = process.argv.slice(2);
const baseline = new Set(JSON.parse(baselineJson));
for (;;) {
  const ready = readdirSync(parent)
    .filter((name) => name.startsWith('.tixkit-cloud-source-'))
    .some((name) => !baseline.has(name));
  if (ready) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
writeFileSync(payload, Buffer.alloc(8 * 1024 * 1024, 0x62));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
writeFileSync(payload, Buffer.alloc(8 * 1024 * 1024, 0x61));
`,
      );
      const parent = dirname(directory);
      const baseline = readdirSync(parent).filter((name) =>
        name.startsWith('.tixkit-cloud-source-'),
      );
      mutationService = spawn(
        process.execPath,
        [service, payload, parent, JSON.stringify(baseline)],
        { stdio: 'ignore' },
      );
      const result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /installed dependency inventory does not match/u);
    } finally {
      mutationService?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
      rmSync(attackDirectory, { recursive: true, force: true });
    }
  },
);

test('verified Cloud commands use fixed trusted Git and archive tools', () => {
  const directory = cloudFixture();
  const evidence = mkdtempSync(join(tmpdir(), 'tixkit-cloud-tool-substitution-'));
  try {
    const manifest = compatibilityManifest();
    installFixturePackages(directory, manifest);
    const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
    for (const name of ['git', 'tar', 'bwrap']) {
      const executable = resolve(bin, name);
      writeFileSync(
        executable,
        `#!/bin/sh\ntouch ${JSON.stringify(resolve(evidence, name))}\nexit 99\n`,
      );
      chmodSync(executable, 0o755);
    }
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot: directory,
      bin,
      command: [process.execPath, '--version'],
    });
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['git', 'tar', 'bwrap'])
      assert.equal(existsSync(resolve(evidence, name)), false, `${name} must not come from PATH`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test(
  'verified Cloud commands reject a hidden alternate public package installation',
  { timeout: 15_000 },
  () => {
    const directory = cloudFixture();
    const externalDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-hidden-install-'));
    try {
      const manifest = compatibilityManifest();
      installFixturePackages(directory, manifest);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      const hiddenPackage = resolve(directory, 'node_modules/rogue/node_modules/@tixkit/domain');
      cpSync(resolve(directory, 'node_modules/@tixkit/domain'), hiddenPackage, { recursive: true });
      writeFileSync(
        resolve(hiddenPackage, 'index.js'),
        'export const state = "hidden-private-patch";\n',
      );
      const result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [
          process.execPath,
          '-e',
          `import(${JSON.stringify(resolve(hiddenPackage, 'index.js'))})`,
        ],
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /(?:installed dependency inventory does not match|installed public package does not match release content: @tixkit\/domain)/u,
      );
      rmSync(resolve(directory, 'node_modules/rogue'), { recursive: true, force: true });
      const externalPackage = resolve(externalDirectory, 'rogue');
      mkdirSync(externalPackage);
      writeFileSync(
        resolve(externalPackage, 'package.json'),
        '{"name":"rogue","version":"1.0.0"}\n',
      );
      cpSync(
        resolve(directory, 'node_modules/@tixkit/domain'),
        resolve(externalPackage, 'node_modules/@tixkit/domain'),
        { recursive: true },
      );
      writeFileSync(
        resolve(externalPackage, 'node_modules/@tixkit/domain/index.js'),
        'export const state = "external-private-patch";\n',
      );
      symlinkSync(externalPackage, resolve(directory, 'node_modules/rogue'), 'dir');
      const symlinkResult = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [
          process.execPath,
          '-e',
          `import(${JSON.stringify(resolve(directory, 'node_modules/rogue/node_modules/@tixkit/domain/index.js'))})`,
        ],
      });
      assert.equal(symlinkResult.status, 1);
      assert.match(symlinkResult.stderr, /unexpected directory symlink/u);
      const lockPath = resolve(directory, 'bun.lock');
      const lock = parseBunLock(readFileSync(lockPath, 'utf8'));
      lock.workspaces[relative(directory, externalPackage)] = { name: 'rogue' };
      writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
      const forgedWorkspaceResult = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(forgedWorkspaceResult.status, 1);
      assert.match(forgedWorkspaceResult.stderr, /lockfile declares an invalid workspace/u);

      delete lock.workspaces[relative(directory, externalPackage)];
      lock.workspaces['packages/control-plane'].name = '@tixkit/domain';
      writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);
      const controlPlanePath = resolve(directory, 'packages/control-plane/package.json');
      const controlPlane = JSON.parse(readFileSync(controlPlanePath, 'utf8'));
      controlPlane.name = '@tixkit/domain';
      writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane)}\n`);
      unlinkSync(resolve(directory, 'node_modules/rogue'));
      symlinkSync(
        resolve(directory, 'packages/control-plane'),
        resolve(directory, 'node_modules/rogue'),
        'dir',
      );
      const publicWorkspaceResult = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(publicWorkspaceResult.status, 1);
      assert.match(
        publicWorkspaceResult.stderr,
        /public package identity cannot be a private workspace/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(externalDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'immutable command sandbox rejects direct and host-service patch-use-restore attacks',
  { timeout: 25_000 },
  () => {
    const directory = cloudFixture();
    const attackDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-install-attack-'));
    let mutationService;
    try {
      const manifest = compatibilityManifest();
      installFixturePackages(directory, manifest);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      const domainPath = resolve(directory, 'node_modules/@tixkit/domain/index.js');
      const domainRoot = resolve(domainPath, '..');
      const proof = resolve(directory, 'proof');
      const attack = resolve(attackDirectory, 'attack.mjs');
      writeFileSync(
        attack,
        `import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
const [kind, domainPath, domainRoot, proof] = process.argv.slice(2);
if (kind === 'chmod') {
  chmodSync(domainPath, 0o644);
  writeFileSync(domainPath, 'export const state = "temporary";\\n');
  mkdirSync(proof, { recursive: true });
  writeFileSync(proof + '/used.txt', readFileSync(domainPath));
  writeFileSync(domainPath, 'export const state = "public";\\n');
} else {
  const backup = domainRoot + '.authentic';
  renameSync(domainRoot, backup);
  mkdirSync(domainRoot);
  writeFileSync(domainRoot + '/index.js', 'export const state = "temporary";\\n');
  mkdirSync(proof, { recursive: true });
  writeFileSync(proof + '/used.txt', readFileSync(domainRoot + '/index.js'));
  rmSync(domainRoot, { recursive: true });
  renameSync(backup, domainRoot);
}
`,
      );
      const unsafeWritable = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
        writable: ['node_modules'],
      });
      assert.equal(unsafeWritable.status, 1);
      assert.match(unsafeWritable.stderr, /writable path overlaps installed dependencies/u);
      for (const kind of ['chmod', 'swap']) {
        const result = runVerifiedCommand({
          manifest,
          releasePath,
          cloudRoot: directory,
          bin,
          command: [process.execPath, attack, kind, domainPath, domainRoot, proof],
          writable: ['proof'],
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(
          result.stderr,
          /Cloud command (?:failed with status|argument references live checkout|contains an undeclared absolute input)/u,
        );
      }
      assert.equal(readFileSync(domainPath, 'utf8'), 'export const state = "public";\n');
      assert.equal(existsSync(resolve(proof, 'used.txt')), false);

      const controlSocket = resolve(attackDirectory, 'mutation.sock');
      const service = resolve(attackDirectory, 'service.mjs');
      const client = resolve(attackDirectory, 'client.mjs');
      writeFileSync(
        service,
        `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const [socketPath, domainPath] = process.argv.slice(2);
const server = createServer((socket) => {
  writeFileSync(domainPath, 'export const state = "daemon-patch";\\n');
  socket.end('patched');
  writeFileSync(domainPath, 'export const state = "public";\\n');
});
server.listen(socketPath);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
      );
      writeFileSync(
        client,
        `import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
const [socketPath, proof] = process.argv.slice(2);
const socket = createConnection(socketPath);
socket.on('data', (data) => {
  mkdirSync(proof, { recursive: true });
  writeFileSync(proof + '/used.txt', data);
});
socket.on('error', (error) => { throw error; });
`,
      );
      mutationService = spawn(process.execPath, [service, controlSocket, domainPath], {
        stdio: 'ignore',
      });
      for (let attempt = 0; attempt < 200 && !existsSync(controlSocket); attempt += 1)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      assert.equal(existsSync(controlSocket), true);
      const serviceEscape = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, client, controlSocket, proof],
        writable: ['proof'],
      });
      assert.equal(serviceEscape.status, 1, serviceEscape.stderr);
      assert.match(
        serviceEscape.stderr,
        /Cloud command (?:failed with status|argument references live checkout|contains an undeclared absolute input)/u,
      );
      assert.equal(readFileSync(domainPath, 'utf8'), 'export const state = "public";\n');
      assert.equal(existsSync(resolve(proof, 'used.txt')), false);
    } finally {
      mutationService?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
      rmSync(attackDirectory, { recursive: true, force: true });
    }
  },
);

test('verified Cloud output publication preserves the staged directory inode', () => {
  const directory = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    writeFileSync(
      resolve(directory, 'packages/control-plane/inode-output.mjs'),
      `import { statSync, writeFileSync } from 'node:fs';
writeFileSync('proof/staged-inode.txt', String(statSync('proof').ino));
writeFileSync('proof/verified-output.txt', 'verified');
`,
    );
    execFileSync('git', ['add', 'packages/control-plane/inode-output.mjs'], { cwd: directory });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Add output inode fixture',
      ],
      { cwd: directory },
    );
    bindCloudRelease(manifest, directory);
    installFixturePackages(directory, manifest);
    const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot: directory,
      bin,
      command: [process.execPath, 'packages/control-plane/inode-output.mjs'],
      writable: ['proof'],
    });
    assert.equal(result.status, 0, result.stderr);
    const proof = resolve(directory, 'proof');
    assert.equal(
      readFileSync(resolve(proof, 'staged-inode.txt'), 'utf8'),
      String(statSync(proof).ino),
    );
    assert.equal(readFileSync(resolve(proof, 'verified-output.txt'), 'utf8'), 'verified');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'verified Cloud commands read a materialized commit during tracked patch-use-restore attacks',
  { timeout: 20_000 },
  () => {
    const directory = cloudFixture();
    const attackDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-source-attack-'));
    let mutationService;
    try {
      const manifest = compatibilityManifest();
      const trackedSource = resolve(directory, 'packages/control-plane/release-source.txt');
      const client = resolve(directory, 'packages/control-plane/source-client.mjs');
      writeFileSync(trackedSource, 'committed-source\n');
      writeFileSync(
        client,
        `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
mkdirSync('proof', { recursive: true });
writeFileSync('proof/used.txt', readFileSync('packages/control-plane/release-source.txt'));
writeFileSync('proof/traversal.txt', readFileSync('proof/../packages/control-plane/release-source.txt'));
let liveCheckoutRead = 'denied';
try { liveCheckoutRead = readFileSync(${JSON.stringify(
          resolve(directory, 'packages/control-plane/release-source.txt'),
        )}, 'utf8'); } catch {}
writeFileSync('proof/live-checkout.txt', liveCheckoutRead);
writeFileSync('proof/environment.json', JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, initCwd: process.env.INIT_CWD, path: process.env.PATH }));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
`,
      );
      execFileSync(
        'git',
        [
          'add',
          'packages/control-plane/release-source.txt',
          'packages/control-plane/source-client.mjs',
        ],
        { cwd: directory },
      );
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Tixkit Cloud Test',
          '-c',
          'user.email=cloud-test@tixkit.invalid',
          'commit',
          '-qm',
          'Add private release source',
        ],
        { cwd: directory },
      );
      bindCloudRelease(manifest, directory);
      installFixturePackages(directory, manifest);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      const proof = resolve(directory, 'proof');
      const service = resolve(attackDirectory, 'source-service.mjs');
      writeFileSync(
        service,
        `import { existsSync, readdirSync, writeFileSync } from 'node:fs';
const [trackedSource, temporaryRoot] = process.argv.slice(2);
for (;;) {
  const ready = readdirSync(temporaryRoot)
    .filter((name) => name.startsWith('.tixkit-cloud-source-'))
    .some((name) => existsSync(temporaryRoot + '/' + name + '/packages/control-plane/release-source.txt') && existsSync(temporaryRoot + '/' + name + '/proof'));
  if (ready) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
writeFileSync(trackedSource, 'host-patched-source\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
writeFileSync(trackedSource, 'committed-source\\n');
`,
      );
      mutationService = spawn(process.execPath, [service, trackedSource, tmpdir()], {
        stdio: 'ignore',
      });
      const result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, 'packages/control-plane/source-client.mjs'],
        writable: ['proof'],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(resolve(proof, 'used.txt'), 'utf8'), 'committed-source\n');
      assert.equal(readFileSync(resolve(proof, 'traversal.txt'), 'utf8'), 'committed-source\n');
      assert.match(
        readFileSync(resolve(proof, 'live-checkout.txt'), 'utf8'),
        /^(?:committed-source\n|denied)$/u,
      );
      const environment = JSON.parse(readFileSync(resolve(proof, 'environment.json'), 'utf8'));
      assert.notEqual(environment.cwd, directory);
      assert.notEqual(environment.pwd, directory);
      assert.notEqual(environment.initCwd, directory);
      assert.equal(environment.path.includes(directory), false);
      assert.equal(readFileSync(trackedSource, 'utf8'), 'committed-source\n');
    } finally {
      mutationService?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
      rmSync(attackDirectory, { recursive: true, force: true });
    }
  },
);

test('verified Cloud commands reject host races against writable output publication', () => {
  const directory = cloudFixture();
  const attackDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-output-attack-'));
  let mutationService;
  try {
    const manifest = compatibilityManifest();
    writeFileSync(resolve(directory, 'output-race-marker'), 'exact fixture\n');
    writeFileSync(
      resolve(directory, 'packages/control-plane/output-client.mjs'),
      `import { writeFileSync } from 'node:fs';
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
writeFileSync('proof/verified-output.txt', 'verified');
`,
    );
    execFileSync('git', ['add', 'output-race-marker', 'packages/control-plane/output-client.mjs'], {
      cwd: directory,
    });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Add output race marker',
      ],
      { cwd: directory },
    );
    bindCloudRelease(manifest, directory);
    installFixturePackages(directory, manifest);
    const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
    const proof = resolve(directory, 'proof');
    const service = resolve(attackDirectory, 'output-service.mjs');
    writeFileSync(
      service,
      `import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
const [destination, temporaryRoot] = process.argv.slice(2);
for (;;) {
  const ready = readdirSync(temporaryRoot)
    .filter((name) => name.startsWith('.tixkit-cloud-source-'))
    .some((name) => existsSync(temporaryRoot + '/' + name + '/output-race-marker') && existsSync(temporaryRoot + '/' + name + '/proof'));
  if (ready) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
mkdirSync(destination);
writeFileSync(destination + '/host-race.txt', 'unbound');
`,
    );
    mutationService = spawn(process.execPath, [service, proof, tmpdir()], {
      stdio: 'ignore',
    });
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot: directory,
      bin,
      command: [process.execPath, 'packages/control-plane/output-client.mjs'],
      writable: ['proof'],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /writable path changed before output publication/u);
    assert.equal(existsSync(resolve(proof, 'verified-output.txt')), false);
  } finally {
    mutationService?.kill('SIGTERM');
    rmSync(directory, { recursive: true, force: true });
    rmSync(attackDirectory, { recursive: true, force: true });
  }
});

test('verified Cloud commands reject unsafe staged output entries', () => {
  const directory = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const command = resolve(directory, 'packages/control-plane/unsafe-output.mjs');
    writeFileSync(
      command,
      `import { symlinkSync } from 'node:fs';
symlinkSync('/etc/passwd', 'proof/leak');
`,
    );
    execFileSync('git', ['add', 'packages/control-plane/unsafe-output.mjs'], { cwd: directory });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Add unsafe output command',
      ],
      { cwd: directory },
    );
    bindCloudRelease(manifest, directory);
    installFixturePackages(directory, manifest);
    const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot: directory,
      bin,
      command: [process.execPath, 'packages/control-plane/unsafe-output.mjs'],
      writable: ['proof'],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /writable output contains an unsafe entry/u);
    assert.equal(existsSync(resolve(directory, 'proof')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'verified Cloud output publication never exposes a raced nested symlink',
  { timeout: 15_000 },
  () => {
    const directory = cloudFixture();
    const attackDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-nested-output-race-'));
    let mutationService;
    let observer;
    try {
      const manifest = compatibilityManifest();
      writeFileSync(resolve(directory, 'nested-output-race-marker'), 'exact fixture\n');
      writeFileSync(
        resolve(directory, 'packages/control-plane/nested-output.mjs'),
        `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('proof/nested', { recursive: true });
for (let index = 0; index < 2000; index += 1) writeFileSync('proof/nested/' + index + '.txt', 'verified-output');
writeFileSync('proof/nested/complete.txt', 'verified');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
`,
      );
      execFileSync(
        'git',
        ['add', 'nested-output-race-marker', 'packages/control-plane/nested-output.mjs'],
        { cwd: directory },
      );
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Tixkit Cloud Test',
          '-c',
          'user.email=cloud-test@tixkit.invalid',
          'commit',
          '-qm',
          'Add nested output race fixture',
        ],
        { cwd: directory },
      );
      bindCloudRelease(manifest, directory);
      installFixturePackages(directory, manifest);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      const service = resolve(attackDirectory, 'nested-service.mjs');
      const observerScript = resolve(attackDirectory, 'observer.mjs');
      const observedLeak = resolve(attackDirectory, 'observed-leak');
      writeFileSync(
        service,
        `import { existsSync, readdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
const [parent, baselineJson] = process.argv.slice(2);
const baseline = new Set(JSON.parse(baselineJson));
let nested;
for (;;) {
  const root = readdirSync(parent).find((name) => name.startsWith('.tixkit-cloud-source-') && !baseline.has(name));
  if (root && existsSync(parent + '/' + root + '/nested-output-race-marker') && existsSync(parent + '/' + root + '/proof/nested/complete.txt')) {
    nested = parent + '/' + root + '/proof/nested';
    break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
const backup = nested + '.authentic';
for (let attempt = 0; attempt < 1000; attempt += 1) {
  try {
    renameSync(nested, backup);
    symlinkSync('/etc', nested, 'dir');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    unlinkSync(nested);
    renameSync(backup, nested);
  } catch {}
}
`,
      );
      writeFileSync(
        observerScript,
        `import { existsSync, lstatSync, writeFileSync } from 'node:fs';
const [destination, evidence] = process.argv.slice(2);
for (let attempt = 0; attempt < 5000; attempt += 1) {
  const nested = destination + '/nested';
  if (existsSync(nested) && lstatSync(nested).isSymbolicLink()) {
    writeFileSync(evidence, 'unsafe output became observable');
    break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
`,
      );
      const parent = dirname(directory);
      const baseline = readdirSync(parent).filter((name) =>
        name.startsWith('.tixkit-cloud-source-'),
      );
      mutationService = spawn(process.execPath, [service, parent, JSON.stringify(baseline)], {
        stdio: 'ignore',
      });
      observer = spawn(
        process.execPath,
        [observerScript, resolve(directory, 'proof'), observedLeak],
        { stdio: 'ignore' },
      );
      const result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, 'packages/control-plane/nested-output.mjs'],
        writable: ['proof'],
      });
      mutationService.kill('SIGTERM');
      observer.kill('SIGTERM');
      assert.equal(existsSync(observedLeak), false);
      if (result.status === 0) {
        const nested = resolve(directory, 'proof/nested');
        assert.equal(lstatSync(nested).isDirectory(), true);
        assert.equal(lstatSync(nested).isSymbolicLink(), false);
        assert.equal(readFileSync(resolve(nested, 'complete.txt'), 'utf8'), 'verified');
        assert.equal(existsSync(resolve(directory, 'proof/nested/passwd')), false);
      } else {
        assert.equal(existsSync(resolve(directory, 'proof')), false);
      }
    } finally {
      mutationService?.kill('SIGTERM');
      observer?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
      rmSync(attackDirectory, { recursive: true, force: true });
    }
  },
);

test('verified Cloud commands reject symlink aliases into the live checkout', () => {
  const directory = cloudFixture();
  const commandDirectory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-live-alias-'));
  try {
    const manifest = compatibilityManifest();
    const trackedCommand = resolve(directory, 'packages/control-plane/live-command.mjs');
    writeFileSync(trackedCommand, 'process.stdout.write("live checkout");\n');
    execFileSync('git', ['add', 'packages/control-plane/live-command.mjs'], { cwd: directory });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Tixkit Cloud Test',
        '-c',
        'user.email=cloud-test@tixkit.invalid',
        'commit',
        '-qm',
        'Add private command',
      ],
      { cwd: directory },
    );
    bindCloudRelease(manifest, directory);
    installFixturePackages(directory, manifest);
    const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
    const alias = resolve(commandDirectory, 'live-command-alias.mjs');
    symlinkSync(trackedCommand, alias);
    const result = runVerifiedCommand({
      manifest,
      releasePath,
      cloudRoot: directory,
      bin,
      command: [process.execPath, alias],
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /command argument references live checkout/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(commandDirectory, { recursive: true, force: true });
  }
});

test(
  'verified Cloud commands reject undeclared external source trees and multiple output roots',
  { timeout: 10_000 },
  () => {
    const directory = cloudFixture();
    const externalCore = mkdtempSync(join(tmpdir(), 'tixkit-cloud-alternate-core-'));
    try {
      const manifest = compatibilityManifest();
      const alternateModule = resolve(externalCore, 'index.mjs');
      writeFileSync(alternateModule, 'export const source = "unattested alternate core";\n');
      const trackedCommand = resolve(directory, 'packages/control-plane/external-core.mjs');
      writeFileSync(
        trackedCommand,
        `await import(${JSON.stringify(`file://${alternateModule}`)});\n`,
      );
      execFileSync('git', ['add', 'packages/control-plane/external-core.mjs'], { cwd: directory });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Tixkit Cloud Test',
          '-c',
          'user.email=cloud-test@tixkit.invalid',
          'commit',
          '-qm',
          'Add external core attack',
        ],
        { cwd: directory },
      );
      bindCloudRelease(manifest, directory);
      installFixturePackages(directory, manifest);
      const { releasePath, bin } = attestedReleaseFixture(directory, publicRelease(manifest));
      let result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, 'packages/control-plane/external-core.mjs'],
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Cloud command failed with status/u);

      result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot: directory,
        bin,
        command: [process.execPath, '--version'],
        writable: ['first-output', 'second-output'],
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /require one common writable output root/u);
      assert.equal(existsSync(resolve(directory, 'first-output')), false);
      assert.equal(existsSync(resolve(directory, 'second-output')), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(externalCore, { recursive: true, force: true });
    }
  },
);

test('verified Cloud commands reject empty or substituted compatibility manifests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-invalid-install-manifest-'));
  try {
    assert.throws(
      () =>
        verifyCloudCoreInstall({ core: { packages: [] } }, 'untrusted.json', directory, ['build']),
      /Cloud\/core install manifest is invalid/u,
    );

    const manifest = compatibilityManifest();
    const cloudRoot = cloudFixture(manifest);
    installFixturePackages(cloudRoot, manifest);
    const { releasePath, bin } = attestedReleaseFixture(cloudRoot, publicRelease(manifest));
    manifest.core.packages.pop();
    try {
      const result = runVerifiedCommand({
        manifest,
        releasePath,
        cloudRoot,
        bin,
        command: [process.execPath, '--version'],
      });
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /core pins must exactly match the verified public release manifest/u,
      );
    } finally {
      rmSync(cloudRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed on internally inconsistent release contracts and schema drift', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    manifest.core.agentProtocol = { status: 'supported', version: '' };
    manifest.core.contracts.find(({ name }) => name === 'openapi').version = '2000-01-01';
    manifest.core.migrationRange.minimum = '9999';
    manifest.unreviewed = true;
    const violations = validateCloudCoreConsumer(
      manifest,
      publicRelease(compatibilityManifest()),
      cloudRoot,
    );
    assert.ok(violations.includes('$.unreviewed is not allowed'));

    delete manifest.unreviewed;
    const semanticViolations = validateCloudCoreConsumer(
      manifest,
      publicRelease(compatibilityManifest()),
      cloudRoot,
    );
    assert.ok(semanticViolations.includes('OpenAPI contract version must equal core.apiVersion'));
    assert.ok(semanticViolations.includes('core migration range minimum must not exceed maximum'));
    assert.ok(semanticViolations.includes('agent protocol status and version are inconsistent'));
    assert.ok(
      semanticViolations.includes(
        'supported agent protocol must match exactly one released contract',
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('validates an older attested core inventory without requiring the current checkout versions', () => {
  const manifest = compatibilityManifest();
  manifest.core.apiVersion = '2025-01-01';
  manifest.core.migrationRange.maximum = '0063';
  manifest.core.contracts.find(({ name }) => name === 'openapi').version = '2025-01-01';
  for (const pin of manifest.core.packages) pin.version = '0.0.9';
  const cloudRoot = cloudFixture(manifest);
  try {
    assert.deepEqual(validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot), []);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects package, image, source, and contract pins that differ from the public release', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const release = publicRelease(manifest);
    manifest.core.sourceCommit = 'f'.repeat(40);
    manifest.core.sourceTreeSha256 = '9'.repeat(64);
    manifest.core.packages[0].integrity = 'sha512-Zg==';
    manifest.core.images[0].digest = `sha256:${'8'.repeat(64)}`;
    manifest.core.images[0].reference = `${manifest.core.images[0].reference.split('@')[0]}@${manifest.core.images[0].digest}`;
    manifest.core.contracts.push({
      name: 'invented',
      version: '1',
      sha256: '7'.repeat(64),
    });
    const violations = validateCloudCoreConsumer(manifest, release, cloudRoot);
    assert.ok(
      violations.includes('core pins must exactly match the verified public release manifest'),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects missing package pins, peers, aliases, and lockfile integrity drift', () => {
  const cloudRoot = cloudFixture();
  try {
    const baseline = compatibilityManifest();
    const manifest = compatibilityManifest();
    manifest.core.packages = manifest.core.packages.filter(({ name }) => name !== '@tixkit/widget');
    const controlPlanePath = resolve(cloudRoot, 'packages/control-plane/package.json');
    const controlPlane = JSON.parse(readFileSync(controlPlanePath, 'utf8'));
    controlPlane.peerDependencies = { tixkit: '^0.1.0' };
    controlPlane.devDependencies = { forked: 'npm:@tixkit/domain@^0.1.0' };
    writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane, null, 2)}\n`);
    const lockPath = resolve(cloudRoot, 'bun.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['@tixkit/domain'][3] = 'sha512-Zg==';
    delete lock.packages['@tixkit/openapi'];
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);

    const violations = validateCloudCoreConsumer(manifest, publicRelease(baseline), cloudRoot);
    assert.ok(violations.includes('missing core package pin: @tixkit/widget'));
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: aliases of public package @tixkit/domain are forbidden',
      ),
    );
    assert.ok(
      violations.some((message) => message.includes('tixkit must use exact compatibility version')),
    );
    assert.ok(
      violations.some((message) => message.includes('bun.lock integrity for @tixkit/domain')),
    );
    assert.ok(violations.includes('bun.lock does not resolve claimed pin @tixkit/openapi@0.1.0'));
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects every alternate public package resolution in the private lockfile', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const lockPath = resolve(cloudRoot, 'bun.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['forked-domain'] = ['@tixkit/domain@9.9.9', '', {}, 'sha512-Zm9ya2Vk'];
    writeFileSync(lockPath, `${JSON.stringify(lock)}\n`);

    const violations = validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot);
    assert.ok(
      violations.includes(
        'bun.lock contains multiple resolutions for public package @tixkit/domain',
      ),
    );
    assert.ok(
      violations.includes(
        'bun.lock resolves public package @tixkit/domain at forbidden version 9.9.9',
      ),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('scans generated-looking paths and rejects remote public source acquisition', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const controlPlaneRoot = resolve(cloudRoot, 'packages/control-plane');
    const copiedSource = readFileSync(resolve(root, 'packages/domain/src/index.ts'));
    for (const directory of ['build', 'coverage', 'dist']) {
      mkdirSync(resolve(controlPlaneRoot, directory), { recursive: true });
      writeFileSync(resolve(controlPlaneRoot, directory, 'fork.ts'), copiedSource);
    }
    const controlPlanePath = resolve(controlPlaneRoot, 'package.json');
    const controlPlane = JSON.parse(readFileSync(controlPlanePath, 'utf8'));
    controlPlane.dependencies.forked = 'tixkit/tixkit#main';
    controlPlane.dependencies.localFork = '../tixkit';
    controlPlane.devDependencies = {
      snapshot: `https://github.com/tixkit/tixkit/archive/${'a'.repeat(40)}.tar.gz`,
    };
    controlPlane.scripts = {
      build: 'gh repo clone tixkit/tixkit vendor/core',
      postbuild: 'bun add github:tixkit/tixkit',
    };
    writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane, null, 2)}\n`);
    writeFileSync(
      resolve(cloudRoot, '.gitmodules'),
      '[submodule "core"]\n\tpath = vendor/core\n\turl = ../tixkit.git\n',
    );
    writeFileSync(
      resolve(controlPlaneRoot, 'Dockerfile'),
      'FROM node:24\nRUN git clone https://github.com/tixkit/tixkit.git /src/core\n',
    );
    mkdirSync(resolve(cloudRoot, '.github/workflows'), { recursive: true });
    writeFileSync(
      resolve(cloudRoot, '.github/workflows/build.yml'),
      'jobs:\n  core:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          repository: tixkit/tixkit\n',
    );

    const violations = validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot);
    for (const directory of ['build', 'coverage', 'dist']) {
      assert.ok(
        violations.some((message) =>
          message.startsWith(`packages/control-plane/${directory}/fork.ts: copies public source`),
        ),
      );
    }
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: dependency forked uses a forbidden mutable or source reference',
      ),
    );
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: dependency snapshot uses a forbidden mutable or source reference',
      ),
    );
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: dependency localFork uses a forbidden mutable or source reference',
      ),
    );
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: script build acquires public Tixkit source',
      ),
    );
    assert.ok(
      violations.includes(
        'packages/control-plane/package.json: script postbuild acquires public Tixkit source',
      ),
    );
    assert.ok(violations.includes('.gitmodules: public Tixkit source submodules are forbidden'));
    assert.ok(
      violations.includes(
        'packages/control-plane/Dockerfile: executable acquires public Tixkit source',
      ),
    );
    assert.ok(
      violations.includes('.github/workflows/build.yml: executable acquires public Tixkit source'),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('rejects tracked dependency output even when node_modules is not walked', () => {
  const cloudRoot = cloudFixture();
  try {
    const trackedPath = 'packages/control-plane/node_modules/forked-core/index.ts';
    const copiedPath = resolve(cloudRoot, trackedPath);
    mkdirSync(resolve(copiedPath, '..'), { recursive: true });
    writeFileSync(copiedPath, readFileSync(resolve(root, 'packages/domain/src/index.ts')));
    execFileSync('git', ['add', '-f', trackedPath], { cwd: cloudRoot });

    const violations = validateCloudCoreConsumer(
      compatibilityManifest(),
      publicRelease(compatibilityManifest()),
      cloudRoot,
    );
    assert.ok(
      violations.includes(`private Cloud tracks forbidden dependency output: ${trackedPath}`),
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});

test('source-boundary validation fails closed without readable Git inventory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-no-git-'));
  try {
    assert.ok(
      privateCloudSourceBoundaryViolations(directory).includes(
        'private Cloud tree must be a Git repository with readable tracked inventory',
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Cloud consumer CLIs fail before consumption when release attestation is not verified', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-attestation-'));
  try {
    const gh = resolve(directory, 'gh');
    const ghArguments = resolve(directory, 'gh-arguments');
    writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGUMENTS"\nexit 17\n');
    chmodSync(gh, 0o755);
    const manifestPath = resolve(directory, 'compatibility.json');
    const releasePath = resolve(directory, 'public-release.json');
    const manifest = compatibilityManifest();
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(releasePath, `${JSON.stringify(publicRelease(manifest))}\n`);
    const commonArguments = [
      '--manifest',
      manifestPath,
      '--public-release-manifest',
      releasePath,
      '--cloud-root',
      directory,
    ];
    for (const [script, trailingArguments] of [
      ['validate-cloud-core-consumer.mjs', []],
      ['verify-cloud-core-install.mjs', ['--', process.execPath, '--version']],
    ]) {
      const result = spawnSync(
        process.execPath,
        [resolve(root, 'scripts', script), ...commonArguments, ...trailingArguments],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_ARGUMENTS: ghArguments,
            PATH: `${directory}:${process.env.PATH}`,
          },
        },
      );
      assert.equal(result.status, 1, script);
      assert.match(result.stderr, /status: 17/u, script);
    }
    const buildResult = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/build-cloud-core-compatibility.mjs'),
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        directory,
        '--cloud-version',
        '0.1.0-private.1',
        '--out',
        resolve(directory, 'generated-compatibility.json'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GH_ARGUMENTS: ghArguments,
          PATH: `${directory}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(buildResult.status, 1, 'build-cloud-core-compatibility.mjs');
    assert.match(buildResult.stderr, /status: 17/u, 'build-cloud-core-compatibility.mjs');
    const argumentsUsed = readFileSync(ghArguments, 'utf8');
    assert.match(
      argumentsUsed,
      /--signer-workflow\ntixkit\/tixkit\/\.github\/workflows\/public-artifact-release\.yml/u,
    );
    assert.match(argumentsUsed, /--source-ref\nrefs\/tags\/v0\.1\.0/u);
    assert.match(argumentsUsed, new RegExp(`--source-digest\\n${'b'.repeat(40)}`, 'u'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Cloud consumption uses the exact release bytes bound by attestation after a path swap', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    const releasePath = resolve(cloudRoot, 'public-release.json');
    writeFileSync(releasePath, `${JSON.stringify(publicRelease(manifest))}\n`);
    const verifiedRelease = publicRelease(manifest);
    verifiedRelease.core.packages[0].version = '9.9.9';
    const verifiedReleasePath = resolve(cloudRoot, 'verified-public-release.json');
    writeFileSync(verifiedReleasePath, `${JSON.stringify(verifiedRelease)}\n`);
    const manifestPath = resolve(cloudRoot, 'compatibility.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const bin = resolve(cloudRoot, '.swap-bin');
    mkdirSync(bin);
    const gh = resolve(bin, 'gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const { copyFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const artifact = process.argv[4];
copyFileSync(process.env.VERIFIED_RELEASE, artifact);
const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex');
process.stdout.write(JSON.stringify([{verificationResult:{statement:{subject:[{digest:{sha256:digest}}]}}}]));
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/validate-cloud-core-consumer.mjs'),
        '--manifest',
        manifestPath,
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        cloudRoot,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          VERIFIED_RELEASE: verifiedReleasePath,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /core pins must exactly match the verified public release manifest/u,
    );
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
  }
});
