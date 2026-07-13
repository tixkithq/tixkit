#!/usr/bin/env bun

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fileConstants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalPortableJson,
  createPortableConfigurationPayloadPolicies,
} from '../packages/portability/src/index.ts';
import { portableCutoverTrustFromEnvironment } from '../packages/api/src/services/portable-import-control.ts';
import {
  PORTABLE_EXPORT_API_VERSION,
  PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
  PORTABLE_EXPORT_MEDIA_POLICY_SHA256,
  PORTABLE_EXPORT_MEDIA_SCANNER_ID,
} from '../packages/api/src/services/portable-export.ts';
import { portableImportTrustFromEnvironment } from '../packages/workflows/src/activities/migration-preparation.ts';
import { validateCompactEnvironment } from './compact.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultEnvironmentPath = resolve(root, 'infra/compact/.env');
const identitySchema = 'tixkit-compact-portability-identity-v1';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const maximumIdentityBytes = 64 * 1024;

function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Compact portability ${name} is invalid.`);
  const actual = Object.keys(value).toSorted();
  if (canonicalPortableJson(actual) !== canonicalPortableJson([...keys].toSorted()))
    throw new Error(`Compact portability ${name} has unexpected fields.`);
  return value;
}

function compactEnvironment(environmentPath) {
  return Object.fromEntries(
    readFileSync(environmentPath, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('Compact environment contains an invalid line.');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function privateKey(environment, name) {
  const encoded = environment[name];
  if (!encoded) throw new Error(`Compact environment is missing ${name}.`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded)
    throw new Error(`Compact environment contains invalid ${name}.`);
  const key = createPrivateKey(bytes.toString('utf8'));
  if (key.asymmetricKeyType !== 'ed25519')
    throw new Error(`Compact environment contains invalid ${name}.`);
  return key;
}

function publicIdentity(environment, keyIdName, privateKeyName) {
  const keyId = environment[keyIdName] ?? '';
  if (!identifier.test(keyId))
    throw new Error(`Compact environment contains invalid ${keyIdName}.`);
  return {
    keyId,
    publicKeyPem: createPublicKey(privateKey(environment, privateKeyName))
      .export({ type: 'spki', format: 'pem' })
      .toString(),
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createCompactPortabilityIdentity({
  environmentPath = defaultEnvironmentPath,
} = {}) {
  validateCompactEnvironment({ environmentPath });
  const environment = compactEnvironment(environmentPath);
  const bundleKey = publicIdentity(
    environment,
    'PORTABILITY_BUNDLE_SIGNING_KEY_ID',
    'PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64',
  );
  const unsigned = {
    schema: identitySchema,
    source: {
      deploymentId: environment.TIXKIT_DEPLOYMENT_ID,
      operatingModel: environment.TIXKIT_OPERATING_MODEL,
      apiVersion: PORTABLE_EXPORT_API_VERSION,
      dataSchemaVersion: PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
    },
    bundleKey,
    payloadKey: publicIdentity(
      environment,
      'PORTABILITY_PAYLOAD_SIGNING_KEY_ID',
      'PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64',
    ),
    cutoverKey: publicIdentity(
      environment,
      'PORTABILITY_CUTOVER_SIGNING_KEY_ID',
      'PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64',
    ),
  };
  const signature = sign(
    null,
    Buffer.from(canonicalPortableJson(unsigned)),
    privateKey(environment, 'PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64'),
  ).toString('base64');
  const artifact = `${canonicalPortableJson({
    ...unsigned,
    signature: { algorithm: 'Ed25519', keyId: bundleKey.keyId, value: signature },
  })}\n`;
  return { artifact, sha256: sha256(artifact) };
}

function parsePublicIdentity(artifactBytes, expectedSha256) {
  const actualSha256 = sha256(artifactBytes);
  if (!sha256Pattern.test(expectedSha256) || actualSha256 !== expectedSha256)
    throw new Error('Compact portability identity checksum does not match the expected SHA-256.');
  let parsed;
  try {
    parsed = JSON.parse(artifactBytes.toString('utf8'));
  } catch {
    throw new Error('Compact portability identity is not valid JSON.');
  }
  const identity = exactObject(
    parsed,
    ['schema', 'source', 'bundleKey', 'payloadKey', 'cutoverKey', 'signature'],
    'identity',
  );
  if (identity.schema !== identitySchema)
    throw new Error('Compact portability identity schema is unsupported.');
  const source = exactObject(
    identity.source,
    ['deploymentId', 'operatingModel', 'apiVersion', 'dataSchemaVersion'],
    'source',
  );
  if (
    !identifier.test(source.deploymentId) ||
    !['cloud', 'self-hosted'].includes(source.operatingModel) ||
    source.apiVersion !== PORTABLE_EXPORT_API_VERSION ||
    source.dataSchemaVersion !== PORTABLE_EXPORT_DATA_SCHEMA_VERSION
  )
    throw new Error('Compact portability source compatibility is invalid.');
  const parseKey = (candidate, name) => {
    const value = exactObject(candidate, ['keyId', 'publicKeyPem'], name);
    if (
      !identifier.test(value.keyId) ||
      typeof value.publicKeyPem !== 'string' ||
      /PRIVATE KEY/u.test(value.publicKeyPem)
    )
      throw new Error(`Compact portability ${name} is invalid.`);
    const key = createPublicKey(value.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error(`Compact portability ${name} is invalid.`);
    return { keyId: value.keyId, publicKeyPem: value.publicKeyPem, key };
  };
  const bundleKey = parseKey(identity.bundleKey, 'bundle key');
  const payloadKey = parseKey(identity.payloadKey, 'payload key');
  const cutoverKey = parseKey(identity.cutoverKey, 'cutover key');
  if (new Set([bundleKey.keyId, payloadKey.keyId, cutoverKey.keyId]).size !== 3)
    throw new Error('Compact portability identity key IDs must be distinct.');
  if (
    bundleKey.key.equals(payloadKey.key) ||
    bundleKey.key.equals(cutoverKey.key) ||
    payloadKey.key.equals(cutoverKey.key)
  )
    throw new Error('Compact portability identity role keys must use distinct key material.');
  const signature = exactObject(identity.signature, ['algorithm', 'keyId', 'value'], 'signature');
  if (
    signature.algorithm !== 'Ed25519' ||
    signature.keyId !== bundleKey.keyId ||
    typeof signature.value !== 'string'
  )
    throw new Error('Compact portability identity signature metadata is invalid.');
  const { signature: _signature, ...unsigned } = identity;
  if (
    !verify(
      null,
      Buffer.from(canonicalPortableJson(unsigned)),
      bundleKey.key,
      Buffer.from(signature.value, 'base64'),
    )
  )
    throw new Error('Compact portability identity signature is invalid.');
  return { source, bundleKey, payloadKey, cutoverKey };
}

function replaceEnvironmentValue(contents, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'mu');
  return pattern.test(contents)
    ? contents.replace(pattern, line)
    : `${contents.trimEnd()}\n${line}\n`;
}

function readIdentityArtifact(artifactPath) {
  const descriptor = openSync(
    resolve(artifactPath),
    fileConstants.O_RDONLY | fileConstants.O_NONBLOCK | fileConstants.O_NOFOLLOW,
  );
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile()) throw new Error('Compact portability identity must be a regular file.');
    if (status.size > maximumIdentityBytes)
      throw new Error('Compact portability identity exceeds the 64 KiB limit.');
    const bytes = Buffer.alloc(maximumIdentityBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > maximumIdentityBytes)
      throw new Error('Compact portability identity exceeds the 64 KiB limit.');
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function trustCompactPortabilityIdentityUnlocked({
  artifactPath,
  expectedSha256,
  environmentPath = defaultEnvironmentPath,
  storageBytes,
  replace = false,
}) {
  if (!artifactPath) throw new Error('Compact portability trust requires an identity artifact.');
  validateCompactEnvironment({ environmentPath });
  const environment = compactEnvironment(environmentPath);
  if (environment.TIXKIT_PORTABILITY_IMPORT_TRUST && !replace)
    throw new Error('Compact portability import trust already exists; pass --replace explicitly.');
  const identity = parsePublicIdentity(readIdentityArtifact(artifactPath), expectedSha256);
  if (identity.source.deploymentId === environment.TIXKIT_DEPLOYMENT_ID)
    throw new Error('Compact portability source and destination deployments must differ.');
  const capacity = storageBytes;
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error('Compact portability available storage must be a positive safe integer.');
  const payloadPolicies = Object.fromEntries(
    [...createPortableConfigurationPayloadPolicies()].map(([section, policy]) => [
      section,
      { ...policy, keyId: identity.payloadKey.keyId },
    ]),
  );
  const importTrust = {
    destination: {
      deploymentId: environment.TIXKIT_DEPLOYMENT_ID,
      apiVersion: PORTABLE_EXPORT_API_VERSION,
      dataSchemaVersion: PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
      capabilities: ['portable-bundle-v2', 'portable-rebinding-kinds-v2'],
      entitlements: ['historical-import-v1'],
      availableStorageBytes: capacity,
      acceptedSourceOperatingModels: ['cloud', 'self-hosted'],
    },
    bundleKeys: { [identity.bundleKey.keyId]: identity.bundleKey.publicKeyPem },
    payloadKeys: { [identity.payloadKey.keyId]: identity.payloadKey.publicKeyPem },
    payloadPolicies,
    mediaKeys: { [identity.payloadKey.keyId]: identity.payloadKey.publicKeyPem },
    mediaPolicies: {
      [PORTABLE_EXPORT_MEDIA_SCANNER_ID]: {
        policySha256: PORTABLE_EXPORT_MEDIA_POLICY_SHA256,
        keyId: identity.payloadKey.keyId,
        detectedMediaTypes: ['image/webp'],
      },
    },
  };
  const existingCutoverTrust = JSON.parse(environment.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS);
  const localCutoverKeyId = environment.PORTABILITY_CUTOVER_SIGNING_KEY_ID;
  const localCutoverPublicKey = existingCutoverTrust[localCutoverKeyId];
  if (identity.cutoverKey.keyId === localCutoverKeyId)
    throw new Error('Compact portability source cutover key conflicts with the destination key.');
  const destinationCutoverKey = createPublicKey(localCutoverPublicKey);
  if (
    identity.bundleKey.key.equals(destinationCutoverKey) ||
    identity.payloadKey.key.equals(destinationCutoverKey) ||
    identity.cutoverKey.key.equals(destinationCutoverKey)
  )
    throw new Error('Compact portability source key conflicts with destination cutover authority.');
  const cutoverTrust = Object.fromEntries([
    [localCutoverKeyId, localCutoverPublicKey],
    [identity.cutoverKey.keyId, identity.cutoverKey.publicKeyPem],
  ]);
  const nextEnvironment = {
    ...environment,
    TIXKIT_PORTABILITY_IMPORT_TRUST: canonicalPortableJson(importTrust),
    PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS: canonicalPortableJson(cutoverTrust),
  };
  portableImportTrustFromEnvironment(
    { tenantId: 'compact_trust_validation', organizationId: 'compact_trust_validation' },
    nextEnvironment,
  );
  portableCutoverTrustFromEnvironment(nextEnvironment);
  let contents = readFileSync(environmentPath, 'utf8');
  contents = replaceEnvironmentValue(
    contents,
    'TIXKIT_PORTABILITY_IMPORT_TRUST',
    nextEnvironment.TIXKIT_PORTABILITY_IMPORT_TRUST,
  );
  contents = replaceEnvironmentValue(
    contents,
    'PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS',
    nextEnvironment.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS,
  );
  const temporaryPath = `${environmentPath}.portability-${process.pid}`;
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(temporaryPath, 0o600);
    validateCompactEnvironment({ environmentPath: temporaryPath });
    renameSync(temporaryPath, environmentPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return {
    sourceDeploymentId: identity.source.deploymentId,
    destinationDeploymentId: environment.TIXKIT_DEPLOYMENT_ID,
    identitySha256: expectedSha256,
  };
}

export function trustCompactPortabilityIdentity(input = {}) {
  const environmentPath = input.environmentPath ?? defaultEnvironmentPath;
  const lockPath = `${environmentPath}.portability.lock`;
  const acquire = () => {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(
          descriptor,
          canonicalPortableJson({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor);
        rmSync(lockPath, { force: true });
        throw error;
      }
      return descriptor;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return undefined;
    }
  };
  const lock = acquire();
  if (lock === undefined)
    throw new Error('Compact portability trust update is already in progress.');
  try {
    return trustCompactPortabilityIdentityUnlocked({ ...input, environmentPath });
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

function usage() {
  return [
    'Usage:',
    '  bun run compact:portability-identity -- [--env-file <path>] <output.json>',
    '  bun run compact:portability-trust -- [--env-file <path>] <identity.json> --sha256 <digest> --available-storage-bytes <bytes> [--replace]',
  ].join('\n');
}

export function parseCompactPortabilityCliArguments(arguments_) {
  const environmentIndexes = arguments_.flatMap((argument, index) =>
    argument === '--env-file' ? [index] : [],
  );
  if (environmentIndexes.length > 1) throw new Error('--env-file may be provided only once.');
  const environmentIndex = environmentIndexes[0] ?? -1;
  const environmentValue = environmentIndex >= 0 ? arguments_[environmentIndex + 1] : undefined;
  if (environmentIndex >= 0 && (!environmentValue || environmentValue.startsWith('--')))
    throw new Error('--env-file requires a value.');
  return {
    environmentPath: environmentValue ? resolve(environmentValue) : defaultEnvironmentPath,
    remaining:
      environmentIndex >= 0
        ? arguments_.filter(
            (_argument, index) => index !== environmentIndex && index !== environmentIndex + 1,
          )
        : [...arguments_],
  };
}

export function parseCompactPortabilityTrustArguments(arguments_) {
  const artifactPath = arguments_[0];
  if (!artifactPath || artifactPath.startsWith('--')) throw new Error(usage());
  let expectedSha256;
  let storageBytes;
  let replace = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--replace') {
      if (replace) throw new Error('--replace may be provided only once.');
      replace = true;
      continue;
    }
    if (argument !== '--sha256' && argument !== '--available-storage-bytes')
      throw new Error(`Unknown Compact portability trust argument: ${argument}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
    if (argument === '--sha256') {
      if (expectedSha256 !== undefined) throw new Error('--sha256 may be provided only once.');
      expectedSha256 = value;
    } else {
      if (storageBytes !== undefined)
        throw new Error('--available-storage-bytes may be provided only once.');
      storageBytes = Number(value);
    }
    index += 1;
  }
  return { artifactPath, expectedSha256, storageBytes, replace };
}

