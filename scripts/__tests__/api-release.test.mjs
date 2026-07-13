import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const currentVersion = '2026-07-13';
const currentVersionIsCheckedIn = (() => {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:artifacts/api/${currentVersion}/openapi.json`], {
      cwd: root,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
})();

test('builds a complete, checksummed, non-publishable API release', () => {
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
  const directory = resolve(root, `artifacts/api/${currentVersion}`);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.apiVersion, currentVersion);
  assert.equal(manifest.publication, 'approval-required');
  assert.match(manifest.provenance.sourceTreeHash, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.provenance.reproducible, true);
  if (manifest.provenance.worktreeState === 'modified') {
    assert.equal(manifest.commit, null);
    assert.equal(manifest.timestamp, null);
    assert.equal(manifest.provenance.publishable, false);
  }
  assert.equal(manifest.breaking, false);
  assert.equal(manifest.artifacts.length, 7);
  const checksums = new Map(
    readFileSync(resolve(directory, 'CHECKSUMS.sha256'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, name] = line.split(/\s{2}/u);
        return [name, hash];
      }),
  );
  for (const artifact of manifest.artifacts) {
    const bytes = readFileSync(resolve(directory, artifact.name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.equal(checksums.get(artifact.name), artifact.sha256);
  }
  const webhookCatalog = JSON.parse(
    readFileSync(resolve(directory, 'webhook-events.json'), 'utf8'),
  );
  assert.ok(webhookCatalog.events.some((event) => event.type === 'test.ping' && event.test));
  for (const artifact of manifest.artifacts) {
    const contents = readFileSync(resolve(directory, artifact.name), 'utf8');
    assert.doesNotMatch(
      contents,
      /@(?!example\.(?:com|test))[a-z0-9.-]+\.[a-z]{2,}|sk_live|whsec_/iu,
    );
  }
});

test(
  'uses the checked-in same-version baseline instead of a mutable generated artifact',
  { skip: !currentVersionIsCheckedIn },
  () => {
    const path = resolve(root, `artifacts/api/${currentVersion}/openapi.json`);
    const original = readFileSync(path, 'utf8');
    const baseline = JSON.parse(original);
    baseline.paths['/__compatibility_fixture'] = {
      get: {
        operationId: 'compatibilityFixture',
        security: [],
        responses: { 204: { description: 'Fixture' } },
      },
    };
    try {
      writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
      assert.doesNotThrow(() =>
        execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
          cwd: root,
          stdio: 'pipe',
        }),
      );
    } finally {
      writeFileSync(path, original);
      execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
        cwd: root,
        stdio: 'pipe',
      });
    }
  },
);

test('rebuilds identical artifacts and never reuses stale provenance', () => {
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
  const directory = resolve(root, `artifacts/api/${currentVersion}`);
  const manifestPath = resolve(directory, 'release-manifest.json');
  const originalManifest = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifest);
  manifest.commit = '0000000000000000000000000000000000000000';
  manifest.timestamp = '2000-01-01T00:00:00.000Z';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
      cwd: root,
      stdio: 'pipe',
    });
    const rebuilt = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.notEqual(rebuilt.commit, manifest.commit);
    assert.notEqual(rebuilt.timestamp, manifest.timestamp);
    const firstBuild = new Map(
      [
        'release-manifest.json',
        'CHECKSUMS.sha256',
        ...rebuilt.artifacts.map((artifact) => artifact.name),
      ].map((name) => [name, readFileSync(resolve(directory, name), 'utf8')]),
    );
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
    for (const [name, contents] of firstBuild) {
      assert.equal(readFileSync(resolve(directory, name), 'utf8'), contents);
    }
  } finally {
    writeFileSync(manifestPath, originalManifest);
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
      cwd: root,
      stdio: 'pipe',
    });
  }
});

test('provenance closes over generated-type and compatibility implementation inputs', () => {
  const manifestPath = resolve(root, `artifacts/api/${currentVersion}/release-manifest.json`);
  const inputs = [
    resolve(root, 'packages/openapi/src/generate-types.ts'),
    resolve(root, 'scripts/lib/openapi-compatibility.ts'),
  ];
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
  let priorHash = JSON.parse(readFileSync(manifestPath, 'utf8')).provenance.sourceTreeHash;

  for (const input of inputs) {
    const original = readFileSync(input, 'utf8');
    try {
      writeFileSync(input, `${original}\n`);
      execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.provenance.worktreeState, 'modified');
      assert.equal(manifest.provenance.publishable, false);
      assert.equal(manifest.commit, null);
      assert.equal(manifest.timestamp, null);
      assert.notEqual(manifest.provenance.sourceTreeHash, priorHash);
    } finally {
      writeFileSync(input, original);
      execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
    }
    const restored = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(restored.provenance.sourceTreeHash, priorHash);
    priorHash = restored.provenance.sourceTreeHash;
  }
});

test('untracked source inputs make release provenance non-publishable and enter its hash', () => {
  const manifestPath = resolve(root, `artifacts/api/${currentVersion}/release-manifest.json`);
  const input = resolve(root, 'packages/openapi/src/__untracked_provenance_fixture.ts');
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
  const cleanHash = JSON.parse(readFileSync(manifestPath, 'utf8')).provenance.sourceTreeHash;
  try {
    writeFileSync(input, 'export const untrackedProvenanceFixture = true;\n');
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.provenance.worktreeState, 'modified');
    assert.equal(manifest.provenance.publishable, false);
    assert.equal(manifest.commit, null);
    assert.notEqual(manifest.provenance.sourceTreeHash, cleanHash);
  } finally {
    rmSync(input, { force: true });
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
  }
});

test('provenance validation rejects an invented source hash and manifest version drift', () => {
  const directory = resolve(root, `artifacts/api/${currentVersion}`);
  const manifestPath = resolve(directory, 'release-manifest.json');
  const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
  const distributionPath = resolve(root, `artifacts/api-distribution-drift-${process.pid}.json`);
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.provenance.sourceTreeHash = 'a'.repeat(64);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, serialized);
    const manifestDigest = createHash('sha256').update(serialized).digest('hex');
    writeFileSync(
      checksumsPath,
      readFileSync(checksumsPath, 'utf8').replace(
        /^[a-f0-9]{64}(?=  release-manifest\.json$)/mu,
        manifestDigest,
      ),
    );
    assert.throws(
      () =>
        execFileSync('bun', ['scripts/validate-api-release-provenance.ts'], {
          cwd: root,
          stdio: 'pipe',
        }),
      /sourceTreeHash does not match repository inputs/u,
    );

    const distribution = JSON.parse(
      readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
    );
    distribution.release.contracts = distribution.release.contracts.map((path) =>
      path.startsWith('artifacts/api/') ? 'artifacts/api/1999-01-01' : path,
    );
    writeFileSync(distributionPath, `${JSON.stringify(distribution, null, 2)}\n`);
    assert.throws(
      () =>
        execFileSync(
          'bun',
          ['scripts/validate-api-release-provenance.ts', '--distribution', distributionPath],
          { cwd: root, stdio: 'pipe' },
        ),
      /active API contract is not manifest-declared/u,
    );
  } finally {
    rmSync(distributionPath, { force: true });
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], { cwd: root, stdio: 'pipe' });
  }
});
