#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedRegularFile, sha256 } from './lib/hosted-trust-receipt.mjs';
import { verifyProductionRehearsal } from './verify-production-rehearsal.mjs';

const allowedArguments = new Set([
  '--evidence-dir',
  '--drill-id',
  '--kind',
  '--dependency',
  '--config',
  '--config-sha256',
  '--expectations',
  '--expectations-sha256',
  '--public-key',
  '--public-key-sha256',
  '--stage-output',
]);
const maximum = Object.freeze({
  evidence: 64 * 1024 * 1024,
  signature: 1_024,
  checksum: 1_024,
  config: 1024 * 1024,
  expectations: 1024 * 1024,
  publicKey: 16 * 1024,
});

function argumentsFrom(argv) {
  if (argv.length !== allowedArguments.size * 2) {
    throw new Error('production DR bundle arguments are missing or duplicated');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowedArguments.has(name) || !value || value.startsWith('--') || values.has(name)) {
      throw new Error('production DR bundle arguments are missing, duplicated, or unsupported');
    }
    const absolute =
      name.startsWith('--') &&
      ['--evidence-dir', '--config', '--expectations', '--public-key', '--stage-output'].includes(
        name,
      )
        ? resolve(value)
        : value;
    values.set(name, absolute);
  }
  return Object.fromEntries(values);
}

function directDirectory(path, label, { empty = false } = {}) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid() ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error(`${label} must be a direct runner-owned directory`);
  }
  if (empty && readdirSync(path).length !== 0) throw new Error(`${label} must be empty`);
}

function exactDirectoryEntries(path, expected, label) {
  const actual = readdirSync(path).sort();
  if (actual.join('\n') !== [...expected].sort().join('\n')) {
    throw new Error(`${label} contains missing or additional files`);
  }
}

function directBytes(path, label, maxBytes) {
  const metadata = lstatSync(path);
  if (metadata.nlink !== 1 || metadata.uid !== process.getuid()) {
    throw new Error(`${label} must be a single-link runner-owned file`);
  }
  return readBoundedRegularFile(path, label, maxBytes);
}

function copyExclusive(path, bytes) {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o400,
  );
  try {
    fchmodSync(descriptor, 0o400);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error('production DR bundle write made no progress');
      }
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function stageProductionDrBundle(argv = process.argv.slice(2)) {
  const values = argumentsFrom(argv);
  const drillId = values['--drill-id'];
  const kind = values['--kind'];
  const dependency = values['--dependency'];
  if (!/^[a-z0-9](?:[-a-z0-9]{0,62})$/u.test(drillId)) {
    throw new Error('production DR bundle drill ID is invalid');
  }
  if (!['zone-loss', 'dependency-loss', 'release-upgrade-rollback'].includes(kind)) {
    throw new Error('production DR bundle kind is invalid');
  }
  if (!['none', 'postgres', 'mysql', 'redis', 'temporal', 'object-storage'].includes(dependency)) {
    throw new Error('production DR bundle dependency is invalid');
  }
  for (const name of ['config', 'expectations', 'public-key']) {
    if (!/^[a-f0-9]{64}$/u.test(values[`--${name}-sha256`])) {
      throw new Error(`production DR bundle ${name} digest is invalid`);
    }
  }
  const evidenceDirectory = resolve(realpathSync(values['--evidence-dir']));
  directDirectory(evidenceDirectory, 'production DR evidence directory');
  const evidenceName = `${drillId}.json`;
  const configPath = resolve(realpathSync(values['--config']));
  const expectationsPath = resolve(realpathSync(values['--expectations']));
  const publicKeyPath = resolve(realpathSync(values['--public-key']));
  const inputParents = [configPath, expectationsPath, publicKeyPath].map(dirname);
  const bundledInputs = inputParents.every((parent) => parent === evidenceDirectory);
  if (!bundledInputs && inputParents.some((parent) => parent === evidenceDirectory)) {
    throw new Error('production DR reviewed inputs must be wholly inside or outside the bundle');
  }
  exactDirectoryEntries(
    evidenceDirectory,
    [
      evidenceName,
      `${evidenceName}.sig`,
      `${evidenceName}.sha256`,
      ...(bundledInputs ? ['config.json', 'expectations.json', 'proof-public-key.pem'] : []),
    ],
    'production DR evidence directory',
  );
  const evidenceBytes = directBytes(
    resolve(evidenceDirectory, evidenceName),
    'production DR evidence',
    maximum.evidence,
  );
  const signatureBytes = directBytes(
    resolve(evidenceDirectory, `${evidenceName}.sig`),
    'production DR proof signature',
    maximum.signature,
  );
  const checksumBytes = directBytes(
    resolve(evidenceDirectory, `${evidenceName}.sha256`),
    'production DR proof checksum',
    maximum.checksum,
  );
  const configBytes = directBytes(configPath, 'production DR config', maximum.config);
  const expectationsBytes = directBytes(
    expectationsPath,
    'production DR expectations',
    maximum.expectations,
  );
  const publicKeyBytes = directBytes(
    publicKeyPath,
    'production DR proof public key',
    maximum.publicKey,
  );
  if (
    sha256(configBytes) !== values['--config-sha256'] ||
    sha256(expectationsBytes) !== values['--expectations-sha256'] ||
    sha256(publicKeyBytes) !== values['--public-key-sha256']
  ) {
    throw new Error('production DR bundle reviewed input digest mismatch');
  }
  const config = JSON.parse(configBytes);
  const proof = JSON.parse(evidenceBytes);
  if (
    config.drillId !== drillId ||
    config.kind !== kind ||
    (config.dependency ?? 'none') !== dependency ||
    proof.drillId !== drillId ||
    proof.kind !== kind ||
    (proof.dependency ?? 'none') !== dependency
  ) {
    throw new Error('production DR bundle identity does not match the approved dispatch');
  }
  verifyProductionRehearsal({
    evidenceBytes,
    signatureBytes,
    checksumBytes,
    publicKeyBytes,
    expectationsBytes,
  });
  const output = resolve(values['--stage-output']);
  directDirectory(output, 'production DR staged bundle', { empty: true });
  const files = new Map([
    [evidenceName, evidenceBytes],
    [`${evidenceName}.sig`, signatureBytes],
    [`${evidenceName}.sha256`, checksumBytes],
    ['config.json', configBytes],
    ['expectations.json', expectationsBytes],
    ['proof-public-key.pem', publicKeyBytes],
  ]);
  for (const [name, bytes] of files) copyExclusive(resolve(output, name), bytes);
  exactDirectoryEntries(output, files.keys(), 'production DR staged bundle');
  return Object.freeze({
    directory: output,
    drillId,
    kind,
    dependency,
    evidenceSha256: sha256(evidenceBytes),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(stageProductionDrBundle())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