export function parseCompactPortabilityIdentityArguments(arguments_) {
  if (arguments_.length !== 1 || !arguments_[0] || arguments_[0].startsWith('--'))
    throw new Error(usage());
  return arguments_[0];
}

const [command, ...rawArguments] = process.argv.slice(2);
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const { environmentPath, remaining: arguments_ } =
      parseCompactPortabilityCliArguments(rawArguments);
    if (command === 'identity') {
      const output = parseCompactPortabilityIdentityArguments(arguments_);
      const identity = createCompactPortabilityIdentity({ environmentPath });
      writeFileSync(resolve(output), identity.artifact, { mode: 0o644, flag: 'wx' });
      console.log(`Wrote public Compact portability identity ${resolve(output)}`);
      console.log(`SHA-256 ${identity.sha256}`);
    } else if (command === 'trust') {
      const { artifactPath, expectedSha256, storageBytes, replace } =
        parseCompactPortabilityTrustArguments(arguments_);
      const result = trustCompactPortabilityIdentity({
        artifactPath,
        environmentPath,
        expectedSha256,
        storageBytes,
        replace,
      });
      console.log(
        `Trusted ${result.sourceDeploymentId} for destination ${result.destinationDeploymentId} using identity ${result.identitySha256}.`,
      );
    } else {
      throw new Error(usage());
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
