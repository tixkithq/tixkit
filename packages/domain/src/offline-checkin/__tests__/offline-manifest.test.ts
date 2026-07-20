import { describe, expect, it } from 'vitest';
import {
  canonicalOfflineManifestPayload,
  classifyOfflineManifestTicketStatus,
  unsignedOfflineManifestV2,
  validateOfflineManifestV2Envelope,
  type OfflineManifestV2,
  type OfflineManifestVerificationKeySet,
} from '../index.js';

const manifest: OfflineManifestV2 = {
  version: 2,
  algorithm: 'ES256',
  issuer: 'https://api.example.test',
  tenantId: 'tnt_1',
  eventId: 'evt_1',
  checkInListId: 'cil_1',
  generatedAt: '2026-07-18T12:00:00.000Z',
  expiresAt: '2026-07-19T12:00:00.000Z',
  keyId: 'manifest-2026-07',
  signature: 'a'.repeat(86),
  tickets: [
    {
      ticketId: 'tkt_1',
      ticketTypeId: 'tt_1',
      attendeeName: 'Ada Lovelace',
      qrHash: 'abc123',
      status: 'valid',
    },
  ],
};

const keySet: OfflineManifestVerificationKeySet = {
  version: 1,
  issuer: manifest.issuer,
  keys: [
    {
      keyId: manifest.keyId,
      algorithm: 'ES256',
      publicKey: {
        kty: 'EC',
        crv: 'P-256',
        x: 'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY',
        y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',
      },
      notBefore: '2026-07-18T00:00:00.000Z',
      notAfter: '2026-07-20T00:00:00.000Z',
    },
  ],
};

const context = {
  now: new Date('2026-07-18T13:00:00.000Z'),
  expectedIssuer: manifest.issuer,
  expectedTenantId: manifest.tenantId,
  expectedEventId: manifest.eventId,
  expectedCheckInListId: manifest.checkInListId,
};

describe('offline manifest V2 canonical payload', () => {
  it('sorts object keys recursively while retaining ticket order', () => {
    expect(canonicalOfflineManifestPayload(unsignedOfflineManifestV2(manifest))).toBe(
      '{"algorithm":"ES256","checkInListId":"cil_1","eventId":"evt_1","expiresAt":"2026-07-19T12:00:00.000Z","generatedAt":"2026-07-18T12:00:00.000Z","issuer":"https://api.example.test","keyId":"manifest-2026-07","tenantId":"tnt_1","tickets":[{"attendeeName":"Ada Lovelace","qrHash":"abc123","status":"valid","ticketId":"tkt_1","ticketTypeId":"tt_1"}],"version":2}',
    );
  });

  it('omits optional undefined fields deterministically', () => {
    const payload = unsignedOfflineManifestV2({
      ...manifest,
      tickets: [{ ...manifest.tickets[0], eventOccurrenceId: undefined }],
    });
    expect(canonicalOfflineManifestPayload(payload)).not.toContain('eventOccurrenceId');
  });

  it('uses code-unit ordering independent of locale and ICU data', () => {
    const payload = unsignedOfflineManifestV2({
      ...manifest,
      tickets: [
        {
          ...manifest.tickets[0],
          attendeeName: 'Åda',
          eventOccurrenceId: 'occ:1',
        },
      ],
    });
    expect(canonicalOfflineManifestPayload(payload)).toContain(
      '"attendeeName":"Åda","eventOccurrenceId":"occ:1","qrHash"',
    );
  });

  it.each([
    ['valid', 'candidate'],
    ['checked_in', 'duplicate'],
    ['void', 'revoked'],
    ['refunded', 'revoked'],
    ['transferred', 'revoked'],
    ['issued', 'invalid'],
    [undefined, 'invalid'],
  ])('classifies %s as %s', (status, expected) => {
    expect(classifyOfflineManifestTicketStatus(status)).toBe(expected);
  });
});

describe('offline manifest V2 envelope validation', () => {
  it('accepts an exact scoped, time-bounded envelope and returns its key', () => {
    expect(validateOfflineManifestV2Envelope(manifest, keySet, context)).toBe(keySet.keys[0]);
  });

  it.each([
    ['wrong key-set version', manifest, { ...keySet, version: 2 }],
    ['overlong lifetime', { ...manifest, expiresAt: '2026-07-19T12:00:00.001Z' }, keySet],
    [
      'unknown ticket status',
      { ...manifest, tickets: [{ ...manifest.tickets[0], status: 'issued' }] },
      keySet,
    ],
    ['wrong tenant scope', { ...manifest, tenantId: 'tnt_2' }, keySet],
    ['non-canonical instant', { ...manifest, generatedAt: '2026-07-18T12:00:00Z' }, keySet],
  ])('rejects %s', (_label, candidate, candidateKeySet) => {
    expect(
      validateOfflineManifestV2Envelope(
        candidate as OfflineManifestV2,
        candidateKeySet as OfflineManifestVerificationKeySet,
        context,
      ),
    ).toBeNull();
  });

  it.each([
    ['invalid clock', { ...context, now: new Date(Number.NaN) }],
    ['negative clock skew', { ...context, maxFutureSkewMs: -1 }],
    ['zero TTL policy', { ...context, maxManifestTtlMs: 0 }],
  ])('rejects %s', (_label, candidateContext) => {
    expect(validateOfflineManifestV2Envelope(manifest, keySet, candidateContext)).toBeNull();
  });

  it.each([
    ['wrong JWK type', { kty: 'RSA' }],
    ['wrong JWK curve', { crv: 'P-384' }],
    ['non-canonical x coordinate', { x: `${'a'.repeat(42)}a` }],
    ['non-canonical y coordinate', { y: `${'b'.repeat(42)}b` }],
  ])('rejects %s', (_label, publicKeyPatch) => {
    const tampered = {
      ...keySet,
      keys: [
        {
          ...keySet.keys[0],
          publicKey: { ...keySet.keys[0]!.publicKey, ...publicKeyPatch },
        },
      ],
    } as OfflineManifestVerificationKeySet;
    expect(validateOfflineManifestV2Envelope(manifest, tampered, context)).toBeNull();
  });
});
