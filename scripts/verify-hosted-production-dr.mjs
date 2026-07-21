#!/usr/bin/env node

import { createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOSTED_TRUST_ARTIFACT_MAX_BYTES,
  HOSTED_TRUST_CLOCK_SKEW_MS,
  HOSTED_TRUST_KEYRING_MAX_BYTES,
  HOSTED_TRUST_MAX_AGE_MS,
  HOSTED_TRUST_RECEIPT_MAX_BYTES,
  canonicalHostedTrustJson,
  hostedTrustReceiptSigningBytes,
  parseCanonicalHostedTrustJson,
  readBoundedRegularFile,
  sha256,
} from './lib/hosted-trust-receipt.mjs';
import { verifyProductionRehearsal } from './verify-production-rehearsal.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const receiptSchema = 'https://tixkit.com/schemas/hosted-production-dr-receipt.schema.json';
const protectedSourcePaths = Object.freeze([
  '.github/workflows/production-dr.yml',
  'distribution/hosted-production-dr-receipt.schema.json',
  'distribution/hosted-trust-keyring.schema.json',
  'distribution/hosted-trust-receipt.schema.json',
  'distribution/public-distribution.schema.json',
  'infra/production/rehearsal-expectations.schema.json',
  'infra/production/rehearsal-proof.schema.json',
  'scripts/lib/hosted-trust-receipt.mjs',
  'scripts/lib/public-distribution.mjs',
  'scripts/create-hosted-production-dr-receipt.mjs',
  'scripts/prepare-production-dr-workflow.mjs',
  'scripts/stage-production-dr-bundle.mjs',
  'scripts/verify-hosted-production-dr.mjs',
  'scripts/verify-production-rehearsal.mjs',
]);
const MAX_PROTECTED_SOURCE_BYTES = 2 * 1024 * 1024;
const contract = Object.freeze({
  trustRecordId: 'dr-evidence',
  scope: 'self-hosted',
  artifactKind: 'production-dr',
  workflow: '.github/workflows/production-dr.yml',
  validator: 'scripts/verify-production-rehearsal.mjs#verifyProductionRehearsal',
});
const inputLimits = Object.freeze({
  signature: 1_024,
  checksum: 1_024,
  publicKey: 16 * 1_024,
  expectations: 1024 * 1_024,
});
const allowedArguments = new Set([
  '--evidence',
  '--signature',
  '--checksum',
  '--public-key',
  '--expectations',
  '--receipt',
  '--trusted-keyring',
]);

