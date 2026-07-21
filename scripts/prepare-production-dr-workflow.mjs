#!/usr/bin/env node

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const drillIdPattern = /^[a-z0-9](?:[-a-z0-9]{0,62})$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const allowedKinds = new Set(['zone-loss', 'dependency-loss', 'release-upgrade-rollback']);
const allowedDependencies = new Set([
  'none',
  'postgres',
  'mysql',
  'redis',
  'temporal',
  'object-storage',
]);
const adapterNames = Object.freeze([
  'baselineProbe',
  'inject',
  'duringProbe',
  'recover',
  'recoveredProbe',
]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactEnvironment(environment) {
  const required = [
    'TIXKIT_DR_DRILL_ID',
    'TIXKIT_DR_KIND',
    'TIXKIT_DR_DEPENDENCY',
    'TIXKIT_DR_CONFIG_SHA256',
    'TIXKIT_DR_EXPECTATIONS_SHA256',
    'TIXKIT_DR_PUBLIC_KEY_SHA256',
    'TIXKIT_PRODUCTION_DR_REVIEWED_ROOT',
    'TIXKIT_PRODUCTION_DR_PROOF_PRIVATE_KEY_PATH',
    'TIXKIT_PRODUCTION_DR_PROOF_PUBLIC_KEY_PATH',
    'RUNNER_TEMP',
    'GITHUB_ENV',
  ];
  const values = Object.fromEntries(
    required.map((name) => {
      const value = environment[name];
      if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.includes('\0') ||
        /[\r\n]/u.test(value)
      ) {
        fail(`${name} is required and must not contain control characters`);
      }
      return [name, value];
    }),
  );
  return Object.freeze(values);
}

function directDirectory(path, label, { ownerOnly = true } = {}) {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  ) {
    fail(`${label} must be a direct canonical directory`);
  }
  if (metadata.uid !== process.getuid()) fail(`${label} must be owned by the runner user`);
  if (ownerOnly && (metadata.mode & 0o077) !== 0)
    fail(`${label} must not be group/world accessible`);
  return resolve(path);
}

function directFile(
  path,
  label,
  { maximumBytes, ownerOnly = true, executable = false, privateKey = false } = {},
) {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const pathMetadata = lstatSync(path);
  if (pathMetadata.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    fail(`${label} must be a direct canonical file`);
  }
  const descriptor = openSync(path, flags);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid()) {
      fail(`${label} must be a single-link regular file owned by the runner user`);
    }
    if (before.size < 1 || before.size > maximumBytes) {
      fail(`${label} must contain 1-${maximumBytes} bytes`);
    }
    if (ownerOnly && (before.mode & 0o077) !== 0) {
      fail(`${label} must not be group/world accessible`);
    }
    if (privateKey && (before.mode & 0o177) !== 0) {
      fail(`${label} must use mode 0600 or stricter`);
    }
    if (executable && (before.mode & 0o100) === 0) fail(`${label} must be owner-executable`);
    if (pathMetadata.dev !== before.dev || pathMetadata.ino !== before.ino) {
      fail(`${label} changed before it was opened`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      fail(`${label} changed while it was read`);
    }
    return Object.freeze({ path: resolve(path), bytes });
  } finally {
    closeSync(descriptor);
  }
}

function appendGitHubEnvironment(path, output) {
  if (!isAbsolute(path)) fail('GitHub environment file must be an absolute path');
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid() ||
    metadata.size > 1024 * 1024 ||
    realpathSync(path) !== resolve(path)
  ) {
    fail('GitHub environment file must be a bounded direct runner-owned file');
  }
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      fail('GitHub environment file changed before it was opened');
    }
    const bytes = Buffer.from(output);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      if (!Number.isSafeInteger(written) || written <= 0) {
        fail('GitHub environment file write made no progress');
      }
      offset += written;
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function bundleFile(bundleRoot, candidate, label, options) {
  if (typeof candidate !== 'string' || candidate.length < 1 || isAbsolute(candidate)) {
    fail(`${label} must be a relative path inside the reviewed drill bundle`);
  }
  const path = resolve(bundleRoot, candidate);
  const fromRoot = relative(bundleRoot, path);
  if (
    fromRoot === '' ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    fail(`${label} escapes the reviewed drill bundle`);
  }
  return directFile(path, label, options);
}

function exactConfig(config, inputs, bundleRoot) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail('production DR config must be an object');
  }
  if (config.drillId !== inputs.drillId || config.kind !== inputs.kind) {
    fail('production DR dispatch identity does not match the reviewed config');
  }
  const configuredDependency = config.dependency ?? 'none';
  if (configuredDependency !== inputs.dependency) {
    fail('production DR dispatch dependency does not match the reviewed config');
  }
  if (
    inputs.kind === 'dependency-loss' ? inputs.dependency === 'none' : inputs.dependency !== 'none'
  ) {
    fail('production DR kind and dependency are inconsistent');
  }
  bundleFile(bundleRoot, config.beforeReleaseManifest, 'prior release manifest', {
    maximumBytes: 4 * 1024 * 1024,
  });
  if (inputs.kind === 'release-upgrade-rollback') {
    bundleFile(bundleRoot, config.targetReleaseManifest, 'target release manifest', {
      maximumBytes: 4 * 1024 * 1024,
    });
  } else if (config.targetReleaseManifest !== undefined) {
    fail('only a release rollback drill may select a target release manifest');
  }
  if (!config.adapters || typeof config.adapters !== 'object' || Array.isArray(config.adapters)) {
    fail('production DR config adapters are invalid');
  }
  for (const adapter of adapterNames) {
    bundleFile(bundleRoot, config.adapters[adapter], `production DR ${adapter} adapter`, {
      maximumBytes: 1024 * 1024,
      executable: true,
    });
  }
}

