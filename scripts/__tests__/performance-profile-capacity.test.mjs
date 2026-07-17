import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  canonicalHostedTrustJson,
  hostedTrustReceiptSigningBytes,
} from '../lib/hosted-trust-receipt.mjs';
import { canonicalJson, sha256 } from '../performance-evidence.mjs';
import {
  createSupportedProfileCapacityEvidence,
  deploymentManifest,
  main,
  validateSupportedProfileCapacityConfig,
  verifySupportedProfileCapacityEvidence,
  verifySupportedProfileCapacityEligibility,
} from '../performance-profile-capacity.mjs';
import schema from '../performance-profile-capacity.schema.json' with { type: 'json' };

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const committedConfig = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'performance-capacity.supported-profiles.json'), 'utf8'),
);
const sourceCommit = 'a'.repeat(40);
const now = Date.UTC(2026, 6, 17, 12);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyId = 'supported-profile-capacity-2026-07';
const keyring = {
  schemaVersion: 1,
  purpose: 'tixkit.hosted-trust-receipt',
  keys: {
    [keyId]: {
      algorithm: 'Ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    },
  },
};
const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function publicReleaseManifest(commit = sourceCommit) {
  const image = (name) => {
    const digest = `sha256:${sha256(Buffer.from(`${commit}:${name}:public-image`))}`;
    return { name, digest, reference: `ghcr.io/tixkit/tixkit-${name}@${digest}` };
  };
  return {
    schemaVersion: 1,
    releaseVersion: '1.0.0-test.1',
    core: {
      sourceCommit: commit,
      sourceTreeSha256: sha256(Buffer.from(`${commit}:public-source-archive`)),
      apiVersion: '2026-08-10',
      migrationRange: { minimum: '0001', maximum: '0099' },
      agentProtocol: { status: 'supported', version: '1' },
      packages: [
        {
          name: '@tixkit/domain',
          version: '1.0.0-test.1',
          integrity: 'sha512-YQ==',
          contentSha256: sha256(Buffer.from(`${commit}:domain-package`)),
          fileCount: 1,
        },
      ],
      images: [image('api'), image('worker')],
      contracts: [
        { name: 'openapi', version: '2026-08-10', sha256: sha256(Buffer.from('openapi')) },
      ],
    },
  };
}

function rawSamples(profile, releaseManifest = publicReleaseManifest()) {
  const count = profile.workload.concurrencyPoints.length * profile.workload.samplesPerPoint;
  const intervalMs = (profile.workload.minimumDurationSeconds * 1000) / count;
  const firstStartedAt = now - profile.workload.minimumDurationSeconds * 1000 - 60_000;
  let sequence = 0;
  return profile.workload.concurrencyPoints.flatMap((concurrency) =>
    Array.from({ length: profile.workload.samplesPerPoint }, () => {
      sequence += 1;
      const saturation = concurrency === 128;
      const successes = Math.min(profile.workload.inventory, concurrency);
      const platformFailures = saturation ? 1 : 0;
      const expectedInventoryDeclines = concurrency - successes - platformFailures;
      const startedAt = new Date(firstStartedAt + (sequence - 1) * intervalMs).toISOString();
      const completedAt = new Date(firstStartedAt + sequence * intervalMs).toISOString();
      return Buffer.from(
        `${canonicalJson({
          sequence,
          startedAt,
          completedAt,
          elapsedMs: intervalMs,
          runtime: {
            profile: profile.id,
            deploymentManifestSha256: profile.deployment.manifestSha256,
            database: profile.database,
            api: {
              ...profile.resources.api,
              imageDigest: releaseManifest.core.images.find(({ name }) => name === 'api').digest,
            },
            worker: {
              ...profile.resources.worker,
              imageDigest: releaseManifest.core.images.find(({ name }) => name === 'worker').digest,
            },
          },
          metrics: {
            attempts: concurrency,
            expectedInventoryDeclines,
            platformFailures,
            successes,
            successfulReservationP95Ms: saturation ? 2500 : 500,
          },
        })}\n`,
      );
    }),
  );
}

function mutateRawSample(bytes, mutate) {
  const value = JSON.parse(bytes);
  mutate(value);
  return Buffer.from(`${canonicalJson(value)}\n`);
}

function signedReceipt(evidenceBytes, mutate = () => undefined, signingKey = privateKey) {
  const receipt = {
    $schema: 'https://tixkit.com/schemas/hosted-trust-receipt.schema.json',
    schemaVersion: 1,
    kind: 'tixkit.hosted-trust-receipt',
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    source: { repository: 'tixkit/tixkit', commit: sourceCommit, tree: 'b'.repeat(40) },
    workflow: {
      repository: 'tixkit/tixkit',
      path: '.github/workflows/performance-profile-capacity.yml',
      runId: '987654321',
      attempt: 1,
      url: 'https://github.com/tixkit/tixkit/actions/runs/987654321',
    },
    artifact: {
      kind: 'performance-profile-capacity',
      sizeBytes: evidenceBytes.length,
      sha256: sha256(evidenceBytes),
    },
    validation: {
      validator: 'scripts/performance-profile-capacity.mjs#verifySupportedProfileCapacityEvidence',
      version: 1,
      outcome: 'passed',
    },
    observedAt: new Date(now - 60_000).toISOString(),
    signature: { algorithm: 'Ed25519', keyId, value: '' },
  };
  mutate(receipt);
  receipt.signature.value = sign(
    null,
    hostedTrustReceiptSigningBytes(receipt),
    signingKey,
  ).toString('base64');
  return receipt;
}

function evidenceFixture(
  profileId = 'compact',
  config = committedConfig,
  root = repositoryRoot,
  commit = sourceCommit,
  gitTree = 'b'.repeat(40),
) {
  const profile = config.profiles.find(({ id }) => id === profileId);
  const releaseManifest = publicReleaseManifest(commit);
  const releaseManifestBytes = Buffer.from(`${canonicalJson(releaseManifest)}\n`);
  const samples = rawSamples(profile, releaseManifest);
  const evidence = createSupportedProfileCapacityEvidence({
    config,
    root,
    profileId,
    sourceCommit: commit,
    gitTree,
    releaseManifest,
    releaseManifestBytes,
    rawSamples: samples,
    capacityClaim: {
      maxPublishableConcurrency: 64,
      saturationObservedAtConcurrency: 128,
    },
  });
  const evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`);
  return {
    evidence,
    evidenceBytes,
    samples,
    releaseManifest,
    releaseManifestBytes,
    receipt: signedReceipt(evidenceBytes, (candidate) => {
      candidate.source.commit = commit;
      candidate.source.tree = gitTree;
    }),
  };
}

function verify(fixture, config = committedConfig, root = repositoryRoot) {
  return verifySupportedProfileCapacityEligibility({
    config,
    root,
    evidence: fixture.evidence,
    evidenceBytes: fixture.evidenceBytes,
    rawSamples: fixture.samples,
    releaseManifest: fixture.releaseManifest,
    releaseManifestBytes: fixture.releaseManifestBytes,
    receipt: fixture.receipt,
    keyring,
    options: { now },
  });
}

function verifySemantic(fixture, config = committedConfig, root = repositoryRoot) {
  return verifySupportedProfileCapacityEvidence({
    config,
    root,
    evidence: fixture.evidence,
    evidenceBytes: fixture.evidenceBytes,
    rawSamples: fixture.samples,
    releaseManifest: fixture.releaseManifest,
    releaseManifestBytes: fixture.releaseManifestBytes,
  });
}

function creationInput(
  profile,
  config = committedConfig,
  root = repositoryRoot,
  commit = sourceCommit,
  gitTree = 'b'.repeat(40),
) {
  const releaseManifest = publicReleaseManifest(commit);
  return {
    config,
    root,
    profileId: profile.id,
    sourceCommit: commit,
    gitTree,
    releaseManifest,
    releaseManifestBytes: Buffer.from(`${canonicalJson(releaseManifest)}\n`),
  };
}

function isolatedConfig() {
  const root = mkdtempSync(path.join(tmpdir(), 'tixkit-supported-capacity-'));
  temporaryRoots.push(root);
  const config = structuredClone(committedConfig);
  for (const profile of config.profiles) {
    for (const file of profile.deployment.files) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${profile.id}:${file}\n`);
    }
    profile.deployment.manifestSha256 = deploymentManifest(root, profile.deployment.files).sha256;
  }
  return { root, config };
}

