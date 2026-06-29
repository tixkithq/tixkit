/**
 * Configurable scanning-code formats (C-079).
 *
 * Builds on the existing HMAC-signed QR scheme (packages/domain/src/tickets
 * QrService) without weakening anti-forgery. Supports:
 * - Barcode symbology choice (rendering-only; the signed payload is identical).
 * - Signed payload format options: `signed_v1` (the existing `{p, s}` base64url
 *   contract used by every SDK scanner) and `compact_v2` (a denser encoding).
 * - Optional rotating short-lived codes (TOTP-style) derived from the same
 *   HMAC key, verified within a configurable time-window tolerance.
 *
 * Parity: `signed_v1` output is byte-identical to QrService.generate for the
 * same (ticketId, code, ts, key), so all RN/Flutter/iOS/Android offline
 * scanners that hash the payload string continue to match the manifest.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SCANNER_CONTRACT_VERSION = '2026-06-rotating-1';

export type BarcodeSymbology = 'qr' | 'code128' | 'pdf417' | 'aztec' | 'data_matrix';

export type PayloadFormat = 'signed_v1' | 'compact_v2';

export type RotatingCodeConfig = {
  /** TOTP time step in seconds. */
  timeStepSeconds: number;
  /** Number of windows to accept before/after the current window. */
  toleranceWindows: number;
  /** Digits in the rotating code. */
  digits?: number;
};

export type CodeFormat = {
  symbology: BarcodeSymbology;
  payloadFormat: PayloadFormat;
  rotating?: RotatingCodeConfig;
};

export const DEFAULT_CODE_FORMAT: CodeFormat = {
  symbology: 'qr',
  payloadFormat: 'signed_v1',
};

export type GeneratedCode = {
  ticketId: string;
  code: string;
  payload: string;
  hash: string;
  rotatingCode?: string;
  rotatingExpiresAt?: string;
};

export type CodeVerification = {
  ticketId: string;
  code: string;
  valid: boolean;
  format: PayloadFormat;
};

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashPayload(payload: string): string {
  return sha256Hex(payload);
}

/** The canonical signed_v1 payload: base64url(JSON({p, s})) — matches QrService. */
export function generateSignedPayloadV1(
  ticketId: string,
  code: string,
  key: string,
  ts: number = Date.now(),
): { payload: string; hash: string } {
  const signedPayload = JSON.stringify({ ticketId, code, ts });
  const signature = createHmac('sha256', key).update(signedPayload).digest('hex');
  const payload = Buffer.from(JSON.stringify({ p: signedPayload, s: signature })).toString(
    'base64url',
  );
  return { payload, hash: sha256Hex(payload) };
}

/**
 * compact_v2: base64url(`${ticketId}.${code}.${ts}.${sigHex}`) — denser than
 * the JSON wrapper while preserving the same HMAC signature over the same
 * canonical signed payload string (so verification logic is shared).
 */
export function generateCompactPayloadV2(
  ticketId: string,
  code: string,
  key: string,
  ts: number = Date.now(),
): { payload: string; hash: string } {
  const signedPayload = JSON.stringify({ ticketId, code, ts });
  const signature = createHmac('sha256', key).update(signedPayload).digest('hex');
  const payload = Buffer.from(`${ticketId}.${code}.${ts}.${signature}`).toString('base64url');
  return { payload, hash: sha256Hex(payload) };
}

export function generateCodePayload(
  format: CodeFormat,
  ticketId: string,
  code: string,
  key: string,
  ts: number = Date.now(),
): { payload: string; hash: string } {
  switch (format.payloadFormat) {
    case 'compact_v2':
      return generateCompactPayloadV2(ticketId, code, key, ts);
    case 'signed_v1':
    default:
      return generateSignedPayloadV1(ticketId, code, key, ts);
  }
}

