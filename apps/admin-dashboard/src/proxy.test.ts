import type { NextFetchEvent } from 'next/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clerkProxyMock = vi.hoisted(() => vi.fn(() => new Response('clerk')));
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: vi.fn(() => clerkProxyMock) }));

import proxy from './proxy';

function configureProduction(authProvider: 'clerk' | 'dev' = 'clerk') {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'production');
  vi.stubEnv('API_BASE_URL', 'https://admin.example.test');
  vi.stubEnv('TIXKIT_CHECKOUT_URL', 'https://checkout.example.test');
  vi.stubEnv('S3_PUBLIC_ENDPOINT', 'https://media.example.test');
  vi.stubEnv('AUTH_PROVIDER', authProvider);
  vi.stubEnv('CLERK_PUBLISHABLE_KEY', authProvider === 'clerk' ? 'pk_live_example' : '');
  vi.stubEnv('CLERK_SECRET_KEY', authProvider === 'clerk' ? 'sk_live_example' : '');
  vi.stubEnv('TIXKIT_BUILD_REVISION', 'release-1');
}

function request(host = 'dashboard.example.test') {
  return new NextRequest(`https://${host}/events`);
}

describe('admin dashboard request-time proxy', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('runs Clerk and applies validated runtime security headers', async () => {
    configureProduction();
    const response = await proxy(request(), {} as NextFetchEvent);
    expect(clerkProxyMock).toHaveBeenCalledTimes(1);
    expect(response.headers.get('content-security-policy')).toContain('https://admin.example.test');
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(self), microphone=(), geolocation=()',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('applies the identical header posture without Clerk in Compact dev auth', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TIXKIT_DEPLOYMENT_PROFILE', 'compact');
    vi.stubEnv('ALLOW_INSECURE_LOCAL_ORIGINS', '1');
    vi.stubEnv('API_BASE_URL', 'http://localhost:4000');
    vi.stubEnv('TIXKIT_CHECKOUT_URL', 'http://localhost:3000');
    vi.stubEnv('S3_PUBLIC_ENDPOINT', 'http://localhost:9000');
    vi.stubEnv('AUTH_PROVIDER', 'dev');
    vi.stubEnv('CLERK_PUBLISHABLE_KEY', '');
    const response = await proxy(request(), {} as NextFetchEvent);
    expect(clerkProxyMock).not.toHaveBeenCalled();
    expect(response.headers.get('content-security-policy')).toContain('http://localhost:4000');
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(self), microphone=(), geolocation=()',
    );
  });

  it('does not derive policy sources from Host or X-Forwarded-Host', async () => {
    configureProduction();
    const hostile = request('attacker.example');
    hostile.headers.set('x-forwarded-host', 'forwarded-attacker.example');
    const response = await proxy(hostile, {} as NextFetchEvent);
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).not.toContain('attacker.example');
    expect(policy).not.toContain('forwarded-attacker.example');
    expect(policy).toContain('https://admin.example.test');
  });

  it('fails closed with a safe 503 when runtime configuration is invalid', async () => {
    configureProduction();
    vi.stubEnv('API_BASE_URL', 'https://user:secret@admin.example.test');
    const response = await proxy(request(), {} as NextFetchEvent);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service unavailable');
    expect(clerkProxyMock).not.toHaveBeenCalled();
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('returns the same safe 503 posture when Clerk middleware throws', async () => {
    configureProduction();
    clerkProxyMock.mockRejectedValueOnce(new Error('Clerk unavailable'));
    const response = await proxy(request(), {} as NextFetchEvent);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
