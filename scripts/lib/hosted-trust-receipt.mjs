import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSchemaViolations } from './public-distribution.mjs';

export const HOSTED_TRUST_RECEIPT_SCHEMA =
  'https://tixkit.com/schemas/hosted-trust-receipt.schema.json';
export const HOSTED_TRUST_RECEIPT_MAX_BYTES = 64 * 1024;
export const HOSTED_TRUST_KEYRING_MAX_BYTES = 256 * 1024;
export const HOSTED_TRUST_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const HOSTED_TRUST_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const HOSTED_TRUST_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../distribution/hosted-trust-receipt.schema.json', import.meta.url)),
    'utf8',
  ),
);

const contracts = Object.freeze({
  'performance-capacity': Object.freeze({
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    workflow: '.github/workflows/performance-capacity.yml',
    validator: 'scripts/performance-capacity.mjs#validateCapacityEvidence',
  }),
  'performance-profile-capacity': Object.freeze({
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    workflow: '.github/workflows/performance-profile-capacity.yml',
    validator: 'scripts/performance-profile-capacity.mjs#verifySupportedProfileCapacityEvidence',
  }),
  'performance-fault': Object.freeze({
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    workflow: '.github/workflows/performance-fault.yml',
    validator: 'scripts/performance-fault.mjs#validateFaultEvidence',
  }),
  'performance-soak': Object.freeze({
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    workflow: '.github/workflows/performance-soak.yml',
    validator: 'scripts/performance-soak.mjs#validateSoakEvidenceDirectory',
  }),
  'performance-temporal-fault': Object.freeze({
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    workflow: '.github/workflows/performance-temporal-fault.yml',
    validator: 'scripts/performance-temporal-fault.mjs#validateTemporalFaultEvidence',
  }),
  'performance-trends': Object.freeze({
    trustRecordId: 'performance-evidence',
    scope: 'public-core',
    workflow: '.github/workflows/performance-nightly.yml',
    validator: 'scripts/performance-trends.mjs#validateTrendEvidence',
  }),
  'production-dr': Object.freeze({
    trustRecordId: 'dr-evidence',
    scope: 'self-hosted',
    workflow: '.github/workflows/trusted-release-dry-run.yml',
    validator: 'scripts/verify-production-rehearsal.mjs#cli',
  }),
});

function plainJsonDataViolations(value, label) {
  const violations = [];
  const seen = new WeakSet();

  function visit(candidate, path) {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) violations.push(`${path} must contain a finite number`);
      return;
    }
    if (typeof candidate !== 'object') {
      violations.push(`${path} must contain only JSON data`);
      return;
    }
    if (seen.has(candidate)) {
      violations.push(`${path} must not contain cyclic references`);
      return;
    }
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        violations.push(`${path} must be an own-property plain JSON array`);
        return;
      }
      const keys = Reflect.ownKeys(candidate).filter((key) => key !== 'length');
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
            Number(key) >= candidate.length,
        ) ||
        keys.length !== candidate.length
      ) {
        violations.push(`${path} must be a dense JSON array without extra properties`);
        return;
      }
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          violations.push(`${path}[${index}] must be an enumerable own data property`);
          continue;
        }
        visit(descriptor.value, `${path}[${index}]`);
      }
      return;
    }

    if (Object.getPrototypeOf(candidate) !== Object.prototype) {
      violations.push(`${path} must be an own-property plain JSON object`);
      return;
    }
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string') {
        violations.push(`${path} must not contain symbol properties`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        violations.push(`${path}.${key} must be an enumerable own data property`);
        continue;
      }
      visit(descriptor.value, `${path}.${key}`);
    }
  }

  visit(value, label);
  return violations;
}

function requiredSchemaOwnPropertyViolations(value, rule, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const violations = [];
  for (const key of rule.required ?? []) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      violations.push(`${path}.${key} must be an enumerable own data property`);
    }
  }
  for (const [key, childRule] of Object.entries(rule.properties ?? {})) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && descriptor.enumerable) {
      violations.push(
        ...requiredSchemaOwnPropertyViolations(descriptor.value, childRule, `${path}.${key}`),
      );
    }
  }
  return violations;
}

