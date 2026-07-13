import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutContentSecurityPolicy } from '@/proxy';

describe('checkoutContentSecurityPolicy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses an exact nonce and feature-minimal origins', () => {
    const policy = checkoutContentSecurityPolicy('nonce-value');
    expect(policy).toContain("script-src 'self' 'nonce-nonce-value'");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("style-src 'self' 'nonce-nonce-value'");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(policy).not.toMatch(/connect-src[^;]*\shttps:\s/);
    expect(policy).not.toContain('googletagmanager');
    expect(policy).not.toContain('facebook');
  });

  it('allows buyer-safe renditions from the configured API origin', () => {
    vi.stubEnv('NEXT_PUBLIC_TIXKIT_API_BASE_URL', 'https://api.example.test/v1');
    expect(checkoutContentSecurityPolicy('nonce-value')).toMatch(
      /img-src[^;]*https:\/\/api\.example\.test/u,
    );
    expect(checkoutContentSecurityPolicy('nonce-value')).toContain('upgrade-insecure-requests');
  });

  it('does not upgrade explicitly configured local HTTP services to TLS', () => {
    vi.stubEnv('NEXT_PUBLIC_TIXKIT_API_BASE_URL', 'http://localhost:4200/v1');
    expect(checkoutContentSecurityPolicy('nonce-value')).not.toContain('upgrade-insecure-requests');
  });

  it('fails closed for non-loopback HTTP API configuration', () => {
    vi.stubEnv('NEXT_PUBLIC_TIXKIT_API_BASE_URL', 'http://api.example.test/v1');
    expect(checkoutContentSecurityPolicy('nonce-value')).toContain('upgrade-insecure-requests');
  });
});
