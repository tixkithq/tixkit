import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createIncidentDiagnosticKeyring,
  decryptExactProviderRequestId,
  encryptExactProviderRequestId,
  hashExactProviderRequestId,
  INCIDENT_DIAGNOSTIC_MAX_RETENTION_MS,
  IncidentDiagnosticDecryptionError,
  IncidentDiagnosticValidationError,
  validateExactProviderRequestId,
  type EncryptedProviderRequestId,
  type IncidentDiagnosticBinding,
  type IncidentDiagnosticContext,
  type IncidentDiagnosticKeyring,
} from '../incident-diagnostics.js';

const capturedAt = Date.UTC(2026, 6, 16, 12);
const context: IncidentDiagnosticContext = {
  evidenceId: 'pie_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  tenantId: 'tenant_01',
  organizationId: 'org_01',
  dependency: 'stripe',
  operation: 'payment-intents.create',
  capturedAt,
  expiresAt: capturedAt + 60_000,
};
const requestId = 'req_1N8xY2A-safe:diagnostic';

function keyring(
  activeKeyId = 'incident-2026-07',
  keys: Readonly<Record<string, Uint8Array>> = {
    'incident-2026-07': Buffer.alloc(32, 0x17),
  },
): IncidentDiagnosticKeyring {
  return createIncidentDiagnosticKeyring(activeKeyId, keys);
}

function encrypt(): EncryptedProviderRequestId {
  return encryptExactProviderRequestId(requestId, context, keyring());
}

function cloneEncrypted(
  encrypted: EncryptedProviderRequestId,
  overrides: Partial<EncryptedProviderRequestId> = {},
): EncryptedProviderRequestId {
  return {
    ...encrypted,
    binding: { ...encrypted.binding },
    ...overrides,
  };
}

