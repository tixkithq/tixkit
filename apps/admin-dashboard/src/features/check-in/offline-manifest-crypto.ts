import {
  canonicalOfflineManifestPayload,
  unsignedOfflineManifestV2,
  validateOfflineManifestV2Envelope,
  type OfflineManifest,
  type OfflineManifestVerificationKeySet,
} from '@tixkit/domain/offline-checkin';

export type OfflineManifestBrowserVerificationContext = {
  apiOrigin: string;
  tenantId: string;
  eventId: string;
  checkInListId: string;
  now?: Date;
  maxFutureSkewMs?: number;
  maxManifestTtlMs?: number;
};

function canonicalBase64UrlBytes(value: string, expectedLength: number): Uint8Array | null {
  if (!new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((expectedLength * 4) / 3)}}$`).test(value)) {
    return null;
  }
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(`${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const roundTrip = btoa(String.fromCharCode(...bytes))
      .replace(/=+$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return bytes.length === expectedLength && roundTrip === value ? bytes : null;
  } catch {
    return null;
  }
}

export async function verifyOfflineManifestForBrowser(
  manifest: OfflineManifest,
  keySet: OfflineManifestVerificationKeySet,
  context: OfflineManifestBrowserVerificationContext,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<boolean> {
  try {
    const expectedOrigin = new URL(context.apiOrigin).origin;
    if (context.apiOrigin !== expectedOrigin) return false;
    const key = validateOfflineManifestV2Envelope(manifest, keySet, {
      now: context.now ?? new Date(),
      expectedIssuer: expectedOrigin,
      expectedTenantId: context.tenantId,
      expectedEventId: context.eventId,
      expectedCheckInListId: context.checkInListId,
      maxFutureSkewMs: context.maxFutureSkewMs,
      maxManifestTtlMs: context.maxManifestTtlMs,
    });
    if (!key || !('version' in manifest)) return false;
    const signature = canonicalBase64UrlBytes(manifest.signature, 64);
    if (!signature) return false;
    const publicKey = await subtle.importKey(
      'jwk',
      {
        ...key.publicKey,
        alg: 'ES256',
        ext: true,
        key_ops: ['verify'],
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature.buffer as ArrayBuffer,
      new TextEncoder().encode(
        canonicalOfflineManifestPayload(unsignedOfflineManifestV2(manifest)),
      ),
    );
  } catch {
    return false;
  }
}
