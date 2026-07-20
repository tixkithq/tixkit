import { createPrivateKey, sign, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalOfflineManifestPayload,
  type OfflineManifestV2,
  type OfflineManifestVerificationKeySet,
} from '@tixkit/domain/offline-checkin';
import { verifyOfflineManifestForBrowser } from './offline-manifest-crypto.js';

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguuqSuoL6HAyrMjU7
QqbeBD0vTTJjUyVvjYCenHz2YnahRANCAATBXJgyEdtghsSJWFjGH55lEfbPnMZk
I3FQVU+ihGu0ZWb3laTbq8k9W2H2B3BIZ+BLtbL6QRIsfcYecnFXq+W4
-----END PRIVATE KEY-----`;

function fixture() {
  const payload: Omit<OfflineManifestV2, 'signature'> = {
    version: 2,
    algorithm: 'ES256',
    issuer: 'https://api.example.test',
    tenantId: 'tnt_1',
    eventId: 'evt_1',
    checkInListId: 'cil_1',
    generatedAt: '2026-07-18T12:00:00.000Z',
    expiresAt: '2026-07-18T13:00:00.000Z',
    keyId: 'manifest-v2-dev-only',
    tickets: [
      {
        ticketId: 'tkt_1',
        ticketTypeId: 'tt_1',
        qrHash: 'hash_1',
        status: 'valid',
        attendeeName: 'Ada Lovelace',
      },
    ],
  };
  const privateKey = createPrivateKey(PRIVATE_KEY);
  const signature = sign('sha256', Buffer.from(canonicalOfflineManifestPayload(payload)), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const publicJwk = privateKey.export({ format: 'jwk' }) as {
    x?: string;
    y?: string;
  };
  const manifest: OfflineManifestV2 = { ...payload, signature };
  const keySet: OfflineManifestVerificationKeySet = {
    version: 1,
    issuer: 'https://api.example.test',
    keys: [
      {
        keyId: 'manifest-v2-dev-only',
        algorithm: 'ES256',
        publicKey: {
          kty: 'EC',
          crv: 'P-256',
          x: publicJwk.x!,
          y: publicJwk.y!,
        },
        notBefore: '2020-01-01T00:00:00.000Z',
        notAfter: '2100-01-01T00:00:00.000Z',
      },
    ],
  };
  return {
    manifest,
    keySet,
    context: {
      apiOrigin: 'https://api.example.test',
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      now: new Date('2026-07-18T12:30:00.000Z'),
    },
  };
}

describe('browser offline manifest verification', () => {
  it('verifies the API IEEE-P1363 signature with WebCrypto', async () => {
    const { manifest, keySet, context } = fixture();
    await expect(
      verifyOfflineManifestForBrowser(
        manifest,
        keySet,
        context,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).resolves.toBe(true);
  });

  it.each([
    ['legacy V1', { version: undefined, algorithm: undefined }],
    ['tampered tenant', { tenantId: 'tnt_2' }],
    ['tampered tickets', { tickets: [] }],
    ['unknown ticket status', { tickets: [{ status: 'issued' }] }],
    ['padded signature', { signature: `${'a'.repeat(86)}==` }],
  ])('fails closed for %s', async (_label, patch) => {
    const { manifest, keySet, context } = fixture();
    const candidate = { ...manifest, ...patch } as typeof manifest;
    await expect(
      verifyOfflineManifestForBrowser(
        candidate,
        keySet,
        context,
        webcrypto.subtle as unknown as SubtleCrypto,
      ),
    ).resolves.toBe(false);
  });
});
