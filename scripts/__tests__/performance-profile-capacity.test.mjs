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
  createLegacySupportedProfileCapacityEvidence,
  createSupportedProfileCapacityFailureEvidence,
  createTargetBinding,
  createTopologyFingerprint,
  deploymentManifest,
  main,
  validateSupportedProfileCapacityConfig,
  verifySupportedProfileCapacityEvidence,
  verifySupportedProfileCapacityFailureEvidence,
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
const topologyFingerprint = createTopologyFingerprint({
  profile: 'fixture',
  runtime: 'reviewed-host',
});
const targetBinding = createTargetBinding({
  profile: 'production',
  apiOrigin: 'https://api.capacity.test',
  fixtureOrigin: 'https://fixture.capacity.test',
  apiImageDigest: `sha256:${'9'.repeat(64)}`,
  fixtureServiceArtifactSha256: 'f'.repeat(64),
  fixtureDeploymentSha256: 'd'.repeat(64),
  fixtureIdentityPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
});
const capacityClaim = (maxPublishableConcurrency = 64, saturationObservedAtConcurrency = 128) => ({
  surface: 'api-checkout-reservation',
  dependencyScope: 'runtime-topology-bound-dependencies-not-independently-characterized',
  hostCapacity: 'not-characterized',
  maxPublishableConcurrency,
  saturationObservedAtConcurrency,
});
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
    return { name, digest, reference: `ghcr.io/tixkithq/tixkit-${name}@${digest}` };
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

function rawSamples(
  profile,
  releaseManifest = publicReleaseManifest(),
  saturationConcurrency = 128,
) {
  const count = profile.workload.concurrencyPoints.length * profile.workload.samplesPerPoint;
  const intervalMs = (profile.workload.minimumDurationSeconds * 1000) / count;
  const firstStartedAt = now - profile.workload.minimumDurationSeconds * 1000 - 60_000;
  let sequence = 0;
  return profile.workload.concurrencyPoints.flatMap((concurrency) =>
    Array.from({ length: profile.workload.samplesPerPoint }, () => {
      sequence += 1;
      const saturation = concurrency === saturationConcurrency;
      const platformFailures = saturation ? 1 : 0;
      const successes =
        Math.min(profile.workload.inventory, concurrency) -
        (saturation && concurrency <= profile.workload.inventory ? platformFailures : 0);
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
            topologyFingerprint,
            targetBinding,
          },
          fixtureSha256: sha256(Buffer.from(`${profile.id}:${sequence}:fresh-fixture`)),
          metrics: {
            attempts: concurrency,
            rounds: 1,
            reservationActiveLoadMs: intervalMs,
            expectedInventoryDeclines,
            platformFailures,
            successes,
            successfulReservationP95Ms: saturation ? 2500 : 500,
            finalHeld: successes,
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
    source: { repository: 'tixkithq/tixkit', commit: sourceCommit, tree: 'b'.repeat(40) },
    workflow: {
      repository: 'tixkithq/tixkit',
      path: '.github/workflows/performance-profile-capacity.yml',
      runId: '987654321',
      attempt: 1,
      url: 'https://github.com/tixkithq/tixkit/actions/runs/987654321',
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
    capacityClaim: capacityClaim(),
    topologyFingerprint,
    targetBinding,
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
    topologyFingerprint,
    targetBinding,
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
        capacityClaim: capacityClaim(32, 128),
      }),
    /does not match derived measurements/u,
  );
  assert.throws(
    () =>
      createSupportedProfileCapacityEvidence({
        ...base,
        rawSamples: base.rawSamples.slice(1),
        capacityClaim: capacityClaim(),
      }),
    /sample count/u,
  );
  const reusedFixture = [...base.rawSamples];
  const firstFixture = JSON.parse(reusedFixture[0]).fixtureSha256;
  reusedFixture[1] = mutateRawSample(reusedFixture[1], (sample) => {
    sample.fixtureSha256 = firstFixture;
  });
  assert.throws(
    () =>
      createSupportedProfileCapacityEvidence({
        ...base,
        rawSamples: reusedFixture,
        capacityClaim: capacityClaim(),
      }),
    /fresh unique fixture identity/u,
  );
  const noSaturation = base.rawSamples.map((sample) =>
    mutateRawSample(sample, ({ metrics }) => {
      metrics.expectedInventoryDeclines += metrics.platformFailures;
      metrics.platformFailures = 0;
      metrics.successfulReservationP95Ms = 500;
    }),
  );
  const noClaim = createSupportedProfileCapacityEvidence({ ...base, rawSamples: noSaturation });
  assert.equal(noClaim.capacityClaim, null);
  assert.equal(noClaim.capacityAssessment.reason, 'saturation-not-observed');
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
        capacityClaim: capacityClaim(),
      }),
    /decline occurred before inventory exhaustion/u,
  );
});

