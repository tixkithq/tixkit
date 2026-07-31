import type { NextFetchEvent } from 'next/server';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { clerkHandlerState, clerkProxyMock } = vi.hoisted(() => {
  const clerkHandlerState: {
    current?: (auth: unknown, request: unknown, event: unknown) => unknown;
  } = {};
  return {
    clerkHandlerState,
    clerkProxyMock: vi.fn((request: unknown, event: unknown) => {
      if (!clerkHandlerState.current) throw new Error('Missing Clerk middleware handler');
      return clerkHandlerState.current(undefined, request, event);
    }),
  };
});
vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn(
    (handler: (auth: unknown, request: unknown, event: unknown) => unknown) => {
      clerkHandlerState.current = handler;
      return clerkProxyMock;
    },
  ),
}));

import proxy, { config as proxyConfig } from './proxy';

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

function securedRequestAt(index: number): NextRequest {
  const call = clerkProxyMock.mock.calls[index];
  if (!call) throw new Error(`Missing Clerk call ${index}`);
  return call[0] as NextRequest;
}

describe('admin dashboard request-time proxy', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('runs Clerk and applies validated runtime security headers', async () => {
    configureProduction();
    const response = await proxy(request(), {} as NextFetchEvent);
    expect(clerkProxyMock).toHaveBeenCalledTimes(1);
    const securedRequest = securedRequestAt(0);
    const nonce = securedRequest.headers.get('x-nonce');
    const requestPolicy = securedRequest.headers.get('content-security-policy');
    expect(nonce).toMatch(/^[A-Za-z0-9+/=]+$/u);
    expect(requestPolicy).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get('content-security-policy')).toBe(requestPolicy);
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
      requestPolicy,
    );
    expect(response.headers.get('x-middleware-override-headers')?.split(',')).toEqual(
      expect.arrayContaining(['x-nonce', 'content-security-policy']),
    );
    expect(requestPolicy).toContain('https://admin.example.test');
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
    const nonce = response.headers.get('x-middleware-request-x-nonce');
    const requestPolicy = response.headers.get('x-middleware-request-content-security-policy');
    expect(nonce).toBeTruthy();
    expect(requestPolicy).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get('content-security-policy')).toBe(requestPolicy);
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

  it('generates a fresh request nonce for each request', async () => {
    configureProduction();
    await proxy(request(), {} as NextFetchEvent);
    await proxy(request(), {} as NextFetchEvent);
    const first = securedRequestAt(0).headers.get('x-nonce');
    const second = securedRequestAt(1).headers.get('x-nonce');
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it.each(['/health', '/ready'])(
    'bypasses Clerk for %s and retains the diagnostic header floor',
    async (path) => {
      configureProduction();
      const response = await proxy(
        new NextRequest(`https://dashboard.example.test${path}`),
        {} as NextFetchEvent,
      );
      expect(clerkProxyMock).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('keeps the route matcher contract authoritative and excludes router prefetches', () => {
    expect(proxyConfig.matcher).toEqual([
      {
        source:
          '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        missing: [
          { type: 'header', key: 'next-router-prefetch' },
          { type: 'header', key: 'purpose', value: 'prefetch' },
        ],
      },
      '/(api|trpc)(.*)',
      '/__clerk/(.*)',
    ]);
  });
});
