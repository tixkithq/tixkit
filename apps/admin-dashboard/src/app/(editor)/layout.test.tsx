import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getPrincipal: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: mocks.auth,
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

vi.mock('@/lib/api', () => ({
  adminApi: {
    getPrincipal: mocks.getPrincipal,
  },
  getAdminApiBaseUrl: () => 'http://localhost:4100',
}));

vi.mock('@/context/permission-provider', () => ({
  PermissionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import EditorLayout from './layout';

const originalClerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalNextPublicClerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const originalAuthProvider = process.env.AUTH_PROVIDER;
const originalNextPublicAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
const originalE2eLocalAdminAuth = process.env.E2E_LOCAL_ADMIN_AUTH;

function disableClerk() {
  delete process.env.AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.E2E_LOCAL_ADMIN_AUTH;
}

function restoreClerkEnv() {
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

  if (originalE2eLocalAdminAuth === undefined) {
    delete process.env.E2E_LOCAL_ADMIN_AUTH;
  } else {
    process.env.E2E_LOCAL_ADMIN_AUTH = originalE2eLocalAdminAuth;
  }
}

describe('EditorLayout auth handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`);
    });
    disableClerk();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreClerkEnv();
  });

  it('renders editor content without Clerk in local dev mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const element = await EditorLayout({
      children: <div data-testid="editor-child">Editor</div>,
    });

    render(element);

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(screen.getByTestId('editor-child')).toBeInTheDocument();
  });

  it('fails closed with explicit e2e local admin auth outside development', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.AUTH_PROVIDER = 'dev';
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'dev';
    process.env.E2E_LOCAL_ADMIN_AUTH = '1';

    const element = await EditorLayout({
      children: <div data-testid="editor-child">Editor</div>,
    });

    render(element);

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.getPrincipal).not.toHaveBeenCalled();
    expect(screen.queryByTestId('editor-child')).not.toBeInTheDocument();
    expect(screen.getByText('Dashboard authentication is not configured')).toBeInTheDocument();
  });
});