test('derives duration only from canonical non-overlapping sample intervals', () => {
  const profile = committedConfig.profiles[0];
  const releaseManifest = publicReleaseManifest();
  const create = (samples) =>
    createSupportedProfileCapacityEvidence({
      ...creationInput(profile),
      rawSamples: samples,
      capacityClaim: capacityClaim(),
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

  const overlapping = [...base];
  overlapping[1] = mutateRawSample(overlapping[1], (sample) => {
    sample.startedAt = new Date(Date.parse(sample.startedAt) - 1000).toISOString();
    sample.completedAt = new Date(Date.parse(sample.completedAt) - 1000).toISOString();
  });
  assert.throws(() => create(overlapping), /must not overlap/u);

  const gapped = base.map((sample, index) =>
    index === 0
      ? sample
      : mutateRawSample(sample, (value) => {
          value.startedAt = new Date(Date.parse(value.startedAt) + 1000).toISOString();
          value.completedAt = new Date(Date.parse(value.completedAt) + 1000).toISOString();
        }),
  );
  assert.doesNotThrow(() => create(gapped));

  const minimumMs = profile.workload.minimumDurationSeconds * 1000;
  const idleInflated = base.map((sample, index) =>
    mutateRawSample(sample, (value) => {
      const started =
        now - minimumMs - 60_000 + Math.floor((index * minimumMs) / (base.length - 1));
      value.startedAt = new Date(started).toISOString();
      value.completedAt = new Date(started + 1000).toISOString();
      value.elapsedMs = 1000;
      value.metrics.reservationActiveLoadMs = 1;
    }),
  );
  assert.throws(() => create(idleInflated), /active load duration/u);

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
    capacityClaim: capacityClaim(),
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
      capacityClaim: capacityClaim(),
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
    (runtime) => (runtime.topologyFingerprint.sha256 = '5'.repeat(64)),
    (runtime) => (runtime.targetBinding.apiOriginSha256 = '6'.repeat(64)),
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
  apiImage.reference = `ghcr.io/tixkithq/tixkit-api@${alternateDigest}`;
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

function failureEvidenceFixture(
  profileId = 'compact',
  config = committedConfig,
  root = repositoryRoot,
  commit = sourceCommit,
  gitTree = 'b'.repeat(40),
) {
  const profile = config.profiles.find(({ id }) => id === profileId);
  const releaseManifest = publicReleaseManifest(commit);
  const releaseManifestBytes = Buffer.from(`${canonicalJson(releaseManifest)}\n`);
  const descriptor = {
    schemaVersion: 'tixkit-supported-profile-observed-topology-v1',
    observation: { targetBinding },
  };
  const failureTopologyFingerprint = createTopologyFingerprint(descriptor);
  const rawSamplesForFailure = rawSamples(profile, releaseManifest).map((sample) =>
    mutateRawSample(sample, (value) => {
      value.runtime.topologyFingerprint = failureTopologyFingerprint;
    }),
  );
  const runtime = {
    images: Object.fromEntries(
      releaseManifest.core.images.map(({ name, digest }) => [name, digest]),
    ),
    topologyFingerprint: failureTopologyFingerprint,
    targetBinding,
  };
  const runtimeBytes = Buffer.from(`${canonicalJson(runtime)}\n`);
  const runtimeDescriptorBytes = Buffer.from(`${canonicalJson(descriptor)}\n`);
  const proofFiles = [
    {
      path: 'fixture-service-artifact.json',
      bytes: Buffer.from(`${canonicalJson({ kind: 'fixture', version: 1 })}\n`),
    },
    {
      path: 'runtime-placement.json',
      bytes: Buffer.from(`${canonicalJson({ kind: 'placement', version: 1 })}\n`),
    },
  ];
  const evidence = createSupportedProfileCapacityFailureEvidence({
    config,
    root,
    profileId,
    sourceCommit: commit,
    gitTree,
    releaseManifest,
    releaseManifestBytes,
    rawSamples: rawSamplesForFailure,
    topologyFingerprint: failureTopologyFingerprint,
    targetBinding,
    runtimeBytes,
    runtimeDescriptorBytes,
    proofFiles,
    reason: 'workload-execution-failed',
    errorSha256: sha256('safe failure reason'),
  });
  return {
    evidence,
    evidenceBytes: Buffer.from(`${canonicalJson(evidence)}\n`),
    releaseManifest,
    releaseManifestBytes,
    rawSamples: rawSamplesForFailure,
    runtimeBytes,
    runtimeDescriptorBytes,
    proofFiles,
  };
}

test('derives adjacent claims and explicit no-claim results from validated measurements', () => {
  const profile = committedConfig.profiles[0];
  const releaseManifest = publicReleaseManifest();
  const create = (samples) =>
    createSupportedProfileCapacityEvidence({
      ...creationInput(profile),
      rawSamples: samples,
    });
  for (const [saturationConcurrency, maxPublishableConcurrency] of [
    [32, 16],
    [64, 32],
    [128, 64],
  ]) {
    const evidence = create(rawSamples(profile, releaseManifest, saturationConcurrency));
    assert.equal(evidence.capacityAssessment.status, 'claim');
    assert.deepEqual(evidence.capacityClaim, {
      surface: 'api-checkout-reservation',
      dependencyScope: 'runtime-topology-bound-dependencies-not-independently-characterized',
      hostCapacity: 'not-characterized',
      maxPublishableConcurrency,
      saturationObservedAtConcurrency: saturationConcurrency,
    });
  }
  const firstPointFailure = create(rawSamples(profile, releaseManifest, 16));
  assert.equal(firstPointFailure.capacityClaim, null);
  assert.equal(firstPointFailure.capacityAssessment.reason, 'first-point-objective-failed');
  const noSaturation = create(rawSamples(profile, releaseManifest, -1));
  assert.equal(noSaturation.capacityClaim, null);
  assert.equal(noSaturation.capacityAssessment.reason, 'saturation-not-observed');
  const mixed = rawSamples(profile, releaseManifest, 128);
  mixed[6] = mutateRawSample(mixed[6], ({ metrics }) => {
    metrics.successes -= 1;
    metrics.finalHeld = metrics.successes;
    metrics.platformFailures += 1;
  });
  assert.equal(create(mixed).capacityClaim.maxPublishableConcurrency, 32);
  const malformed = rawSamples(profile, releaseManifest, 128);
  malformed[0] = mutateRawSample(malformed[0], ({ metrics }) => {
    metrics.successfulReservationP95Ms = -1;
  });
  assert.throws(() => create(malformed), /finite and non-negative/u);
});

test('eligibility rejects signed no-claim evidence', () => {
  const fixture = gitRepositoryFixture();
  const profile = fixture.config.profiles[0];
  const raw = rawSamples(profile, fixture.releaseManifest, -1);
  const evidence = createSupportedProfileCapacityEvidence({
    ...creationInput(profile, fixture.config, fixture.root, fixture.commit, fixture.gitTree),
    rawSamples: raw,
  });
  const evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`);
  assert.throws(
    () =>
      verify(
        {
          ...fixture,
          evidence,
          evidenceBytes,
          samples: raw,
          receipt: signedReceipt(evidenceBytes, (receipt) => {
            receipt.source.commit = fixture.commit;
            receipt.source.tree = fixture.gitTree;
          }),
        },
        fixture.config,
        fixture.root,
      ),
    /no-claim capacity evidence is not eligible/u,
  );
});

test('failure verifier checksum-binds committed revision, runtime, proofs, and completed raw samples', () => {
  const repository = gitRepositoryFixture();
  const fixture = failureEvidenceFixture(
    'compact',
    repository.config,
    repository.root,
    repository.commit,
    repository.gitTree,
  );
  const input = {
    config: repository.config,
    root: repository.root,
    evidence: fixture.evidence,
    evidenceBytes: fixture.evidenceBytes,
    releaseManifest: fixture.releaseManifest,
    releaseManifestBytes: fixture.releaseManifestBytes,
    rawSamples: fixture.rawSamples,
    runtimeBytes: fixture.runtimeBytes,
    runtimeDescriptorBytes: fixture.runtimeDescriptorBytes,
    proofFiles: fixture.proofFiles,
  };
  assert.equal(verifySupportedProfileCapacityFailureEvidence(input).outcome, 'failure');
  assert.throws(
    () =>
      createSupportedProfileCapacityFailureEvidence({
        config: repository.config,
        root: repository.root,
        profileId: 'compact',
        sourceCommit: '0'.repeat(40),
        gitTree: repository.gitTree,
        releaseManifest: fixture.releaseManifest,
        releaseManifestBytes: fixture.releaseManifestBytes,
        rawSamples: fixture.rawSamples,
        topologyFingerprint: fixture.evidence.topologyFingerprint,
        targetBinding: fixture.evidence.targetBinding,
        runtimeBytes: fixture.runtimeBytes,
        runtimeDescriptorBytes: fixture.runtimeDescriptorBytes,
        proofFiles: fixture.proofFiles,
        reason: 'workload-execution-failed',
        errorSha256: sha256('safe failure reason'),
      }),
    /does not bind the exact committed Git config and tree/u,
  );
  const rawSubstitution = { ...input, rawSamples: [...input.rawSamples] };
  rawSubstitution.rawSamples[0] = mutateRawSample(rawSubstitution.rawSamples[0], (sample) => {
    sample.metrics.successfulReservationP95Ms += 1;
  });
  assert.throws(
    () => verifySupportedProfileCapacityFailureEvidence(rawSubstitution),
    /does not match config, runtime, proofs, or raw samples/u,
  );
  const badConfig = structuredClone(repository.config);
  badConfig.profiles[0].workload.maximumP95Ms += 1;
  assert.throws(
    () => verifySupportedProfileCapacityFailureEvidence({ ...input, config: badConfig }),
    /does not match the committed canonical config/u,
  );
  const badEvidence = structuredClone(fixture.evidence);
  badEvidence.sourceCommit = '0'.repeat(40);
  assert.throws(
    () =>
      verifySupportedProfileCapacityFailureEvidence({
        ...input,
        evidence: badEvidence,
        evidenceBytes: Buffer.from(`${canonicalJson(badEvidence)}\n`),
      }),
    /does not bind the exact committed Git config and tree/u,
  );
});

test('retains semantic verification for immutable legacy v2 claim evidence', () => {
  const fixture = gitRepositoryFixture();
  const profile = fixture.config.profiles[0];
  const evidence = createLegacySupportedProfileCapacityEvidence({
    ...creationInput(profile, fixture.config, fixture.root, fixture.commit, fixture.gitTree),
    rawSamples: fixture.samples,
    capacityClaim: capacityClaim(),
  });
  const evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`);
  assert.equal(evidence.schemaVersion, 'tixkit-supported-profile-capacity-evidence-v2');
  assert.equal(
    verifySupportedProfileCapacityEvidence({
      config: fixture.config,
      root: fixture.root,
      evidence,
      evidenceBytes,
      rawSamples: fixture.samples,
      releaseManifest: fixture.releaseManifest,
      releaseManifestBytes: fixture.releaseManifestBytes,
    }).validated,
    true,
  );
  const receipt = signedReceipt(evidenceBytes, (candidate) => {
    candidate.source.commit = fixture.commit;
    candidate.source.tree = fixture.gitTree;
  });
  assert.equal(
    verify(
      {
        ...fixture,
        evidence,
        evidenceBytes,
        samples: fixture.samples,
        receipt,
      },
      fixture.config,
      fixture.root,
    ).eligibleForReview,
    true,
  );
});
