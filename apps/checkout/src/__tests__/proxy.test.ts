import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  checkoutContentSecurityPolicy,
  checkoutSecurityHeaders,
} from '@/lib/checkout-security-headers';
import type { PublicCheckoutRuntimeConfig } from '@/lib/runtime-config-contract';
import { proxy } from '@/proxy';

function config(apiBaseUrl: string): PublicCheckoutRuntimeConfig {
  return {
    schemaVersion: '1',
    deploymentProfile: apiBaseUrl.startsWith('http:') ? 'compact' : 'production',
    apiBaseUrl,
    platformApiBaseUrl: `${apiBaseUrl}/v1`,
    checkoutUrl: apiBaseUrl.startsWith('http:')
      ? 'http://localhost:3000'
      : 'https://checkout.example.test',
    mediaOrigin: apiBaseUrl.startsWith('http:')
      ? 'http://localhost:9000'
      : 'https://media.example.test',
    ...(apiBaseUrl.startsWith('https:') ? { stripePublishableKey: 'pk_test_example' } : {}),
    buildRevision: 'release-1',
    configFingerprint: `sha256:${'1'.repeat(64)}`,
  };
}

describe('checkoutContentSecurityPolicy', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('uses an exact nonce and feature-minimal origins', () => {
    const policy = checkoutContentSecurityPolicy(config('https://api.example.test'), 'nonce-value');
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
    const policy = checkoutContentSecurityPolicy(config('https://api.example.test'), 'nonce-value');
    expect(policy).toMatch(/img-src[^;]*https:\/\/api\.example\.test/u);
    expect(policy).toMatch(/connect-src[^;]*https:\/\/media\.example\.test/u);
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('does not upgrade explicitly configured local HTTP services to TLS', () => {
    expect(
      checkoutContentSecurityPolicy(config('http://localhost:4200'), 'nonce-value'),
    ).not.toContain('upgrade-insecure-requests');
  });

  it('keeps public HTTPS framing as an explicit embed contract', () => {
    expect(
      checkoutContentSecurityPolicy(config('https://api.example.test'), 'nonce-value'),
    ).toContain("frame-ancestors 'self' https:");
  });

  it('allows only bounded loopback HTTP framing in local profiles', () => {
    const policy = checkoutContentSecurityPolicy(config('http://localhost:4200'), 'nonce-value');
    expect(policy).toContain("frame-ancestors 'self' https: http://localhost:* http://127.0.0.1:*");
    expect(policy).not.toContain('frame-ancestors http:');
  });

  it('uses Stripe surface-specific origins instead of a broad wildcard', () => {
    const policy = checkoutContentSecurityPolicy(config('https://api.example.test'), 'nonce-value');
    expect(policy).toMatch(/script-src[^;]*https:\/\/js\.stripe\.com/u);
    expect(policy).toMatch(/connect-src[^;]*https:\/\/api\.stripe\.com/u);
    expect(policy).toMatch(/connect-src[^;]*https:\/\/r\.stripe\.com/u);
    expect(policy).toMatch(/frame-src[^;]*https:\/\/hooks\.stripe\.com/u);
    expect(policy).not.toMatch(
      /(?:script-src|connect-src|frame-src)[^;]*https:\/\/\*\.stripe\.com/u,
    );
  });

  it('suppresses referrers on payment and confirmation surfaces', () => {
    expect(
      checkoutSecurityHeaders(config('https://api.example.test'), 'nonce-value', {
        noReferrer: true,
      })['Referrer-Policy'],
    ).toBe('no-referrer');
  });

  it('fails closed with baseline headers on business routes when production config is invalid', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
    const response = proxy(new NextRequest('https://checkout.example.test/checkout'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_RUNTIME_CONFIGURATION' },
    });
  });

  it.each(['/health', '/ready'])(
    'passes through %s with baseline headers for diagnostics',
    (path) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
      const response = proxy(new NextRequest(`https://checkout.example.test${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    },
  );

  it('applies runtime CSP and checkout privacy headers for valid configuration', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
    vi.stubEnv('API_BASE_URL', 'https://api.example.test');
    vi.stubEnv('TIXKIT_CHECKOUT_URL', 'https://checkout.example.test');
    vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://media.example.test');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_live_example');
    vi.stubEnv('TIXKIT_BUILD_REVISION', 'release-1');
    const response = proxy(new NextRequest('https://checkout.example.test/checkout'));
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('https://media.example.test');
  });
});