function gitRepositoryFixture(profileId = 'compact') {
  const { root, config } = isolatedConfig();
  writeFileSync(
    path.join(root, 'performance-capacity.supported-profiles.json'),
    `${canonicalJson(config)}\n`,
  );
  execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: root });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: root });
  execFileSync(
    '/usr/bin/git',
    [
      '-c',
      'user.name=Tixkit Test',
      '-c',
      'user.email=test@tixkit.invalid',
      'commit',
      '--quiet',
      '-m',
      'capacity fixture',
    ],
    { cwd: root },
  );
  const commit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const gitTree = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return {
    ...evidenceFixture(profileId, config, root, commit, gitTree),
    root,
    config,
    commit,
    gitTree,
  };
}

test('committed supported-profile config is closed, canonical, and binds deployment inputs', () => {
  const validate = new Ajv2020({ strict: true, formats: { 'date-time': true } }).compile(schema);
  assert.equal(validate(committedConfig), true, JSON.stringify(validate.errors));
  assert.equal(
    validateSupportedProfileCapacityConfig(committedConfig, { root: repositoryRoot }),
    committedConfig,
  );
  assert.deepEqual(
    committedConfig.profiles.map(({ id }) => id),
    ['compact', 'production'],
  );
  assert.throws(() => main(['one', 'two']), /usage/u);
});