function keyringRequiredOwnPropertyViolations(keyring) {
  if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring)) return [];
  const violations = [];
  for (const key of ['schemaVersion', 'purpose', 'keys']) {
    const descriptor = Object.getOwnPropertyDescriptor(keyring, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      violations.push(`trusted keyring.${key} must be an enumerable own data property`);
    }
  }
  const keysDescriptor = Object.getOwnPropertyDescriptor(keyring, 'keys');
  const keys = keysDescriptor && 'value' in keysDescriptor ? keysDescriptor.value : undefined;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return violations;
  for (const keyId of Object.keys(keys)) {
    const entryDescriptor = Object.getOwnPropertyDescriptor(keys, keyId);
    const entry = entryDescriptor && 'value' in entryDescriptor ? entryDescriptor.value : undefined;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    for (const field of ['algorithm', 'publicKeyPem']) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, field);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        violations.push(
          `trusted keyring.keys.${keyId}.${field} must be an enumerable own data property`,
        );
      }
    }
  }
  return violations;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Canonical JSON accepts only plain JSON values');
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
    .join(',')}}`;
}

export function canonicalHostedTrustJson(value) {
  return canonicalValue(value);
}

export function hostedTrustReceiptSigningBytes(receipt) {
  const violations = plainJsonDataViolations(receipt, 'hosted trust receipt');
  violations.push(...requiredSchemaOwnPropertyViolations(receipt, schema, 'hosted trust receipt'));
  if (violations.length > 0) {
    throw new TypeError(violations.join('\n'));
  }
  if (!receipt?.signature || typeof receipt.signature !== 'object') {
    throw new TypeError('Hosted trust receipt signature metadata is required');
  }
  const { value: _value, ...signature } = receipt.signature;
  return Buffer.from(canonicalHostedTrustJson({ ...receipt, signature }), 'utf8');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export function readBoundedRegularFile(path, label, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Hosted trust input byte limit must be a positive safe integer');
  }
  const absolute = resolve(path);
  const before = lstatSync(absolute, { throwIfNoEntry: false });
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if (before.size < 1 || before.size > maxBytes) {
    throw new Error(`${label} must contain 1-${maxBytes} bytes`);
  }
  const canonicalPath = realpathSync(absolute);
  if (canonicalPath !== absolute) {
    throw new Error(`${label} path must be canonical and contain no symbolic-link indirection`);
  }
  const bytes = readFileSync(absolute);
  const after = lstatSync(absolute);
  if (
    bytes.byteLength !== before.size ||
    !sameFile(before, after) ||
    realpathSync(absolute) !== canonicalPath
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
  return bytes;
}

export function parseCanonicalHostedTrustJson(bytes, label) {
  let value;
  const text = bytes.toString('utf8');
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  let canonical;
  try {
    canonical = canonicalHostedTrustJson(value);
  } catch {
    throw new Error(`${label} must contain only plain JSON values`);
  }
  if (text !== canonical && text !== `${canonical}\n`) {
    throw new Error(`${label} must use canonical JSON with unique fields`);
  }
  return value;
}

function keyringViolations(keyring) {
  const violations = [];
  if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring)) {
    return ['trusted keyring must be an object'];
  }
  const keys = Object.keys(keyring).sort();
  if (keys.join(',') !== 'keys,purpose,schemaVersion') {
    violations.push('trusted keyring must contain only keys, purpose, and schemaVersion');
  }
  if (keyring.schemaVersion !== 1) violations.push('trusted keyring schemaVersion must equal 1');
  if (keyring.purpose !== 'tixkit.hosted-trust-receipt') {
    violations.push('trusted keyring purpose is invalid');
  }
  if (!keyring.keys || typeof keyring.keys !== 'object' || Array.isArray(keyring.keys)) {
    violations.push('trusted keyring keys must be an object');
    return violations;
  }
  const entries = Object.entries(keyring.keys);
  if (entries.length < 1 || entries.length > 16) {
    violations.push('trusted keyring must contain 1-16 keys');
  }
  for (const [keyId, candidate] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)) {
      violations.push(`trusted keyring key ID is invalid: ${keyId}`);
      continue;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      violations.push(`trusted keyring entry must be an object: ${keyId}`);
      continue;
    }
    if (Object.keys(candidate).sort().join(',') !== 'algorithm,publicKeyPem') {
      violations.push(`trusted keyring entry has unexpected fields: ${keyId}`);
    }
    if (candidate.algorithm !== 'Ed25519') {
      violations.push(`trusted keyring entry algorithm must be Ed25519: ${keyId}`);
    }
    if (
      typeof candidate.publicKeyPem !== 'string' ||
      candidate.publicKeyPem.length > 1_024 ||
      /PRIVATE KEY/u.test(candidate.publicKeyPem)
    ) {
      violations.push(`trusted keyring entry public key is invalid: ${keyId}`);
      continue;
    }
    try {
      const key = createPublicKey(candidate.publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') {
        violations.push(`trusted keyring entry must contain an Ed25519 public key: ${keyId}`);
      }
    } catch {
      violations.push(`trusted keyring entry public key is invalid: ${keyId}`);
    }
  }
  return violations;
}

function canonicalTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function signatureBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength === 64 && bytes.toString('base64') === value ? bytes : undefined;
}

export function hostedTrustReceiptViolations(
  receipt,
  artifactBytes,
  keyring,
  { now = Date.now(), maxAgeMs = HOSTED_TRUST_MAX_AGE_MS } = {},
) {
  const inputViolations = plainJsonDataViolations(receipt, 'hosted trust receipt');
  inputViolations.push(...plainJsonDataViolations(keyring, 'trusted keyring'));
  if (inputViolations.length > 0) return [...new Set(inputViolations)].sort();
  inputViolations.push(
    ...requiredSchemaOwnPropertyViolations(receipt, schema, 'hosted trust receipt'),
    ...keyringRequiredOwnPropertyViolations(keyring),
  );
  if (inputViolations.length > 0) return [...new Set(inputViolations)].sort();
  const violations = jsonSchemaViolations(receipt, schema);
  if (violations.length > 0) return violations;
  if (!Buffer.isBuffer(artifactBytes)) violations.push('hosted trust artifact must be bytes');
  if (!Number.isSafeInteger(now)) violations.push('verification clock must be a safe integer');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > HOSTED_TRUST_MAX_AGE_MS) {
    violations.push('verification maximum age must be bounded to 90 days');
  }

  const contract = contracts[receipt.artifact.kind];
  if (
    !contract ||
    receipt.trustRecordId !== contract.trustRecordId ||
    receipt.scope !== contract.scope ||
    receipt.workflow.path !== contract.workflow ||
    receipt.validation.validator !== contract.validator
  ) {
    violations.push(
      'hosted trust receipt record, scope, workflow, artifact, and validator disagree',
    );
  }
  if (receipt.source.repository !== receipt.workflow.repository) {
    violations.push('hosted trust receipt repository bindings disagree');
  }
  if (
    receipt.workflow.url !==
    `https://github.com/${receipt.workflow.repository}/actions/runs/${receipt.workflow.runId}`
  ) {
    violations.push('hosted trust receipt workflow URL does not bind the exact run ID');
  }
  if (!Number.isSafeInteger(receipt.workflow.attempt) || receipt.workflow.attempt > 100) {
    violations.push('hosted trust receipt workflow attempt must be between 1 and 100');
  }
  if (
    !Number.isSafeInteger(receipt.artifact.sizeBytes) ||
    receipt.artifact.sizeBytes > HOSTED_TRUST_ARTIFACT_MAX_BYTES
  ) {
    violations.push('hosted trust receipt artifact size is invalid');
  }
  if (Buffer.isBuffer(artifactBytes)) {
    if (artifactBytes.byteLength !== receipt.artifact.sizeBytes) {
      violations.push('hosted trust receipt artifact size does not match the verified bytes');
    }
    if (sha256(artifactBytes) !== receipt.artifact.sha256) {
      violations.push('hosted trust receipt artifact digest does not match the verified bytes');
    }
  }

  const observedAt = canonicalTimestamp(receipt.observedAt);
  if (observedAt === undefined) {
    violations.push('hosted trust receipt observedAt must be a canonical UTC timestamp');
  } else if (Number.isSafeInteger(now) && Number.isSafeInteger(maxAgeMs)) {
    if (observedAt > now + HOSTED_TRUST_CLOCK_SKEW_MS) {
      violations.push('hosted trust receipt observedAt is in the future');
    }
    if (observedAt < now - maxAgeMs) {
      violations.push('hosted trust receipt is stale');
    }
  }

  violations.push(...keyringViolations(keyring));
  if (violations.length > 0) return [...new Set(violations)].sort();
  if (!Object.hasOwn(keyring.keys, receipt.signature.keyId)) {
    return ['hosted trust receipt signature key is not trusted'];
  }
  const trusted = keyring.keys[receipt.signature.keyId];
  const signature = signatureBytes(receipt.signature.value);
  if (!signature) return ['hosted trust receipt signature encoding is invalid'];
  const publicKey = createPublicKey(trusted.publicKeyPem);
  if (!verify(null, hostedTrustReceiptSigningBytes(receipt), publicKey, signature)) {
    return ['hosted trust receipt signature is invalid'];
  }
  return [];
}

