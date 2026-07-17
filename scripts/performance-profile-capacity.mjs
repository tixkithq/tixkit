#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './performance-profile-capacity.schema.json' with { type: 'json' };
import { publicReleaseManifestViolations } from './build-public-release-manifest.mjs';
import { verifyHostedTrustReceipt } from './lib/hosted-trust-receipt.mjs';
import { canonicalJson, sha256 } from './performance-evidence.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_VERSION = 'tixkit-supported-profile-capacity-config-v1';
const CONFIG_SCOPE = 'supported-profile-capacity-eligibility';
const EVIDENCE_VERSION = 'tixkit-supported-profile-capacity-evidence-v1';
const EVIDENCE_SCOPE = 'supported-profile-capacity-characterization';
const MAX_DEPLOYMENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SAMPLE_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const CONFIG_DENIALS = Object.freeze([
  'capacity proof without profile-scoped hosted evidence',
  'Cloud capacity',
  'SLA or SLO attainment',
  'soak stability',
  'fault tolerance',
]);
const EVIDENCE_DENIALS = Object.freeze([
  'Cloud capacity',
  'SLA or SLO attainment',
  'soak stability',
  'fault tolerance',
]);
const ajv = new Ajv2020({ strict: true, formats: { 'date-time': true } });
const validateSchema = ajv.compile(schema);

function schemaViolation(value, kind) {
  if (validateSchema(value)) return;
  const details = validateSchema.errors
    ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`${kind} schema violation: ${details ?? 'unknown error'}`);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function readDeploymentFile(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!isWithin(root, absolute))
    throw new Error(`deployment file escapes repository: ${relativePath}`);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`deployment file must be a direct regular file: ${relativePath}`);
  }
  if (metadata.size < 1 || metadata.size > MAX_DEPLOYMENT_FILE_BYTES) {
    throw new Error(`deployment file exceeds bounded size: ${relativePath}`);
  }
  const canonical = realpathSync(absolute);
  if (!isWithin(root, canonical) || canonical !== absolute) {
    throw new Error(`deployment file contains symbolic-link indirection: ${relativePath}`);
  }
  const bytes = readFileSync(absolute);
  const after = lstatSync(absolute);
  if (
    bytes.length !== metadata.size ||
    metadata.dev !== after.dev ||
    metadata.ino !== after.ino ||
    metadata.size !== after.size ||
    metadata.mtimeMs !== after.mtimeMs ||
    metadata.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`deployment file changed while being read: ${relativePath}`);
  }
  return bytes;
}

