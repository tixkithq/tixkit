import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminApiAuthHeaders } from './api';
import { authProvider, usesLocalDevAuth } from './auth';

const originalClerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalNextPublicClerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const originalAuthProvider = process.env.AUTH_PROVIDER;
const originalNextPublicAuthProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

function enableClerk() {
  process.env.AUTH_PROVIDER = 'clerk';
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'clerk';
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_valid';
  delete process.env.CLERK_PUBLISHABLE_KEY;
}

function disableClerk() {
  delete process.env.AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.CLERK_PUBLISHABLE_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
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
}

describe('getAdminApiAuthHeaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disableClerk();
    delete window.Clerk;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreClerkEnv();
    delete window.Clerk;
  });

  it('does not wait on Clerk or attach authorization in no-Clerk local dev mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const headers = await getAdminApiAuthHeaders({ 'X-Test': '1' });

    expect(headers).toEqual({ 'X-Test': '1' });
  });

  it.each(['test', 'staging', 'preview', 'production'])(
    'does not use local-dev auth when AUTH_PROVIDER=dev and NODE_ENV=%s',
    (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      process.env.AUTH_PROVIDER = 'dev';
      process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'dev';

      expect(authProvider()).toBe('dev');
      expect(usesLocalDevAuth()).toBe(false);
    },
  );

  it('attaches the active Clerk session token when Clerk is configured', async () => {
    enableClerk();
    const getToken = vi.fn().mockResolvedValue('clerk_session_jwt');
    window.Clerk = {
      loaded: true,
      session: { getToken },
    };

    const headers = await getAdminApiAuthHeaders();

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(headers.Authorization).toBe('Bearer clerk_session_jwt');
  });

  it('uses Clerk when development has a public Clerk key but no public auth provider flag', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.AUTH_PROVIDER;
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    delete process.env.CLERK_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_valid';
    const getToken = vi.fn().mockResolvedValue('public_key_clerk_session_jwt');
    window.Clerk = {
      loaded: true,
      session: { getToken },
    };

    const headers = await getAdminApiAuthHeaders();

    expect(authProvider()).toBe('clerk');
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(headers.Authorization).toBe('Bearer public_key_clerk_session_jwt');
  });

  it('loads Clerk before reading a token when the browser SDK is present but not loaded', async () => {
    enableClerk();
    const load = vi.fn().mockResolvedValue(undefined);
    const getToken = vi.fn().mockResolvedValue('loaded_clerk_session_jwt');
    window.Clerk = {
      loaded: false,
      load,
      session: { getToken },
    };

    const headers = await getAdminApiAuthHeaders();

    expect(load).toHaveBeenCalledTimes(1);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(headers.Authorization).toBe('Bearer loaded_clerk_session_jwt');
  });

  it('preserves an explicit Authorization header without calling Clerk', async () => {
    enableClerk();
    const getToken = vi.fn().mockResolvedValue('clerk_session_jwt');
    window.Clerk = {
      loaded: true,
      session: { getToken },
    };

    const headers = await getAdminApiAuthHeaders({
      Authorization: 'Bearer supplied_token',
    });

    expect(getToken).not.toHaveBeenCalled();
    expect(headers.Authorization).toBe('Bearer supplied_token');
  });

  it('does not attach an Authorization header when Clerk has no active session token', async () => {
    enableClerk();
    window.Clerk = {
      loaded: true,
      session: {
        getToken: vi.fn().mockResolvedValue(null),
      },
    };

    const headers = await getAdminApiAuthHeaders();

    expect(headers.Authorization).toBeUndefined();
  });
});
