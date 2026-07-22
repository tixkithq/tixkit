#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from './performance-profile-capacity.schema.json' with { type: 'json' };
import { publicReleaseManifestViolations } from './build-public-release-manifest.mjs';
import { verifyHostedTrustReceipt } from './lib/hosted-trust-receipt.mjs';
import { canonicalJson, sha256 } from './performance-evidence.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_VERSION = 'tixkit-supported-profile-capacity-config-v2';
const CONFIG_SCOPE = 'supported-profile-capacity-eligibility';
const LEGACY_EVIDENCE_VERSION = 'tixkit-supported-profile-capacity-evidence-v2';
const EVIDENCE_VERSION = 'tixkit-supported-profile-capacity-evidence-v3';
const EVIDENCE_SCOPE = 'supported-profile-capacity-characterization';
export const TOPOLOGY_FINGERPRINT_VERSION = 'tixkit-supported-profile-topology-v1';
const MAX_DEPLOYMENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SAMPLE_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_EVIDENCE_BYTES = 1024 * 1024;
const MAX_FAILURE_PROOF_FILES = 32;
const MAX_FAILURE_PROOF_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXTERNAL_HA_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EXTERNAL_HA_VALIDITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
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
  'worker, frontend, provider, Temporal, Redis, object-storage or host capacity',
  'relational database and dependency capacity are not independently characterized',
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

export function validateTopologyFingerprint(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(['sha256', 'version']) ||
    value.version !== TOPOLOGY_FINGERPRINT_VERSION ||
    !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '')
  ) {
    throw new Error('supported-profile topology fingerprint is malformed');
  }
  return Object.freeze({ version: value.version, sha256: value.sha256 });
}

export function createTopologyFingerprint(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('supported-profile topology descriptor must be an object');
  }
  return Object.freeze({
    version: TOPOLOGY_FINGERPRINT_VERSION,
    sha256: sha256(canonicalJson(descriptor)),
  });
}

export function createReviewedTopologyFingerprint(descriptor) {
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    descriptor.schemaVersion !== 'tixkit-supported-profile-runtime-descriptor-v1' ||
    !['compact', 'production'].includes(descriptor.profile)
  ) {
    throw new Error('supported-profile reviewed topology descriptor is malformed');
  }
  const reviewed = structuredClone(descriptor);
  if (reviewed.profile === 'production') {
    const digest = /^[a-f0-9]{64}$/u;
    const observations = [
      reviewed.cluster?.profileProofSha256,
      reviewed.api?.deploymentRevisionSha256,
      reviewed.api?.templateHashSha256,
      reviewed.api?.readyPodIdentitiesSha256,
      reviewed.worker?.deploymentRevisionSha256,
      reviewed.worker?.templateHashSha256,
      reviewed.worker?.readyPodIdentitiesSha256,
    ];
    if (observations.some((value) => !digest.test(value ?? ''))) {
      throw new Error('Production topology is missing exact runtime observations');
    }
    delete reviewed.cluster.profileProofSha256;
    for (const component of [reviewed.api, reviewed.worker]) {
      delete component.deploymentRevisionSha256;
      delete component.templateHashSha256;
      delete component.readyPodIdentitiesSha256;
    }
  }
  return createTopologyFingerprint(reviewed);
}

export function validateTargetBinding(value) {
  const digest = /^[a-f0-9]{64}$/u;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson([
        'apiImageDigest',
        'apiOriginSha256',
        'fixtureDeploymentSha256',
        'fixtureIdentityPublicKeySha256',
        'fixtureOriginSha256',
        'fixtureServiceArtifactSha256',
        'transport',
      ]) ||
    !['https', 'compact-loopback-http'].includes(value.transport) ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.apiImageDigest ?? '') ||
    !digest.test(value.apiOriginSha256 ?? '') ||
    !digest.test(value.fixtureDeploymentSha256 ?? '') ||
    !digest.test(value.fixtureIdentityPublicKeySha256 ?? '') ||
    !digest.test(value.fixtureOriginSha256 ?? '') ||
    !digest.test(value.fixtureServiceArtifactSha256 ?? '')
  ) {
    throw new Error('supported-profile target binding is malformed');
  }
  return Object.freeze({ ...value });
}