function exactObject(value, keys, label) {
  const ownKeys = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.map(String).sort().join(',') !== [...keys].sort().join(',') ||
    ownKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function safeGit(root, arguments_) {
  return execFileSync('/usr/bin/git', ['-C', root, ...arguments_], {
    encoding: 'utf8',
    env: {
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: process.env.HOME ?? '/tmp',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function safeGitBytes(root, arguments_) {
  return execFileSync('/usr/bin/git', ['-C', root, ...arguments_], {
    env: {
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: process.env.HOME ?? '/tmp',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
    },
    maxBuffer: MAX_PROTECTED_SOURCE_BYTES + 1,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function authoritativeSource(root) {
  const canonicalRoot = realpathSync(resolve(root));
  if (canonicalRoot !== realpathSync(repositoryRoot)) {
    throw new Error('hosted production DR verification must use its own repository checkout');
  }
  const topLevel = realpathSync(safeGit(canonicalRoot, ['rev-parse', '--show-toplevel']));
  if (topLevel !== canonicalRoot) {
    throw new Error('hosted production DR verification root must be the Git top level');
  }
  const commit = safeGit(canonicalRoot, ['rev-parse', '--verify', 'HEAD']);
  const tree = safeGit(canonicalRoot, ['rev-parse', '--verify', `${commit}^{tree}`]);
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new Error('authoritative Git source identity is invalid');
  }
  const status = safeGit(canonicalRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...protectedSourcePaths,
  ]);
  if (status !== '') {
    throw new Error('hosted production DR verifier source must be clean and tracked');
  }
  for (const path of protectedSourcePaths) {
    safeGit(canonicalRoot, ['ls-files', '--error-unmatch', '--', path]);
    const flags = safeGit(canonicalRoot, ['ls-files', '-v', '--', path]);
    if (flags !== `H ${path}`) {
      throw new Error(`hosted production DR verifier source has hidden index flags: ${path}`);
    }
    const actual = readBoundedRegularFile(
      resolve(canonicalRoot, path),
      `hosted production DR verifier source ${path}`,
      MAX_PROTECTED_SOURCE_BYTES,
    );
    const committed = safeGitBytes(canonicalRoot, ['show', `${commit}:${path}`]);
    if (!actual.equals(committed)) {
      throw new Error(`hosted production DR verifier source differs from ${commit}: ${path}`);
    }
  }
  const finalCommit = safeGit(canonicalRoot, ['rev-parse', '--verify', 'HEAD']);
  if (finalCommit !== commit) {
    throw new Error('authoritative Git HEAD changed during hosted production DR verification');
  }
  return Object.freeze({ commit, tree });
}

function trustedReceiptKey(keyring, keyId) {
  exactObject(keyring, ['schemaVersion', 'purpose', 'keys'], 'hosted production DR keyring');
  if (keyring.schemaVersion !== 1 || keyring.purpose !== 'tixkit.hosted-trust-receipt') {
    throw new Error('hosted production DR keyring purpose or version is invalid');
  }
  exactObject(keyring.keys, Object.keys(keyring.keys), 'hosted production DR keyring keys');
  const entries = Object.entries(keyring.keys);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error('hosted production DR keyring must contain 1-16 keys');
  }
  for (const [candidateId, candidate] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(candidateId)) {
      throw new Error('hosted production DR key ID is invalid');
    }
    exactObject(candidate, ['algorithm', 'publicKeyPem'], 'hosted production DR key');
    if (
      candidate.algorithm !== 'Ed25519' ||
      typeof candidate.publicKeyPem !== 'string' ||
      candidate.publicKeyPem.length < 1 ||
      candidate.publicKeyPem.length > 1_024 ||
      /PRIVATE KEY/u.test(candidate.publicKeyPem)
    ) {
      throw new Error('hosted production DR key is invalid');
    }
    const candidateKey = createPublicKey(candidate.publicKeyPem);
    if (
      candidateKey.asymmetricKeyType !== 'ed25519' ||
      String(candidateKey.export({ type: 'spki', format: 'pem' })) !== candidate.publicKeyPem
    ) {
      throw new Error('hosted production DR key must be canonical Ed25519 SPKI PEM');
    }
  }
  if (!Object.hasOwn(keyring.keys, keyId)) {
    throw new Error('hosted production DR receipt signature key is not trusted');
  }
  const trusted = keyring.keys[keyId];
  return createPublicKey(trusted.publicKeyPem);
}

function canonicalEd25519PublicKey(bytes, label) {
  let key;
  try {
    key = createPublicKey(bytes);
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} must be Ed25519`);
  }
  return key;
}

function verifyDedicatedReceipt({
  receipt,
  evidenceBytes,
  proofPublicKeyBytes,
  expectationsBytes,
  keyring,
  source,
  now,
  completedAt,
}) {
  exactObject(
    receipt,
    [
      '$schema',
      'schemaVersion',
      'kind',
      'trustRecordId',
      'scope',
      'source',
      'workflow',
      'artifact',
      'validation',
      'observedAt',
      'signature',
    ],
    'hosted production DR receipt',
  );
  exactObject(receipt.source, ['repository', 'commit', 'tree'], 'hosted production DR source');
  exactObject(
    receipt.workflow,
    ['repository', 'path', 'runId', 'attempt', 'url'],
    'hosted production DR workflow',
  );
  exactObject(receipt.artifact, ['kind', 'sizeBytes', 'sha256'], 'hosted production DR artifact');
  exactObject(
    receipt.validation,
    ['validator', 'version', 'outcome', 'expectationsSha256'],
    'hosted production DR validation',
  );
  exactObject(receipt.signature, ['algorithm', 'keyId', 'value'], 'hosted production DR signature');
  if (
    receipt.$schema !== receiptSchema ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'tixkit.hosted-production-dr-receipt' ||
    receipt.trustRecordId !== contract.trustRecordId ||
    receipt.scope !== contract.scope ||
    receipt.source.repository !== 'tixkit/tixkit' ||
    receipt.workflow.repository !== 'tixkit/tixkit' ||
    receipt.workflow.path !== contract.workflow ||
    receipt.artifact.kind !== contract.artifactKind ||
    receipt.validation.validator !== contract.validator ||
    receipt.validation.version !== 1 ||
    receipt.validation.outcome !== 'passed' ||
    receipt.validation.expectationsSha256 !== sha256(expectationsBytes)
  ) {
    throw new Error('hosted production DR receipt does not match the dedicated contract');
  }
  if (receipt.source.commit !== source.commit || receipt.source.tree !== source.tree) {
    throw new Error('hosted production DR receipt does not bind the authoritative checkout');
  }
  if (
    typeof receipt.workflow.runId !== 'string' ||
    !/^[1-9][0-9]{0,19}$/u.test(receipt.workflow.runId) ||
    !Number.isSafeInteger(receipt.workflow.attempt) ||
    receipt.workflow.attempt < 1 ||
    receipt.workflow.attempt > 100 ||
    receipt.workflow.url !==
      `https://github.com/tixkit/tixkit/actions/runs/${receipt.workflow.runId}`
  ) {
    throw new Error('hosted production DR workflow identity is invalid');
  }
  if (
    !Number.isSafeInteger(receipt.artifact.sizeBytes) ||
    receipt.artifact.sizeBytes !== evidenceBytes.byteLength ||
    receipt.artifact.sha256 !== sha256(evidenceBytes)
  ) {
    throw new Error('hosted production DR receipt does not bind the verified evidence bytes');
  }
  if (!Number.isSafeInteger(now)) throw new Error('verification clock must be a safe integer');
  const observed = canonicalTimestamp(receipt.observedAt, 'hosted production DR observedAt');
  const completed = canonicalTimestamp(completedAt, 'production rehearsal completedAt');
  if (observed < completed || observed - completed > 24 * 60 * 60 * 1_000) {
    throw new Error('hosted production DR observation must follow completion within 24 hours');
  }
  if (observed > now + HOSTED_TRUST_CLOCK_SKEW_MS || observed < now - HOSTED_TRUST_MAX_AGE_MS) {
    throw new Error('hosted production DR receipt is future-dated or stale');
  }
  if (
    receipt.signature.algorithm !== 'Ed25519' ||
    typeof receipt.signature.keyId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(receipt.signature.keyId) ||
    typeof receipt.signature.value !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(receipt.signature.value)
  ) {
    throw new Error('hosted production DR signature metadata is invalid');
  }
  const signature = Buffer.from(receipt.signature.value, 'base64');
  if (signature.byteLength !== 64 || signature.toString('base64') !== receipt.signature.value) {
    throw new Error('hosted production DR signature encoding is invalid');
  }
  const publicKey = trustedReceiptKey(keyring, receipt.signature.keyId);
  const proofPublicKey = canonicalEd25519PublicKey(
    proofPublicKeyBytes,
    'production evidence signing key',
  );
  const receiptFingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  const proofFingerprint = sha256(proofPublicKey.export({ type: 'spki', format: 'der' }));
  if (receiptFingerprint === proofFingerprint) {
    throw new Error('production evidence and hosted receipt must use distinct signing keys');
  }
  if (!verify(null, hostedTrustReceiptSigningBytes(receipt), publicKey, signature)) {
    throw new Error('hosted production DR receipt signature is invalid');
  }
  return Object.freeze({ workflowRunId: receipt.workflow.runId, observedAt: receipt.observedAt });
}

export function verifyHostedProductionDr({
  evidenceBytes,
  signatureBytes,
  checksumBytes,
  publicKeyBytes,
  expectationsBytes,
  receipt,
  keyring,
  root = repositoryRoot,
  now = Date.now(),
}) {
  if (!Buffer.isBuffer(evidenceBytes)) {
    throw new Error('hosted production DR evidence must be bytes');
  }
  const semantic = verifyProductionRehearsal({
    evidenceBytes,
    signatureBytes,
    checksumBytes,
    publicKeyBytes,
    expectationsBytes,
  });
  const source = authoritativeSource(root);
  const hosted = verifyDedicatedReceipt({
    receipt,
    evidenceBytes,
    proofPublicKeyBytes: publicKeyBytes,
    expectationsBytes,
    keyring,
    source,
    now,
    completedAt: semantic.completedAt,
  });
  return Object.freeze({
    eligibleForReview: true,
    drillId: semantic.drillId,
    kind: semantic.kind,
    sourceCommit: source.commit,
    sourceTree: source.tree,
    evidenceSha256: semantic.evidenceSha256,
    workflowRunId: hosted.workflowRunId,
    observedAt: hosted.observedAt,
  });
}

function argumentsFrom(argv) {
  if (argv.length !== allowedArguments.size * 2) {
    throw new Error(
      '--evidence, --signature, --checksum, --public-key, --expectations, --receipt, and --trusted-keyring are required exactly once',
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('hosted production DR arguments are missing, duplicated, or unsupported');
    }
    const absolute = resolve(value);
    values.set(name, resolve(realpathSync(dirname(absolute)), basename(absolute)));
  }
  return Object.fromEntries(values);
}

export function verifyHostedProductionDrCli(argv = process.argv.slice(2)) {
  const values = argumentsFrom(argv);
  const evidenceBytes = readBoundedRegularFile(
    values['--evidence'],
    'hosted production DR evidence',
    HOSTED_TRUST_ARTIFACT_MAX_BYTES,
  );
  return verifyHostedProductionDr({
    evidenceBytes,
    signatureBytes: readBoundedRegularFile(
      values['--signature'],
      'production evidence signature',
      inputLimits.signature,
    ),
    checksumBytes: readBoundedRegularFile(
      values['--checksum'],
      'production evidence checksum',
      inputLimits.checksum,
    ),
    publicKeyBytes: readBoundedRegularFile(
      values['--public-key'],
      'production evidence public key',
      inputLimits.publicKey,
    ),
    expectationsBytes: readBoundedRegularFile(
      values['--expectations'],
      'production rehearsal expectations',
      inputLimits.expectations,
    ),
    receipt: parseCanonicalHostedTrustJson(
      readBoundedRegularFile(
        values['--receipt'],
        'hosted production DR receipt',
        HOSTED_TRUST_RECEIPT_MAX_BYTES,
      ),
      'hosted production DR receipt',
    ),
    keyring: parseCanonicalHostedTrustJson(
      readBoundedRegularFile(
        values['--trusted-keyring'],
        'hosted production DR keyring',
        HOSTED_TRUST_KEYRING_MAX_BYTES,
      ),
      'hosted production DR keyring',
    ),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = verifyHostedProductionDrCli();
    process.stdout.write(`${canonicalHostedTrustJson(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
