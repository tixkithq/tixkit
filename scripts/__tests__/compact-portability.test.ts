import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { portableCutoverTrustFromEnvironment } from '../../packages/api/src/services/portable-import-control.ts';
import { portableImportTrustFromEnvironment } from '../../packages/workflows/src/activities/migration-preparation.ts';
import { canonicalPortableJson } from '../../packages/portability/src/index.ts';
import {
  createCompactPortabilityIdentity,
  parseCompactPortabilityCliArguments,
  parseCompactPortabilityIdentityArguments,
  parseCompactPortabilityTrustArguments,
  trustCompactPortabilityIdentity,
} from '../compact-portability.mjs';
import { initializeCompactEnvironment } from '../compact.mjs';

const root = resolve(import.meta.dirname, '../..');
const composePath = resolve(root, 'infra/compact/compose.yml');
const directories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-compact-portability-'));
  directories.push(directory);
  return directory;
}

function environment(path: string) {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('Compact portability public identity exchange', () => {
  test('selects a non-default environment without consuming command arguments', () => {
    const selected = parseCompactPortabilityCliArguments([
      'identity.json',
      '--env-file',
      './tmp/destination.env',
      '--replace',
    ]);
    expect(selected.environmentPath).toBe(resolve('./tmp/destination.env'));
    expect(selected.remaining).toEqual(['identity.json', '--replace']);
    expect(() => parseCompactPortabilityCliArguments(['--env-file'])).toThrow(
      '--env-file requires a value.',
    );
    expect(() =>
      parseCompactPortabilityCliArguments([
        '--env-file',
        './source.env',
        '--env-file',
        './destination.env',
      ]),
    ).toThrow('--env-file may be provided only once.');
    expect(
      parseCompactPortabilityTrustArguments([
        'identity.json',
        '--sha256',
        'a'.repeat(64),
        '--available-storage-bytes',
        '1024',
        '--replace',
      ]),
    ).toEqual({
      artifactPath: 'identity.json',
      expectedSha256: 'a'.repeat(64),
      storageBytes: 1024,
      replace: true,
    });
    expect(() =>
      parseCompactPortabilityTrustArguments(['identity.json', '--sha256', 'a', '--sha256', 'b']),
    ).toThrow('--sha256 may be provided only once.');
    expect(() => parseCompactPortabilityTrustArguments(['identity.json', '--unknown'])).toThrow(
      'Unknown Compact portability trust argument',
    );
    expect(() =>
      parseCompactPortabilityIdentityArguments(['identity.json', 'ignored.json']),
    ).toThrow('Usage:');
  });

  test('installs checksum-pinned source trust for the destination worker without private-key transfer', () => {
    const directory = temporaryDirectory();
    const sourceEnvironment = resolve(directory, 'source.env');
    const destinationEnvironment = resolve(directory, 'destination.env');
    const artifactPath = resolve(directory, 'source-identity.json');
    initializeCompactEnvironment({ environmentPath: sourceEnvironment });
    initializeCompactEnvironment({ environmentPath: destinationEnvironment });
    const identity = createCompactPortabilityIdentity({ environmentPath: sourceEnvironment });
    expect(createCompactPortabilityIdentity({ environmentPath: sourceEnvironment })).toEqual(
      identity,
    );
    writeFileSync(artifactPath, identity.artifact, { mode: 0o644 });
    expect(createHash('sha256').update(readFileSync(artifactPath)).digest('hex')).toBe(
      identity.sha256,
    );

    const result = trustCompactPortabilityIdentity({
      artifactPath,
      expectedSha256: identity.sha256,
      environmentPath: destinationEnvironment,
      storageBytes: 1024 * 1024 * 1024,
    });
    const source = environment(sourceEnvironment);
    const destination = environment(destinationEnvironment);
    expect(result.sourceDeploymentId).toBe(source.TIXKIT_DEPLOYMENT_ID);
    expect(result.destinationDeploymentId).toBe(destination.TIXKIT_DEPLOYMENT_ID);
    expect(identity.artifact).not.toContain('PRIVATE KEY');
    for (const name of [
      'PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64',
      'PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64',
      'PORTABILITY_CUTOVER_SIGNING_PRIVATE_KEY_BASE64',
    ])
      expect(identity.artifact).not.toContain(source[name]);

    const trust = portableImportTrustFromEnvironment(
      { tenantId: 'tenant_destination', organizationId: 'organization_destination' },
      destination,
    );
    expect(trust.destination.deploymentId).toBe(destination.TIXKIT_DEPLOYMENT_ID);
    expect(trust.destination.availableStorageBytes).toBe(1024 * 1024 * 1024);
    expect(trust.trustedBundleKeys.has(source.PORTABILITY_BUNDLE_SIGNING_KEY_ID)).toBe(true);
    expect(trust.trustedPayloadKeys.has(source.PORTABILITY_PAYLOAD_SIGNING_KEY_ID)).toBe(true);
    expect(trust.trustedPayloadPolicies.size).toBe(12);
    expect(trust.destination.capabilities).toEqual([
      'portable-bundle-v2',
      'portable-rebinding-kinds-v2',
      'portable-content-documents-v1',
    ]);
    expect(trust.trustedMediaPolicies.get('tixkit_event_media_scanner_v1')).toEqual(
      expect.objectContaining({
        keyId: source.PORTABILITY_PAYLOAD_SIGNING_KEY_ID,
        detectedMediaTypes: ['image/webp'],
      }),
    );
    const cutoverTrust = portableCutoverTrustFromEnvironment(destination);
    expect(cutoverTrust.trustedPublicKeys.has(source.PORTABILITY_CUTOVER_SIGNING_KEY_ID)).toBe(
      true,
    );
    expect(cutoverTrust.trustedPublicKeys.has(destination.PORTABILITY_CUTOVER_SIGNING_KEY_ID)).toBe(
      true,
    );

    const rendered = JSON.parse(
      execFileSync(
        'docker',
        [
          'compose',
          '--env-file',
          destinationEnvironment,
          '-f',
          composePath,
          'config',
          '--format',
          'json',
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    expect(rendered.services.worker.environment.TIXKIT_PORTABILITY_IMPORT_TRUST).toBe(
      destination.TIXKIT_PORTABILITY_IMPORT_TRUST,
    );
    expect(rendered.services.api.environment.TIXKIT_PORTABILITY_IMPORT_TRUST).toBeUndefined();

    const replacementEnvironment = resolve(directory, 'replacement.env');
    const replacementArtifactPath = resolve(directory, 'replacement-identity.json');
    initializeCompactEnvironment({ environmentPath: replacementEnvironment });
    const replacementIdentity = createCompactPortabilityIdentity({
      environmentPath: replacementEnvironment,
    });
    writeFileSync(replacementArtifactPath, replacementIdentity.artifact);
    trustCompactPortabilityIdentity({
      artifactPath: replacementArtifactPath,
      expectedSha256: replacementIdentity.sha256,
      environmentPath: destinationEnvironment,
      storageBytes: 512 * 1024 * 1024,
      replace: true,
    });
    const replacedDestination = environment(destinationEnvironment);
    const replacementSource = environment(replacementEnvironment);
    const replacedImportTrust = portableImportTrustFromEnvironment(
      { tenantId: 'tenant_destination', organizationId: 'organization_destination' },
      replacedDestination,
    );
    expect(
      replacedImportTrust.trustedBundleKeys.has(source.PORTABILITY_BUNDLE_SIGNING_KEY_ID),
    ).toBe(false);
    expect(
      replacedImportTrust.trustedBundleKeys.has(
        replacementSource.PORTABILITY_BUNDLE_SIGNING_KEY_ID,
      ),
    ).toBe(true);
    const replacedCutoverTrust = portableCutoverTrustFromEnvironment(replacedDestination);
    expect(
      replacedCutoverTrust.trustedPublicKeys.has(source.PORTABILITY_CUTOVER_SIGNING_KEY_ID),
    ).toBe(false);
    expect(
      replacedCutoverTrust.trustedPublicKeys.has(
        replacementSource.PORTABILITY_CUTOVER_SIGNING_KEY_ID,
      ),
    ).toBe(true);
    expect(
      replacedCutoverTrust.trustedPublicKeys.has(
        replacedDestination.PORTABILITY_CUTOVER_SIGNING_KEY_ID,
      ),
    ).toBe(true);
  });

  test('fails closed on trust substitution, unsafe keys, invalid contracts, concurrent updates, and implicit replacement', () => {
    const directory = temporaryDirectory();
    const sourceEnvironment = resolve(directory, 'source.env');
    const destinationEnvironment = resolve(directory, 'destination.env');
    const artifactPath = resolve(directory, 'source-identity.json');
    initializeCompactEnvironment({ environmentPath: sourceEnvironment });
    initializeCompactEnvironment({ environmentPath: destinationEnvironment });
    const identity = createCompactPortabilityIdentity({ environmentPath: sourceEnvironment });
    const source = environment(sourceEnvironment);
    const destination = environment(destinationEnvironment);
    const sourceBundlePrivateKey = createPrivateKey(
      Buffer.from(source.PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64, 'base64').toString('utf8'),
    );
    const signedMutation = (mutate: (value: Record<string, any>) => void) => {
      const value = JSON.parse(identity.artifact);
      mutate(value);
      const { signature: signatureMetadata, ...unsigned } = value;
      value.signature = {
        ...signatureMetadata,
        keyId: value.bundleKey.keyId,
        value: sign(
          null,
          Buffer.from(canonicalPortableJson(unsigned)),
          sourceBundlePrivateKey,
        ).toString('base64'),
      };
      return `${canonicalPortableJson(value)}\n`;
    };
    const expectUnchangedFailure = (
      artifact: string,
      pattern: RegExp,
      storageBytes: number = 1024,
    ) => {
      writeFileSync(artifactPath, artifact);
      const before = readFileSync(destinationEnvironment);
      expect(() =>
        trustCompactPortabilityIdentity({
          artifactPath,
          expectedSha256: createHash('sha256').update(artifact).digest('hex'),
          environmentPath: destinationEnvironment,
          storageBytes,
        }),
      ).toThrow(pattern);
      expect(readFileSync(destinationEnvironment)).toEqual(before);
      expect(existsSync(`${destinationEnvironment}.portability.lock`)).toBe(false);
    };
    writeFileSync(artifactPath, identity.artifact);
    const lockPath = `${destinationEnvironment}.portability.lock`;
    writeFileSync(
      lockPath,
      canonicalPortableJson({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath,
        expectedSha256: identity.sha256,
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/update is already in progress/u);
    rmSync(lockPath);
    writeFileSync(
      lockPath,
      canonicalPortableJson({ pid: 99_999_999, createdAt: '2020-01-01T00:00:00.000Z' }),
    );
    writeFileSync(artifactPath, identity.artifact);
    const beforeStaleLockDenial = readFileSync(destinationEnvironment);
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath,
        expectedSha256: '0'.repeat(64),
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/update is already in progress/u);
    expect(readFileSync(destinationEnvironment)).toEqual(beforeStaleLockDenial);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);

    writeFileSync(artifactPath, identity.artifact);
    const beforeChecksumFailure = readFileSync(destinationEnvironment);
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath,
        expectedSha256: '0'.repeat(64),
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/checksum does not match/u);
    expect(readFileSync(destinationEnvironment)).toEqual(beforeChecksumFailure);

    const tampered = identity.artifact.replace('self-hosted', 'cloud');
    expectUnchangedFailure(tampered, /signature is invalid/u);
    expectUnchangedFailure(
      signedMutation((value) => {
        value.unexpected = true;
      }),
      /unexpected fields/u,
    );
    expectUnchangedFailure(
      signedMutation((value) => {
        value.schema = 'unsupported';
      }),
      /schema is unsupported/u,
    );
    expectUnchangedFailure(
      signedMutation((value) => {
        value.source.apiVersion = '2025-01-01';
      }),
      /source compatibility is invalid/u,
    );
    expectUnchangedFailure(
      signedMutation((value) => {
        value.payloadKey.publicKeyPem = Buffer.from(
          source.PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64,
          'base64',
        ).toString('utf8');
      }),
      /payload key is invalid/u,
    );
    const rsaPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expectUnchangedFailure(
      signedMutation((value) => {
        value.payloadKey.publicKeyPem = rsaPublicKey;
      }),
      /payload key is invalid/u,
    );
    expectUnchangedFailure(
      signedMutation((value) => {
        value.payloadKey.keyId = value.bundleKey.keyId;
      }),
      /key IDs must be distinct/u,
    );
    expectUnchangedFailure(
      signedMutation((value) => {
        value.payloadKey.publicKeyPem = value.bundleKey.publicKeyPem;
      }),
      /role keys must use distinct key material/u,
    );
    const destinationCutoverPublicKey = JSON.parse(
      destination.PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS,
    )[destination.PORTABILITY_CUTOVER_SIGNING_KEY_ID];
    expectUnchangedFailure(
      signedMutation((value) => {
        value.cutoverKey.publicKeyPem = destinationCutoverPublicKey;
      }),
      /source key conflicts with destination cutover authority/u,
    );
    expectUnchangedFailure(identity.artifact, /positive safe integer/u, 0);
    expectUnchangedFailure(
      identity.artifact,
      /positive safe integer/u,
      Number.MAX_SAFE_INTEGER + 1,
    );
    expectUnchangedFailure('x'.repeat(64 * 1024 + 1), /exceeds the 64 KiB limit/u);
    const beforeNonRegularArtifact = readFileSync(destinationEnvironment);
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath: directory,
        expectedSha256: identity.sha256,
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/must be a regular file/u);
    expect(readFileSync(destinationEnvironment)).toEqual(beforeNonRegularArtifact);
    expect(existsSync(lockPath)).toBe(false);
    writeFileSync(artifactPath, identity.artifact);
    const symlinkPath = resolve(directory, 'source-identity-link.json');
    symlinkSync(artifactPath, symlinkPath);
    const beforeSymlinkArtifact = readFileSync(destinationEnvironment);
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath: symlinkPath,
        expectedSha256: identity.sha256,
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow();
    expect(readFileSync(destinationEnvironment)).toEqual(beforeSymlinkArtifact);
    expect(existsSync(lockPath)).toBe(false);
    const fifoPath = resolve(directory, 'source-identity.fifo');
    execFileSync('mkfifo', [fifoPath]);
    const beforeFifoArtifact = readFileSync(destinationEnvironment);
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath: fifoPath,
        expectedSha256: identity.sha256,
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/must be a regular file/u);
    expect(readFileSync(destinationEnvironment)).toEqual(beforeFifoArtifact);
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(artifactPath, identity.artifact);
    const sourceBeforeSelfTrust = readFileSync(sourceEnvironment);
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath,
        expectedSha256: identity.sha256,
        environmentPath: sourceEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/source and destination deployments must differ/u);
    expect(readFileSync(sourceEnvironment)).toEqual(sourceBeforeSelfTrust);
    trustCompactPortabilityIdentity({
      artifactPath,
      expectedSha256: identity.sha256,
      environmentPath: destinationEnvironment,
      storageBytes: 1024,
    });
    expect(() =>
      trustCompactPortabilityIdentity({
        artifactPath,
        expectedSha256: identity.sha256,
        environmentPath: destinationEnvironment,
        storageBytes: 1024,
      }),
    ).toThrow(/already exists/u);
  });
});