export function verifyHostedTrustReceipt(input) {
  const violations = hostedTrustReceiptViolations(
    input.receipt,
    input.artifactBytes,
    input.keyring,
    input.options,
  );
  if (violations.length > 0) {
    throw new Error(`Hosted trust receipt validation failed:\n${violations.join('\n')}`);
  }
  return Object.freeze({
    verified: true,
    trustRecordId: input.receipt.trustRecordId,
    artifactKind: input.receipt.artifact.kind,
    artifactSha256: input.receipt.artifact.sha256,
    sourceCommit: input.receipt.source.commit,
    workflowRunId: input.receipt.workflow.runId,
    observedAt: input.receipt.observedAt,
  });
}

export function loadAndVerifyHostedTrustReceipt({
  receiptPath,
  artifactPath,
  keyringPath,
  options,
}) {
  const receipt = parseCanonicalHostedTrustJson(
    readBoundedRegularFile(receiptPath, 'hosted trust receipt', HOSTED_TRUST_RECEIPT_MAX_BYTES),
    'hosted trust receipt',
  );
  const keyring = parseCanonicalHostedTrustJson(
    readBoundedRegularFile(keyringPath, 'hosted trust keyring', HOSTED_TRUST_KEYRING_MAX_BYTES),
    'hosted trust keyring',
  );
  const artifactBytes = readBoundedRegularFile(
    artifactPath,
    'hosted trust artifact',
    HOSTED_TRUST_ARTIFACT_MAX_BYTES,
  );
  return verifyHostedTrustReceipt({ receipt, artifactBytes, keyring, options });
}
