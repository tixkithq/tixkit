import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  publicDependencyBoundaryViolations,
  sdkReleaseWorkflowViolations,
  validatePublicDistribution,
} from '../lib/public-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);

test('validates the authoritative public distribution and every SDK release path', () => {
  assert.deepEqual(validatePublicDistribution(structuredClone(manifest), root), manifest);
  assert.ok(manifest.source.packages.includes('packages/sdk-go'));
  assert.ok(manifest.source.packages.includes('packages/sdk-rust'));
  assert.ok(manifest.release.packages.some((entry) => entry.path === 'packages/sdk-go'));
  assert.ok(manifest.release.packages.some((entry) => entry.path === 'packages/sdk-rust'));
  assert.deepEqual(publicDependencyBoundaryViolations(manifest, root), []);
});

test('rejects a newly unclassified package and public/private overlap', () => {
  const missingPackage = structuredClone(manifest);
  missingPackage.source.packages = missingPackage.source.packages.filter(
    (path) => path !== 'packages/sdk-rust',
  );
  assert.throws(
    () => validatePublicDistribution(missingPackage, root),
    /unclassified public packages directory: packages\/sdk-rust/u,
  );

  const overlap = structuredClone(manifest);
  overlap.classification.topLevel.privateCloud = ['scripts'];
  assert.throws(
    () => validatePublicDistribution(overlap, root),
    /private Cloud root is included publicly: scripts/u,
  );
});

test('rejects incomplete repository classification and malformed schema fields', () => {
  const unclassifiedRoot = structuredClone(manifest);
  unclassifiedRoot.classification.topLevel.public =
    unclassifiedRoot.classification.topLevel.public.filter((path) => path !== 'README.md');
  assert.throws(
    () => validatePublicDistribution(unclassifiedRoot, root),
    /unclassified top-level path: README\.md/u,
  );

  const unclassifiedDocs = structuredClone(manifest);
  unclassifiedDocs.classification.docs.public = unclassifiedDocs.classification.docs.public.filter(
    (path) => path !== 'docs/public',
  );
  assert.throws(
    () => validatePublicDistribution(unclassifiedDocs, root),
    /unclassified docs path: docs\/public/u,
  );

  const malformed = structuredClone(manifest);
  malformed.authority.unreviewedPolicy = true;
  assert.throws(
    () => validatePublicDistribution(malformed, root),
    /\$\.authority\.unreviewedPolicy is not allowed/u,
  );
});

test('rejects unsafe release paths and omitted publishable packages', () => {
  const traversal = structuredClone(manifest);
  traversal.release.contracts.push('../../etc/passwd');
  assert.throws(
    () => validatePublicDistribution(traversal, root),
    /release\.contracts.*(?:unsafe path|must match)/u,
  );

  const missingCli = structuredClone(manifest);
  missingCli.release.packages = missingCli.release.packages.filter(
    (entry) => entry.path !== 'packages/cli',
  );
  assert.throws(
    () => validatePublicDistribution(missingCli, root),
    /publishable package missing from release\.packages: packages\/cli/u,
  );
});

test('rejects SDK workflow trigger and verification-job drift', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/sdk-release-dry-run.yml'), 'utf8');
  assert.deepEqual(sdkReleaseWorkflowViolations(manifest, workflow), []);
  assert.deepEqual(
    sdkReleaseWorkflowViolations(manifest, workflow.replace("'packages/**'", "'docs/**'")),
    ['SDK release workflow must trigger for every packages/** change'],
  );
  assert.deepEqual(
    sdkReleaseWorkflowViolations(
      manifest,
      workflow.replace('  go-sdk-dry-run:', '  removed-go-job:'),
    ),
    ['packages/sdk-go: SDK release workflow is missing job go-sdk-dry-run'],
  );
});

test('scans workflow and script references throughout the public boundary', () => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'tixkit-public-boundary-'));
  try {
    mkdirSync(resolve(fixtureRoot, '.github/workflows'), { recursive: true });
    mkdirSync(resolve(fixtureRoot, 'scripts'), { recursive: true });
    mkdirSync(resolve(fixtureRoot, 'managed'), { recursive: true });
    writeFileSync(
      resolve(fixtureRoot, '.github/workflows/ci.yml'),
      'steps:\n  - uses: tixkit/tixkit-cloud-action@v1\n',
    );
    writeFileSync(
      resolve(fixtureRoot, 'scripts/build.mjs'),
      "await import('../../../managed/provisioning.js');\n",
    );
    writeFileSync(resolve(fixtureRoot, 'scripts/Dockerfile'), 'COPY managed /app/managed\n');
    writeFileSync(
      resolve(fixtureRoot, 'scripts/package.json'),
      JSON.stringify({
        dependencies: { 'internal-provider': 'file:../../managed/provider' },
        scripts: { build: 'node managed' },
      }),
    );
    writeFileSync(
      resolve(fixtureRoot, 'scripts/tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@private/*': ['managed/*'] } } }),
    );
    symlinkSync(
      resolve(fixtureRoot, 'scripts/build.mjs'),
      resolve(fixtureRoot, 'scripts/link.mjs'),
    );
    symlinkSync(resolve(fixtureRoot, 'managed'), resolve(fixtureRoot, 'scripts/private-dir'));
    const fixtureManifest = {
      source: {
        rootFiles: [],
        rootDirectories: ['.github', 'scripts'],
        applications: [],
        packages: [],
        documentation: [],
      },
      classification: { topLevel: { privateCloud: ['managed'] } },
      forbiddenDependencies: manifest.forbiddenDependencies,
    };

    assert.deepEqual(publicDependencyBoundaryViolations(fixtureManifest, fixtureRoot), [
      'scripts/link.mjs: symbolic links are forbidden in public source',
      'scripts/private-dir: symbolic links are forbidden in public source',
      '.github/workflows/ci.yml: forbidden private dependency/build reference',
      'scripts/Dockerfile: forbidden private dependency/build reference',
      'scripts/build.mjs: forbidden private dependency/build reference',
      'scripts/package.json: forbidden dependencies dependency internal-provider',
      'scripts/package.json: forbidden private script reference build',
      'scripts/tsconfig.json: forbidden private JSON build reference',
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects false legal approval and missing immutable release entries', () => {
  const approved = structuredClone(manifest);
  approved.licensing.status = 'approved';
  approved.licensing.mayClaimLegalApproval = true;
  assert.throws(() => validatePublicDistribution(approved, root), /canonical legal evidence/u);

  approved.licensing.legalReviewEvidence = 'docs/completion/legal-review-approval.md';
  assert.throws(() => validatePublicDistribution(approved, root), /path does not exist/u);

  const missingSdkRelease = structuredClone(manifest);
  missingSdkRelease.release.packages = missingSdkRelease.release.packages.filter(
    (entry) => entry.path !== 'packages/sdk-go',
  );
  assert.throws(
    () => validatePublicDistribution(missingSdkRelease, root),
    /public SDK missing from release.packages: packages\/sdk-go/u,
  );

  const forbiddenPublicDependency = structuredClone(manifest);
  forbiddenPublicDependency.forbiddenDependencies.push('@tixkit/js');
  assert.throws(
    () => validatePublicDistribution(forbiddenPublicDependency, root),
    /forbidden dependencies dependency @tixkit\/js/u,
  );
});
