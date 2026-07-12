import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

const root = resolve(import.meta.dirname, '../..');
const distribution = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);
const migrationIds = readdirSync(resolve(root, 'packages/db/src/migrations'))
  .map((name) => name.match(/^(\d{4}(?:_\d+)?)/u)?.[1])
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
const currentMigrationRange = { minimum: migrationIds[0], maximum: migrationIds.at(-1) };

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
      return { name: manifest.name, version: manifest.version, integrity: 'sha512-YQ==' };
    });
  return {
    schemaVersion: 1,
    cloudRelease: { version: '0.1.0-private.1', sourceCommit: 'a'.repeat(40) },
    core: {
      sourceCommit: 'b'.repeat(40),
      sourceTreeSha256: 'c'.repeat(64),
      apiVersion: '2026-01-01',
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
          version: '2026-01-01',
          sha256: readFileSync(
            [
              resolve(root, 'artifacts/api/2026-01-01/CHECKSUMS.sha256'),
              resolve(root, 'apps/docs/public/contracts/2026-01-01/CHECKSUMS.sha256'),
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

function cloudFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-consumer-'));
  mkdirSync(resolve(directory, 'packages/control-plane'), { recursive: true });
  writeFileSync(
    resolve(directory, 'packages/control-plane/package.json'),
    `${JSON.stringify(
      {
        name: '@tixkit-cloud/control-plane',
        private: true,
        dependencies: { '@tixkit/domain': '0.1.0' },
      },
      null,
      2,
    )}\n`,
  );
  const domainPin = compatibilityManifest().core.packages.find(
    ({ name }) => name === '@tixkit/domain',
  );
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
        compatibilityManifest().core.packages.map((pin) => [
          pin.name,
          [`${pin.name}@${pin.version}`, '', {}, pin.integrity],
        ]),
      ),
    })}\n`,
  );
  return directory;
}

function publicRelease(manifest) {
  return { schemaVersion: 1, releaseVersion: '0.1.0', core: structuredClone(manifest.core) };
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
    mkdirSync(resolve(cloudRoot, 'packages/control-plane/src'), { recursive: true });
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
    publicReleaseManifestViolations({ schemaVersion: 1, releaseVersion: '0.1.0', core: {} })
      .length > 0,
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
    packFromSourceArchive(
      { release: { packages: [{ path: 'packages/example', ecosystem: 'npm' }] } },
      archive,
      artifacts,
      { install: false },
    );
    const tarball = resolve(
      artifacts,
      readdirSync(artifacts).find((name) => name.endsWith('.tgz')),
    );
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    assert.match(entries, /package\/dist\/index\.js/u);
    assert.doesNotMatch(entries, /stale\.js/u);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
    const release = {
      core: { packages: [{ name: '@tixkit/example', version: '1.0.0', integrity }] },
    };
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
    controlPlane.patchedDependencies = { '@tixkit/domain': 'patches/domain.patch' };
    writeFileSync(controlPlanePath, `${JSON.stringify(controlPlane, null, 2)}\n`);
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
      violations.includes('openapi@2026-01-01 checksum does not match the public contract'),
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
    mkdirSync(resolve(cloudRoot, 'packages/control-plane/scripts'), { recursive: true });
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

test('verified Cloud commands fail when an installed public package byte changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tixkit-cloud-installed-core-'));
  try {
    const packagePath = resolve(directory, 'node_modules/@tixkit/domain');
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(resolve(packagePath, 'index.js'), 'export const state = "public";\n');
    assert.throws(
      () =>
        verifyCloudCoreInstall(
          { core: { packages: [{ name: '@tixkit/domain' }] } },
          directory,
          ['malicious-build'],
          () => {
            writeFileSync(resolve(packagePath, 'index.js'), 'export const state = "patched";\n');
            return { status: 0 };
          },
        ),
      /modified installed public artifacts: @tixkit\/domain/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed on missing agent support and migration or schema drift', () => {
  const cloudRoot = cloudFixture();
  try {
    const manifest = compatibilityManifest();
    manifest.core.agentProtocol = { status: 'unavailable', version: '' };
    manifest.core.migrationRange.maximum = '0063';
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
    assert.ok(
      semanticViolations.includes(`migration maximum must equal ${currentMigrationRange.maximum}`),
    );
    assert.ok(
      semanticViolations.includes('released agent protocol requires a supported pinned version'),
    );
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
    manifest.core.contracts.push({ name: 'invented', version: '1', sha256: '7'.repeat(64) });
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

test('CLI fails before consumption when public release attestation is not verified', () => {
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
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/validate-cloud-core-consumer.mjs'),
        '--manifest',
        manifestPath,
        '--public-release-manifest',
        releasePath,
        '--cloud-root',
        directory,
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
    assert.equal(result.status, 1);
    assert.match(result.stderr, /status: 17/u);
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
