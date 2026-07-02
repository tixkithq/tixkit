import type { NextFetchEvent, NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clerkProxyMock = vi.hoisted(() => vi.fn(() => ({ type: 'clerk' })));
const nextResponseNextMock = vi.hoisted(() => vi.fn(() => ({ type: 'next' })));

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: vi.fn(() => clerkProxyMock),
}));

vi.mock('next/server', () => ({
  NextResponse: {
    next: nextResponseNextMock,
  },
}));

const originalNodeEnv = process.env.NODE_ENV;
const originalAuthProvider = process.env.AUTH_PROVIDER;
const originalNextPublicAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
const originalClerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalNextPublicClerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const originalE2eLocalAdminAuth = process.env.E2E_LOCAL_ADMIN_AUTH;

function restoreEnv() {
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, 'NODE_ENV');
  } else {
    Reflect.set(process.env, 'NODE_ENV', originalNodeEnv);
  }

  if (originalAuthProvider === undefined) {
    delete process.env.AUTH_PROVIDER;
  } else {
    process.env.AUTH_PROVIDER = originalAuthProvider;
  }

  if (originalNextPublicAuthProvider === undefined) {
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  } else {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = originalNextPublicAuthProvider;
  }

  if (originalClerkPublishableKey === undefined) {
    delete process.env.CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.CLERK_PUBLISHABLE_KEY = originalClerkPublishableKey;
  }

  if (originalNextPublicClerkPublishableKey === undefined) {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  } else {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = originalNextPublicClerkPublishableKey;
  }

  if (originalE2eLocalAdminAuth === undefined) {
    delete process.env.E2E_LOCAL_ADMIN_AUTH;
  } else {
    process.env.E2E_LOCAL_ADMIN_AUTH = originalE2eLocalAdminAuth;
  }
}

function configureAuthEnv(nodeEnv: string | undefined) {
  if (nodeEnv === undefined) {
    Reflect.deleteProperty(process.env, 'NODE_ENV');
  } else {
    Reflect.set(process.env, 'NODE_ENV', nodeEnv);
  }
  process.env.AUTH_PROVIDER = 'dev';
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'dev';
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_valid';
  delete process.env.E2E_LOCAL_ADMIN_AUTH;
  delete process.env.CLERK_PUBLISHABLE_KEY;
}

async function loadProxy() {
  return (await import('./proxy')).default;
}

describe('admin dashboard proxy auth provider gating', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('skips Clerk only for AUTH_PROVIDER=dev in development', async () => {
    configureAuthEnv('development');
    const proxy = await loadProxy();

    const response = proxy({} as NextRequest, {} as NextFetchEvent);

    expect(response).toEqual({ type: 'next' });
    expect(nextResponseNextMock).toHaveBeenCalledTimes(1);
    expect(clerkProxyMock).not.toHaveBeenCalled();
  });

  it.each([
    ['staging', 'staging'],
    ['test', 'test'],
    ['preview', 'preview'],
    ['unset', undefined],
    ['production', 'production'],
  ])('uses Clerk when AUTH_PROVIDER=dev and NODE_ENV is %s', async (_, nodeEnv) => {
    configureAuthEnv(nodeEnv);
    const proxy = await loadProxy();

    const response = proxy({} as NextRequest, {} as NextFetchEvent);

    expect(response).toEqual({ type: 'clerk' });
    expect(clerkProxyMock).toHaveBeenCalledTimes(1);
    expect(nextResponseNextMock).not.toHaveBeenCalled();
  });

  it('uses Clerk when explicit e2e local admin auth is set outside development', async () => {
    configureAuthEnv('production');
    process.env.E2E_LOCAL_ADMIN_AUTH = '1';
    const proxy = await loadProxy();

    const response = proxy({} as NextRequest, {} as NextFetchEvent);

    expect(response).toEqual({ type: 'clerk' });
    expect(clerkProxyMock).toHaveBeenCalledTimes(1);
    expect(nextResponseNextMock).not.toHaveBeenCalled();
  });
});