function boundOrigin(value, profile, label) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(`${label} must be a bounded absolute origin`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute origin`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowedHttp = profile === 'compact' && url.protocol === 'http:' && loopback;
  if (
    (url.protocol !== 'https:' && !allowedHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} transport or origin is unsupported`);
  }
  return { origin: url.origin, transport: allowedHttp ? 'compact-loopback-http' : 'https' };
}

export function createTargetBinding({
  profile,
  apiOrigin,
  fixtureOrigin,
  apiImageDigest,
  fixtureServiceArtifactSha256,
  fixtureDeploymentSha256,
  fixtureIdentityPublicKeyPem,
}) {
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(apiImageDigest ?? '') ||
    !/^[a-f0-9]{64}$/u.test(fixtureServiceArtifactSha256 ?? '') ||
    !/^[a-f0-9]{64}$/u.test(fixtureDeploymentSha256 ?? '') ||
    typeof fixtureIdentityPublicKeyPem !== 'string' ||
    fixtureIdentityPublicKeyPem.length > 8192
  ) {
    throw new Error('capacity target release or fixture identity is invalid');
  }
  let fixtureIdentityKey;
  try {
    fixtureIdentityKey = createPublicKey(fixtureIdentityPublicKeyPem);
  } catch {
    throw new Error('capacity fixture identity public key is invalid');
  }
  if (fixtureIdentityKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('capacity fixture identity public key must be Ed25519');
  }
  const api = boundOrigin(apiOrigin, profile, 'capacity API origin');
  const fixture = boundOrigin(fixtureOrigin, profile, 'capacity fixture origin');
  if (api.transport !== fixture.transport) {
    throw new Error('capacity API and fixture transports must use the same trust mode');
  }
  return validateTargetBinding({
    transport: api.transport,
    apiImageDigest,
    apiOriginSha256: sha256(api.origin),
    fixtureDeploymentSha256,
    fixtureIdentityPublicKeySha256: sha256(fixtureIdentityPublicKeyPem),
    fixtureOriginSha256: sha256(fixture.origin),
    fixtureServiceArtifactSha256,
  });
}

function exactOwnKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())
  ) {
    throw new Error(`${label} must use its closed public-safe schema`);
  }
}

function proofTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(timestamp) ||
    value.length > 64
  ) {
    throw new Error(`${label} must be a bounded RFC 3339 timestamp`);
  }
  return timestamp;
}

