import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  jsonSchemaViolations,
  npmReleaseDependencyViolations,
  publicDependencyBoundaryViolations,
  historicalClassificationViolations,
  sdkReleaseWorkflowViolations,
  validatePublicDistribution,
} from '../lib/public-distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
);
const generatedOpenApiVersion = JSON.parse(
  readFileSync(resolve(root, 'apps/docs/public/openapi.json'), 'utf8'),
).info.version;

test('validates integer schema types and numeric minimums', () => {
  const schema = { type: 'integer', minimum: 1 };
  assert.deepEqual(jsonSchemaViolations(2, schema), []);
  assert.deepEqual(jsonSchemaViolations(0, schema), ['$ must be at least 1']);
  assert.deepEqual(jsonSchemaViolations(1.5, schema), ['$ must be integer']);
});

test('rejects workspace protocols from publishable npm manifests', () => {
  assert.deepEqual(
    npmReleaseDependencyViolations(
      {
        dependencies: { '@tixkit/domain': 'workspace:*', ajv: '^8.20.0' },
        peerDependencies: { '@tixkit/js': 'workspace:0.1.0' },
      },
      'packages/example',
    ),
    [
      'packages/example: dependencies.@tixkit/domain uses non-publishable workspace protocol workspace:*',
      'packages/example: peerDependencies.@tixkit/js uses non-publishable workspace protocol workspace:0.1.0',
    ],
  );
  assert.deepEqual(
    npmReleaseDependencyViolations({
      dependencies: { '@tixkit/domain': '0.1.0' },
    }),
    [],
  );
});

