import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  createS3PortableExportArtifactStore,
  portableExportSigningFromEnvironment,
  readPortableArtifactBody,
} from '../services/portable-export.js';

function encodedPrivateKey(): string {
  return Buffer.from(
    generateKeyPairSync('ed25519').privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }),
  ).toString('base64');
}

describe('portable export signing configuration', () => {
  it('loads only canonical Ed25519 private keys and closed deployment metadata', () => {
    const configuration = portableExportSigningFromEnvironment({
      TIXKIT_DEPLOYMENT_ID: 'deployment_compact_01',
      TIXKIT_OPERATING_MODEL: 'self-hosted',
      PORTABILITY_BUNDLE_SIGNING_KEY_ID: 'bundle_key_01',
      PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64: encodedPrivateKey(),
      PORTABILITY_PAYLOAD_SIGNING_KEY_ID: 'payload_key_01',
      PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64: encodedPrivateKey(),
    });
    expect(configuration).toMatchObject({
      deploymentId: 'deployment_compact_01',
      operatingModel: 'self-hosted',
      bundleKeyId: 'bundle_key_01',
      payloadKeyId: 'payload_key_01',
    });
    expect(configuration.bundlePrivateKey.asymmetricKeyType).toBe('ed25519');
    expect(configuration.payloadPrivateKey.asymmetricKeyType).toBe('ed25519');
  });

  it('fails closed without leaking malformed key material', () => {
    const base = {
      TIXKIT_DEPLOYMENT_ID: 'deployment_compact_01',
      TIXKIT_OPERATING_MODEL: 'self-hosted',
      PORTABILITY_BUNDLE_SIGNING_KEY_ID: 'bundle_key_01',
      PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64: encodedPrivateKey(),
      PORTABILITY_PAYLOAD_SIGNING_KEY_ID: 'payload_key_01',
      PORTABILITY_PAYLOAD_SIGNING_PRIVATE_KEY_BASE64: encodedPrivateKey(),
    };
    expect(() =>
      portableExportSigningFromEnvironment({
        ...base,
        TIXKIT_OPERATING_MODEL: 'unknown',
      }),
    ).toThrow(/OPERATING_MODEL_INVALID/u);
    expect(() =>
      portableExportSigningFromEnvironment({
        ...base,
        TIXKIT_OPERATING_MODEL: 'cloud',
      }),
    ).toThrow(/OPERATING_MODEL_INVALID/u);
    expect(() =>
      portableExportSigningFromEnvironment({
        ...base,
        PORTABILITY_BUNDLE_SIGNING_PRIVATE_KEY_BASE64: 'private-secret-value',
      }),
    ).toThrow('PORTABLE_EXPORT_BUNDLE_PRIVATE_KEY_INVALID');
  });
});

describe('portable export immutable object storage', () => {
  it('caps chunked reads before allocating the aggregate artifact', async () => {
    async function* chunks() {
      yield Uint8Array.from([1, 2, 3]);
      yield Uint8Array.from([4, 5]);
    }
    await expect(readPortableArtifactBody(chunks(), undefined, 4)).rejects.toThrow(/TOO_LARGE/u);
    await expect(readPortableArtifactBody(chunks(), 5, 4)).rejects.toThrow(/TOO_LARGE/u);
    await expect(readPortableArtifactBody(chunks(), 5, 5)).resolves.toEqual(
      Uint8Array.from([1, 2, 3, 4, 5]),
    );
  });

  it('uses conditional encrypted checksum writes and treats preconditions as immutable replay', async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const client = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command);
        return {};
      },
    } as unknown as Pick<S3Client, 'send'>;
    const store = createS3PortableExportArtifactStore(
      { PORTABILITY_EXPORT_BUCKET: 'portable-test', S3_REGION: 'us-east-1' },
      client,
    );
    const digest = 'a'.repeat(64);
    await expect(store.putIfAbsent('artifact.json', Uint8Array.from([1]), digest)).resolves.toBe(
      'created',
    );
    expect(commands[0]!.input).toMatchObject({
      Bucket: 'portable-test',
      Key: 'artifact.json',
      IfNoneMatch: '*',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
    });

    const conflictingClient = {
      async send() {
        throw { $metadata: { httpStatusCode: 412 } };
      },
    } as unknown as Pick<S3Client, 'send'>;
    const conflictingStore = createS3PortableExportArtifactStore(
      { PORTABILITY_EXPORT_BUCKET: 'portable-test' },
      conflictingClient,
    );
    await expect(
      conflictingStore.putIfAbsent('artifact.json', Uint8Array.from([1]), digest),
    ).resolves.toBe('exists');
  });
});