function canonicalInput(bytes, label, maximumBytes) {
  const input = Buffer.from(bytes);
  if (input.length < 1 || input.length > maximumBytes) {
    throw new Error(`${label} exceeds bounded size`);
  }
  let value;
  try {
    value = JSON.parse(input.toString('utf8'));
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (input.toString('utf8') !== `${canonicalJson(value)}\n`) {
    throw new Error(`${label} must use canonical JSON`);
  }
  return value;
}

function validateReleaseManifest(releaseManifest, releaseManifestBytes, sourceCommit) {
  const parsed = canonicalInput(
    releaseManifestBytes,
    'public release manifest',
    MAX_RELEASE_MANIFEST_BYTES,
  );
  if (canonicalJson(parsed) !== canonicalJson(releaseManifest)) {
    throw new Error('public release manifest object does not match its canonical bytes');
  }
  const violations = publicReleaseManifestViolations(parsed);
  if (violations.length > 0) {
    throw new Error(`public release manifest is invalid: ${violations.join('; ')}`);
  }
  if (parsed.core.sourceCommit !== sourceCommit) {
    throw new Error('public release manifest source commit does not match capacity evidence');
  }
  const images = new Map();
  for (const image of parsed.core.images) {
    if (images.has(image.name)) throw new Error(`public release manifest duplicates ${image.name}`);
    if (image.reference !== `ghcr.io/tixkit/tixkit-${image.name}@${image.digest}`) {
      throw new Error(`public release manifest ${image.name} reference is not authoritative`);
    }
    images.set(image.name, image.digest);
  }
  if (!images.has('api') || !images.has('worker')) {
    throw new Error('public release manifest must contain exact API and worker images');
  }
  return {
    sha256: sha256(Buffer.from(releaseManifestBytes)),
    images: { api: images.get('api'), worker: images.get('worker') },
  };
}

export function deploymentManifest(root, files) {
  const canonicalRoot = realpathSync(path.resolve(root));
  const identities = new Set();
  const entries = files.map((file) => {
    const absolute = path.resolve(canonicalRoot, file);
    const relativeIdentity = path.relative(canonicalRoot, absolute);
    if (relativeIdentity === '..' || relativeIdentity.startsWith(`..${path.sep}`)) {
      throw new Error(`deployment file path escapes repository: ${file}`);
    }
    const identity = relativeIdentity.split(path.sep).join('/');
    if (identity !== file || identities.has(identity)) {
      throw new Error(`deployment file path must be canonical and unique: ${file}`);
    }
    identities.add(identity);
    return { path: file, sha256: sha256(readDeploymentFile(canonicalRoot, file)) };
  });
  return Object.freeze({ entries, sha256: sha256(canonicalJson(entries)) });
}

export function validateSupportedProfileCapacityConfig(config, { root = repositoryRoot } = {}) {
  schemaViolation(config, 'supported-profile capacity config');
  if (
    config.schemaVersion !== CONFIG_VERSION ||
    config.claimScope !== CONFIG_SCOPE ||
    canonicalJson(config.denials) !== canonicalJson(CONFIG_DENIALS)
  ) {
    throw new Error('supported-profile capacity config authority drifted');
  }
  if (
    canonicalJson(config.profiles.map(({ id }) => id)) !== canonicalJson(['compact', 'production'])
  ) {
    throw new Error(
      'supported-profile capacity config requires compact then production exactly once',
    );
  }
  for (const profile of config.profiles) {
    const expectedKind = profile.id === 'compact' ? 'compact-compose' : 'production-helm';
    const expectedTopology =
      profile.id === 'compact' ? 'bundled-single-instance' : 'external-high-availability';
    if (
      profile.deployment.kind !== expectedKind ||
      profile.database.topology !== expectedTopology ||
      profile.database.engine !== 'postgresql'
    ) {
      throw new Error(`${profile.id} deployment or datastore topology is unsupported`);
    }
    for (let index = 1; index < profile.workload.concurrencyPoints.length; index += 1) {
      if (
        profile.workload.concurrencyPoints[index] <= profile.workload.concurrencyPoints[index - 1]
      ) {
        throw new Error(`${profile.id} concurrency points must be strictly increasing`);
      }
    }
    if (
      !profile.workload.concurrencyPoints.includes(profile.workload.inventory) ||
      !profile.workload.concurrencyPoints.some((value) => value > profile.workload.inventory)
    ) {
      throw new Error(`${profile.id} workload must test exact inventory and a saturation point`);
    }
    const manifest = deploymentManifest(root, profile.deployment.files);
    if (manifest.sha256 !== profile.deployment.manifestSha256) {
      throw new Error(`${profile.id} deployment manifest digest does not match repository inputs`);
    }
  }
  return config;
}

function canonicalTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function validateObservedRuntime(value, profile, releaseImages) {
  const imagePattern = /^sha256:[a-f0-9]{64}$/u;
  const images = { api: value?.api?.imageDigest, worker: value?.worker?.imageDigest };
  if (!imagePattern.test(images.api ?? '') || !imagePattern.test(images.worker ?? '')) {
    throw new Error('supported-profile raw sample runtime requires exact image digests');
  }
  if (canonicalJson(images) !== canonicalJson(releaseImages)) {
    throw new Error('supported-profile raw sample runtime images do not match the public release');
  }
  const expected = {
    profile: profile.id,
    deploymentManifestSha256: profile.deployment.manifestSha256,
    database: profile.database,
    api: { ...profile.resources.api, imageDigest: images.api },
    worker: { ...profile.resources.worker, imageDigest: images.worker },
  };
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(
      'supported-profile raw sample runtime identity does not match the committed profile',
    );
  }
  return images;
}

