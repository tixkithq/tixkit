import { describe, it, expect } from 'vitest';
import { QrService } from '../services/qr.js';

describe('QrService', () => {
  const qrService = new QrService('test-secret-key');

  it('should generate a signed QR payload', () => {
    const result = qrService.generate('tkt_123');
    expect(result.ticketId).toBe('tkt_123');
    expect(result.code).toMatch(/^GK-[A-F0-9]+$/);
    expect(result.payload).toBeTruthy();
    expect(result.hash).toHaveLength(64);
  });

  it('should verify a valid QR payload', () => {
    const generated = qrService.generate('tkt_456');
    const verification = qrService.getQrPayload(generated.payload);
    expect(verification).toEqual({
      ticketId: 'tkt_456',
      code: generated.code,
      valid: true,
    });
    expect(qrService.hashPayload(generated.payload)).toBe(generated.hash);
  });

  it('should generate unique codes', () => {
    const r1 = qrService.generate('tkt_1');
    const r2 = qrService.generate('tkt_2');
    expect(r1.code).not.toBe(r2.code);
    expect(r1.hash).not.toBe(r2.hash);
  });

  it('should reject tampered QR payloads', () => {
    const generated = qrService.generate('tkt_789');
    const decoded = JSON.parse(Buffer.from(generated.payload, 'base64url').toString()) as {
      p: string;
      s: string;
    };
    const parsed = JSON.parse(decoded.p) as Record<string, unknown>;
    parsed.ticketId = 'tkt_attacker';
    const tampered = Buffer.from(JSON.stringify({ p: JSON.stringify(parsed), s: decoded.s })).toString('base64url');
    const result = qrService.getQrPayload(tampered);
    expect(result.valid).toBe(false);
  });
});
