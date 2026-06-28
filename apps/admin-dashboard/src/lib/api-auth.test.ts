import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminApiAuthHeaders } from './api';

const originalClerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY;
const originalNextPublicClerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

function enableClerk() {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_valid';
  delete process.env.CLERK_PUBLISHABLE_KEY;
}

function disableClerk() {
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
}

describe('getAdminApiAuthHeaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disableClerk();
    delete window.Clerk;
  });

  afterEach(() => {
    restoreClerkEnv();
    delete window.Clerk;
  });

  it('does not wait on Clerk or attach authorization in no-Clerk local dev mode', async () => {
    const headers = await getAdminApiAuthHeaders({ 'X-Test': '1' });

    expect(headers).toEqual({ 'X-Test': '1' });
  });

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