export function createCapacityProofProjection(
  kind,
  value,
  sourceSha256,
  { now = () => new Date() } = {},
) {
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256 ?? '')) {
    throw new Error('capacity proof source digest is invalid');
  }
  if (kind === 'fixture-service-artifact') {
    exactOwnKeys(
      value,
      ['schemaVersion', 'sourceCommit', 'deploymentSha256', 'identityPublicKeyPem'],
      'fixture service artifact',
    );
    if (
      value.schemaVersion !== 'tixkit-capacity-fixture-service-artifact-v1' ||
      !/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? '') ||
      !/^[a-f0-9]{64}$/u.test(value.deploymentSha256 ?? '')
    ) {
      throw new Error('fixture service artifact identity is invalid');
    }
    let key;
    try {
      key = createPublicKey(value.identityPublicKeyPem);
    } catch {
      throw new Error('fixture service artifact public key is invalid');
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('fixture service artifact public key must be Ed25519');
    }
    return Object.freeze({
      schemaVersion: value.schemaVersion,
      sourceCommit: value.sourceCommit,
      deploymentSha256: value.deploymentSha256,
      identityPublicKeyPem: value.identityPublicKeyPem,
      sourceSha256,
    });
  }
  if (kind === 'external-ha-attestation') {
    exactOwnKeys(
      value,
      ['schemaVersion', 'databaseEngine', 'topology', 'observedAt', 'expiresAt', 'evidenceSha256'],
      'external HA attestation',
    );
    const observedAt = proofTimestamp(value.observedAt, 'external HA observedAt');
    const expiresAt = proofTimestamp(value.expiresAt, 'external HA expiresAt');
    const current = now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new Error('external HA proof clock must return a valid Date');
    }
    const currentTime = current.getTime();
    if (
      value.schemaVersion !== 'tixkit-external-ha-attestation-v1' ||
      value.databaseEngine !== 'postgresql' ||
      value.topology !== 'external-high-availability' ||
      !/^[a-f0-9]{64}$/u.test(value.evidenceSha256 ?? '') ||
      expiresAt <= observedAt ||
      observedAt > currentTime ||
      expiresAt <= currentTime ||
      currentTime - observedAt > MAX_EXTERNAL_HA_OBSERVATION_AGE_MS ||
      expiresAt - observedAt > MAX_EXTERNAL_HA_VALIDITY_WINDOW_MS
    ) {
      throw new Error('external HA attestation identity or validity window is invalid');
    }
    return Object.freeze({
      schemaVersion: value.schemaVersion,
      databaseEngine: value.databaseEngine,
      topology: value.topology,
      observedAt: new Date(observedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      evidenceSha256: value.evidenceSha256,
      sourceSha256,
    });
  }
  if (kind === 'production-profile') {
    exactOwnKeys(
      value,
      [
        'schemaVersion',
        'drillId',
        'context',
        'cluster',
        'namespace',
        'namespaceUid',
        'release',
        'helmRelease',
        'startedAt',
        'completedAt',
        'disruptionPerformed',
        'before',
        'after',
        'disruptions',
      ],
      'Production profile proof',
    );
    const startedAt = proofTimestamp(value.startedAt, 'Production proof startedAt');
    const completedAt = proofTimestamp(value.completedAt, 'Production proof completedAt');
    if (
      value.schemaVersion !== 'tixkit-production-profile-proof-v1' ||
      typeof value.disruptionPerformed !== 'boolean' ||
      !Array.isArray(value.before) ||
      !Array.isArray(value.after) ||
      !Array.isArray(value.disruptions) ||
      completedAt < startedAt
    ) {
      throw new Error('Production profile proof identity is invalid');
    }
    return Object.freeze({
      schemaVersion: 'tixkit-production-profile-public-projection-v1',
      sourceSha256,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      disruptionPerformed: value.disruptionPerformed,
      clusterIdentitySha256: sha256(canonicalJson(value.cluster)),
      helmReleaseSha256: sha256(canonicalJson(value.helmRelease)),
      componentStateSha256: sha256(canonicalJson({ before: value.before, after: value.after })),
      disruptionsSha256: sha256(canonicalJson(value.disruptions)),
    });
  }
  throw new Error('capacity proof projection kind is unsupported');
}

