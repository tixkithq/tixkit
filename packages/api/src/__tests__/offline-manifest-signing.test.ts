import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildOfflineManifestV2,
  loadOfflineManifestSigningRegistry,
  offlineManifestVerificationKeySet,
  verifyOfflineManifestV2,
} from '../services/offline-manifest-signing.js';

function signingEnvironment(input?: {
  activeKeyId?: string;
  secondKey?: boolean;
  notBefore?: string;
  notAfter?: string;
}): NodeJS.ProcessEnv {
  const first = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  });
  const keys = [
    {
      keyId: 'manifest-2026-07',
      privateKeyPem: first,
      notBefore: input?.notBefore ?? '2026-07-01T00:00:00.000Z',
      notAfter: input?.notAfter ?? '2026-09-01T00:00:00.000Z',
    },
  ];
  if (input?.secondKey) {
    keys.push({
      keyId: 'manifest-2026-08',
      privateKeyPem: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }),
      notBefore: '2026-07-15T00:00:00.000Z',
      notAfter: '2026-10-01T00:00:00.000Z',
    });
  }
  return {
    NODE_ENV: 'production',
    API_BASE_URL: 'https://api.example.test',
    OFFLINE_MANIFEST_ACTIVE_KEY_ID: input?.activeKeyId ?? 'manifest-2026-07',
    OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON: JSON.stringify(keys),
  };
}

function buildFixture(environment = signingEnvironment()) {
  const registry = loadOfflineManifestSigningRegistry(
    environment,
    new Date('2026-07-18T12:00:00.000Z'),
  );
  const manifest = buildOfflineManifestV2({
    registry,
    tenantId: 'tnt_1',
    eventId: 'evt_1',
    checkInListId: 'cil_1',
    generatedAt: new Date('2026-07-18T12:00:00.000Z'),
    ttlMs: 60 * 60 * 1000,
    rows: [
      {
        ticket_id: 'tkt_1',
        ticket_type_id: 'tt_1',
        event_occurrence_id: null,
        qr_hash: 'hash_1',
        status: 'valid',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'must-not-appear@example.test',
      },
    ],
  });
  const keySet = offlineManifestVerificationKeySet(registry);
  const context = {
    keySet,
    now: new Date('2026-07-18T12:30:00.000Z'),
    expectedIssuer: 'https://api.example.test',
    expectedTenantId: 'tnt_1',
    expectedEventId: 'evt_1',
    expectedCheckInListId: 'cil_1',
  };
  return { manifest, keySet, context };
}

