import { describe, expect, it } from 'vitest';
import { adminContentSecurityPolicy, adminSecurityHeaders } from '@/lib/admin-security-headers';
import { parseAdminRuntimeConfig } from '@/lib/runtime-config-server';

function productionConfig() {
  return parseAdminRuntimeConfig({
    NODE_ENV: 'production',
    TIXKIT_DEPLOYMENT_PROFILE: 'production',
    API_BASE_URL: 'https://admin.example.test',
    TIXKIT_CHECKOUT_URL: 'https://checkout.example.test',
    TIXKIT_DOCS_URL: 'https://docs.example.test',
    S3_PUBLIC_ENDPOINT: 'https://media.example.test',
    AUTH_PROVIDER: 'clerk',
    CLERK_PUBLISHABLE_KEY: 'pk_live_example',
    CLERK_SECRET_KEY: 'sk_live_example',
    TIXKIT_BUILD_REVISION: 'release-1',
  });
}

describe('admin request-time security headers', () => {
  it('uses only the validated exact runtime origins in production', () => {
    const policy = adminContentSecurityPolicy(productionConfig(), 'request-nonce');
    expect(policy).toContain(
      "connect-src 'self' https://admin.example.test https://checkout.example.test https://media.example.test",
    );
    expect(policy).toContain("frame-src 'self' https://checkout.example.test");
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(policy).toContain("script-src 'self' 'nonce-request-nonce' 'strict-dynamic'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self' 'nonce-request-nonce'");
    expect(policy).toContain(
      "style-src-elem 'self' 'nonce-request-nonce' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' 'sha256-YjaKGiklmzC6wjXA513HAMmzus8VE61XCOT+SmwNZWA=' 'sha256-CIxDM5jnsGiKqXs2v7NKCY5MzdR9gu6TtiMJrDw29AY=' 'sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo='",
    );
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
  });

  it('retains the current explicitly bounded development posture', () => {
    const policy = adminContentSecurityPolicy(
      parseAdminRuntimeConfig({ NODE_ENV: 'development' }),
      'development-nonce',
      { development: true },
    );
    expect(policy).toContain("'unsafe-inline'");
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain('http://localhost:7331');
  });

  it('sets the complete header set including the camera policy', () => {
    expect(adminSecurityHeaders(productionConfig(), 'request-nonce')).toMatchObject({
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });

  it.each(["quote'nonce", 'semi;nonce', 'space nonce', 'line\nnonce', '', 'a'.repeat(129)])(
    'rejects an unsafe nonce value %#',
    (nonce) => {
      expect(() => adminContentSecurityPolicy(productionConfig(), nonce)).toThrow(
        'CSP nonce must be a bounded base64 value',
      );
    },
  );
});
