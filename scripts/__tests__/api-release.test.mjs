import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');

test('builds a complete, checksummed, non-publishable API release', () => {
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
  const directory = resolve(root, 'artifacts/api/2026-01-01');
  const manifest = JSON.parse(readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.apiVersion, '2026-01-01');
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

test('uses the checked-in same-version baseline instead of a mutable generated artifact', () => {
  const path = resolve(root, 'artifacts/api/2026-01-01/openapi.json');
  const original = readFileSync(path, 'utf8');
  const baseline = JSON.parse(original);
  baseline.paths['/__compatibility_fixture'] = {
    get: {
      operationId: 'compatibilityFixture',
      security: [],
      responses: { 204: { description: 'Fixture' } },
    },
  };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  assert.doesNotThrow(() =>
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
      cwd: root,
      stdio: 'pipe',
    }),
  );
  writeFileSync(path, original);
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
});

test('rebuilds identical artifacts and never reuses stale provenance', () => {
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
  const directory = resolve(root, 'artifacts/api/2026-01-01');
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
  const manifestPath = resolve(root, 'artifacts/api/2026-01-01/release-manifest.json');
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
