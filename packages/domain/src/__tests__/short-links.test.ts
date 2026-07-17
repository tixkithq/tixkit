import { describe, it, expect } from 'vitest';
import {
  generateShortLinkSlug,
  generateUniqueSlug,
  sanitizeUtmParams,
  isAllowedDestination,
  composeRedirectUrl,
  dayBucket,
} from '../messaging/short-links.js';

const fixedRandom = (n: number) => new Uint8Array(n).fill(0);
const alwaysExists = () => Promise.resolve(true);

describe('generateShortLinkSlug', () => {
  it('produces a slug of the requested length from the base62 alphabet', () => {
    const slug = generateShortLinkSlug(7);
    expect(slug).toHaveLength(7);
    expect(slug).toMatch(/^[A-Za-z0-9]{7}$/);
  });

  it('is collision-resistant over many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      seen.add(generateShortLinkSlug(8));
    }
    // With 8 base62 chars the keyspace is huge; 5000 draws should be unique.
    expect(seen.size).toBe(5000);
  });

  it('accepts a custom random source for determinism in tests', () => {
    expect(generateShortLinkSlug(4, fixedRandom)).toBe('aaaa');
  });
});

describe('generateUniqueSlug', () => {
  it('returns a slug that does not collide with existing ones', async () => {
    const existing = new Set<string>(['aaaaaaa']);
    const exists = (slug: string) => Promise.resolve(existing.has(slug));
    const slug = await generateUniqueSlug(exists, 8, 7);
    expect(existing.has(slug)).toBe(false);
  });

  it('throws after exhausting attempts when all candidates collide', async () => {
    await expect(generateUniqueSlug(alwaysExists, 3, 7)).rejects.toThrow(/unique short-link slug/);
  });
});

describe('sanitizeUtmParams', () => {
  it('keeps only allowlisted UTM params and strips control chars', () => {
    expect(
      sanitizeUtmParams({
        utm_source: 'news\x00letter',
        utm_medium: 'email',
        utm_campaign: 'summer',
        evil_param: 'hax',
        redirect: 'https://evil.test',
      }),
    ).toEqual({ utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'summer' });
  });

  it('drops non-string UTM values', () => {
    expect(sanitizeUtmParams({ utm_source: 123 })).toEqual({});
  });
});

describe('isAllowedDestination', () => {
  it('allows http(s) public URLs', () => {
    expect(isAllowedDestination('https://example.test/e/evt_1')).toBe(true);
    expect(isAllowedDestination('http://example.test')).toBe(true);
  });

  it('rejects non-http protocols (open-redirect guard)', () => {
    expect(isAllowedDestination('javascript:alert(1)')).toBe(false);
    expect(isAllowedDestination('data:text/html,<script>')).toBe(false);
    expect(isAllowedDestination('file:///etc/passwd')).toBe(false);
  });

  it('rejects loopback and private hosts by default', () => {
    expect(isAllowedDestination('http://localhost/admin')).toBe(false);
    expect(isAllowedDestination('http://127.0.0.1:8080')).toBe(false);
    expect(isAllowedDestination('http://192.168.1.1')).toBe(false);
    expect(isAllowedDestination('http://10.0.0.1')).toBe(false);
    expect(isAllowedDestination('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedDestination('http://service.local')).toBe(false);
    expect(isAllowedDestination('http://localhost./admin')).toBe(false);
    expect(isAllowedDestination('http://127.0.0.2/admin')).toBe(false);
    expect(isAllowedDestination('http://0.0.0.1/admin')).toBe(false);
    expect(isAllowedDestination('http://100.64.0.1/admin')).toBe(false);
    expect(isAllowedDestination('http://198.18.0.1/admin')).toBe(false);
    expect(isAllowedDestination('http://224.0.0.1/admin')).toBe(false);
    expect(isAllowedDestination('http://2130706433/admin')).toBe(false);
    expect(isAllowedDestination('http://0177.0.0.1/admin')).toBe(false);
    expect(isAllowedDestination('http://0x7f000001/admin')).toBe(false);
    expect(isAllowedDestination('https://[fc00::1]/admin')).toBe(false);
    expect(isAllowedDestination('https://[fd12:3456::1]/')).toBe(false);
    expect(isAllowedDestination('https://[fe80::1]/')).toBe(false);
    expect(isAllowedDestination('https://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isAllowedDestination('https://[ff02::1]/')).toBe(false);
    expect(isAllowedDestination('https://[100::1]/')).toBe(false);
    expect(isAllowedDestination('https://[2001:2::1]/')).toBe(false);
    expect(isAllowedDestination('https://[2001:db8::1]/')).toBe(false);
    expect(isAllowedDestination('https://[3fff::1]/')).toBe(false);
    expect(isAllowedDestination('https://[5f00::1]/')).toBe(false);
    expect(isAllowedDestination('https://[2606:4700:4700::1111]/')).toBe(true);
  });

  it('allows private hosts when explicitly permitted (dev)', () => {
    expect(isAllowedDestination('http://localhost:3000', true)).toBe(true);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedDestination('not a url')).toBe(false);
  });
});

describe('composeRedirectUrl', () => {
  it('appends UTM params to the destination', () => {
    expect(
      composeRedirectUrl('https://example.test/e/evt_1', {
        utm_source: 'email',
        utm_campaign: 'summer',
      }),
    ).toBe('https://example.test/e/evt_1?utm_source=email&utm_campaign=summer');
  });

  it('preserves existing query params', () => {
    expect(composeRedirectUrl('https://example.test/e/evt_1?ref=abc', { utm_medium: 'sms' })).toBe(
      'https://example.test/e/evt_1?ref=abc&utm_medium=sms',
    );
  });

  it('returns the destination unchanged when no UTM params', () => {
    expect(composeRedirectUrl('https://example.test/e/evt_1')).toBe('https://example.test/e/evt_1');
  });
});

describe('dayBucket', () => {
  it('produces a coarse UTC YYYY-MM-DD bucket', () => {
    expect(dayBucket(new Date('2026-06-28T23:59:00Z'))).toBe('2026-06-28');
    expect(dayBucket(new Date('2026-06-29T00:01:00Z'))).toBe('2026-06-29');
  });
});