test('validates the authoritative public distribution and every SDK release path', () => {
  assert.deepEqual(validatePublicDistribution(structuredClone(manifest), root), manifest);
  assert.ok(manifest.source.packages.includes('packages/sdk-go'));
  assert.ok(manifest.source.packages.includes('packages/sdk-rust'));
  assert.ok(manifest.release.packages.some((entry) => entry.path === 'packages/sdk-go'));
  assert.ok(manifest.release.packages.some((entry) => entry.path === 'packages/sdk-rust'));
  assert.ok(
    manifest.release.contracts.includes('distribution/hosted-production-dr-receipt.schema.json'),
  );
  assert.ok(manifest.release.contracts.includes('distribution/hosted-trust-keyring.schema.json'));
  assert.ok(manifest.release.contracts.includes('distribution/hosted-trust-receipt.schema.json'));
  assert.ok(
    manifest.release.contracts.includes('distribution/policy-approval-keyring.schema.json'),
  );
  assert.ok(
    manifest.release.contracts.includes('distribution/policy-approval-receipt.schema.json'),
  );
  const codeowners = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8');
  assert.match(codeowners, /^\/distribution\/public-distribution\.json @tixkit\/maintainers$/mu);
  assert.match(
    codeowners,
    /^\/distribution\/public-distribution\.schema\.json @tixkit\/maintainers$/mu,
  );
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

test(
  'classifies deleted historical paths exactly once',
  {
    skip: manifest.classification.historyValidation === 'snapshot',
  },
  () => {
    assert.deepEqual(historicalClassificationViolations(manifest, root), []);

    const missing = structuredClone(manifest);
    missing.classification.historical.public = missing.classification.historical.public.filter(
      (path) => path !== '.prettierrc',
    );
    assert.deepEqual(historicalClassificationViolations(missing, root), [
      'unclassified historical path: .prettierrc',
    ]);

    const duplicate = structuredClone(manifest);
    duplicate.classification.historical.privateCloud = ['.prettierrc'];
    assert.deepEqual(historicalClassificationViolations(duplicate, root), [
      'historical path has multiple classifications: .prettierrc',
    ]);

    const present = structuredClone(manifest);
    present.classification.historical.public.push('README.md');
    assert.deepEqual(historicalClassificationViolations(present, root), [
      'historical classification is still present: README.md',
    ]);
  },
);

test('distinguishes snapshot validation from complete ancestry proof', () => {
  const repository = mkdtempSync(resolve(tmpdir(), 'tixkit-shallow-history-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repository });
    writeFileSync(resolve(repository, 'README.md'), '# Fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture'],
      { cwd: repository },
    );
    const snapshot = structuredClone(manifest);
    snapshot.classification.historyValidation = 'snapshot';
    snapshot.classification.historical = {
      public: [],
      privateCloud: [],
      internalPlanning: [],
    };
    assert.deepEqual(historicalClassificationViolations(snapshot, repository), []);
    snapshot.classification.historical.public = ['deleted.md'];
    assert.deepEqual(historicalClassificationViolations(snapshot, repository), [
      'snapshot history classification must not contain historical paths',
    ]);
    snapshot.classification.historical.public = [];
    writeFileSync(resolve(repository, 'SECOND.md'), '# Second\n');
    execFileSync('git', ['add', 'SECOND.md'], { cwd: repository });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'second'],
      { cwd: repository },
    );
    assert.deepEqual(historicalClassificationViolations(snapshot, repository), [
      'snapshot history must contain exactly one reachable commit, found 2',
    ]);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    writeFileSync(resolve(repository, '.git/shallow'), `${commit}\n`);
    assert.throws(
      () => historicalClassificationViolations(snapshot, repository),
      /snapshot history validation requires complete ancestry/u,
    );
    const full = {
      classification: {
        historyValidation: 'full',
        historical: { public: [], privateCloud: [], internalPlanning: [] },
        topLevel: {
          public: ['README.md'],
          privateCloud: [],
          internalPlanning: [],
          mixed: [],
        },
        docs: { public: [], internalPlanning: [] },
        generatedRoots: [],
      },
    };
    assert.throws(
      () => historicalClassificationViolations(full, repository),
      /full history validation requires complete ancestry/u,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
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

  const missingRetainedApi = structuredClone(manifest);
  missingRetainedApi.release.contracts = missingRetainedApi.release.contracts.filter(
    (contract) => contract !== 'artifacts/api/2026-07-17',
  );
  assert.throws(
    () => validatePublicDistribution(missingRetainedApi, root),
    /retained API contract missing from release\.contracts: artifacts\/api\/2026-07-17/u,
  );

  const reorderedApiContracts = structuredClone(manifest);
  const activeApiContract = reorderedApiContracts.release.contracts.find((contract) =>
    contract.startsWith('artifacts/api/'),
  );
  reorderedApiContracts.release.contracts = [
    'artifacts/api/2026-01-01',
    ...reorderedApiContracts.release.contracts.filter(
      (contract) => contract !== 'artifacts/api/2026-01-01',
    ),
  ];
  assert.notEqual(reorderedApiContracts.release.contracts[0], activeApiContract);
  assert.throws(
    () => validatePublicDistribution(reorderedApiContracts, root),
    new RegExp(
      `first release API contract must be the generated active contract: artifacts/api/${generatedOpenApiVersion}`,
      'u',
    ),
  );
});

test('rejects SDK workflow trigger and verification-job drift', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/sdk-release-dry-run.yml'), 'utf8');
  assert.deepEqual(sdkReleaseWorkflowViolations(manifest, workflow), []);
  assert.deepEqual(
    sdkReleaseWorkflowViolations(
      manifest,
      workflow.replace(
        '    branches: [main]\n',
        "    branches: [main]\n    paths:\n      - 'docs/**'\n",
      ),
    ),
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
    mkdirSync(resolve(fixtureRoot, 'scripts/build'), { recursive: true });
    mkdirSync(resolve(fixtureRoot, 'managed'), { recursive: true });
    writeFileSync(
      resolve(fixtureRoot, '.github/workflows/ci.yml'),
      'steps:\n  - uses: tixkithq/tixkit-cloud-action@v1\n',
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
      JSON.stringify({
        compilerOptions: { paths: { '@private/*': ['managed/*'] } },
      }),
    );
    symlinkSync(
      resolve(fixtureRoot, 'scripts/build.mjs'),
      resolve(fixtureRoot, 'scripts/link.mjs'),
    );
    symlinkSync(resolve(fixtureRoot, 'managed'), resolve(fixtureRoot, 'scripts/private-dir'));
    writeFileSync(
      resolve(fixtureRoot, 'scripts/build/private.sh'),
      'git clone https://github.com/tixkithq/tixkit-cloud\n',
    );
    execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: fixtureRoot });
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: fixtureRoot });
    mkdirSync(resolve(fixtureRoot, 'scripts/dist'), { recursive: true });
    writeFileSync(
      resolve(fixtureRoot, 'scripts/dist/untracked-generated.js'),
      "await import('../../../managed/untracked.js');\n",
    );
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
      'scripts/build/private.sh: forbidden private dependency/build reference',
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
  approved.licensing.mayClaimLegalApproval = false;
  approved.licensing.legalReviewEvidence = '';
  assert.throws(() => validatePublicDistribution(approved, root), /canonical legal evidence/u);

  approved.licensing.mayClaimLegalApproval = true;
  approved.licensing.legalReviewEvidence = 'LEGAL_APPROVAL.md';
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
