export type OfflineManifestTicketStatus =
  | 'valid'
  | 'checked_in'
  | 'void'
  | 'refunded'
  | 'transferred';

export type OfflineManifestTicket = {
  ticketId: string;
  ticketTypeId: string;
  eventOccurrenceId?: string;
  attendeeName: string;
  qrHash: string;
  status: OfflineManifestTicketStatus;
};

export type OfflineManifestLegacyTicket = Omit<OfflineManifestTicket, 'status'> & {
  status: string;
};

export type OfflineManifestTicketDisposition = 'candidate' | 'duplicate' | 'revoked' | 'invalid';

export function classifyOfflineManifestTicketStatus(
  status: unknown,
): OfflineManifestTicketDisposition {
  if (status === 'valid') return 'candidate';
  if (status === 'checked_in') return 'duplicate';
  if (status === 'void' || status === 'refunded' || status === 'transferred') return 'revoked';
  return 'invalid';
}

export type OfflineManifestV1 = {
  eventId: string;
  checkInListId: string;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  tickets: OfflineManifestLegacyTicket[];
};

export type OfflineManifestV2Payload = {
  version: 2;
  algorithm: 'ES256';
  issuer: string;
  tenantId: string;
  eventId: string;
  checkInListId: string;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  tickets: OfflineManifestTicket[];
};

export type OfflineManifestV2 = OfflineManifestV2Payload & {
  signature: string;
};

export type OfflineManifest = OfflineManifestV1 | OfflineManifestV2;

export type OfflineManifestVerificationKey = {
  keyId: string;
  algorithm: 'ES256';
  publicKey: {
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
  };
  notBefore: string;
  notAfter: string;
};

export type OfflineManifestVerificationKeySet = {
  version: 1;
  issuer: string;
  keys: OfflineManifestVerificationKey[];
};

export type OfflineManifestEnvelopeContext = {
  now: Date;
  expectedIssuer: string;
  expectedTenantId: string;
  expectedEventId: string;
  expectedCheckInListId: string;
  maxFutureSkewMs?: number;
  maxManifestTtlMs?: number;
};

function exactInstant(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function isCanonicalP256Coordinate(value: string): boolean {
  return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value);
}

export function validateOfflineManifestV2Envelope(
  manifest: OfflineManifest,
  keySet: OfflineManifestVerificationKeySet,
  context: OfflineManifestEnvelopeContext,
): OfflineManifestVerificationKey | null {
  if (!('version' in manifest) || manifest.version !== 2 || manifest.algorithm !== 'ES256') {
    return null;
  }
  if (
    keySet.version !== 1 ||
    manifest.issuer !== context.expectedIssuer ||
    manifest.issuer !== keySet.issuer ||
    manifest.tenantId !== context.expectedTenantId ||
    manifest.eventId !== context.expectedEventId ||
    manifest.checkInListId !== context.expectedCheckInListId ||
    !/^[A-Za-z0-9_-]{86}$/.test(manifest.signature) ||
    manifest.tickets.some(
      (ticket) => classifyOfflineManifestTicketStatus(ticket.status) === 'invalid',
    )
  ) {
    return null;
  }
  const generatedAt = exactInstant(manifest.generatedAt);
  const expiresAt = exactInstant(manifest.expiresAt);
  const now = context.now.getTime();
  const maxFutureSkewMs = context.maxFutureSkewMs ?? 5 * 60 * 1000;
  const maxManifestTtlMs = context.maxManifestTtlMs ?? 24 * 60 * 60 * 1000;
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(maxFutureSkewMs) ||
    maxFutureSkewMs < 0 ||
    !Number.isSafeInteger(maxManifestTtlMs) ||
    maxManifestTtlMs <= 0 ||
    generatedAt === null ||
    expiresAt === null ||
    expiresAt <= generatedAt ||
    expiresAt <= now ||
    generatedAt > now + maxFutureSkewMs ||
    expiresAt - generatedAt > maxManifestTtlMs
  ) {
    return null;
  }
  const key = keySet.keys.find((candidate) => candidate.keyId === manifest.keyId);
  if (
    !key ||
    key.algorithm !== 'ES256' ||
    key.publicKey.kty !== 'EC' ||
    key.publicKey.crv !== 'P-256' ||
    !isCanonicalP256Coordinate(key.publicKey.x) ||
    !isCanonicalP256Coordinate(key.publicKey.y)
  ) {
    return null;
  }
  const notBefore = exactInstant(key.notBefore);
  const notAfter = exactInstant(key.notAfter);
  if (notBefore === null || notAfter === null || generatedAt < notBefore || expiresAt > notAfter) {
    return null;
  }
  return key;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/**
 * Stable signing bytes for the V2 offline-manifest protocol. Arrays retain
 * their order; object keys are recursively sorted by UTF-16 code units and
 * undefined fields are omitted. Signers and verifiers must use this exact
 * function. The ES256 signature is the unpadded base64url encoding of the
 * 64-byte IEEE-P1363 r||s value, never an ASN.1 DER signature.
 */
export function canonicalOfflineManifestPayload(payload: OfflineManifestV2Payload): string {
  return JSON.stringify(canonicalize(payload));
}

export function unsignedOfflineManifestV2(manifest: OfflineManifestV2): OfflineManifestV2Payload {
  const { signature: _signature, ...payload } = manifest;
  return payload;
}
