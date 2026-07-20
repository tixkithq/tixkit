import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import {
  canonicalOfflineManifestPayload,
  classifyOfflineManifestTicketStatus,
  unsignedOfflineManifestV2,
  validateOfflineManifestV2Envelope,
  type OfflineManifestEnvelopeContext,
  type OfflineManifestTicket,
  type OfflineManifestLegacyTicket,
  type OfflineManifestV1,
  type OfflineManifestV2,
  type OfflineManifestV2Payload,
  type OfflineManifestVerificationKeySet,
} from '@tixkit/domain/offline-checkin';

export type OfflineManifestTicketRow = {
  ticket_id: string;
  ticket_type_id: string;
  event_occurrence_id?: string | null;
  qr_hash: string;
  status: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
};

type ConfiguredPrivateKey = {
  keyId: string;
  privateKeyPem: string;
  notBefore: string;
  notAfter: string;
};

type LoadedPrivateKey = {
  keyId: string;
  privateKey: KeyObject;
  publicKey: OfflineManifestVerificationKeySet['keys'][number]['publicKey'];
  notBefore: string;
  notAfter: string;
};

type SigningKeyRegistry = {
  issuer: string;
  activeKeyId: string;
  keys: LoadedPrivateKey[];
};

export type OfflineManifestVerificationContext = OfflineManifestEnvelopeContext & {
  keySet: OfflineManifestVerificationKeySet;
};

const DEV_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguuqSuoL6HAyrMjU7
QqbeBD0vTTJjUyVvjYCenHz2YnahRANCAATBXJgyEdtghsSJWFjGH55lEfbPnMZk
I3FQVU+ihGu0ZWb3laTbq8k9W2H2B3BIZ+BLtbL6QRIsfcYecnFXq+W4
-----END PRIVATE KEY-----`;
const DEV_KEY_ID = 'manifest-v2-dev-only';
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function legacyManifestTickets(rows: OfflineManifestTicketRow[]): OfflineManifestLegacyTicket[] {
  return rows.map((row) => ({
    ticketId: row.ticket_id,
    ticketTypeId: row.ticket_type_id,
    ...(row.event_occurrence_id ? { eventOccurrenceId: row.event_occurrence_id } : {}),
    attendeeName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
    qrHash: row.qr_hash,
    status: row.status,
  }));
}

function manifestTickets(rows: OfflineManifestTicketRow[]): OfflineManifestTicket[] {
  return rows.map((row) => {
    if (classifyOfflineManifestTicketStatus(row.status) === 'invalid') {
      throw new Error(`Unsupported offline manifest ticket status: ${row.status}`);
    }
    return {
      ticketId: row.ticket_id,
      ticketTypeId: row.ticket_type_id,
      ...(row.event_occurrence_id ? { eventOccurrenceId: row.event_occurrence_id } : {}),
      attendeeName: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
      qrHash: row.qr_hash,
      status: row.status as OfflineManifestTicket['status'],
    };
  });
}

function parseInstant(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${field} must be an ISO 8601 UTC instant`);
  }
  return timestamp;
}

function parseConfiguredKeys(raw: string): ConfiguredPrivateKey[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON must be valid JSON');
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON must be a non-empty array');
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Offline manifest signing key at index ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.keyId !== 'string' ||
      typeof candidate.privateKeyPem !== 'string' ||
      typeof candidate.notBefore !== 'string' ||
      typeof candidate.notAfter !== 'string'
    ) {
      throw new Error(`Offline manifest signing key at index ${index} is incomplete`);
    }
    return {
      keyId: candidate.keyId,
      privateKeyPem: candidate.privateKeyPem,
      notBefore: candidate.notBefore,
      notAfter: candidate.notAfter,
    };
  });
}