function parseRawSample(
  bytes,
  profile,
  expectedConcurrency,
  expectedSequence,
  previousCompletedAt,
  releaseImages,
) {
  const raw = Buffer.from(bytes);
  if (raw.length < 1 || raw.length > MAX_SAMPLE_BYTES) {
    throw new Error('supported-profile raw sample exceeds bounded size');
  }
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('supported-profile raw sample must be valid JSON');
  }
  if (raw.toString('utf8') !== `${canonicalJson(value)}\n`) {
    throw new Error('supported-profile raw sample must use canonical JSON');
  }
  const expectedSampleFields = [
    'completedAt',
    'elapsedMs',
    'metrics',
    'runtime',
    'sequence',
    'startedAt',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedSampleFields)
  ) {
    throw new Error('supported-profile raw sample fields are incomplete');
  }
  if (value.sequence !== expectedSequence) {
    throw new Error('supported-profile raw sample sequence is not canonical');
  }
  const started = canonicalTimestamp(value.startedAt, 'supported-profile sample startedAt');
  const completed = canonicalTimestamp(value.completedAt, 'supported-profile sample completedAt');
  if (
    completed <= started ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs !== completed - started
  ) {
    throw new Error('supported-profile raw sample elapsed time does not match its timestamps');
  }
  if (previousCompletedAt !== undefined && value.startedAt !== previousCompletedAt) {
    throw new Error(
      'supported-profile raw sample intervals must be contiguous without gaps or overlap',
    );
  }
  validateObservedRuntime(value.runtime, profile, releaseImages);
  const metrics = value.metrics;
  const expectedFields = [
    'attempts',
    'expectedInventoryDeclines',
    'platformFailures',
    'successes',
    'successfulReservationP95Ms',
  ];
  if (
    !metrics ||
    typeof metrics !== 'object' ||
    Array.isArray(metrics) ||
    canonicalJson(Object.keys(metrics).sort()) !== canonicalJson(expectedFields)
  ) {
    throw new Error('supported-profile raw sample metric fields are incomplete');
  }
  for (const [name, value] of Object.entries(metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`supported-profile raw sample ${name} must be finite and non-negative`);
    }
  }
  for (const name of ['attempts', 'successes', 'expectedInventoryDeclines', 'platformFailures']) {
    if (!Number.isSafeInteger(metrics[name])) throw new Error(`${name} must be a safe integer`);
  }
  if (
    metrics.attempts !== expectedConcurrency ||
    metrics.attempts !==
      metrics.successes + metrics.expectedInventoryDeclines + metrics.platformFailures
  ) {
    throw new Error('supported-profile raw sample accounting or duration is invalid');
  }
  const maximumSuccesses = Math.min(profile.workload.inventory, expectedConcurrency);
  if (metrics.successes > maximumSuccesses) throw new Error('supported-profile sample oversold');
  const maximumExpectedDeclines = Math.max(0, expectedConcurrency - profile.workload.inventory);
  if (metrics.expectedInventoryDeclines > maximumExpectedDeclines) {
    throw new Error('supported-profile inventory decline occurred before inventory exhaustion');
  }
  if (metrics.expectedInventoryDeclines > 0 && metrics.successes !== profile.workload.inventory) {
    throw new Error('supported-profile inventory decline requires exact inventory exhaustion');
  }
  return {
    raw,
    sequence: value.sequence,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    elapsedMs: value.elapsedMs,
    runtime: value.runtime,
    metrics,
  };
}

function evidencePayload({
  config,
  profile,
  sourceCommit,
  gitTree,
  releaseManifest,
  releaseManifestBytes,
  rawSamples,
  capacityClaim,
}) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error('supported-profile evidence requires an exact 40-character Git SHA');
  }
  if (!/^[a-f0-9]{40}$/u.test(gitTree)) {
    throw new Error('supported-profile evidence requires an exact Git tree ID');
  }
  const release = validateReleaseManifest(releaseManifest, releaseManifestBytes, sourceCommit);
  const expectedCount =
    profile.workload.concurrencyPoints.length * profile.workload.samplesPerPoint;
  if (!Array.isArray(rawSamples) || rawSamples.length !== expectedCount) {
    throw new Error('supported-profile raw sample count does not match the workload');
  }
  const samples = [];
  let rawIndex = 0;
  let previousCompletedAt;
  for (const concurrency of profile.workload.concurrencyPoints) {
    for (let sample = 1; sample <= profile.workload.samplesPerPoint; sample += 1) {
      const parsed = parseRawSample(
        rawSamples[rawIndex],
        profile,
        concurrency,
        rawIndex + 1,
        previousCompletedAt,
        release.images,
      );
      samples.push({
        sequence: parsed.sequence,
        concurrency,
        sample,
        startedAt: parsed.startedAt,
        completedAt: parsed.completedAt,
        elapsedMs: parsed.elapsedMs,
        runtime: parsed.runtime,
        rawSha256: sha256(parsed.raw),
        metrics: parsed.metrics,
      });
      previousCompletedAt = parsed.completedAt;
      rawIndex += 1;
    }
  }
  const startedAt = samples[0].startedAt;
  const completedAt = samples.at(-1).completedAt;
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (durationMs % 1000 !== 0 || durationMs < profile.workload.minimumDurationSeconds * 1000) {
    throw new Error('supported-profile derived execution duration is below the committed minimum');
  }
  const durationSeconds = durationMs / 1000;
  const maxConcurrency = capacityClaim?.maxPublishableConcurrency;
  const saturationConcurrency = capacityClaim?.saturationObservedAtConcurrency;
  const points = profile.workload.concurrencyPoints;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    !Number.isSafeInteger(saturationConcurrency) ||
    !points.includes(maxConcurrency) ||
    !points.includes(saturationConcurrency) ||
    points.indexOf(saturationConcurrency) !== points.indexOf(maxConcurrency) + 1
  ) {
    throw new Error('supported-profile capacity claim must bind adjacent tested saturation points');
  }
  for (const entry of samples) {
    if (
      entry.concurrency <= maxConcurrency &&
      (entry.metrics.platformFailures !== 0 ||
        entry.metrics.successfulReservationP95Ms > profile.workload.maximumP95Ms)
    ) {
      throw new Error('publishable supported-profile sample violated its objective candidate');
    }
  }
  const saturationSamples = samples.filter(
    ({ concurrency }) => concurrency === saturationConcurrency,
  );
  if (
    saturationSamples.every(
      ({ metrics }) =>
        metrics.platformFailures === 0 &&
        metrics.successfulReservationP95Ms <= profile.workload.maximumP95Ms,
    )
  ) {
    throw new Error('supported-profile saturation point did not exhibit a bounded failure signal');
  }
  return {
    schemaVersion: EVIDENCE_VERSION,
    claimScope: EVIDENCE_SCOPE,
    denials: [...EVIDENCE_DENIALS],
    integrityModel: 'checksums-plus-hosted-Ed25519-receipt',
    sourceCommit,
    gitTree,
    configSha256: sha256(canonicalJson(config)),
    releaseManifestSha256: release.sha256,
    images: release.images,
    profile: profile.id,
    deploymentManifestSha256: profile.deployment.manifestSha256,
    database: profile.database,
    resourcesSha256: sha256(canonicalJson(profile.resources)),
    workloadSha256: sha256(canonicalJson(profile.workload)),
    startedAt,
    completedAt,
    durationSeconds,
    samples,
    capacityClaim,
  };
}

