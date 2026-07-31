import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { acquireRepositoryMutationLock } from './helpers/repository-mutation-lock.mjs';

const root = resolve(import.meta.dirname, '../..');
const releaseRepositoryMutationLock = await acquireRepositoryMutationLock(root);
after(releaseRepositoryMutationLock);
const currentVersion = '2026-09-04';
const currentReleaseManifest = JSON.parse(
  readFileSync(resolve(root, `artifacts/api/${currentVersion}/release-manifest.json`), 'utf8'),
);
const currentReleaseIsDerivedExport =
  currentReleaseManifest.provenance?.exportTransformation?.kind === 'license-status-normalization';
const currentReleaseIsPublishable = currentReleaseManifest.provenance?.publishable === true;
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
if (!currentVersionIsCheckedIn) process.env.ALLOW_BREAKING_API_RELEASE = '1';
const releaseFiles = [
  'openapi.json',
  'openapi.yaml',
  'openapi.d.ts',
  'webhook-events.json',
  'examples.json',
  'api-diff.json',
  'CHANGELOG.md',
  'release-manifest.json',
  'CHECKSUMS.sha256',
];
const disposableCandidateVersion = '2099-12-31';

function buildApiRelease() {
  execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
    cwd: root,
    stdio: 'pipe',
  });
}

function withDisposableApiCandidate(run) {
  const openApiPath = resolve(root, 'packages/openapi/src/index.ts');
  const candidateDirectory = resolve(root, `artifacts/api/${disposableCandidateVersion}`);
  const candidateDocsDirectory = resolve(
    root,
    `apps/docs/public/contracts/${disposableCandidateVersion}`,
  );
  const releaseIndexPath = resolve(root, 'apps/docs/src/generated/api-release-index.ts');
  assert.equal(
    existsSync(candidateDirectory),
    false,
    'disposable API artifact directory already exists',
  );
  assert.equal(
    existsSync(candidateDocsDirectory),
    false,
    'disposable API documentation directory already exists',
  );
  const originalOpenApi = readFileSync(openApiPath, 'utf8');
  const candidateOpenApi = originalOpenApi.replace(
    "version: '2026-09-04'",
    `version: '${disposableCandidateVersion}'`,
  );
  assert.notEqual(candidateOpenApi, originalOpenApi, 'OpenAPI version declaration was not found');
  const originalReleaseIndex = readFileSync(releaseIndexPath);
  writeFileSync(openApiPath, candidateOpenApi);
  try {
    return run({
      directory: candidateDirectory,
      version: disposableCandidateVersion,
    });
  } finally {
    writeFileSync(openApiPath, originalOpenApi);
    rmSync(candidateDirectory, { force: true, recursive: true });
    rmSync(candidateDocsDirectory, { force: true, recursive: true });
    writeFileSync(releaseIndexPath, originalReleaseIndex);
  }
}

function snapshotRelease() {
  const directory = resolve(root, `artifacts/api/${currentVersion}`);
  return new Map(releaseFiles.map((name) => [name, readFileSync(resolve(directory, name))]));
}

function assertReleaseSnapshot(expected) {
  const directory = resolve(root, `artifacts/api/${currentVersion}`);
  for (const [name, bytes] of expected) {
    assert.deepEqual(readFileSync(resolve(directory, name)), bytes, `${name} changed`);
  }
}

test('refuses to rebind API provenance from a dirty authoritative repository', () => {
  const input = resolve(root, 'packages/openapi/src/generate-types.ts');
  const original = readFileSync(input, 'utf8');
  try {
    writeFileSync(input, `${original}\n`);
    assert.throws(
      () =>
        execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
          cwd: root,
          env: { ...process.env, REBIND_PUBLIC_API_PROVENANCE: '1' },
          stdio: 'pipe',
        }),
      /requires a clean authoritative public tree/u,
    );
  } finally {
    writeFileSync(input, original);
  }
});

