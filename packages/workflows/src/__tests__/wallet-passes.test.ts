import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAppleWalletPass,
  generateGoogleWalletPass,
  loadWalletPassConfig,
  type WalletPassTicketInput,
} from '../wallet-passes.js';

function testInput(): WalletPassTicketInput {
  return {
    passId: 'wps_test',
    ticketId: 'tkt_test',
    ticketCode: 'TK-TEST',
    ticketTypeName: 'General Admission',
    attendeeName: 'Ada Lovelace',
    qrPayload: 'tixkit:signed:qr',
    eventId: 'evt_test',
    eventTitle: 'Founders Summit',
    startsAt: '2027-05-12T18:30:00.000Z',
    timezone: 'America/New_York',
    venueName: 'Main Hall',
    brandName: 'Northstar Events',
    brandColor: '#1f6feb',
  };
}

function testCertificates() {
  const dir = mkdtempSync(join(tmpdir(), 'tixkit-wallet-pass-'));
  const keyPath = join(dir, 'signer.key');
  const certPath = join(dir, 'signer.crt');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=Tixkit Wallet Test',
  ]);

  const signerKey = readFileSync(keyPath, 'utf8');
  const signerCert = readFileSync(certPath, 'utf8');
  return { signerKey, signerCert, wwdr: signerCert };
}

describe('wallet pass generation', () => {
  it('fails closed in production when signing configuration is missing', () => {
    expect(() =>
      loadWalletPassConfig({
        NODE_ENV: 'production',
        API_BASE_URL: 'https://api.example.test',
      } as NodeJS.ProcessEnv),
    ).toThrow(/Wallet pass signing configuration is incomplete/);
  });

  it('generates an Apple pass manifest, signature, and QR barcode payload', () => {
    const certificates = testCertificates();
    const pass = createAppleWalletPass(testInput(), {
      passTypeIdentifier: 'pass.test.tixkit',
      teamIdentifier: 'TEAM123456',
      organizationName: 'Tixkit Test',
      ...certificates,
    });
    const raw = pass.getAsRaw();

    expect(Object.keys(raw)).toEqual(
      expect.arrayContaining(['pass.json', 'manifest.json', 'signature']),
    );
    expect(raw.signature.byteLength).toBeGreaterThan(64);

    const passJson = JSON.parse(raw['pass.json'].toString('utf8')) as {
      serialNumber: string;
      barcodes: Array<{ format: string; message: string; altText: string }>;
    };
    expect(passJson.serialNumber).toBe('tkt_test');
    expect(passJson.barcodes[0]).toMatchObject({
      format: 'PKBarcodeFormatQR',
      message: 'tixkit:signed:qr',
      altText: 'TK-TEST',
    });

    const manifest = JSON.parse(raw['manifest.json'].toString('utf8')) as Record<string, string>;
    const passJsonSha1 = createHash('sha1').update(raw['pass.json']).digest('hex');
    expect(manifest['pass.json']).toBe(passJsonSha1);
  });

  it('generates a signed Google Wallet save URL with an event ticket barcode', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const artifact = generateGoogleWalletPass(testInput(), {
      issuerId: 'issuer123',
      classSuffix: 'tixkit_event',
      serviceAccountEmail: 'wallet@example.iam.gserviceaccount.com',
      privateKey: privatePem,
      origins: ['checkout.example.test'],
    });

    const token = artifact.passUrl.replace('https://pay.google.com/gp/v/save/', '');
    const [header, payload, signature] = token.split('.');
    const verified = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iss: string;
      aud: string;
      typ: string;
      payload: {
        eventTicketObjects: Array<{
          barcode: { type: string; value: string; alternateText: string };
          ticketNumber: string;
        }>;
      };
    };

    expect(verified).toBe(true);
    expect(claims).toMatchObject({
      iss: 'wallet@example.iam.gserviceaccount.com',
      aud: 'google',
      typ: 'savetowallet',
    });
    expect(claims.payload.eventTicketObjects[0].barcode).toMatchObject({
      type: 'QR_CODE',
      value: 'tixkit:signed:qr',
      alternateText: 'TK-TEST',
    });
  });
});