function verifySignedPayloadV1(
  payload: string,
  key: string,
): { ticketId: string; code: string; valid: boolean } | null {
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      p?: unknown;
      s?: unknown;
    };
    if (typeof decoded.p !== 'string' || typeof decoded.s !== 'string') return null;
    const expected = createHmac('sha256', key).update(decoded.p).digest('hex');
    const valid =
      Buffer.from(decoded.s, 'hex').length === Buffer.from(expected, 'hex').length &&
      timingSafeEqual(Buffer.from(decoded.s, 'hex'), Buffer.from(expected, 'hex'));
    const parsed = JSON.parse(decoded.p) as { ticketId?: unknown; code?: unknown };
    if (typeof parsed.ticketId !== 'string' || typeof parsed.code !== 'string') return null;
    return { ticketId: parsed.ticketId, code: parsed.code, valid };
  } catch {
    return null;
  }
}

function verifyCompactPayloadV2(
  payload: string,
  key: string,
): { ticketId: string; code: string; valid: boolean } | null {
  try {
    const decoded = Buffer.from(payload, 'base64url').toString();
    const parts = decoded.split('.');
    if (parts.length !== 4) return null;
    const [ticketId, code, tsStr, signature] = parts;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return null;
    const signedPayload = JSON.stringify({ ticketId, code, ts });
    const expected = createHmac('sha256', key).update(signedPayload).digest('hex');
    const valid =
      Buffer.from(signature, 'hex').length === Buffer.from(expected, 'hex').length &&
      timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    return { ticketId, code, valid };
  } catch {
    return null;
  }
}

export function verifyCodePayload(payload: string, key: string): CodeVerification {
  const v1 = verifySignedPayloadV1(payload, key);
  if (v1) {
    return { ticketId: v1.ticketId, code: v1.code, valid: v1.valid, format: 'signed_v1' };
  }
  const v2 = verifyCompactPayloadV2(payload, key);
  if (v2) {
    return { ticketId: v2.ticketId, code: v2.code, valid: v2.valid, format: 'compact_v2' };
  }
  return { ticketId: '', code: '', valid: false, format: 'signed_v1' };
}

// ---- Rotating short-lived codes (TOTP-style) ----

function timeBucket(at: Date, timeStepSeconds: number): number {
  return Math.floor(at.getTime() / 1000 / timeStepSeconds);
}

/**
 * Generate a rotating numeric code derived from HMAC-SHA256(key, ticketId|bucket).
 * Returns the code and the absolute expiry of the current window.
 */
export function generateRotatingCode(
  ticketId: string,
  key: string,
  config: RotatingCodeConfig,
  at: Date = new Date(),
): { code: string; expiresAt: string } {
  const bucket = timeBucket(at, config.timeStepSeconds);
  const digits = config.digits ?? 6;
  const hmac = createHmac('sha256', key).update(`${ticketId}|${bucket}`).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = (binary % 10 ** digits).toString().padStart(digits, '0');
  const expiresAt = new Date((bucket + 1) * config.timeStepSeconds * 1000).toISOString();
  return { code, expiresAt };
}

export function verifyRotatingCode(
  ticketId: string,
  code: string,
  key: string,
  config: RotatingCodeConfig,
  at: Date = new Date(),
): boolean {
  const digits = config.digits ?? 6;
  if (code.length !== digits) return false;
  const currentBucket = timeBucket(at, config.timeStepSeconds);
  for (let offset = -config.toleranceWindows; offset <= config.toleranceWindows; offset += 1) {
    const candidateBucket = currentBucket + offset;
    const hmac = createHmac('sha256', key).update(`${ticketId}|${candidateBucket}`).digest();
    const offsetByte = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offsetByte] & 0x7f) << 24) |
      ((hmac[offsetByte + 1] & 0xff) << 16) |
      ((hmac[offsetByte + 2] & 0xff) << 8) |
      (hmac[offsetByte + 3] & 0xff);
    const candidate = (binary % 10 ** digits).toString().padStart(digits, '0');
    if (timingSafeEqual(Buffer.from(code), Buffer.from(candidate))) return true;
  }
  return false;
}