export function createSupportedProfileCapacityEvidence(input) {
  validateSupportedProfileCapacityConfig(input.config, { root: input.root });
  const profile = input.config.profiles.find(({ id }) => id === input.profileId);
  if (!profile) throw new Error('supported-profile capacity profile is absent from config');
  const payload = evidencePayload({ ...input, profile });
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  schemaViolation(evidence, 'supported-profile capacity evidence');
  return evidence;
}

export function verifySupportedProfileCapacityEvidence(input) {
  if (input.evidence?.claimScope === 'trusted-single-host-capacity-characterization') {
    throw new Error('trusted-single-host evidence cannot establish supported-profile capacity');
  }
  validateSupportedProfileCapacityConfig(input.config, { root: input.root });
  schemaViolation(input.evidence, 'supported-profile capacity evidence');
  const evidenceBytes = Buffer.from(input.evidenceBytes);
  if (evidenceBytes.length < 1 || evidenceBytes.length > MAX_EVIDENCE_BYTES) {
    throw new Error('supported-profile capacity evidence exceeds bounded size');
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(input.evidence)}\n`);
  if (!evidenceBytes.equals(canonicalBytes)) {
    throw new Error('supported-profile capacity evidence bytes must be canonical and exact');
  }
  const profile = input.config.profiles.find(({ id }) => id === input.evidence.profile);
  const expectedPayload = evidencePayload({
    config: input.config,
    profile,
    sourceCommit: input.evidence.sourceCommit,
    gitTree: input.evidence.gitTree,
    releaseManifest: input.releaseManifest,
    releaseManifestBytes: input.releaseManifestBytes,
    rawSamples: input.rawSamples,
    capacityClaim: input.evidence.capacityClaim,
  });
  const expected = {
    ...expectedPayload,
    evidenceSha256: sha256(canonicalJson(expectedPayload)),
  };
  if (canonicalJson(expected) !== canonicalJson(input.evidence)) {
    throw new Error('supported-profile evidence does not match config, raw samples, or checksum');
  }
  return Object.freeze({
    validated: true,
    profile: input.evidence.profile,
    sourceCommit: input.evidence.sourceCommit,
    deploymentManifestSha256: input.evidence.deploymentManifestSha256,
    evidenceSha256: input.evidence.evidenceSha256,
  });
}

function git(root, arguments_) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
}

function gitBytes(root, arguments_) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_DEPLOYMENT_FILE_BYTES + 1,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function committedEligibilityContext(root, suppliedConfig) {
  const canonicalRoot = realpathSync(path.resolve(root));
  const configPath = 'performance-capacity.supported-profiles.json';
  const sourceCommit = git(canonicalRoot, ['rev-parse', '--verify', 'HEAD']);
  const gitTree = git(canonicalRoot, ['rev-parse', '--verify', `${sourceCommit}^{tree}`]);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^[a-f0-9]{40}$/u.test(gitTree)) {
    throw new Error('capacity eligibility requires exact Git commit and tree identities');
  }
  const committedConfigBytes = gitBytes(canonicalRoot, ['show', `${sourceCommit}:${configPath}`]);
  let committedConfig;
  try {
    committedConfig = JSON.parse(committedConfigBytes.toString('utf8'));
  } catch {
    throw new Error('committed supported-profile capacity config must be valid JSON');
  }
  if (canonicalJson(committedConfig) !== canonicalJson(suppliedConfig)) {
    throw new Error('supplied capacity config does not match the committed canonical config');
  }
  const protectedPaths = [
    configPath,
    ...committedConfig.profiles.flatMap(({ deployment }) => deployment.files),
  ];
  for (const protectedPath of protectedPaths) {
    git(canonicalRoot, ['ls-files', '--error-unmatch', '--', protectedPath]);
    const worktreeBytes = readDeploymentFile(canonicalRoot, protectedPath);
    const committedBytes = gitBytes(canonicalRoot, ['show', `${sourceCommit}:${protectedPath}`]);
    if (!worktreeBytes.equals(committedBytes)) {
      throw new Error('capacity config and deployment inputs must exactly match the Git commit');
    }
  }
  const status = git(canonicalRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...protectedPaths,
  ]);
  if (status !== '') {
    throw new Error('capacity config and deployment inputs must be clean tracked Git files');
  }
  validateSupportedProfileCapacityConfig(committedConfig, { root: canonicalRoot });
  return {
    config: committedConfig,
    configSha256: sha256(canonicalJson(committedConfig)),
    sourceCommit,
    gitTree,
  };
}

export function verifySupportedProfileCapacityEligibility(input) {
  if (input.evidence?.claimScope === 'trusted-single-host-capacity-characterization') {
    throw new Error('trusted-single-host evidence cannot establish supported-profile capacity');
  }
  const repository = committedEligibilityContext(input.root, input.config);
  if (
    input.evidence.sourceCommit !== repository.sourceCommit ||
    input.evidence.gitTree !== repository.gitTree ||
    input.evidence.configSha256 !== repository.configSha256
  ) {
    throw new Error('capacity evidence does not bind the exact committed Git config and tree');
  }
  const validated = verifySupportedProfileCapacityEvidence({
    ...input,
    config: repository.config,
  });
  const receipt = verifyHostedTrustReceipt({
    receipt: input.receipt,
    artifactBytes: Buffer.from(input.evidenceBytes),
    keyring: input.keyring,
    options: input.options,
  });
  if (
    receipt.trustRecordId !== 'performance-evidence' ||
    receipt.artifactKind !== 'performance-profile-capacity' ||
    receipt.sourceCommit !== validated.sourceCommit ||
    input.receipt.source.tree !== repository.gitTree ||
    input.receipt.workflow.path !== '.github/workflows/performance-profile-capacity.yml' ||
    input.receipt.validation.validator !==
      'scripts/performance-profile-capacity.mjs#verifySupportedProfileCapacityEvidence'
  ) {
    throw new Error('hosted receipt does not bind the supported-profile capacity revision');
  }
  const observedAt = canonicalTimestamp(input.receipt.observedAt, 'hosted receipt observedAt');
  const completedAt = canonicalTimestamp(
    input.evidence.completedAt,
    'capacity evidence completedAt',
  );
  if (observedAt < completedAt || observedAt - completedAt > 24 * 60 * 60 * 1000) {
    throw new Error('hosted receipt observation time does not follow the capacity execution');
  }
  return Object.freeze({
    eligibleForReview: true,
    profile: validated.profile,
    sourceCommit: validated.sourceCommit,
    deploymentManifestSha256: validated.deploymentManifestSha256,
    evidenceSha256: validated.evidenceSha256,
    hostedReceiptSha256: receipt.artifactSha256,
  });
}

export function main(argv = process.argv.slice(2)) {
  const configPath =
    argv[0] ?? path.join(repositoryRoot, 'performance-capacity.supported-profiles.json');
  if (argv.length > 1) throw new Error('usage: performance-profile-capacity.mjs [config-path]');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  validateSupportedProfileCapacityConfig(config, { root: repositoryRoot });
  process.stdout.write(
    'Supported-profile capacity eligibility config is valid; no capacity proof is claimed.\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
