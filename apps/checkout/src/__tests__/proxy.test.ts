import { describe, expect, it } from 'vitest';
import { checkoutContentSecurityPolicy } from '@/proxy';

describe('checkoutContentSecurityPolicy', () => {
  it('uses an exact nonce and feature-minimal origins without unsafe-inline or broad connect HTTPS', () => {
    const policy = checkoutContentSecurityPolicy('nonce-value');
    expect(policy).toContain("script-src 'self' 'nonce-nonce-value' 'strict-dynamic'");
    expect(policy).toContain("style-src 'self' 'nonce-nonce-value'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toMatch(/connect-src[^;]*\shttps:\s/);
    expect(policy).not.toContain('googletagmanager');
    expect(policy).not.toContain('facebook');
  });
});