describe('incident diagnostic request ID encryption', () => {
  it('round-trips an exact request ID with its complete domain binding', () => {
    const encrypted = encrypt();

    expect(
      decryptExactProviderRequestId(encrypted, encrypted.binding, keyring(), { now: capturedAt }),
    ).toBe(requestId);
    expect(encrypted).toMatchObject({
      version: 1,
      algorithm: 'aes-256-gcm',
      keyId: 'incident-2026-07',
      binding: {
        ...context,
        requestIdHash: hashExactProviderRequestId(requestId),
      },
    });
    expect(Object.isFrozen(encrypted)).toBe(true);
    expect(Object.isFrozen(encrypted.binding)).toBe(true);
  });

  it('uses a fresh random nonce for every encryption', () => {
    const first = encrypt();
    const second = encrypt();

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('does not serialize the exact provider request ID into ciphertext metadata', () => {
    const encrypted = encrypt();
    const serialized = JSON.stringify(encrypted);

    expect(serialized).not.toContain(requestId);
    expect(Buffer.from(encrypted.ciphertext, 'base64url').toString('utf8')).not.toContain(
      requestId,
    );
  });

  it.each([
    ['evidence', { evidenceId: 'pie_02HZZZZZZZZZZZZZZZZZZZZZZZ' }],
    ['tenant', { tenantId: 'tenant_02' }],
    ['organization', { organizationId: 'org_02' }],
    ['provider', { dependency: 'resend' }],
    ['operation', { operation: 'refunds.create' }],
    ['request hash', { requestIdHash: `sha256:${'0'.repeat(64)}` }],
    ['capture timestamp', { capturedAt: capturedAt + 1 }],
    ['expiry timestamp', { expiresAt: context.expiresAt + 1 }],
  ] satisfies ReadonlyArray<[string, Partial<IncidentDiagnosticBinding>]>)(
    'rejects a wrong %s binding',
    (_label, override) => {
      const encrypted = encrypt();
      const wrongBinding = { ...encrypted.binding, ...override };
      const reboundCiphertext = cloneEncrypted(encrypted, { binding: wrongBinding });

      expect(() =>
        decryptExactProviderRequestId(reboundCiphertext, wrongBinding, keyring(), {
          now: capturedAt,
        }),
      ).toThrow(IncidentDiagnosticDecryptionError);
    },
  );

  it.each(['nonce', 'ciphertext', 'authenticationTag'] as const)(
    'rejects tampering with the %s',
    (field) => {
      const encrypted = encrypt();
      const current = encrypted[field];
      const replacement = `${current[0] === 'A' ? 'B' : 'A'}${current.slice(1)}`;
      const tampered = cloneEncrypted(encrypted, { [field]: replacement });

      expect(() =>
        decryptExactProviderRequestId(tampered, encrypted.binding, keyring(), { now: capturedAt }),
      ).toThrow(IncidentDiagnosticDecryptionError);
    },
  );

  it('rejects an unknown encryption key without revealing which check failed', () => {
    const encrypted = encrypt();
    const unavailableKeys = keyring('incident-2026-08', {
      'incident-2026-08': Buffer.alloc(32, 0x28),
    });

    expect(() =>
      decryptExactProviderRequestId(encrypted, encrypted.binding, unavailableKeys, {
        now: capturedAt,
      }),
    ).toThrow(new IncidentDiagnosticDecryptionError());
  });

  it('decrypts older records after an active-key rotation', () => {
    const oldKey = Buffer.alloc(32, 0x17);
    const newKey = Buffer.alloc(32, 0x28);
    const oldKeyring = keyring('incident-2026-07', { 'incident-2026-07': oldKey });
    const encrypted = encryptExactProviderRequestId(requestId, context, oldKeyring);
    const rotatedKeyring = keyring('incident-2026-08', {
      'incident-2026-07': oldKey,
      'incident-2026-08': newKey,
    });

    expect(
      decryptExactProviderRequestId(encrypted, encrypted.binding, rotatedKeyring, {
        now: capturedAt,
      }),
    ).toBe(requestId);
    expect(encryptExactProviderRequestId(requestId, context, rotatedKeyring).keyId).toBe(
      'incident-2026-08',
    );
  });

  it('rejects decryption after the bound expiry', () => {
    const encrypted = encrypt();

    expect(() =>
      decryptExactProviderRequestId(encrypted, encrypted.binding, keyring(), {
        now: context.expiresAt + 1,
      }),
    ).toThrow(IncidentDiagnosticDecryptionError);
  });
});

describe('incident diagnostic validation', () => {
  it.each([
    '',
    ' request',
    'request id',
    'request\tidentifier',
    'request\nidentifier',
    `request${String.fromCharCode(0)}identifier`,
    'réquest_identifier',
    'x'.repeat(256),
  ])('rejects malformed, oversized, control, whitespace, or Unicode request ID %j', (value) => {
    expect(() => validateExactProviderRequestId(value)).toThrow(IncidentDiagnosticValidationError);
  });

  it.each([
    ['short key', Buffer.alloc(31)],
    ['long key', Buffer.alloc(33)],
    ['non-byte key', 'x'.repeat(32)],
  ])('rejects a %s', (_label, key) => {
    expect(() =>
      createIncidentDiagnosticKeyring('incident-key', {
        'incident-key': key as unknown as Uint8Array,
      }),
    ).toThrow(IncidentDiagnosticValidationError);
  });

  it.each(['', ' key', 'key space', 'kéy', 'x'.repeat(65)])(
    'rejects invalid key ID %j',
    (keyId) => {
      expect(() => createIncidentDiagnosticKeyring(keyId, { [keyId]: randomBytes(32) })).toThrow(
        IncidentDiagnosticValidationError,
      );
    },
  );

  it('rejects a keyring with a missing active key', () => {
    expect(() =>
      createIncidentDiagnosticKeyring('incident-new', { 'incident-old': randomBytes(32) }),
    ).toThrow(IncidentDiagnosticValidationError);
  });

  it.each([
    ['empty evidence', { evidenceId: '' }],
    ['empty tenant', { tenantId: '' }],
    ['Unicode organization', { organizationId: 'örg_01' }],
    ['control dependency', { dependency: 'stripe\nother' }],
    ['oversized operation', { operation: 'x'.repeat(129) }],
  ] satisfies ReadonlyArray<[string, Partial<IncidentDiagnosticContext>]>)(
    'rejects %s',
    (_label, override) => {
      expect(() =>
        encryptExactProviderRequestId(requestId, { ...context, ...override }, keyring()),
      ).toThrow(IncidentDiagnosticValidationError);
    },
  );

  it.each([
    ['fractional capture', { capturedAt: capturedAt + 0.5 }],
    ['early capture', { capturedAt: Date.UTC(1999, 11, 31) }],
    ['late expiry', { expiresAt: Date.UTC(2100, 0, 1) + 1 }],
    ['expiry before capture', { expiresAt: capturedAt - 1 }],
    ['zero retention', { expiresAt: capturedAt }],
    ['sub-minute retention', { expiresAt: capturedAt + 59_999 }],
    ['excessive retention', { expiresAt: capturedAt + INCIDENT_DIAGNOSTIC_MAX_RETENTION_MS + 1 }],
  ] satisfies ReadonlyArray<[string, Partial<IncidentDiagnosticContext>]>)(
    'rejects %s',
    (_label, override) => {
      expect(() =>
        encryptExactProviderRequestId(requestId, { ...context, ...override }, keyring()),
      ).toThrow(IncidentDiagnosticValidationError);
    },
  );

  it('rejects invalid current timestamps on decrypt', () => {
    const encrypted = encrypt();

    expect(() =>
      decryptExactProviderRequestId(encrypted, encrypted.binding, keyring(), { now: Number.NaN }),
    ).toThrow(IncidentDiagnosticDecryptionError);
  });
});