test(
  'builds a complete, checksummed API release with truthful compatibility metadata',
  { skip: currentReleaseIsDerivedExport },
  () => {
    withDisposableApiCandidate(({ directory, version }) => {
      buildApiRelease();
      const manifest = JSON.parse(
        readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'),
      );
      assert.equal(manifest.apiVersion, version);
      assert.equal(manifest.publication, 'approval-required');
      assert.match(manifest.provenance.sourceTreeHash, /^[a-f0-9]{64}$/u);
      assert.equal(manifest.provenance.reproducible, true);
      assert.ok(
        manifest.provenance.excludedGeneratedPaths.includes('apps/admin-dashboard/next-env.d.ts'),
      );
      assert.ok(
        manifest.provenance.excludedGeneratedPaths.includes('artifacts/api-integration-skills/'),
      );
      assert.ok(
        manifest.provenance.excludedGeneratedPaths.includes(
          'distribution/public-distribution.json',
        ),
      );
      assert.equal(manifest.commit, null);
      assert.equal(manifest.timestamp, null);
      assert.equal(manifest.provenance.publishable, false);
      const apiDiff = JSON.parse(readFileSync(resolve(directory, 'api-diff.json'), 'utf8'));
      assert.equal(manifest.breaking, apiDiff.breaking);
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
  },
);

test('rebuilds the protected API release without changing bytes when source is unchanged', () => {
  const expected = snapshotRelease();
  assert.doesNotThrow(buildApiRelease);
  assertReleaseSnapshot(expected);
});

test('uses the last checked-in release baseline instead of mutable candidate artifacts', () => {
  withDisposableApiCandidate(({ directory }) => {
    buildApiRelease();
    const path = resolve(directory, 'openapi.json');
    const baseline = JSON.parse(readFileSync(path, 'utf8'));
    baseline.paths['/__compatibility_fixture'] = {
      get: {
        operationId: 'compatibilityFixture',
        security: [],
        responses: { 204: { description: 'Fixture' } },
      },
    };
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
    buildApiRelease();
    assert.equal(
      Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')).paths, '/__compatibility_fixture'),
      false,
    );
  });
});

test('rebuilds identical artifacts and never reuses stale provenance', () => {
  withDisposableApiCandidate(({ directory }) => {
    buildApiRelease();
    const manifestPath = resolve(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.commit = '0000000000000000000000000000000000000000';
    manifest.timestamp = '2000-01-01T00:00:00.000Z';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    buildApiRelease();
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
    buildApiRelease();
    for (const [name, contents] of firstBuild) {
      assert.equal(readFileSync(resolve(directory, name), 'utf8'), contents);
    }
  });
});

test(
  'dirty implementation-only inputs cannot rewrite a protected API release',
  { skip: !currentVersionIsCheckedIn },
  () => {
    const inputs = [
      resolve(root, 'packages/openapi/src/generate-types.ts'),
      resolve(root, 'scripts/lib/openapi-compatibility.ts'),
    ];
    const expected = snapshotRelease();

    for (const input of inputs) {
      const original = readFileSync(input, 'utf8');
      try {
        writeFileSync(input, `${original}\n`);
        assert.doesNotThrow(buildApiRelease);
        assertReleaseSnapshot(expected);
      } finally {
        writeFileSync(input, original);
      }
    }
  },
);

test(
  'untracked source inputs cannot rewrite a protected API release',
  { skip: !currentVersionIsCheckedIn },
  () => {
    const input = resolve(root, 'packages/openapi/src/__untracked_provenance_fixture.ts');
    const expected = snapshotRelease();
    try {
      writeFileSync(input, 'export const untrackedProvenanceFixture = true;\n');
      assert.doesNotThrow(buildApiRelease);
      assertReleaseSnapshot(expected);
    } finally {
      rmSync(input, { force: true });
    }
  },
);

test(
  'rejects compatible and breaking same-version source drift without mutating release bytes',
  { skip: !currentVersionIsCheckedIn },
  () => {
    const input = resolve(root, 'packages/openapi/src/index.ts');
    const original = readFileSync(input, 'utf8');
    const cases = [
      ["title: 'Tixkit API'", "title: 'Tixkit API changed'"],
      ["'/events': {", "'/events-removed': {"],
    ];
    const expected = snapshotRelease();
    for (const [from, to] of cases) {
      assert.ok(original.includes(from));
      try {
        writeFileSync(input, original.replace(from, to));
        assert.throws(
          () =>
            execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
              cwd: root,
              stdio: 'pipe',
            }),
          /immutable API version|not reproducible/u,
        );
        assertReleaseSnapshot(expected);
      } finally {
        writeFileSync(input, original);
      }
    }
  },
);

test(
  'clean committed rebuild is byte-stable and validates recorded provenance',
  {
    skip:
      !currentVersionIsCheckedIn || currentReleaseIsDerivedExport || !currentReleaseIsPublishable,
  },
  () => {
    const expected = snapshotRelease();
    execFileSync('bun', ['run', 'scripts/build-api-release.ts'], {
      cwd: root,
      stdio: 'pipe',
    });
    assertReleaseSnapshot(expected);
    assert.doesNotThrow(() =>
      execFileSync('bun', ['scripts/validate-api-release-provenance.ts'], {
        cwd: root,
        stdio: 'pipe',
      }),
    );
  },
);

test(
  'disposable local candidate is byte-stable and remains publication-ineligible',
  {
    skip: currentReleaseIsDerivedExport,
  },
  () => {
    withDisposableApiCandidate(({ directory }) => {
      buildApiRelease();
      const expected = new Map(
        releaseFiles.map((name) => [name, readFileSync(resolve(directory, name))]),
      );
      buildApiRelease();
      for (const [name, bytes] of expected) {
        assert.deepEqual(readFileSync(resolve(directory, name)), bytes, `${name} changed`);
      }
      const manifest = JSON.parse(
        readFileSync(resolve(directory, 'release-manifest.json'), 'utf8'),
      );
      assert.equal(manifest.provenance.publishable, false);
      assert.equal(manifest.commit, null);
      assert.equal(manifest.timestamp, null);
    });
  },
);

test(
  'validates recorded provenance when a shallow or exported repository lacks the source object',
  {
    skip:
      !currentVersionIsCheckedIn || currentReleaseIsDerivedExport || !currentReleaseIsPublishable,
  },
  () => {
    const directory = resolve(root, `artifacts/api/${currentVersion}`);
    const docsDirectory = resolve(root, `apps/docs/public/contracts/${currentVersion}`);
    const manifestPath = resolve(directory, 'release-manifest.json');
    const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
    const docsManifestPath = resolve(docsDirectory, 'release-manifest.json');
    const docsChecksumsPath = resolve(docsDirectory, 'CHECKSUMS.sha256');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const originalChecksums = readFileSync(checksumsPath, 'utf8');
    const unavailableCommit = 'f'.repeat(40);
    const manifest = JSON.parse(originalManifest);
    manifest.commit = unavailableCommit;
    manifest.provenance.sourceCommit = unavailableCommit;
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    try {
      assert.throws(() =>
        execFileSync('git', ['cat-file', '-e', `${unavailableCommit}^{commit}`], {
          cwd: root,
          stdio: 'pipe',
        }),
      );
      writeFileSync(manifestPath, serialized);
      writeFileSync(docsManifestPath, serialized);
      const unavailableChecksums = originalChecksums.replace(
        /^[a-f0-9]{64}(?=  release-manifest\.json$)/mu,
        createHash('sha256').update(serialized).digest('hex'),
      );
      writeFileSync(checksumsPath, unavailableChecksums);
      writeFileSync(docsChecksumsPath, unavailableChecksums);
      assert.throws(
        () =>
          execFileSync('bun', ['scripts/validate-api-release-provenance.ts'], {
            cwd: root,
            stdio: 'pipe',
          }),
        /source commit is unavailable/u,
      );
      const output = execFileSync(
        'bun',
        ['scripts/validate-api-release-provenance.ts', '--allow-recorded-source'],
        { cwd: root, encoding: 'utf8' },
      );
      assert.match(output, /recorded but unverified and is not sufficient for publication/u);

      const blob = execFileSync('git', ['rev-parse', 'HEAD:package.json'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      manifest.commit = blob;
      manifest.provenance.sourceCommit = blob;
      const blobSerialized = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(manifestPath, blobSerialized);
      writeFileSync(docsManifestPath, blobSerialized);
      const blobChecksums = originalChecksums.replace(
        /^[a-f0-9]{64}(?=  release-manifest\.json$)/mu,
        createHash('sha256').update(blobSerialized).digest('hex'),
      );
      writeFileSync(checksumsPath, blobChecksums);
      writeFileSync(docsChecksumsPath, blobChecksums);
      assert.throws(
        () =>
          execFileSync(
            'bun',
            ['scripts/validate-api-release-provenance.ts', '--allow-recorded-source'],
            { cwd: root, stdio: 'pipe' },
          ),
        /not a commit/u,
      );
    } finally {
      writeFileSync(manifestPath, originalManifest);
      writeFileSync(checksumsPath, originalChecksums);
      writeFileSync(docsManifestPath, originalManifest);
      writeFileSync(docsChecksumsPath, originalChecksums);
    }
  },
);

test(
  'derived export integrity mode accepts only the pending-license normalization contract',
  {
    skip:
      !currentVersionIsCheckedIn || currentReleaseIsDerivedExport || !currentReleaseIsPublishable,
  },
  () => {
    const directory = resolve(root, `artifacts/api/${currentVersion}`);
    const docsDirectory = resolve(root, `apps/docs/public/contracts/${currentVersion}`);
    const manifestPath = resolve(directory, 'release-manifest.json');
    const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
    const docsManifestPath = resolve(docsDirectory, 'release-manifest.json');
    const docsChecksumsPath = resolve(docsDirectory, 'CHECKSUMS.sha256');
    const distributionPath = resolve(
      root,
      `artifacts/api-derived-distribution-${process.pid}.json`,
    );
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const originalChecksums = readFileSync(checksumsPath, 'utf8');
    const distribution = JSON.parse(
      readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
    );
    distribution.licensing = {
      intendedPublicLicense: 'MIT',
      status: 'pending-legal-review',
      mayClaimLegalApproval: false,
      legalReviewEvidence: '',
    };
    distribution.release.contracts = distribution.release.contracts.filter(
      (path) => !path.startsWith('artifacts/api/') || path === `artifacts/api/${currentVersion}`,
    );
    writeFileSync(distributionPath, `${JSON.stringify(distribution, null, 2)}\n`);
    const manifest = JSON.parse(originalManifest);
    manifest.provenance.publishable = false;
    manifest.provenance.reproducible = false;
    manifest.provenance.exportTransformation = {
      kind: 'license-status-normalization',
      licensingStatus: 'pending-legal-review',
      sourceArtifacts: {
        'openapi.json': 'a'.repeat(64),
        'openapi.yaml': 'b'.repeat(64),
      },
    };

    const writeManifest = () => {
      const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(manifestPath, serialized);
      writeFileSync(docsManifestPath, serialized);
      const serializedChecksums = originalChecksums.replace(
        /^[a-f0-9]{64}(?=  release-manifest\.json$)/mu,
        createHash('sha256').update(serialized).digest('hex'),
      );
      writeFileSync(checksumsPath, serializedChecksums);
      writeFileSync(docsChecksumsPath, serializedChecksums);
    };

    try {
      writeManifest();
      assert.throws(
        () =>
          execFileSync(
            'bun',
            ['scripts/validate-api-release-provenance.ts', '--allow-recorded-source'],
            { cwd: root, stdio: 'pipe' },
          ),
        /release provenance is not publishable/u,
      );
      const output = execFileSync(
        'bun',
        [
          'scripts/validate-api-release-provenance.ts',
          '--allow-recorded-source',
          '--allow-derived-export',
          '--distribution',
          distributionPath,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.match(output, /pending-license derived API artifact integrity/u);
      assert.match(output, /not sufficient for publication/u);

      manifest.provenance.exportTransformation.licensingStatus = 'approved';
      writeManifest();
      assert.throws(
        () =>
          execFileSync(
            'bun',
            [
              'scripts/validate-api-release-provenance.ts',
              '--allow-recorded-source',
              '--allow-derived-export',
              '--distribution',
              distributionPath,
            ],
            { cwd: root, stdio: 'pipe' },
          ),
        /release is not a pending-license derived export/u,
      );
    } finally {
      writeFileSync(manifestPath, originalManifest);
      writeFileSync(checksumsPath, originalChecksums);
      writeFileSync(docsManifestPath, originalManifest);
      writeFileSync(docsChecksumsPath, originalChecksums);
      rmSync(distributionPath, { force: true });
    }
  },
);

test('provenance validation binds checksums to manifest artifact metadata', () => {
  const directory = resolve(root, `artifacts/api/${currentVersion}`);
  const artifactPath = resolve(directory, 'api-diff.json');
  const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
  const originalArtifact = readFileSync(artifactPath);
  const originalChecksums = readFileSync(checksumsPath, 'utf8');
  const tamperedArtifact = Buffer.concat([originalArtifact, Buffer.from('\n')]);
  const args = ['scripts/validate-api-release-provenance.ts'];
  if (currentReleaseIsDerivedExport) {
    args.push('--allow-recorded-source', '--allow-derived-export');
  }

  try {
    writeFileSync(artifactPath, tamperedArtifact);
    writeFileSync(
      checksumsPath,
      originalChecksums.replace(
        /^[a-f0-9]{64}(?=  api-diff\.json$)/mu,
        createHash('sha256').update(tamperedArtifact).digest('hex'),
      ),
    );
    assert.throws(
      () => execFileSync('bun', args, { cwd: root, stdio: 'pipe' }),
      /api-diff\.json manifest (?:sha256|size) does not match/u,
    );
  } finally {
    writeFileSync(artifactPath, originalArtifact);
    writeFileSync(checksumsPath, originalChecksums);
  }
});

test('provenance validation binds every documentation contract mirror byte', () => {
  const path = resolve(root, `apps/docs/public/contracts/${currentVersion}/openapi.json`);
  const original = readFileSync(path);
  const args = ['scripts/validate-api-release-provenance.ts'];
  if (currentReleaseIsDerivedExport) {
    args.push('--allow-recorded-source', '--allow-derived-export');
  }
  try {
    writeFileSync(path, Buffer.concat([original, Buffer.from('\n')]));
    assert.throws(
      () => execFileSync('bun', args, { cwd: root, stdio: 'pipe' }),
      /documentation contract mirror differs for openapi\.json/u,
    );
  } finally {
    writeFileSync(path, original);
  }
});

test(
  'derived export integrity mode validates every historical release transformation',
  { skip: !currentReleaseIsDerivedExport },
  () => {
    const historicalVersion = '2026-01-01';
    const directory = resolve(root, `artifacts/api/${historicalVersion}`);
    const manifestPath = resolve(directory, 'release-manifest.json');
    const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
    const originalManifest = readFileSync(manifestPath, 'utf8');
    const originalChecksums = readFileSync(checksumsPath, 'utf8');
    const manifest = JSON.parse(originalManifest);
    manifest.provenance.exportTransformation.licensingStatus = 'approved';
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

    try {
      writeFileSync(manifestPath, serialized);
      writeFileSync(
        checksumsPath,
        originalChecksums.replace(
          /^[a-f0-9]{64}(?=  release-manifest\.json$)/mu,
          createHash('sha256').update(serialized).digest('hex'),
        ),
      );
      assert.throws(
        () =>
          execFileSync(
            'bun',
            [
              'scripts/validate-api-release-provenance.ts',
              '--allow-recorded-source',
              '--allow-derived-export',
            ],
            { cwd: root, stdio: 'pipe' },
          ),
        new RegExp(
          `artifacts/api/${historicalVersion}: release is not a pending-license derived export`,
          'u',
        ),
      );
    } finally {
      writeFileSync(manifestPath, originalManifest);
      writeFileSync(checksumsPath, originalChecksums);
    }
  },
);

test(
  'provenance validation rejects an invented source hash and manifest version drift',
  {
    skip: currentReleaseIsDerivedExport,
  },
  () => {
    const directory = resolve(root, `artifacts/api/${currentVersion}`);
    const manifestPath = resolve(directory, 'release-manifest.json');
    const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
    const distributionPath = resolve(root, `artifacts/api-distribution-drift-${process.pid}.json`);
    const originalManifest = readFileSync(manifestPath);
    const originalChecksums = readFileSync(checksumsPath);
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
        /sourceTreeHash does not match recorded source inputs/u,
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
      writeFileSync(manifestPath, originalManifest);
      writeFileSync(checksumsPath, originalChecksums);
      rmSync(distributionPath, { force: true });
    }
  },
);
