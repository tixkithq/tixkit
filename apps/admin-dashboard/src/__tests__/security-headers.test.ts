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
    const policy = adminContentSecurityPolicy(productionConfig());
    expect(policy).toContain(
      "connect-src 'self' https://admin.example.test https://checkout.example.test https://media.example.test",
    );
    expect(policy).toContain("frame-src 'self' https://checkout.example.test");
    expect(policy).not.toContain('localhost');
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('retains the current explicitly bounded development posture', () => {
    const policy = adminContentSecurityPolicy(
      parseAdminRuntimeConfig({ NODE_ENV: 'development' }),
      { development: true },
    );
    expect(policy).toContain("'unsafe-inline'");
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain('http://localhost:7331');
  });

  it('sets the complete header set including the camera policy', () => {
    expect(adminSecurityHeaders(productionConfig())).toMatchObject({
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
  });
});