describe('offline manifest V2 signing', () => {
  it('signs with an active P-256 key and exposes only its public JWK', () => {
    const { manifest, keySet, context } = buildFixture();
    expect(manifest).toMatchObject({
      version: 2,
      algorithm: 'ES256',
      issuer: 'https://api.example.test',
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      keyId: 'manifest-2026-07',
    });
    expect(Buffer.from(manifest.signature, 'base64url')).toHaveLength(64);
    expect(JSON.stringify(manifest)).not.toContain('must-not-appear@example.test');
    expect(keySet.keys[0]?.publicKey).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(JSON.stringify(keySet)).not.toContain('private');
    expect(verifyOfflineManifestV2(manifest, context)).toBe(true);
  });

  it('supports overlapping rotation keys while signing only with the configured active key', () => {
    const environment = signingEnvironment({ secondKey: true, activeKeyId: 'manifest-2026-08' });
    const { manifest, keySet } = buildFixture(environment);
    expect(manifest.keyId).toBe('manifest-2026-08');
    expect(keySet.keys.map((key) => key.keyId)).toEqual(['manifest-2026-07', 'manifest-2026-08']);
  });

  it.each([
    ['tenant substitution', { tenantId: 'tnt_2' }, {}],
    ['event substitution', { eventId: 'evt_2' }, {}],
    ['list substitution', { checkInListId: 'cil_2' }, {}],
    ['issuer substitution', { issuer: 'https://evil.example.test' }, {}],
    ['ticket tampering', { tickets: [] }, {}],
    ['wrong expected tenant', {}, { expectedTenantId: 'tnt_2' }],
    ['wrong expected issuer', {}, { expectedIssuer: 'https://other.example.test' }],
  ])('rejects %s', (_label, manifestPatch, contextPatch) => {
    const { manifest, context } = buildFixture();
    expect(
      verifyOfflineManifestV2({ ...manifest, ...manifestPatch }, { ...context, ...contextPatch }),
    ).toBe(false);
  });

  it('rejects expired manifests and manifests generated beyond clock skew', () => {
    const { manifest, context } = buildFixture();
    expect(
      verifyOfflineManifestV2(manifest, {
        ...context,
        now: new Date('2026-07-18T13:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      verifyOfflineManifestV2(manifest, {
        ...context,
        now: new Date('2026-07-18T11:54:59.999Z'),
      }),
    ).toBe(false);
  });

  it('rejects a signing key that cannot cover the complete manifest lifetime', () => {
    const registry = loadOfflineManifestSigningRegistry(
      signingEnvironment({ notAfter: '2026-07-19T11:30:00.000Z' }),
      new Date('2026-07-17T12:00:00.000Z'),
    );
    expect(() =>
      buildOfflineManifestV2({
        registry,
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        checkInListId: 'cil_1',
        generatedAt: new Date('2026-07-18T12:00:00.000Z'),
        ttlMs: 24 * 60 * 60 * 1000,
        rows: [],
      }),
    ).toThrow('not valid for the manifest lifetime');
  });

  it.each([0, -1, 24 * 60 * 60 * 1000 + 1, 1.5])(
    'rejects a protocol-invalid TTL of %s milliseconds before signing',
    (ttlMs) => {
      const registry = loadOfflineManifestSigningRegistry(
        signingEnvironment(),
        new Date('2026-07-18T12:00:00.000Z'),
      );
      expect(() =>
        buildOfflineManifestV2({
          registry,
          tenantId: 'tnt_1',
          eventId: 'evt_1',
          checkInListId: 'cil_1',
          generatedAt: new Date('2026-07-18T12:00:00.000Z'),
          ttlMs,
          rows: [],
        }),
      ).toThrow('TTL must be an integer from 1ms through 24 hours');
    },
  );
});

describe('offline manifest signing configuration', () => {
  it('treats blank example values as absent in non-production development', () => {
    const registry = loadOfflineManifestSigningRegistry({
      NODE_ENV: 'development',
      API_BASE_URL: 'http://localhost:4000',
      OFFLINE_MANIFEST_ACTIVE_KEY_ID: '',
      OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON: '',
    });
    expect(registry.activeKeyId).toBe('manifest-v2-dev-only');
    expect(registry.keys).toHaveLength(1);
  });

  it.each([
    [{ NODE_ENV: 'production', API_BASE_URL: 'https://api.example.test' }, 'PRIVATE_KEYS_JSON'],
    [
      {
        ...signingEnvironment(),
        API_BASE_URL: 'https://api.example.test/v1',
      },
      'exact HTTP(S) origin',
    ],
    [
      {
        ...signingEnvironment(),
        OFFLINE_MANIFEST_ACTIVE_KEY_ID: 'missing',
      },
      'must identify a configured signing key',
    ],
    [
      {
        ...signingEnvironment(),
        OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON: 'not-json',
      },
      'must be valid JSON',
    ],
  ])('fails closed for invalid production configuration', (environment, message) => {
    expect(() =>
      loadOfflineManifestSigningRegistry(environment, new Date('2026-07-18T12:00:00.000Z')),
    ).toThrow(message);
  });

  it.each([
    [{ notBefore: '2026-07-18T12:00:00.001Z' }],
    [{ notAfter: '2026-07-19T11:59:59.999Z' }],
  ])('rejects an active key that cannot serve the default manifest lifetime', (window) => {
    expect(() =>
      loadOfflineManifestSigningRegistry(
        signingEnvironment(window),
        new Date('2026-07-18T12:00:00.000Z'),
      ),
    ).toThrow('must be valid now and for the complete 24-hour manifest lifetime');
  });

  it('keeps retained public verification keys available when new signing is no longer safe', () => {
    const environment = signingEnvironment({ notAfter: '2026-07-18T18:00:00.000Z' });
    const now = new Date('2026-07-18T12:00:00.000Z');
    expect(() => loadOfflineManifestSigningRegistry(environment, now)).toThrow(
      'must be valid now and for the complete 24-hour manifest lifetime',
    );
    const verificationRegistry = loadOfflineManifestSigningRegistry(environment, now, {
      requireActiveManifestLifetime: false,
    });
    expect(offlineManifestVerificationKeySet(verificationRegistry).keys).toMatchObject([
      { keyId: 'manifest-2026-07', notAfter: '2026-07-18T18:00:00.000Z' },
    ]);
  });
});