export function validateObservedRuntime(
  value,
  profile,
  releaseImages,
  topologyFingerprint,
  targetBinding,
) {
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
    topologyFingerprint: validateTopologyFingerprint(topologyFingerprint),
    targetBinding: validateTargetBinding(targetBinding),
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
  topologyFingerprint,
  targetBinding,
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
    'fixtureSha256',
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
  if (
    previousCompletedAt !== undefined &&
    Date.parse(value.startedAt) < Date.parse(previousCompletedAt)
  ) {
    throw new Error('supported-profile raw sample intervals must not overlap');
  }
  validateObservedRuntime(
    value.runtime,
    profile,
    releaseImages,
    topologyFingerprint,
    targetBinding,
  );
  if (!/^[a-f0-9]{64}$/u.test(value.fixtureSha256 ?? '')) {
    throw new Error('supported-profile raw sample fixture identity is invalid');
  }
  const metrics = value.metrics;
  const expectedFields = [
    'attempts',
    'expectedInventoryDeclines',
    'finalHeld',
    'platformFailures',
    'reservationActiveLoadMs',
    'rounds',
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
  for (const name of [
    'attempts',
    'rounds',
    'successes',
    'expectedInventoryDeclines',
    'platformFailures',
    'reservationActiveLoadMs',
  ]) {
    if (!Number.isSafeInteger(metrics[name])) throw new Error(`${name} must be a safe integer`);
  }
  if (
    metrics.attempts !== expectedConcurrency * metrics.rounds ||
    metrics.attempts !==
      metrics.successes + metrics.expectedInventoryDeclines + metrics.platformFailures
  ) {
    throw new Error('supported-profile raw sample accounting or duration is invalid');
  }
  const maximumSuccesses =
    Math.min(profile.workload.inventory, expectedConcurrency) * metrics.rounds;
  if (metrics.successes > maximumSuccesses) throw new Error('supported-profile sample oversold');
  const maximumExpectedDeclines =
    Math.max(0, expectedConcurrency - profile.workload.inventory) * metrics.rounds;
  if (metrics.expectedInventoryDeclines > maximumExpectedDeclines) {
    throw new Error('supported-profile inventory decline occurred before inventory exhaustion');
  }
  if (
    metrics.expectedInventoryDeclines > 0 &&
    metrics.successes !== profile.workload.inventory * metrics.rounds
  ) {
    throw new Error('supported-profile inventory decline requires exact inventory exhaustion');
  }
  if (metrics.finalHeld !== metrics.successes || metrics.finalHeld > maximumSuccesses) {
    throw new Error('supported-profile final inventory reconciliation is invalid');
  }
  return {
    raw,
    sequence: value.sequence,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    elapsedMs: value.elapsedMs,
    runtime: value.runtime,
    fixtureSha256: value.fixtureSha256,
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
  topologyFingerprint,
  targetBinding,
  legacy = false,
}) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new Error('supported-profile evidence requires an exact 40-character Git SHA');
  }
  if (!/^[a-f0-9]{40}$/u.test(gitTree)) {
    throw new Error('supported-profile evidence requires an exact Git tree ID');
  }
  const release = validateReleaseManifest(releaseManifest, releaseManifestBytes, sourceCommit);
  const frozenTopologyFingerprint = validateTopologyFingerprint(topologyFingerprint);
  const frozenTargetBinding = validateTargetBinding(targetBinding);
  const expectedCount =
    profile.workload.concurrencyPoints.length * profile.workload.samplesPerPoint;
  if (!Array.isArray(rawSamples) || rawSamples.length !== expectedCount) {
    throw new Error('supported-profile raw sample count does not match the workload');
  }
  const samples = [];
  const fixtureIdentities = new Set();
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
        frozenTopologyFingerprint,
        frozenTargetBinding,
      );
      if (fixtureIdentities.has(parsed.fixtureSha256)) {
        throw new Error('supported-profile samples require fresh unique fixture identity');
      }
      fixtureIdentities.add(parsed.fixtureSha256);
      samples.push({
        sequence: parsed.sequence,
        concurrency,
        sample,
        startedAt: parsed.startedAt,
        completedAt: parsed.completedAt,
        elapsedMs: parsed.elapsedMs,
        runtime: parsed.runtime,
        fixtureSha256: parsed.fixtureSha256,
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
  const activeLoadMs = samples.reduce(
    (total, sample) => total + sample.metrics.reservationActiveLoadMs,
    0,
  );
  if (activeLoadMs < profile.workload.minimumDurationSeconds * 1000) {
    throw new Error('supported-profile active load duration is below the committed minimum');
  }
  const activeLoadSeconds = activeLoadMs / 1000;
  let capacityAssessment;
  let resolvedCapacityClaim;
  if (legacy) {
    const maxConcurrency = capacityClaim?.maxPublishableConcurrency;
    const saturationConcurrency = capacityClaim?.saturationObservedAtConcurrency;
    const points = profile.workload.concurrencyPoints;
    if (
      !Number.isSafeInteger(maxConcurrency) ||
      !Number.isSafeInteger(saturationConcurrency) ||
      !points.includes(maxConcurrency) ||
      !points.includes(saturationConcurrency) ||
      points.indexOf(saturationConcurrency) !== points.indexOf(maxConcurrency) + 1 ||
      capacityClaim?.surface !== 'api-checkout-reservation' ||
      capacityClaim?.dependencyScope !==
        'runtime-topology-bound-dependencies-not-independently-characterized' ||
      capacityClaim?.hostCapacity !== 'not-characterized'
    ) {
      throw new Error(
        'supported-profile capacity claim must bind adjacent tested saturation points',
      );
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
      throw new Error(
        'supported-profile saturation point did not exhibit a bounded failure signal',
      );
    }
    resolvedCapacityClaim = capacityClaim;
  } else {
    const assessment = deriveCapacityAssessment(profile, samples);
    if (
      capacityClaim !== undefined &&
      canonicalJson(capacityClaim) !== canonicalJson(assessment.capacityClaim)
    ) {
      throw new Error(
        'supported-profile supplied capacity claim does not match derived measurements',
      );
    }
    capacityAssessment = assessment.capacityAssessment;
    resolvedCapacityClaim = assessment.capacityClaim;
  }
  const payload = {
    schemaVersion: legacy ? LEGACY_EVIDENCE_VERSION : EVIDENCE_VERSION,
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
    topologyFingerprint: frozenTopologyFingerprint,
    targetBinding: frozenTargetBinding,
    resourcesSha256: sha256(canonicalJson(profile.resources)),
    workloadSha256: sha256(canonicalJson(profile.workload)),
    startedAt,
    completedAt,
    durationSeconds,
    activeLoadSeconds,
    samples,
    capacityClaim: resolvedCapacityClaim,
  };
  if (!legacy) payload.capacityAssessment = capacityAssessment;
  return payload;
}

function objectiveSatisfied(profile, sample) {
  return (
    sample.metrics.platformFailures === 0 &&
    sample.metrics.successfulReservationP95Ms <= profile.workload.maximumP95Ms
  );
}

export function deriveCapacityAssessment(profile, samples) {
  const points = profile?.workload?.concurrencyPoints;
  if (!Array.isArray(points) || !Array.isArray(samples)) {
    throw new Error('supported-profile capacity assessment requires validated profile samples');
  }
  const failingPointIndex = points.findIndex((concurrency) =>
    samples.some(
      (sample) => sample.concurrency === concurrency && !objectiveSatisfied(profile, sample),
    ),
  );
  if (failingPointIndex === -1) {
    return Object.freeze({
      capacityAssessment: Object.freeze({
        status: 'no-claim',
        reason: 'saturation-not-observed',
        evaluatedConcurrencyPoints: [...points],
        objectiveViolatingConcurrency: null,
      }),
      capacityClaim: null,
    });
  }
  const objectiveViolatingConcurrency = points[failingPointIndex];
  if (failingPointIndex === 0) {
    return Object.freeze({
      capacityAssessment: Object.freeze({
        status: 'no-claim',
        reason: 'first-point-objective-failed',
        evaluatedConcurrencyPoints: [...points],
        objectiveViolatingConcurrency,
      }),
      capacityClaim: null,
    });
  }
  const maxPublishableConcurrency = points[failingPointIndex - 1];
  return Object.freeze({
    capacityAssessment: Object.freeze({
      status: 'claim',
      reason: 'saturation-observed',
      evaluatedConcurrencyPoints: [...points],
      objectiveViolatingConcurrency,
    }),
    capacityClaim: Object.freeze({
      surface: 'api-checkout-reservation',
      dependencyScope: 'runtime-topology-bound-dependencies-not-independently-characterized',
      hostCapacity: 'not-characterized',
      maxPublishableConcurrency,
      saturationObservedAtConcurrency: objectiveViolatingConcurrency,
    }),
  });
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

export function createLegacySupportedProfileCapacityEvidence(input) {
  validateSupportedProfileCapacityConfig(input.config, { root: input.root });
  const profile = input.config.profiles.find(({ id }) => id === input.profileId);
  if (!profile) throw new Error('legacy supported-profile capacity profile is absent from config');
  const payload = evidencePayload({ ...input, profile, legacy: true });
  return { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
}

function completedFailureSamples({ profile, rawSamples }) {
  const maximumSamples =
    profile.workload.concurrencyPoints.length * profile.workload.samplesPerPoint;
  if (!Array.isArray(rawSamples) || rawSamples.length > maximumSamples) {
    throw new Error('supported-profile failure evidence has too many completed raw samples');
  }
  return rawSamples.map((rawSample, index) => {
    const raw = Buffer.from(rawSample);
    canonicalInput(raw, `supported-profile failure raw sample ${index + 1}`, MAX_SAMPLE_BYTES);
    return { sequence: index + 1, rawSha256: sha256(raw) };
  });
}

function failureProofs(proofFiles) {
  if (
    !Array.isArray(proofFiles) ||
    proofFiles.length < 1 ||
    proofFiles.length > MAX_FAILURE_PROOF_FILES
  ) {
    throw new Error('supported-profile failure evidence requires bounded proof files');
  }
  const paths = new Set();
  return proofFiles
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !/^[a-z0-9][a-z0-9._-]{0,127}\.json$/u.test(entry.path ?? '') ||
        paths.has(entry.path)
      ) {
        throw new Error('supported-profile failure proof path is invalid');
      }
      paths.add(entry.path);
      const value = canonicalInput(
        entry.bytes,
        `supported-profile failure proof ${entry.path}`,
        MAX_FAILURE_PROOF_FILE_BYTES,
      );
      return { path: entry.path, sha256: sha256(canonicalJson(value)) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function failureRuntime({
  runtimeBytes,
  runtimeDescriptorBytes,
  releaseImages,
  topologyFingerprint,
  targetBinding,
}) {
  const runtime = canonicalInput(
    runtimeBytes,
    'supported-profile failure runtime',
    MAX_RUNTIME_EVIDENCE_BYTES,
  );
  const descriptor = canonicalInput(
    runtimeDescriptorBytes,
    'supported-profile failure runtime descriptor',
    MAX_RUNTIME_EVIDENCE_BYTES,
  );
  if (
    !runtime ||
    typeof runtime !== 'object' ||
    Array.isArray(runtime) ||
    canonicalJson(runtime.images) !== canonicalJson(releaseImages) ||
    canonicalJson(runtime.topologyFingerprint) !== canonicalJson(topologyFingerprint) ||
    canonicalJson(runtime.targetBinding) !== canonicalJson(targetBinding) ||
    !descriptor ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor) ||
    descriptor.schemaVersion !== 'tixkit-supported-profile-observed-topology-v1' ||
    canonicalJson(descriptor.observation?.targetBinding) !== canonicalJson(targetBinding) ||
    canonicalJson(createTopologyFingerprint(descriptor)) !== canonicalJson(topologyFingerprint)
  ) {
    throw new Error(
      'supported-profile failure runtime evidence does not bind the observed topology',
    );
  }
  return {
    runtimeSha256: sha256(Buffer.from(runtimeBytes)),
    runtimeDescriptorSha256: sha256(Buffer.from(runtimeDescriptorBytes)),
  };
}

function failureEvidencePayload({
  config,
  profile,
  sourceCommit,
  gitTree,
  releaseManifest,
  releaseManifestBytes,
  rawSamples,
  topologyFingerprint,
  targetBinding,
  runtimeBytes,
  runtimeDescriptorBytes,
  proofFiles,
  reason,
  errorSha256,
}) {
  if (!['workload-execution-failed', 'evidence-validation-failed'].includes(reason)) {
    throw new Error('supported-profile failure reason is not classified');
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^[a-f0-9]{40}$/u.test(gitTree)) {
    throw new Error('supported-profile failure evidence requires exact Git identities');
  }
  if (!/^[a-f0-9]{64}$/u.test(errorSha256 ?? '')) {
    throw new Error('supported-profile failure evidence requires a redacted error checksum');
  }
  const release = validateReleaseManifest(releaseManifest, releaseManifestBytes, sourceCommit);
  const frozenTopologyFingerprint = validateTopologyFingerprint(topologyFingerprint);
  const frozenTargetBinding = validateTargetBinding(targetBinding);
  const runtime = failureRuntime({
    runtimeBytes,
    runtimeDescriptorBytes,
    releaseImages: release.images,
    topologyFingerprint: frozenTopologyFingerprint,
    targetBinding: frozenTargetBinding,
  });
  return {
    schemaVersion: EVIDENCE_VERSION,
    claimScope: EVIDENCE_SCOPE,
    denials: [...EVIDENCE_DENIALS],
    integrityModel: 'checksums-plus-hosted-Ed25519-receipt',
    outcome: 'failure',
    reason,
    sourceCommit,
    gitTree,
    configSha256: sha256(canonicalJson(config)),
    releaseManifestSha256: release.sha256,
    images: release.images,
    profile: profile.id,
    deploymentManifestSha256: profile.deployment.manifestSha256,
    database: profile.database,
    topologyFingerprint: frozenTopologyFingerprint,
    targetBinding: frozenTargetBinding,
    runtime,
    proofs: failureProofs(proofFiles),
    samples: completedFailureSamples({ profile, rawSamples }),
    errorSha256,
  };
}

export function createSupportedProfileCapacityFailureEvidence(input) {
  const repository = committedEligibilityContext(input.root, input.config);
  if (
    input.sourceCommit !== repository.sourceCommit ||
    input.gitTree !== repository.gitTree ||
    sha256(canonicalJson(input.config)) !== repository.configSha256
  ) {
    throw new Error(
      'capacity failure evidence does not bind the exact committed Git config and tree',
    );
  }
  const profile = repository.config.profiles.find(({ id }) => id === input.profileId);
  if (!profile) throw new Error('supported-profile failure profile is absent from config');
  const payload = failureEvidencePayload({ ...input, config: repository.config, profile });
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  schemaViolation(evidence, 'supported-profile capacity failure evidence');
  return evidence;
}

export function verifySupportedProfileCapacityFailureEvidence(input) {
  const repository = committedEligibilityContext(input.root, input.config);
  if (
    input.evidence?.sourceCommit !== repository.sourceCommit ||
    input.evidence?.gitTree !== repository.gitTree ||
    input.evidence?.configSha256 !== repository.configSha256
  ) {
    throw new Error(
      'capacity failure evidence does not bind the exact committed Git config and tree',
    );
  }
  validateSupportedProfileCapacityConfig(input.config, { root: input.root });
  schemaViolation(input.evidence, 'supported-profile capacity failure evidence');
  const evidenceBytes = Buffer.from(input.evidenceBytes);
  if (evidenceBytes.length < 1 || evidenceBytes.length > MAX_EVIDENCE_BYTES) {
    throw new Error('supported-profile capacity failure evidence exceeds bounded size');
  }
  if (!evidenceBytes.equals(Buffer.from(`${canonicalJson(input.evidence)}\n`))) {
    throw new Error(
      'supported-profile capacity failure evidence bytes must be canonical and exact',
    );
  }
  if (input.evidence.outcome !== 'failure') {
    throw new Error('supported-profile failure verifier requires a failure envelope');
  }
  const profile = input.config.profiles.find(({ id }) => id === input.evidence.profile);
  const payload = failureEvidencePayload({
    config: input.config,
    profile,
    sourceCommit: input.evidence.sourceCommit,
    gitTree: input.evidence.gitTree,
    releaseManifest: input.releaseManifest,
    releaseManifestBytes: input.releaseManifestBytes,
    rawSamples: input.rawSamples,
    topologyFingerprint: input.evidence.topologyFingerprint,
    targetBinding: input.evidence.targetBinding,
    runtimeBytes: input.runtimeBytes,
    runtimeDescriptorBytes: input.runtimeDescriptorBytes,
    proofFiles: input.proofFiles,
    reason: input.evidence.reason,
    errorSha256: input.evidence.errorSha256,
  });
  const expected = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  if (canonicalJson(expected) !== canonicalJson(input.evidence)) {
    throw new Error(
      'supported-profile failure evidence does not match config, runtime, proofs, or raw samples',
    );
  }
  return Object.freeze({
    validated: true,
    outcome: 'failure',
    profile: input.evidence.profile,
    sourceCommit: input.evidence.sourceCommit,
    evidenceSha256: input.evidence.evidenceSha256,
  });
}

function canonicalUtcTimestamp(date, label) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error(`${label} must return a valid Date`);
  }
  return date.toISOString();
}

export async function executeSupportedProfileCapacitySample({
  profile,
  releaseImages,
  topologyFingerprint,
  targetBinding,
  sequence,
  concurrency,
  executeWorkload,
  clock = { wallNow: () => new Date(), monotonicNow: () => performance.now() },
}) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('supported-profile sample sequence must be a positive integer');
  }
  if (!profile.workload.concurrencyPoints.includes(concurrency)) {
    throw new Error('supported-profile sample concurrency is not configured');
  }
  if (typeof executeWorkload !== 'function') {
    throw new Error('supported-profile workload executor is required');
  }
  const fingerprint = validateTopologyFingerprint(topologyFingerprint);
  const startedAt = canonicalUtcTimestamp(clock.wallNow(), 'sample wall clock');
  const monotonicStart = clock.monotonicNow();
  const result = await executeWorkload({ concurrency, inventory: profile.workload.inventory });
  const monotonicEnd = clock.monotonicNow();
  const elapsedMs = Math.max(1, Math.ceil(monotonicEnd - monotonicStart));
  if (
    !Number.isFinite(monotonicStart) ||
    !Number.isFinite(monotonicEnd) ||
    monotonicEnd < monotonicStart
  ) {
    throw new Error('supported-profile sample monotonic clock is invalid');
  }
  const completedAt = new Date(Date.parse(startedAt) + elapsedMs).toISOString();
  const raw = {
    sequence,
    startedAt,
    completedAt,
    elapsedMs,
    runtime: {
      profile: profile.id,
      deploymentManifestSha256: profile.deployment.manifestSha256,
      database: profile.database,
      api: { ...profile.resources.api, imageDigest: releaseImages.api },
      worker: { ...profile.resources.worker, imageDigest: releaseImages.worker },
      topologyFingerprint: fingerprint,
      targetBinding: validateTargetBinding(targetBinding),
    },
    fixtureSha256: result?.fixtureSha256,
    metrics: result?.metrics,
  };
  return Buffer.from(`${canonicalJson(raw)}\n`);
}

