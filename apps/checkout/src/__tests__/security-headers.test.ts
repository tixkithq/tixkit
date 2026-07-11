import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';

describe('checkout security headers', () => {
  it('prevents fragment handoff destinations from emitting referrers', async () => {
    expect(nextConfig.headers).toBeTypeOf('function');
    const rules = await nextConfig.headers!();
    const globalIndex = rules.findIndex((rule) => rule.source === '/:path*');
    const checkoutIndex = rules.findIndex((rule) => rule.source === '/checkout');
    expect(checkoutIndex).toBeGreaterThan(globalIndex);
    const checkout = rules[checkoutIndex];
    expect(checkout?.headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
  });
});
