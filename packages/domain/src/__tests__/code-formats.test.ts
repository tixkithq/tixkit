import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { QrService } from '../tickets/index.js';
import {
  SCANNER_CONTRACT_VERSION,
  DEFAULT_CODE_FORMAT,
  generateSignedPayloadV1,
  generateCompactPayloadV2,
  generateCodePayload,
  verifyCodePayload,
  generateRotatingCode,
  verifyRotatingCode,
  hashPayload,
} from '../tickets/code-formats.js';

const KEY = 'test-signing-key';
const TICKET_ID = 'tkt_123';
const CODE = 'TK-ABC123';

describe('scanner contract version', () => {
  it('exposes a stable contract version string', () => {
    expect(SCANNER_CONTRACT_VERSION).toMatch(/^2026-/);
    expect(DEFAULT_CODE_FORMAT).toEqual({ symbology: 'qr', payloadFormat: 'signed_v1' });
  });
});

describe('signed_v1 payload (parity with QrService)', () => {
  it('produces base64url(JSON({p, s})) with a valid HMAC signature', () => {
    const ts = 1_700_000_000_000;
    const { payload, hash } = generateSignedPayloadV1(TICKET_ID, CODE, KEY, ts);
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(decoded.p).toBe(JSON.stringify({ ticketId: TICKET_ID, code: CODE, ts }));
    expect(decoded.s).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashPayload(payload));
  });

  it('is byte-identical to QrService.generate for the same inputs', () => {
    const ts = 1_700_000_000_000;
    const { payload, hash } = generateSignedPayloadV1(TICKET_ID, CODE, KEY, ts);
    // Reproduce QrService.generate exactly (it uses the same canonical format).
    const signedPayload = JSON.stringify({ ticketId: TICKET_ID, code: CODE, ts });
    const signature = createHmac('sha256', KEY).update(signedPayload).digest('hex');
    const expectedPayload = Buffer.from(
      JSON.stringify({ p: signedPayload, s: signature }),
    ).toString('base64url');
    expect(payload).toBe(expectedPayload);
    expect(hash).toBe(createHash('sha256').update(expectedPayload).digest('hex'));
  });

  it('verifies a valid signed_v1 payload and rejects a tampered one', () => {
    const ts = Date.now();
    const { payload } = generateSignedPayloadV1(TICKET_ID, CODE, KEY, ts);
    const result = verifyCodePayload(payload, KEY);
    expect(result.valid).toBe(true);
    expect(result.ticketId).toBe(TICKET_ID);
    expect(result.code).toBe(CODE);
    expect(result.format).toBe('signed_v1');

    // Tampered payload (flip a char) is invalid.
    const tampered = payload.slice(0, -2) + (payload.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyCodePayload(tampered, KEY).valid).toBe(false);
  });

  it('rejects a payload signed with a different key', () => {
    const { payload } = generateSignedPayloadV1(TICKET_ID, CODE, KEY);
    expect(verifyCodePayload(payload, 'wrong-key').valid).toBe(false);
  });
});

describe('compact_v2 payload', () => {
  it('produces a denser base64url encoding with a valid signature', () => {
    const ts = 1_700_000_000_000;
    const { payload, hash } = generateCompactPayloadV2(TICKET_ID, CODE, KEY, ts);
    const decoded = Buffer.from(payload, 'base64url').toString();
    expect(decoded).toContain(`${TICKET_ID}.${CODE}.${ts}.`);
    expect(hash).toBe(hashPayload(payload));
    // compact_v2 payload should be shorter than signed_v1 for the same inputs.
    const v1 = generateSignedPayloadV1(TICKET_ID, CODE, KEY, ts).payload;
    expect(payload.length).toBeLessThan(v1.length);
  });

  it('verifies a valid compact_v2 payload', () => {
    const { payload } = generateCompactPayloadV2(TICKET_ID, CODE, KEY);
    const result = verifyCodePayload(payload, KEY);
    expect(result.valid).toBe(true);
    expect(result.format).toBe('compact_v2');
    expect(result.ticketId).toBe(TICKET_ID);
  });

  it('generateCodePayload dispatches by format', () => {
    const v1 = generateCodePayload(
      { symbology: 'qr', payloadFormat: 'signed_v1' },
      TICKET_ID,
      CODE,
      KEY,
    );
    const v2 = generateCodePayload(
      { symbology: 'code128', payloadFormat: 'compact_v2' },
      TICKET_ID,
      CODE,
      KEY,
    );
    expect(verifyCodePayload(v1.payload, KEY).format).toBe('signed_v1');
    expect(verifyCodePayload(v2.payload, KEY).format).toBe('compact_v2');
  });
});

describe('rotating short-lived codes', () => {
  const config = { timeStepSeconds: 30, toleranceWindows: 1, digits: 6 };

  it('generates a 6-digit code that verifies in the current window', () => {
    const now = new Date(1_700_000_000_000);
    const { code, expiresAt } = generateRotatingCode(TICKET_ID, KEY, config, now);
    expect(code).toMatch(/^\d{6}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(now.getTime());
    expect(verifyRotatingCode(TICKET_ID, code, KEY, config, now)).toBe(true);
  });

  it('verifies within the tolerance window but not far outside it', () => {
    const now = new Date(1_700_000_000_000);
    const { code } = generateRotatingCode(TICKET_ID, KEY, config, now);
    // One step ahead (within tolerance=1) verifies.
    expect(
      verifyRotatingCode(TICKET_ID, code, KEY, config, new Date(now.getTime() + 30_000)),
    ).toBe(true);
    // One step behind (within tolerance=1) verifies.
    expect(
      verifyRotatingCode(TICKET_ID, code, KEY, config, new Date(now.getTime() - 30_000)),
    ).toBe(true);
    // Two steps ahead (outside tolerance=1) does not verify.
    expect(
      verifyRotatingCode(TICKET_ID, code, KEY, config, new Date(now.getTime() + 60_000)),
    ).toBe(false);
  });

  it('rejects a rotating code signed with a different key', () => {
    const now = new Date(1_700_000_000_000);
    const { code } = generateRotatingCode(TICKET_ID, KEY, config, now);
    expect(verifyRotatingCode(TICKET_ID, code, 'wrong-key', config, now)).toBe(false);
  });

  it('different ticket ids produce different rotating codes in the same window', () => {
    const now = new Date(1_700_000_000_000);
    const a = generateRotatingCode('tkt_a', KEY, config, now).code;
    const b = generateRotatingCode('tkt_b', KEY, config, now).code;
    expect(a).not.toBe(b);
  });

  it('rejects wrong-length codes', () => {
    const now = new Date(1_700_000_000_000);
    expect(verifyRotatingCode(TICKET_ID, '123', KEY, config, now)).toBe(false);
  });
});

describe('QrService integration (no weakening)', () => {
  it('QrService payloads still verify through the shared verifier', () => {
    const qr = new QrService(KEY).generate(TICKET_ID);
    const result = verifyCodePayload(qr.payload, KEY);
    expect(result.valid).toBe(true);
    expect(result.ticketId).toBe(TICKET_ID);
    expect(result.format).toBe('signed_v1');
    expect(result.code).toBe(qr.code);
  });
});
