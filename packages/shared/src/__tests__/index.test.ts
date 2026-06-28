import { describe, it, expect } from 'vitest';
import {
  generateId,
  hashString,
  signPayload,
  verifySignature,
  generateApiKey,
  signWebhookPayload,
  verifyWebhookSignature,
  paginate,
  maskApiKey,
} from '../index.js';

describe('Shared Utilities', () => {
  describe('generateId', () => {
    it('should generate prefixed IDs', () => {
      const id = generateId('evt');
      expect(id).toMatch(/^evt_/);
      expect(id.length).toBeGreaterThan(10);
    });

    it('should generate unique IDs', () => {
      const id1 = generateId('tkt');
      const id2 = generateId('tkt');
      expect(id1).not.toBe(id2);
    });
  });

  describe('hashString', () => {
    it('should produce consistent hashes', () => {
      expect(hashString('test')).toBe(hashString('test'));
    });

    it('should produce different hashes for different inputs', () => {
      expect(hashString('test1')).not.toBe(hashString('test2'));
    });
  });

  describe('signPayload / verifySignature', () => {
    const secret = 'test-secret';
    const payload = '{"event":"test"}';

    it('should verify valid signatures', () => {
      const signature = signPayload(payload, secret);
      expect(verifySignature(payload, signature, secret)).toBe(true);
    });

    it('should reject invalid signatures', () => {
      expect(verifySignature(payload, 'invalid-signature', secret)).toBe(false);
    });

    it('should reject with wrong secret', () => {
      const signature = signPayload(payload, secret);
      expect(verifySignature(payload, signature, 'wrong-secret')).toBe(false);
    });
  });

  describe('generateApiKey', () => {
    it('should generate a valid API key', () => {
      const { key, hashedKey, keyPrefix } = generateApiKey();
      expect(key).toMatch(/^tk_[a-f0-9]+$/);
      expect(keyPrefix).toHaveLength(12);
      expect(hashedKey).toHaveLength(64);
      expect(hashString(key)).toBe(hashedKey);
    });
  });

  describe('signWebhookPayload / verifyWebhookSignature', () => {
    const secret = 'whsec_test';
    const payload = { type: 'order.paid', data: { id: '123' } };

    it('should verify valid webhook signatures', () => {
      const body = JSON.stringify(payload);
      const { signature, timestamp } = signWebhookPayload(payload, secret);
      expect(verifyWebhookSignature(body, signature, timestamp, secret)).toBe(true);
    });

    it('should reject invalid webhook signatures', () => {
      const body = JSON.stringify(payload);
      expect(verifyWebhookSignature(body, 'bad', '123', secret)).toBe(false);
    });

    it('should reject stale timestamps', () => {
      const body = JSON.stringify(payload);
      const { signature } = signWebhookPayload(payload, secret);
      const oldTimestamp = Math.floor(Date.now() / 1000 - 600).toString();
      expect(verifyWebhookSignature(body, signature, oldTimestamp, secret)).toBe(false);
    });
  });

  describe('paginate', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);

    it('should return first page', () => {
      const result = paginate(items, 10);
      expect(result.items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });

    it('should return second page using cursor', () => {
      const first = paginate(items, 10);
      const second = paginate(items, 10, first.nextCursor!);
      expect(second.items).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
      expect(second.hasMore).toBe(true);
    });

    it('should return last page', () => {
      const first = paginate(items, 10);
      const second = paginate(items, 10, first.nextCursor!);
      const third = paginate(items, 10, second.nextCursor!);
      expect(third.items).toEqual([20, 21, 22, 23, 24]);
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();
    });
  });

  describe('maskApiKey', () => {
    it('should mask API key middle section', () => {
      const masked = maskApiKey('tk_1234567890abcdefghijklmno');
      expect(masked).toMatch(/^tk_123456789\*+lmno$/);
      expect(masked).toContain('*');
    });

    it('should not mask short keys', () => {
      expect(maskApiKey('tk_short')).toBe('tk_short');
    });
  });
});
