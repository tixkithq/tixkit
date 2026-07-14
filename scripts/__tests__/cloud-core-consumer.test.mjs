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
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import {
  assertPublicReleaseContext,
  packFromSourceArchive,
  publicImageViolations,
  publicReleaseContextViolations,
  publicReleaseManifestViolations,
} from '../build-public-release-manifest.mjs';
import {
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
import { classifyStagedPublicRelease } from '../validate-staged-public-release.mjs';
import { SDK_API_VERSION } from '../lib/sdk-parity.mjs';
import { packageContentDigest } from '../lib/package-content-digest.mjs';

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
    cloudRelease: { version: '0.1.0-private.1', sourceCommit: 'a'.repeat(40) },
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
        releaseManifest.core.packages.map((pin) => [
          pin.name,
          [`${pin.name}@${pin.version}`, '', {}, pin.integrity],
        ]),
      ),
    })}\n`,
  );
  writeFileSync(
    resolve(directory, 'bunfig.toml'),
    '[install]\nlinker = "isolated"\nbackend = "copyfile"\n',
  );
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', '-A'], { cwd: directory });
  return directory;
}

function publicRelease(manifest) {
  return {
    schemaVersion: 1,
    releaseVersion: '0.1.0',
    core: structuredClone(manifest.core),
  };
}

function installFixturePackages(directory, manifest) {
  for (const pin of manifest.core.packages) {
    const packagePath = resolve(directory, 'node_modules', ...pin.name.split('/'));
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(resolve(packagePath, 'index.js'), 'export const state = "public";\n');
    writeFileSync(
      resolve(packagePath, 'package.json'),
      `${JSON.stringify({ name: pin.name, version: pin.version, type: 'module' })}\n`,
    );
    Object.assign(pin, packageContentDigest(packagePath));
  }
}

function attestedReleaseFixture(directory, release) {
  const releasePath = resolve(directory, 'public-release.json');
  writeFileSync(releasePath, `${JSON.stringify(release)}\n`);
  const bin = resolve(directory, '.test-bin');
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
    assert.deepEqual(validateCloudCoreConsumer(manifest, publicRelease(manifest), cloudRoot), []);
  } finally {
    rmSync(cloudRoot, { recursive: true, force: true });
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
  assert.match(workflow, /if: needs\.validate\.outputs\.resume != 'true'/u);
  assert.match(workflow, /name: resumed-public-release/u);
  assert.match(workflow, /image-\{admin,api,checkout,worker\}\.json/u);
  assert.match(workflow, /validate:public-repository -- --repository \./u);
  assert.match(workflow, /for asset in resumed-public-release\/\*/u);
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
        /installed public package does not match release content: @tixkit\/domain/u,
      );
      chmodSync(domainPath, 0o644);
      const sharedPath = resolve(directory, 'shared-index.js');
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
        /installed public package does not match release content: @tixkit\/domain/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
        /installed public package does not match release content: @tixkit\/domain/u,
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
        assert.match(result.stderr, /Cloud command failed with status/u);
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
      assert.match(serviceEscape.stderr, /Cloud command failed with status/u);
      assert.equal(readFileSync(domainPath, 'utf8'), 'export const state = "public";\n');
      assert.equal(existsSync(resolve(proof, 'used.txt')), false);
    } finally {
      mutationService?.kill('SIGTERM');
      rmSync(directory, { recursive: true, force: true });
      rmSync(attackDirectory, { recursive: true, force: true });
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
