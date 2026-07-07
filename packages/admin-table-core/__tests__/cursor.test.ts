import { describe, it, expect } from 'vitest';
import {
  encodeCursor,
  decodeCursor,
  base64urlEncode,
  base64urlDecode,
  CursorError,
  isCursorError,
  DEFAULT_CURSOR_VERSION,
} from '../src/index.js';

describe('base64url', () => {
  it('encodes and decodes round-trip', () => {
    const input = '{"hello":"world","num":42}';
    const encoded = base64urlEncode(input);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(base64urlDecode(encoded)).toBe(input);
  });

  it('handles unicode', () => {
    const input = 'héllo wörld 日本語';
    const encoded = base64urlEncode(input);
    expect(base64urlDecode(encoded)).toBe(input);
  });

  it('handles empty string', () => {
    const encoded = base64urlEncode('');
    expect(base64urlDecode(encoded)).toBe('');
  });
});

describe('encodeCursor', () => {
  it('produces a version-prefixed cursor', () => {
    const cursor = encodeCursor(
      [{ field: 'createdAt', direction: 'desc', value: '2026-01-01T00:00:00Z' }],
      'order_123',
    );
    expect(cursor).toMatch(/^v1\./);
  });

  it('encodes multiple sort entries', () => {
    const cursor = encodeCursor(
      [
        { field: 'status', direction: 'asc', value: 'paid' },
        { field: 'createdAt', direction: 'desc', value: '2026-01-01T00:00:00Z' },
      ],
      'order_456',
    );
    const decoded = decodeCursor(cursor);
    expect(decoded.s).toHaveLength(2);
    expect(decoded.s[0].f).toBe('status');
    expect(decoded.s[1].f).toBe('createdAt');
    expect(decoded.id).toBe('order_456');
  });

  it('supports custom version', () => {
    const cursor = encodeCursor([{ field: 'createdAt', direction: 'desc', value: 123 }], 'id_1', 2);
    expect(cursor).toMatch(/^v2\./);
    const decoded = decodeCursor(cursor);
    expect(decoded.v).toBe(2);
  });
});

describe('decodeCursor', () => {
  it('round-trips encode/decode', () => {
    const entries = [
      { field: 'createdAt', direction: 'desc' as const, value: '2026-07-05T10:00:00Z' },
      { field: 'totalCents', direction: 'asc' as const, value: 5000 },
    ];
    const cursor = encodeCursor(entries, 'order_abc');
    const decoded = decodeCursor(cursor);

    expect(decoded.v).toBe(DEFAULT_CURSOR_VERSION);
    expect(decoded.id).toBe('order_abc');
    expect(decoded.s).toHaveLength(2);
    expect(decoded.s[0]).toEqual({ f: 'createdAt', d: 'desc', v: '2026-07-05T10:00:00Z' });
    expect(decoded.s[1]).toEqual({ f: 'totalCents', d: 'asc', v: 5000 });
  });

  it('throws on missing version prefix', () => {
    expect(() => decodeCursor('abc123')).toThrow(CursorError);
  });

  it('throws on malformed version prefix', () => {
    expect(() => decodeCursor('x1.abc')).toThrow(CursorError);
  });

  it('throws on version mismatch when expectedVersion is provided', () => {
    const cursor = encodeCursor([{ field: 'createdAt', direction: 'desc', value: 'x' }], 'id_1', 1);
    expect(() => decodeCursor(cursor, 2)).toThrow(CursorError);
    expect(() => decodeCursor(cursor, 2)).toThrow('version mismatch');
  });

  it('throws on invalid base64', () => {
    expect(() => decodeCursor('v1.!!!invalid!!!')).toThrow(CursorError);
  });

  it('throws on invalid JSON payload', () => {
    const badB64 = base64urlEncode('not json');
    expect(() => decodeCursor(`v1.${badB64}`)).toThrow(CursorError);
  });

  it('throws when payload version does not match prefix version', () => {
    // Manually craft a cursor where the payload version is wrong
    const payload = JSON.stringify({ v: 99, s: [], id: 'x' });
    const cursor = `v1.${base64urlEncode(payload)}`;
    expect(() => decodeCursor(cursor)).toThrow(CursorError);
  });

  it('throws when payload is missing required fields', () => {
    const payload = JSON.stringify({ v: 1 });
    const cursor = `v1.${base64urlEncode(payload)}`;
    expect(() => decodeCursor(cursor)).toThrow(CursorError);
  });
});

describe('isCursorError', () => {
  it('returns true for CursorError instances', () => {
    const error = new CursorError('test');
    expect(isCursorError(error)).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isCursorError(new Error('test'))).toBe(false);
    expect(isCursorError(null)).toBe(false);
    expect(isCursorError('string')).toBe(false);
  });
});