function keyPair(privateKeyBytes, publicKeyBytes) {
  const privateKey = createPrivateKey(privateKeyBytes);
  const derived = createPublicKey(privateKey);
  const published = createPublicKey(publicKeyBytes);
  if (privateKey.asymmetricKeyType !== 'ed25519' || published.asymmetricKeyType !== 'ed25519') {
    fail('production DR proof keys must be Ed25519');
  }
  const derivedBytes = derived.export({ type: 'spki', format: 'der' });
  const publishedBytes = published.export({ type: 'spki', format: 'der' });
  if (!Buffer.from(derivedBytes).equals(Buffer.from(publishedBytes))) {
    fail('production DR proof public key does not match the private key');
  }
}

export function prepareProductionDrWorkflow(environment = process.env) {
  const values = exactEnvironment(environment);
  const inputs = Object.freeze({
    drillId: values.TIXKIT_DR_DRILL_ID,
    kind: values.TIXKIT_DR_KIND,
    dependency: values.TIXKIT_DR_DEPENDENCY,
  });
  if (!drillIdPattern.test(inputs.drillId)) fail('production DR drill ID is invalid');
  if (!allowedKinds.has(inputs.kind)) fail('production DR kind is invalid');
  if (!allowedDependencies.has(inputs.dependency)) fail('production DR dependency is invalid');
  for (const [name, digest] of [
    ['config', values.TIXKIT_DR_CONFIG_SHA256],
    ['expectations', values.TIXKIT_DR_EXPECTATIONS_SHA256],
    ['public key', values.TIXKIT_DR_PUBLIC_KEY_SHA256],
  ]) {
    if (!sha256Pattern.test(digest)) fail(`production DR ${name} digest is invalid`);
  }

  const reviewedRoot = directDirectory(
    values.TIXKIT_PRODUCTION_DR_REVIEWED_ROOT,
    'production DR reviewed root',
  );
  const bundleRoot = directDirectory(
    join(reviewedRoot, inputs.drillId),
    'production DR reviewed drill bundle',
  );
  if (dirname(bundleRoot) !== reviewedRoot || basename(bundleRoot) !== inputs.drillId) {
    fail('production DR reviewed drill bundle identity is invalid');
  }
  const config = directFile(join(bundleRoot, 'config.json'), 'production DR config', {
    maximumBytes: 1024 * 1024,
  });
  const expectations = directFile(
    join(bundleRoot, 'expectations.json'),
    'production DR expectations',
    { maximumBytes: 1024 * 1024 },
  );
  const privateKey = directFile(
    values.TIXKIT_PRODUCTION_DR_PROOF_PRIVATE_KEY_PATH,
    'production DR proof private key',
    { maximumBytes: 16 * 1024, privateKey: true },
  );
  const publicKey = directFile(
    values.TIXKIT_PRODUCTION_DR_PROOF_PUBLIC_KEY_PATH,
    'production DR proof public key',
    { maximumBytes: 16 * 1024 },
  );
  if (
    sha256(config.bytes) !== values.TIXKIT_DR_CONFIG_SHA256 ||
    sha256(expectations.bytes) !== values.TIXKIT_DR_EXPECTATIONS_SHA256 ||
    sha256(publicKey.bytes) !== values.TIXKIT_DR_PUBLIC_KEY_SHA256
  ) {
    fail('production DR reviewed input digest mismatch');
  }
  let parsedConfig;
  try {
    parsedConfig = JSON.parse(config.bytes);
  } catch {
    fail('production DR config must be JSON');
  }
  exactConfig(parsedConfig, inputs, bundleRoot);
  keyPair(privateKey.bytes, publicKey.bytes);

  const runnerTemp = directDirectory(values.RUNNER_TEMP, 'runner temporary directory', {
    ownerOnly: false,
  });
  const evidenceDirectory = mkdtempSync(join(runnerTemp, 'tixkit-production-dr-'));
  chmodSync(evidenceDirectory, 0o700);
  const outputs = Object.freeze({
    TIXKIT_DR_CONFIG_PATH: config.path,
    TIXKIT_DR_EXPECTATIONS_PATH: expectations.path,
    TIXKIT_DR_PRIVATE_KEY_PATH: privateKey.path,
    TIXKIT_DR_PUBLIC_KEY_PATH: publicKey.path,
    TIXKIT_DR_EVIDENCE_DIR: evidenceDirectory,
  });
  appendGitHubEnvironment(
    values.GITHUB_ENV,
    `${Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
  );
  return Object.freeze({
    drillId: inputs.drillId,
    kind: inputs.kind,
    dependency: inputs.dependency,
    configSha256: values.TIXKIT_DR_CONFIG_SHA256,
    expectationsSha256: values.TIXKIT_DR_EXPECTATIONS_SHA256,
    publicKeySha256: values.TIXKIT_DR_PUBLIC_KEY_SHA256,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(prepareProductionDrWorkflow())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