function loadPrivateKey(config: ConfiguredPrivateKey): LoadedPrivateKey {
  if (!KEY_ID_PATTERN.test(config.keyId)) {
    throw new Error(`Invalid offline manifest keyId: ${config.keyId}`);
  }
  const notBefore = parseInstant(
    config.notBefore,
    `Offline manifest key ${config.keyId} notBefore`,
  );
  const notAfter = parseInstant(config.notAfter, `Offline manifest key ${config.keyId} notAfter`);
  if (notAfter <= notBefore) {
    throw new Error(`Offline manifest key ${config.keyId} notAfter must be after notBefore`);
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(config.privateKeyPem);
  } catch {
    throw new Error(`Offline manifest key ${config.keyId} is not a valid private key`);
  }
  if (privateKey.asymmetricKeyType !== 'ec') {
    throw new Error(`Offline manifest key ${config.keyId} must be an EC private key`);
  }
  const details = privateKey.asymmetricKeyDetails;
  if (details?.namedCurve !== 'prime256v1') {
    throw new Error(`Offline manifest key ${config.keyId} must use P-256`);
  }
  const exported = createPublicKey(privateKey).export({ format: 'jwk' }) as JsonWebKey;
  if (
    exported.kty !== 'EC' ||
    exported.crv !== 'P-256' ||
    typeof exported.x !== 'string' ||
    typeof exported.y !== 'string'
  ) {
    throw new Error(`Offline manifest key ${config.keyId} did not produce a P-256 public key`);
  }
  return {
    keyId: config.keyId,
    privateKey,
    publicKey: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y },
    notBefore: config.notBefore,
    notAfter: config.notAfter,
  };
}

export function loadOfflineManifestSigningRegistry(
  environment: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  options: { requireActiveManifestLifetime?: boolean } = {},
): SigningKeyRegistry {
  const configuredKeys =
    environment.OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON?.trim() || undefined;
  const production = environment.NODE_ENV === 'production';
  if (!configuredKeys && production) {
    throw new Error('OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON is required in production');
  }

  const apiBaseUrl = environment.API_BASE_URL ?? (production ? '' : 'http://localhost:4000');
  let issuer: string;
  try {
    const parsed = new URL(apiBaseUrl);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.origin.length > 512
    ) {
      throw new Error('invalid origin');
    }
    issuer = parsed.origin;
  } catch {
    throw new Error('API_BASE_URL must be an exact HTTP(S) origin for offline manifest signing');
  }
  const keys = (
    configuredKeys
      ? parseConfiguredKeys(configuredKeys)
      : [
          {
            keyId: DEV_KEY_ID,
            privateKeyPem: DEV_PRIVATE_KEY,
            notBefore: '2020-01-01T00:00:00.000Z',
            notAfter: '2100-01-01T00:00:00.000Z',
          },
        ]
  ).map(loadPrivateKey);
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error('Offline manifest signing key IDs must be unique');
  }
  const activeKeyId =
    environment.OFFLINE_MANIFEST_ACTIVE_KEY_ID?.trim() || (production ? '' : DEV_KEY_ID);
  if (!activeKeyId || !keys.some((key) => key.keyId === activeKeyId)) {
    throw new Error('OFFLINE_MANIFEST_ACTIVE_KEY_ID must identify a configured signing key');
  }
  const activeKey = keys.find((key) => key.keyId === activeKeyId)!;
  if (
    options.requireActiveManifestLifetime !== false &&
    (
    Date.parse(activeKey.notBefore) > now.getTime() ||
    Date.parse(activeKey.notAfter) < now.getTime() + 24 * 60 * 60 * 1000
    )
  ) {
    throw new Error(
      'OFFLINE_MANIFEST_ACTIVE_KEY_ID must be valid now and for the complete 24-hour manifest lifetime',
    );
  }
  return { issuer, activeKeyId, keys };
}

function getLegacyManifestSigningKey(): string {
  const configuredKey = process.env.OFFLINE_MANIFEST_SIGNING_KEY ?? process.env.QR_SIGNING_SECRET;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('OFFLINE_MANIFEST_SIGNING_KEY or QR_SIGNING_SECRET is required in production');
  }
  return configuredKey ?? 'tixkit-manifest-secret-dev-only';
}

