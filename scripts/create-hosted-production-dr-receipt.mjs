#!/usr/bin/env node

import { createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOSTED_TRUST_ARTIFACT_MAX_BYTES,
  HOSTED_TRUST_KEYRING_MAX_BYTES,
  canonicalHostedTrustJson,
  hostedTrustReceiptSigningBytes,
  parseCanonicalHostedTrustJson,
  readBoundedRegularFile,
  sha256,
} from './lib/hosted-trust-receipt.mjs';
import { verifyHostedProductionDr } from './verify-hosted-production-dr.mjs';

const root = resolve(import.meta.dirname, '..');
const limits = Object.freeze({
  signature: 1_024,
  checksum: 1_024,
  publicKey: 16 * 1_024,
  expectations: 1024 * 1_024,
  privateKey: 16 * 1_024,
});
const allowedArguments = new Set([
  '--evidence',
  '--signature',
  '--checksum',
  '--public-key',
  '--expectations',
  '--receipt-private-key',
  '--receipt-key-id',
  '--trusted-keyring',
  '--run-id',
  '--run-attempt',
  '--output',
]);
const pathArguments = new Set([
  '--evidence',
  '--signature',
  '--checksum',
  '--public-key',
  '--expectations',
  '--receipt-private-key',
  '--trusted-keyring',
  '--output',
]);

function argumentsFrom(argv) {
  if (argv.length !== allowedArguments.size * 2) {
    throw new Error('hosted production DR receipt arguments are missing or duplicated');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error(
        'hosted production DR receipt arguments are missing, duplicated, or unsupported',
      );
    }
    if (pathArguments.has(name)) {
      const absolute = resolve(value);
      values.set(name, resolve(realpathSync(dirname(absolute)), basename(absolute)));
    } else {
      values.set(name, value);
    }
  }
  return Object.fromEntries(values);
}

function safeGit(arguments_) {
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

function writeExclusive(path, bytes) {
  const output = resolve(path);
  const parent = dirname(output);
  const parentMetadata = lstatSync(parent);
  if (
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    parentMetadata.uid !== process.getuid() ||
    realpathSync(parent) !== parent
  ) {
    throw new Error('hosted production DR receipt output parent must be a direct owned directory');
  }
  const descriptor = openSync(
    output,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    fchmodSync(descriptor, 0o400);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error('hosted production DR receipt write made no progress');
      }
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readPrivateKey(path) {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o177) !== 0 ||
    realpathSync(absolute) !== absolute
  ) {
    throw new Error('hosted production DR receipt private key must be a direct owner-only file');
  }
  return readBoundedRegularFile(
    absolute,
    'hosted production DR receipt private key',
    limits.privateKey,
  );
}

export function createHostedProductionDrReceipt(argv = process.argv.slice(2), now = Date.now()) {
  const values = argumentsFrom(argv);
  const runId = values['--run-id'];
  const runAttempt = Number(values['--run-attempt']);
  const keyId = values['--receipt-key-id'];
  if (!/^[1-9][0-9]{0,19}$/u.test(runId)) throw new Error('workflow run ID is invalid');
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 100) {
    throw new Error('workflow run attempt is invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)) {
    throw new Error('hosted receipt key ID is invalid');
  }
  if (!Number.isSafeInteger(now)) throw new Error('receipt clock must be a safe integer');
  const evidenceBytes = readBoundedRegularFile(
    resolve(values['--evidence']),
    'production DR evidence',
    HOSTED_TRUST_ARTIFACT_MAX_BYTES,
  );
  const signatureBytes = readBoundedRegularFile(
    resolve(values['--signature']),
    'production DR proof signature',
    limits.signature,
  );
  const checksumBytes = readBoundedRegularFile(
    resolve(values['--checksum']),
    'production DR proof checksum',
    limits.checksum,
  );
  const publicKeyBytes = readBoundedRegularFile(
    resolve(values['--public-key']),
    'production DR proof public key',
    limits.publicKey,
  );
  const expectationsBytes = readBoundedRegularFile(
    resolve(values['--expectations']),
    'production DR expectations',
    limits.expectations,
  );
  const keyring = parseCanonicalHostedTrustJson(
    readBoundedRegularFile(
      resolve(values['--trusted-keyring']),
      'hosted production DR trusted keyring',
      HOSTED_TRUST_KEYRING_MAX_BYTES,
    ),
    'hosted production DR trusted keyring',
  );
  const privateKey = createPrivateKey(readPrivateKey(values['--receipt-private-key']));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('hosted production DR receipt private key must be Ed25519');
  }
  const commit = safeGit(['rev-parse', '--verify', 'HEAD']);
  const tree = safeGit(['rev-parse', '--verify', `${commit}^{tree}`]);
  const receipt = {
    $schema: 'https://tixkit.com/schemas/hosted-production-dr-receipt.schema.json',
    schemaVersion: 1,
    kind: 'tixkit.hosted-production-dr-receipt',
    trustRecordId: 'dr-evidence',
    scope: 'self-hosted',
    source: { repository: 'tixkithq/tixkit', commit, tree },
    workflow: {
      repository: 'tixkithq/tixkit',
      path: '.github/workflows/production-dr.yml',
      runId,
      attempt: runAttempt,
      url: `https://github.com/tixkithq/tixkit/actions/runs/${runId}`,
    },
    artifact: {
      kind: 'production-dr',
      sizeBytes: evidenceBytes.byteLength,
      sha256: sha256(evidenceBytes),
    },
    validation: {
      validator: 'scripts/verify-production-rehearsal.mjs#verifyProductionRehearsal',
      version: 1,
      outcome: 'passed',
      expectationsSha256: sha256(expectationsBytes),
    },
    observedAt: new Date(now).toISOString(),
    signature: { algorithm: 'Ed25519', keyId, value: '' },
  };
  receipt.signature.value = sign(
    null,
    hostedTrustReceiptSigningBytes(receipt),
    privateKey,
  ).toString('base64');
  verifyHostedProductionDr({
    evidenceBytes,
    signatureBytes,
    checksumBytes,
    publicKeyBytes,
    expectationsBytes,
    receipt,
    keyring,
    root,
    now,
  });
  writeExclusive(
    resolve(values['--output']),
    Buffer.from(`${canonicalHostedTrustJson(receipt)}\n`),
  );
  return Object.freeze({
    output: resolve(values['--output']),
    evidenceSha256: receipt.artifact.sha256,
    observedAt: receipt.observedAt,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.stdout.write(`${canonicalHostedTrustJson(createHostedProductionDrReceipt())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
