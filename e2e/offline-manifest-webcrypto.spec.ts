import { createPrivateKey, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguuqSuoL6HAyrMjU7
QqbeBD0vTTJjUyVvjYCenHz2YnahRANCAATBXJgyEdtghsSJWFjGH55lEfbPnMZk
I3FQVU+ihGu0ZWb3laTbq8k9W2H2B3BIZ+BLtbL6QRIsfcYecnFXq+W4
-----END PRIVATE KEY-----`;

let server: Server;
let secureContextOrigin: string;

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Offline manifest WebCrypto contract</title>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  secureContextOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('verifies the V2 offline manifest P1363 contract in browser WebCrypto', async ({ page }) => {
  await page.goto(secureContextOrigin);
  const privateKey = createPrivateKey(PRIVATE_KEY);
  const privateJwk = privateKey.export({ format: 'jwk' }) as JsonWebKey;
  const publicJwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: privateJwk.x,
    y: privateJwk.y,
  };
  const canonicalPayload =
    '{"algorithm":"ES256","checkInListId":"cil_1","eventId":"evt_1","expiresAt":"2026-07-18T13:00:00.000Z","generatedAt":"2026-07-18T12:00:00.000Z","issuer":"https://api.example.test","keyId":"manifest-v2-dev-only","tenantId":"tnt_1","tickets":[{"attendeeName":"Åda Lovelace","qrHash":"hash_1","status":"valid","ticketId":"tkt_1","ticketTypeId":"tt_1"}],"version":2}';
  const signature = sign('sha256', Buffer.from(canonicalPayload), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');

  const result = await page.evaluate(
    async ({ canonicalPayload, publicJwk, signature }) => {
      const decode = (value: string) => {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(`${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`);
        return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      };
      const key = await crypto.subtle.importKey(
        'jwk',
        { ...publicJwk, alg: 'ES256', ext: true, key_ops: ['verify'] },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const signatureBytes = decode(signature);
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signatureBytes,
        new TextEncoder().encode(canonicalPayload),
      );
      const tampered = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        signatureBytes,
        new TextEncoder().encode(canonicalPayload.replace('tnt_1', 'tnt_2')),
      );
      return { valid, tampered, signatureBytes: signatureBytes.byteLength };
    },
    { canonicalPayload, publicJwk, signature },
  );

  expect(result).toEqual({ valid: true, tampered: false, signatureBytes: 64 });
});
