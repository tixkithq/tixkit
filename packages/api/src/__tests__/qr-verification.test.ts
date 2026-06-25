import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { QrService } from '../services/qr.js';

const SIGNING_KEY = 'test-signing-key-for-verification';

function makeSignedPayload(ticketId: string, code: string, key: string = SIGNING_KEY): string {
  const payload = JSON.stringify({ ticketId, code, ts: Date.now() });
  const signature = createHmac('sha256', key).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: signature })).toString('base64url');
}

describe('QrService verification', () => {
  const qrService = new QrService(SIGNING_KEY);

  describe('getQrPayload', () => {
    it('verifies a valid QR payload', () => {
      const generated = qrService.generate('tkt_abc');
      const qrPayload = makeSignedPayload('tkt_abc', generated.code);

      const result = qrService.getQrPayload(qrPayload);
      expect(result.valid).toBe(true);
      expect(result.ticketId).toBe('tkt_abc');
      expect(result.code).toBe(generated.code);
    });

    it('rejects tampered payload (modified ticketId)', () => {
      const payload = JSON.stringify({ ticketId: 'tkt_abc', code: 'GK-123456', ts: Date.now() });
      const signature = createHmac('sha256', SIGNING_KEY).update(payload).digest('hex');

      const tamperedPayload = JSON.stringify({ ticketId: 'tkt_hacked', code: 'GK-123456', ts: Date.now() });
      const qrPayload = Buffer.from(JSON.stringify({ p: tamperedPayload, s: signature })).toString('base64url');

      const result = qrService.getQrPayload(qrPayload);
      expect(result.valid).toBe(false);
    });

    it('rejects tampered signature', () => {
      const payload = JSON.stringify({ ticketId: 'tkt_abc', code: 'GK-123456', ts: Date.now() });
      const fakeSignature = 'a'.repeat(64);
      const qrPayload = Buffer.from(JSON.stringify({ p: payload, s: fakeSignature })).toString('base64url');

      const result = qrService.getQrPayload(qrPayload);
      expect(result.valid).toBe(false);
    });

    it('rejects invalid base64', () => {
      const result = qrService.getQrPayload('not-valid-base64!!!');
      expect(result.valid).toBe(false);
      expect(result.ticketId).toBe('');
    });

    it('rejects malformed JSON', () => {
      const result = qrService.getQrPayload(Buffer.from('not json').toString('base64url'));
      expect(result.valid).toBe(false);
    });

    it('rejects payload signed with wrong key', () => {
      const qrPayload = makeSignedPayload('tkt_abc', 'GK-123456', 'wrong-key');

      const result = qrService.getQrPayload(qrPayload);
      expect(result.valid).toBe(false);
    });

    it('rejects payload with missing signature field', () => {
      const payload = JSON.stringify({ ticketId: 'tkt_abc', code: 'GK-123456', ts: Date.now() });
      const qrPayload = Buffer.from(JSON.stringify({ p: payload })).toString('base64url');

      const result = qrService.getQrPayload(qrPayload);
      expect(result.valid).toBe(false);
    });

    it('rejects empty string', () => {
      const result = qrService.getQrPayload('');
      expect(result.valid).toBe(false);
    });
  });

  describe('hashPayload', () => {
    it('produces a deterministic 64-char hex hash', () => {
      const h1 = qrService.hashPayload('test-payload');
      const h2 = qrService.hashPayload('test-payload');
      expect(h1).toBe(h2);
      expect(h1).toHaveLength(64);
      expect(h1).toMatch(/^[0-9a-f]+$/);
    });

    it('produces different hashes for different payloads', () => {
      const h1 = qrService.hashPayload('payload-a');
      const h2 = qrService.hashPayload('payload-b');
      expect(h1).not.toBe(h2);
    });
  });

  describe('generate', () => {
    it('produces a code matching GK- format', () => {
      const result = qrService.generate('tkt_1');
      expect(result.code).toMatch(/^GK-[A-F0-9]+$/);
    });

    it('produces unique codes for different ticket IDs', () => {
      const r1 = qrService.generate('tkt_1');
      const r2 = qrService.generate('tkt_2');
      expect(r1.code).not.toBe(r2.code);
    });
  });
});