export function verifySupportedProfileCapacityEvidence(input) {
  if (input.evidence?.claimScope === 'trusted-single-host-capacity-characterization') {
    throw new Error('trusted-single-host evidence cannot establish supported-profile capacity');
  }
  validateSupportedProfileCapacityConfig(input.config, { root: input.root });
  const evidenceBytes = Buffer.from(input.evidenceBytes);
  if (evidenceBytes.length < 1 || evidenceBytes.length > MAX_EVIDENCE_BYTES) {
    throw new Error('supported-profile capacity evidence exceeds bounded size');
  }
  const canonicalBytes = Buffer.from(`${canonicalJson(input.evidence)}\n`);
  if (!evidenceBytes.equals(canonicalBytes)) {
    throw new Error('supported-profile capacity evidence bytes must be canonical and exact');
  }
  const legacy = input.evidence?.schemaVersion === LEGACY_EVIDENCE_VERSION;
  if (!legacy) schemaViolation(input.evidence, 'supported-profile capacity evidence');
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
    topologyFingerprint: input.evidence.topologyFingerprint,
    targetBinding: input.evidence.targetBinding,
    legacy,
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
  if (
    input.evidence.schemaVersion !== LEGACY_EVIDENCE_VERSION &&
    (input.evidence.capacityAssessment?.status !== 'claim' || input.evidence.capacityClaim === null)
  ) {
    throw new Error('no-claim capacity evidence is not eligible for review');
  }
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