export function buildOfflineManifestV1(input: {
  eventId: string;
  checkInListId: string;
  rows: OfflineManifestTicketRow[];
  generatedAt?: Date;
  ttlMs?: number;
}): OfflineManifestV1 {
  const generatedAt = input.generatedAt ?? new Date();
  const expiresAt = new Date(generatedAt.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1000));
  const payload = {
    eventId: input.eventId,
    checkInListId: input.checkInListId,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    keyId: process.env.OFFLINE_MANIFEST_KEY_ID ?? 'manifest:v1',
    tickets: legacyManifestTickets(input.rows),
  };
  return {
    ...payload,
    signature: createHmac('sha256', getLegacyManifestSigningKey())
      .update(JSON.stringify(payload))
      .digest('hex'),
  };
}

export function verifyOfflineManifestV1(manifest: OfflineManifestV1): boolean {
  if (!/^[0-9a-f]{64}$/i.test(manifest.signature)) return false;
  const { signature, ...payload } = manifest;
  const expected = createHmac('sha256', getLegacyManifestSigningKey())
    .update(JSON.stringify(payload))
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function buildOfflineManifestV2(input: {
  tenantId: string;
  eventId: string;
  checkInListId: string;
  rows: OfflineManifestTicketRow[];
  generatedAt?: Date;
  ttlMs?: number;
  registry?: SigningKeyRegistry;
}): OfflineManifestV2 {
  const registry = input.registry ?? loadOfflineManifestSigningRegistry();
  const generatedAt = input.generatedAt ?? new Date();
  const ttlMs = input.ttlMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) {
    throw new Error('Offline manifest V2 TTL must be an integer from 1ms through 24 hours');
  }
  const expiresAt = new Date(generatedAt.getTime() + ttlMs);
  const key = registry.keys.find((candidate) => candidate.keyId === registry.activeKeyId);
  if (!key) throw new Error('Active offline manifest signing key is unavailable');
  const generatedAtMs = generatedAt.getTime();
  const expiresAtMs = expiresAt.getTime();
  if (
    generatedAtMs < Date.parse(key.notBefore) ||
    generatedAtMs >= Date.parse(key.notAfter) ||
    expiresAtMs > Date.parse(key.notAfter)
  ) {
    throw new Error('Active offline manifest signing key is not valid for the manifest lifetime');
  }
  const payload: OfflineManifestV2Payload = {
    version: 2,
    algorithm: 'ES256',
    issuer: registry.issuer,
    tenantId: input.tenantId,
    eventId: input.eventId,
    checkInListId: input.checkInListId,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    keyId: key.keyId,
    tickets: manifestTickets(input.rows),
  };
  const signature = signBytes('sha256', Buffer.from(canonicalOfflineManifestPayload(payload)), {
    key: key.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { ...payload, signature };
}

export function offlineManifestVerificationKeySet(
  registry: SigningKeyRegistry = loadOfflineManifestSigningRegistry(process.env, new Date(), {
    requireActiveManifestLifetime: false,
  }),
): OfflineManifestVerificationKeySet {
  return {
    version: 1,
    issuer: registry.issuer,
    keys: registry.keys.map((key) => ({
      keyId: key.keyId,
      algorithm: 'ES256',
      publicKey: key.publicKey,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    })),
  };
}

export function verifyOfflineManifestV2(
  manifest: OfflineManifestV2,
  context: OfflineManifestVerificationContext,
): boolean {
  try {
    const key = validateOfflineManifestV2Envelope(manifest, context.keySet, context);
    if (!key) return false;
    const signature = Buffer.from(manifest.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== manifest.signature) {
      return false;
    }
    const publicKey = createPublicKey({
      key: { ...key.publicKey, ext: true },
      format: 'jwk',
    });
    return verifyBytes(
      'sha256',
      Buffer.from(canonicalOfflineManifestPayload(unsignedOfflineManifestV2(manifest))),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  } catch {
    return false;
  }
}