test('verifies Compact and Production eligibility without promoting trust state', () => {
  for (const profileId of ['compact', 'production']) {
    const fixture = gitRepositoryFixture(profileId);
    const result = verify(fixture, fixture.config, fixture.root);
    assert.deepEqual(result, {
      eligibleForReview: true,
      profile: profileId,
      sourceCommit: fixture.commit,
      deploymentManifestSha256: fixture.evidence.deploymentManifestSha256,
      evidenceSha256: fixture.evidence.evidenceSha256,
      hostedReceiptSha256: sha256(fixture.evidenceBytes),
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal('proven' in result, false);
    assert.equal('trustState' in result, false);
  }
});

test('semantic validator independently re-derives exact raw and evidence bindings', () => {
  const fixture = evidenceFixture('compact');
  assert.deepEqual(
    verifySupportedProfileCapacityEvidence({
      config: committedConfig,
      root: repositoryRoot,
      evidence: fixture.evidence,
      evidenceBytes: fixture.evidenceBytes,
      rawSamples: fixture.samples,
      releaseManifest: fixture.releaseManifest,
      releaseManifestBytes: fixture.releaseManifestBytes,
    }),
    {
      validated: true,
      profile: 'compact',
      sourceCommit,
      deploymentManifestSha256: fixture.evidence.deploymentManifestSha256,
      evidenceSha256: fixture.evidence.evidenceSha256,
    },
  );
});

test('rejects trusted-host scope and Compact/Production substitution', () => {
  assert.throws(
    () =>
      verifySupportedProfileCapacityEligibility({
        config: committedConfig,
        evidence: { claimScope: 'trusted-single-host-capacity-characterization' },
      }),
    /cannot establish supported-profile/u,
  );
  const fixture = evidenceFixture('compact');
  fixture.evidence.profile = 'production';
  fixture.evidenceBytes = Buffer.from(`${canonicalJson(fixture.evidence)}\n`);
  fixture.receipt = signedReceipt(fixture.evidenceBytes);
  assert.throws(
    () => verifySemantic(fixture),
    /derived execution duration|runtime identity|does not match config/u,
  );
});

test('rejects raw, evidence, checksum, receipt, and mixed-revision tampering', () => {
  const raw = evidenceFixture();
  raw.samples[0] = mutateRawSample(raw.samples[0], (sample) => {
    sample.metrics.successfulReservationP95Ms += 1;
  });
  assert.throws(() => verifySemantic(raw), /does not match config, raw samples, or checksum/u);

  const summary = evidenceFixture();
  summary.evidence.samples[0].metrics.successfulReservationP95Ms = 1;
  summary.evidenceBytes = Buffer.from(`${canonicalJson(summary.evidence)}\n`);
  summary.receipt = signedReceipt(summary.evidenceBytes);
  assert.throws(() => verifySemantic(summary), /does not match config, raw samples, or checksum/u);

  const checksum = evidenceFixture();
  checksum.evidence.evidenceSha256 = '0'.repeat(64);
  checksum.evidenceBytes = Buffer.from(`${canonicalJson(checksum.evidence)}\n`);
  checksum.receipt = signedReceipt(checksum.evidenceBytes);
  assert.throws(() => verifySemantic(checksum), /does not match config, raw samples, or checksum/u);

  const receipt = gitRepositoryFixture();
  receipt.receipt.signature.value = `${'A'.repeat(86)}==`;
  assert.throws(() => verify(receipt, receipt.config, receipt.root), /signature is invalid/u);

  const revision = gitRepositoryFixture();
  revision.receipt = signedReceipt(revision.evidenceBytes, (candidate) => {
    candidate.source.commit = 'c'.repeat(40);
    candidate.source.tree = revision.gitTree;
  });
  assert.throws(
    () => verify(revision, revision.config, revision.root),
    /does not bind the supported-profile capacity revision/u,
  );
});

test('rejects noncanonical, oversized, stale, and unsigned evidence inputs', () => {
  const noncanonical = evidenceFixture();
  noncanonical.evidenceBytes = Buffer.from(JSON.stringify(noncanonical.evidence, null, 2));
  noncanonical.receipt = signedReceipt(noncanonical.evidenceBytes);
  assert.throws(() => verifySemantic(noncanonical), /must be canonical and exact/u);

  const oversized = evidenceFixture();
  oversized.evidenceBytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
  assert.throws(() => verifySemantic(oversized), /bounded size/u);

  const stale = gitRepositoryFixture();
  stale.receipt = signedReceipt(stale.evidenceBytes, (candidate) => {
    candidate.source.commit = stale.commit;
    candidate.source.tree = stale.gitTree;
    candidate.observedAt = new Date(now - 91 * 24 * 60 * 60_000).toISOString();
  });
  assert.throws(() => verify(stale, stale.config, stale.root), /is stale/u);

  const unknown = gitRepositoryFixture();
  unknown.receipt.signature.keyId = 'unknown';
  assert.throws(
    () => verify(unknown, unknown.config, unknown.root),
    /signature key is not trusted|signature is invalid/u,
  );
});

test('rejects config drift, duplicate profiles, topology drift, path escape, symlink, and oversize', (context) => {
  const { root, config } = isolatedConfig();
  const outside = mkdtempSync(path.join(tmpdir(), 'tixkit-supported-capacity-outside-'));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  assert.equal(validateSupportedProfileCapacityConfig(config, { root }), config);

  const duplicate = structuredClone(config);
  duplicate.profiles[1] = structuredClone(duplicate.profiles[0]);
  assert.throws(
    () => validateSupportedProfileCapacityConfig(duplicate, { root }),
    /compact then production exactly once/u,
  );

  const topology = structuredClone(config);
  topology.profiles[0].database.topology = 'external-high-availability';
  assert.throws(
    () => validateSupportedProfileCapacityConfig(topology, { root }),
    /topology is unsupported/u,
  );

  const digest = structuredClone(config);
  digest.profiles[0].deployment.manifestSha256 = '0'.repeat(64);
  assert.throws(
    () => validateSupportedProfileCapacityConfig(digest, { root }),
    /digest does not match/u,
  );

  const alias = structuredClone(config);
  alias.profiles[0].deployment.files[0] = 'infra/compact/./.env.example';
  assert.throws(
    () => validateSupportedProfileCapacityConfig(alias, { root }),
    /canonical and unique/u,
  );

  const escaped = structuredClone(config);
  const outsideFile = path.join(outside, 'outside.txt');
  writeFileSync(outsideFile, 'outside');
  escaped.profiles[0].deployment.files[0] = 'infra/compact/../../../outside.txt';
  assert.throws(
    () => validateSupportedProfileCapacityConfig(escaped, { root }),
    /escapes repository/u,
  );

  const symlinked = structuredClone(config);
  const symlinkPath = path.join(root, symlinked.profiles[0].deployment.files[0]);
  rmSync(symlinkPath);
  symlinkSync(outsideFile, symlinkPath);
  assert.throws(
    () => validateSupportedProfileCapacityConfig(symlinked, { root }),
    /direct regular file/u,
  );

  rmSync(symlinkPath);
  writeFileSync(symlinkPath, 'x');
  truncateSync(symlinkPath, 4 * 1024 * 1024 + 1);
  assert.throws(() => validateSupportedProfileCapacityConfig(symlinked, { root }), /bounded size/u);
});

test('capacity claim requires adjacent saturation and complete fail-closed samples', () => {
  const profile = committedConfig.profiles[0];
  const releaseManifest = publicReleaseManifest();
  const base = {
    ...creationInput(profile),
    rawSamples: rawSamples(profile, releaseManifest),
  };
  assert.throws(
    () =>
      createSupportedProfileCapacityEvidence({
        ...base,
        capacityClaim: { maxPublishableConcurrency: 32, saturationObservedAtConcurrency: 128 },
      }),
    /adjacent tested saturation/u,
  );
  assert.throws(
    () =>
      createSupportedProfileCapacityEvidence({
        ...base,
        rawSamples: base.rawSamples.slice(1),
        capacityClaim: { maxPublishableConcurrency: 64, saturationObservedAtConcurrency: 128 },
      }),
    /sample count/u,
  );
  const noSaturation = base.rawSamples.map((sample) =>
    Buffer.from(
      sample
        .toString()
        .replace('"platformFailures":1', '"platformFailures":0')
        .replace('"successfulReservationP95Ms":2500', '"successfulReservationP95Ms":500')
        .replace('"expectedInventoryDeclines":63', '"expectedInventoryDeclines":64'),
    ),
  );
  assert.throws(
    () =>
      createSupportedProfileCapacityEvidence({
        ...base,
        rawSamples: noSaturation,
        capacityClaim: { maxPublishableConcurrency: 64, saturationObservedAtConcurrency: 128 },
      }),
    /did not exhibit/u,
  );
  const prematureDecline = [...base.rawSamples];
  prematureDecline[0] = Buffer.from(
    prematureDecline[0]
      .toString()
      .replace('"successes":16', '"successes":15')
      .replace('"expectedInventoryDeclines":0', '"expectedInventoryDeclines":1'),
  );
  assert.throws(
    () =>
      createSupportedProfileCapacityEvidence({
        ...base,
        rawSamples: prematureDecline,
        capacityClaim: { maxPublishableConcurrency: 64, saturationObservedAtConcurrency: 128 },
      }),
    /decline occurred before inventory exhaustion/u,
  );
});

test('derives duration only from canonical contiguous sample intervals', () => {
  const profile = committedConfig.profiles[0];
  const releaseManifest = publicReleaseManifest();
  const create = (samples) =>
    createSupportedProfileCapacityEvidence({
      ...creationInput(profile),
      rawSamples: samples,
      capacityClaim: { maxPublishableConcurrency: 64, saturationObservedAtConcurrency: 128 },
    });
  const base = rawSamples(profile, releaseManifest);

  const wrongSequence = [...base];
  wrongSequence[1] = mutateRawSample(wrongSequence[1], (sample) => {
    sample.sequence = 99;
  });
  assert.throws(() => create(wrongSequence), /sequence is not canonical/u);

  const elapsedInflation = [...base];
  elapsedInflation[0] = mutateRawSample(elapsedInflation[0], (sample) => {
    sample.elapsedMs += 60_000;
  });
  assert.throws(() => create(elapsedInflation), /elapsed time does not match/u);

  for (const offset of [1000, -1000]) {
    const discontinuous = [...base];
    discontinuous[1] = mutateRawSample(discontinuous[1], (sample) => {
      sample.startedAt = new Date(Date.parse(sample.startedAt) + offset).toISOString();
      sample.completedAt = new Date(Date.parse(sample.completedAt) + offset).toISOString();
    });
    assert.throws(() => create(discontinuous), /contiguous without gaps or overlap/u);
  }

  const tooShort = base.map((sample, index) =>
    mutateRawSample(sample, (value) => {
      value.startedAt = new Date(now - 60_000 + index * 1000).toISOString();
      value.completedAt = new Date(now - 60_000 + (index + 1) * 1000).toISOString();
      value.elapsedMs = 1000;
    }),
  );
  assert.throws(() => create(tooShort), /derived execution duration/u);

  const durationForgery = evidenceFixture();
  durationForgery.evidence.durationSeconds += 10_000;
  durationForgery.evidenceBytes = Buffer.from(`${canonicalJson(durationForgery.evidence)}\n`);
  durationForgery.receipt = signedReceipt(durationForgery.evidenceBytes);
  assert.throws(
    () => verifySemantic(durationForgery),
    /does not match config, raw samples, or checksum/u,
  );

  const shiftedFixture = gitRepositoryFixture();
  const shiftedProfile = shiftedFixture.config.profiles[0];
  const shifted = shiftedFixture.samples.map((sample) =>
    mutateRawSample(sample, (value) => {
      value.startedAt = new Date(Date.parse(value.startedAt) + 24 * 60 * 60_000).toISOString();
      value.completedAt = new Date(Date.parse(value.completedAt) + 24 * 60 * 60_000).toISOString();
    }),
  );
  const shiftedEvidence = createSupportedProfileCapacityEvidence({
    ...creationInput(
      shiftedProfile,
      shiftedFixture.config,
      shiftedFixture.root,
      shiftedFixture.commit,
      shiftedFixture.gitTree,
    ),
    rawSamples: shifted,
    capacityClaim: { maxPublishableConcurrency: 64, saturationObservedAtConcurrency: 128 },
  });
  const shiftedBytes = Buffer.from(`${canonicalJson(shiftedEvidence)}\n`);
  const shiftedReceipt = signedReceipt(shiftedBytes, (candidate) => {
    candidate.source.commit = shiftedFixture.commit;
    candidate.source.tree = shiftedFixture.gitTree;
  });
  assert.throws(
    () =>
      verifySupportedProfileCapacityEligibility({
        config: shiftedFixture.config,
        root: shiftedFixture.root,
        evidence: shiftedEvidence,
        evidenceBytes: shiftedBytes,
        rawSamples: shifted,
        releaseManifest: shiftedFixture.releaseManifest,
        releaseManifestBytes: shiftedFixture.releaseManifestBytes,
        receipt: shiftedReceipt,
        keyring,
        options: { now },
      }),
    /observation time does not follow/u,
  );
});

test('binds every raw sample to exact stable observed runtime identity', () => {
  const profile = committedConfig.profiles[0];
  const releaseManifest = publicReleaseManifest();
  const create = (samples) =>
    createSupportedProfileCapacityEvidence({
      ...creationInput(profile),
      rawSamples: samples,
      capacityClaim: { maxPublishableConcurrency: 64, saturationObservedAtConcurrency: 128 },
    });
  const attacks = [
    (runtime) => (runtime.profile = 'production'),
    (runtime) => (runtime.deploymentManifestSha256 = '0'.repeat(64)),
    (runtime) => (runtime.database.engine = 'mysql'),
    (runtime) => (runtime.database.topology = 'external-high-availability'),
    (runtime) => (runtime.api.replicas += 1),
    (runtime) => (runtime.worker.replicas += 1),
    (runtime) => (runtime.api.cpuQuotaMillis = 0),
    (runtime) => (runtime.worker.cpuQuotaMillis = null),
    (runtime) => (runtime.api.memoryLimitMiB += 1),
    (runtime) => (runtime.worker.memoryLimitMiB += 1),
    (runtime) => (runtime.api.imageDigest = `sha256:${'3'.repeat(64)}`),
    (runtime) => (runtime.worker.imageDigest = `sha256:${'4'.repeat(64)}`),
  ];
  for (const attack of attacks) {
    const samples = rawSamples(profile, releaseManifest);
    samples[1] = mutateRawSample(samples[1], (sample) => attack(sample.runtime));
    assert.throws(
      () => create(samples),
      /runtime (?:identity does not match|requires exact image digests|images do not match)/u,
    );
  }
});

test('eligibility rejects config, commit, tree, receipt-tree, and dirty worktree substitution', () => {
  const configFixture = gitRepositoryFixture();
  const substitutedConfig = structuredClone(configFixture.config);
  substitutedConfig.profiles[0].workload.maximumP95Ms += 1;
  assert.throws(
    () => verify(configFixture, substitutedConfig, configFixture.root),
    /does not match the committed canonical config/u,
  );

  for (const field of ['sourceCommit', 'gitTree']) {
    const fixture = gitRepositoryFixture();
    fixture.evidence[field] = field === 'sourceCommit' ? 'c'.repeat(40) : 'd'.repeat(40);
    fixture.evidenceBytes = Buffer.from(`${canonicalJson(fixture.evidence)}\n`);
    assert.throws(
      () => verify(fixture, fixture.config, fixture.root),
      /does not bind the exact committed Git config and tree/u,
    );
  }

  const receiptTree = gitRepositoryFixture();
  receiptTree.receipt = signedReceipt(receiptTree.evidenceBytes, (candidate) => {
    candidate.source.commit = receiptTree.commit;
    candidate.source.tree = 'e'.repeat(40);
  });
  assert.throws(
    () => verify(receiptTree, receiptTree.config, receiptTree.root),
    /does not bind the supported-profile capacity revision/u,
  );

  for (const dirtyPath of [
    'performance-capacity.supported-profiles.json',
    committedConfig.profiles[0].deployment.files[0],
  ]) {
    const fixture = gitRepositoryFixture();
    const target = path.join(fixture.root, dirtyPath);
    writeFileSync(
      target,
      `${readFileSync(target, 'utf8')}${dirtyPath.endsWith('.json') ? ' ' : 'dirty\n'}`,
    );
    assert.throws(
      () => verify(fixture, fixture.config, fixture.root),
      /exactly match the Git commit|clean tracked Git files/u,
    );
  }

  const hiddenWorktreeSubstitution = gitRepositoryFixture();
  const hiddenPath = hiddenWorktreeSubstitution.config.profiles[0].deployment.files[0];
  execFileSync('/usr/bin/git', ['update-index', '--skip-worktree', '--', hiddenPath], {
    cwd: hiddenWorktreeSubstitution.root,
  });
  writeFileSync(path.join(hiddenWorktreeSubstitution.root, hiddenPath), 'hidden substitution\n');
  assert.throws(
    () =>
      verify(
        hiddenWorktreeSubstitution,
        hiddenWorktreeSubstitution.config,
        hiddenWorktreeSubstitution.root,
      ),
    /exactly match the Git commit/u,
  );
});

test('release manifest and every runtime image remain independently bound', () => {
  const objectSubstitution = evidenceFixture();
  objectSubstitution.releaseManifest = structuredClone(objectSubstitution.releaseManifest);
  objectSubstitution.releaseManifest.releaseVersion = '1.0.0-test.2';
  assert.throws(
    () => verifySemantic(objectSubstitution),
    /object does not match its canonical bytes/u,
  );

  const manifestSubstitution = evidenceFixture();
  manifestSubstitution.releaseManifest = structuredClone(manifestSubstitution.releaseManifest);
  const alternateDigest = `sha256:${'3'.repeat(64)}`;
  const apiImage = manifestSubstitution.releaseManifest.core.images.find(
    ({ name }) => name === 'api',
  );
  apiImage.digest = alternateDigest;
  apiImage.reference = `ghcr.io/tixkit/tixkit-api@${alternateDigest}`;
  manifestSubstitution.releaseManifestBytes = Buffer.from(
    `${canonicalJson(manifestSubstitution.releaseManifest)}\n`,
  );
  assert.throws(
    () => verifySemantic(manifestSubstitution),
    /does not match config, raw samples, or checksum|images do not match/u,
  );

  const commitSubstitution = evidenceFixture();
  commitSubstitution.releaseManifest = publicReleaseManifest('c'.repeat(40));
  commitSubstitution.releaseManifestBytes = Buffer.from(
    `${canonicalJson(commitSubstitution.releaseManifest)}\n`,
  );
  assert.throws(
    () => verifySemantic(commitSubstitution),
    /source commit does not match capacity evidence/u,
  );

  const checksumSubstitution = evidenceFixture();
  checksumSubstitution.evidence.releaseManifestSha256 = '0'.repeat(64);
  checksumSubstitution.evidenceBytes = Buffer.from(
    `${canonicalJson(checksumSubstitution.evidence)}\n`,
  );
  assert.throws(
    () => verifySemantic(checksumSubstitution),
    /does not match config, raw samples, or checksum/u,
  );

  const uniformImageSubstitution = evidenceFixture();
  uniformImageSubstitution.samples = uniformImageSubstitution.samples.map((sample) =>
    mutateRawSample(sample, (value) => {
      value.runtime.api.imageDigest = alternateDigest;
    }),
  );
  assert.throws(
    () => verifySemantic(uniformImageSubstitution),
    /runtime images do not match the public release/u,
  );
});

test('canonical hosted artifact contains no raw secrets or trust escalation fields', () => {
  const fixture = evidenceFixture();
  const text = fixture.evidenceBytes.toString('utf8');
  assert.equal(text.includes('privateKey'), false);
  assert.equal(text.includes('providerSecret'), false);
  assert.equal(text.includes('trustState'), false);
  assert.equal(text.includes('proven'), false);
  assert.equal(canonicalHostedTrustJson(keyring).includes('PRIVATE KEY'), false);
});
