import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  PermissionProvider,
  usePermissions,
  resetPrincipalCache,
} from '@/context/permission-provider';
import { adminApi } from '@/lib/api';
import { installTestRuntimeConfig } from '@/test/runtime-config';
import { RuntimeConfigProvider } from '@/context/runtime-config-provider';
import { readAdminRuntimeConfig } from '@/lib/runtime-config-contract';
import { resetBrowserRuntimeConfigForTests } from '@/lib/runtime-config-browser';

type MockAuthState = {
  isLoaded: boolean;
  isSignedIn: boolean;
  sessionId: string | null;
  userId: string | null;
  orgId: string | null;
};

type PrincipalSuccess = {
  ok: true;
  data: { permissions: string[]; tenantId: string; organizationIds: string[] };
};

const authState = vi.hoisted(() => ({
  current: {
    isLoaded: true,
    isSignedIn: true,
    sessionId: 'sess_1',
    userId: 'user_1',
    orgId: 'org_1',
  } as MockAuthState,
}));

const originalNodeEnv = process.env.NODE_ENV;
const originalE2eLocalAdminAuth = process.env.E2E_LOCAL_ADMIN_AUTH;

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => authState.current,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <RuntimeConfigProvider config={readAdminRuntimeConfig()}>
      <PermissionProvider>{children}</PermissionProvider>
    </RuntimeConfigProvider>
  );
}

function usePermissionsHook() {
  return usePermissions();
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPrincipalCache();
  delete process.env.AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (originalNodeEnv === undefined) {
    Reflect.deleteProperty(process.env, 'NODE_ENV');
  } else {
    Reflect.set(process.env, 'NODE_ENV', originalNodeEnv);
  }
  if (originalE2eLocalAdminAuth === undefined) {
    delete process.env.E2E_LOCAL_ADMIN_AUTH;
  } else {
    process.env.E2E_LOCAL_ADMIN_AUTH = originalE2eLocalAdminAuth;
  }
});

describe('PermissionProvider (local dev, no Clerk key)', () => {
  beforeEach(() => {
    Reflect.set(process.env, 'NODE_ENV', 'development');
    delete process.env.AUTH_PROVIDER;
    delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it('uses local-dev permissions without Clerk dev/test keys', () => {
    const { result } = renderHook(usePermissionsHook, { wrapper });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.can('billing.write')).toBe(true);
    expect(result.current.can('developers.write')).toBe(true);
  });
});

describe('PermissionProvider (production, no Clerk key)', () => {
  beforeEach(() => {
    resetBrowserRuntimeConfigForTests();
    Reflect.set(process.env, 'NODE_ENV', 'production');
    process.env.AUTH_PROVIDER = 'dev';
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'dev';
    process.env.E2E_LOCAL_ADMIN_AUTH = '1';
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  });

  it('fails closed instead of granting local-dev permissions', () => {
    installTestRuntimeConfig({
      deploymentProfile: 'production',
      apiBaseUrl: 'https://admin.example.test',
      platformApiBaseUrl: 'https://admin.example.test/v1',
      checkoutUrl: 'https://checkout.example.test',
      docsUrl: 'https://docs.example.test',
      uploadOrigin: 'https://media.example.test',
      authProvider: 'dev',
    });
    expect(() => renderHook(usePermissionsHook, { wrapper })).toThrow(
      'production requires Clerk authentication',
    );
  });
});

describe('PermissionProvider (production, Clerk key present)', () => {
  beforeEach(() => {
    resetBrowserRuntimeConfigForTests();
    Reflect.set(process.env, 'NODE_ENV', 'production');
    process.env.AUTH_PROVIDER = 'clerk';
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'clerk';
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_123';
    installTestRuntimeConfig({
      deploymentProfile: 'production',
      apiBaseUrl: 'https://admin.example.test',
      platformApiBaseUrl: 'https://admin.example.test/v1',
      checkoutUrl: 'https://checkout.example.test',
      docsUrl: 'https://docs.example.test',
      uploadOrigin: 'https://media.example.test',
      authProvider: 'clerk',
      clerkPublishableKey: 'pk_test_123',
    });
    authState.current = {
      isLoaded: true,
      isSignedIn: true,
      sessionId: 'sess_1',
      userId: 'user_1',
      orgId: 'org_1',
    };
  });

  it('fetches the principal and honors backend-granted permissions', async () => {
    const spy = vi.spyOn(adminApi, 'getPrincipal').mockResolvedValue({
      ok: true,
      data: {
        permissions: ['events.read', 'orders.read'],
        tenantId: 't1',
        organizationIds: ['o1'],
      },
    });

    const { result } = renderHook(usePermissionsHook, { wrapper });
    // Starts fail-closed (empty) while loading.
    expect(result.current.permissions).toEqual([]);
    expect(result.current.loading).toBe(true);

    // Flush the async principal resolution.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(spy).toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.permissions).toEqual(['events.read', 'orders.read']);
    expect(result.current.can('events.read')).toBe(true);
    expect(result.current.can('billing.write')).toBe(false);
  });

  it('fail-closes immediately when Clerk reports a signed-out session', async () => {
    const spy = vi.spyOn(adminApi, 'getPrincipal').mockResolvedValue({
      ok: true,
      data: {
        permissions: ['events.read'],
        tenantId: 't1',
        organizationIds: ['o1'],
      },
    });

    const { result, rerender } = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.permissions).toEqual(['events.read']);

    authState.current = {
      isLoaded: true,
      isSignedIn: false,
      sessionId: null,
      userId: null,
      orgId: null,
    };
    rerender();

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.permissions).toEqual([]);
    });
    expect(result.current.error).toBeNull();
    expect(result.current.can('events.read')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fail-closes immediately when sign-out resets the principal cache before Clerk updates', async () => {
    vi.spyOn(adminApi, 'getPrincipal').mockResolvedValue({
      ok: true,
      data: {
        permissions: ['events.read'],
        tenantId: 't1',
        organizationIds: ['o1'],
      },
    });

    const { result } = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(result.current.permissions).toEqual(['events.read']));

    act(() => {
      resetPrincipalCache();
    });

    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('events.read')).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('ignores delayed principal fetches that resolve after sign-out reset', async () => {
    let resolveFetch!: (value: PrincipalSuccess) => void;
    const delayedFetch = new Promise<PrincipalSuccess>((resolve) => {
      resolveFetch = resolve;
    });
    const spy = vi
      .spyOn(adminApi, 'getPrincipal')
      .mockReturnValueOnce(delayedFetch)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          permissions: ['orders.read'],
          tenantId: 't1',
          organizationIds: ['o1'],
        },
      });

    const first = renderHook(usePermissionsHook, { wrapper });

    expect(first.result.current.permissions).toEqual([]);
    expect(first.result.current.loading).toBe(true);

    act(() => {
      resetPrincipalCache();
    });

    expect(first.result.current.permissions).toEqual([]);
    expect(first.result.current.can('events.read')).toBe(false);
    expect(first.result.current.loading).toBe(false);

    resolveFetch({
      ok: true,
      data: {
        permissions: ['events.read'],
        tenantId: 't1',
        organizationIds: ['o1'],
      },
    });

    await act(async () => {
      await delayedFetch;
    });

    expect(first.result.current.permissions).toEqual([]);
    expect(first.result.current.can('events.read')).toBe(false);

    first.unmount();
    const second = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(second.result.current.permissions).toEqual(['orders.read']));
    expect(second.result.current.can('events.read')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetches permissions when Clerk switches to a different signed-in identity', async () => {
    const spy = vi
      .spyOn(adminApi, 'getPrincipal')
      .mockResolvedValueOnce({
        ok: true,
        data: {
          permissions: ['events.read'],
          tenantId: 't1',
          organizationIds: ['o1'],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          permissions: ['orders.read'],
          tenantId: 't2',
          organizationIds: ['o2'],
        },
      });

    const { result, rerender } = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(result.current.permissions).toEqual(['events.read']));

    authState.current = {
      isLoaded: true,
      isSignedIn: true,
      sessionId: 'sess_2',
      userId: 'user_2',
      orgId: 'org_2',
    };
    rerender();

    await waitFor(() => expect(result.current.permissions).toEqual(['orders.read']));
    expect(result.current.can('events.read')).toBe(false);
    expect(result.current.can('orders.read')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fail-closes while refetching permissions after an organization switch', async () => {
    let resolveSecondFetch!: (value: PrincipalSuccess) => void;
    const secondFetch = new Promise<PrincipalSuccess>((resolve) => {
      resolveSecondFetch = resolve;
    });
    const spy = vi
      .spyOn(adminApi, 'getPrincipal')
      .mockResolvedValueOnce({
        ok: true,
        data: {
          permissions: ['events.read'],
          tenantId: 't1',
          organizationIds: ['org_1'],
        },
      })
      .mockReturnValueOnce(secondFetch);

    const { result, rerender } = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(result.current.permissions).toEqual(['events.read']));

    authState.current = {
      isLoaded: true,
      isSignedIn: true,
      sessionId: 'sess_1',
      userId: 'user_1',
      orgId: 'org_2',
    };
    rerender();

    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('events.read')).toBe(false);
    expect(result.current.loading).toBe(true);

    resolveSecondFetch({
      ok: true,
      data: {
        permissions: ['orders.read'],
        tenantId: 't2',
        organizationIds: ['org_2'],
      },
    });

    await waitFor(() => expect(result.current.permissions).toEqual(['orders.read']));
    expect(result.current.can('orders.read')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fail-closes while Clerk is still loading a session update', async () => {
    const spy = vi.spyOn(adminApi, 'getPrincipal').mockResolvedValue({
      ok: true,
      data: {
        permissions: ['events.read'],
        tenantId: 't1',
        organizationIds: ['o1'],
      },
    });

    const { result, rerender } = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(result.current.permissions).toEqual(['events.read']));

    authState.current = {
      isLoaded: false,
      isSignedIn: false,
      sessionId: null,
      userId: null,
      orgId: null,
    };
    rerender();

    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('events.read')).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fail-closes to empty permissions and surfaces an error on fetch failure', async () => {
    vi.spyOn(adminApi, 'getPrincipal').mockResolvedValue({
      ok: false,
      error: { code: 'unauthorized', message: 'No session' },
    });

    const { result } = renderHook(usePermissionsHook, { wrapper });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('events.read')).toBe(false);
    expect(result.current.can('billing.write')).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it('does not cache failed principal lookups as a silent empty-permissions success', async () => {
    const spy = vi
      .spyOn(adminApi, 'getPrincipal')
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'network_error', message: 'API unavailable' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          permissions: ['events.read'],
          tenantId: 't1',
          organizationIds: ['o1'],
        },
      });

    const first = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => {
      expect(first.result.current.loading).toBe(false);
      expect(first.result.current.permissions).toEqual([]);
      expect(first.result.current.error).toBe('API unavailable');
    });

    first.unmount();

    const second = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(second.result.current.permissions).toEqual(['events.read']));
    expect(second.result.current.error).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a failed lookup in place and restores authorized content', async () => {
    const spy = vi
      .spyOn(adminApi, 'getPrincipal')
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'network_error', message: 'API unavailable' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          permissions: ['events.read'],
          tenantId: 't1',
          organizationIds: ['o1'],
        },
      });
    const { result } = renderHook(usePermissionsHook, { wrapper });

    await waitFor(() => expect(result.current.error).toBe('API unavailable'));
    act(() => result.current.retry());
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.permissions).toEqual([]);
    expect(result.current.can('events.read')).toBe(false);
    await waitFor(() => expect(result.current.permissions).toEqual(['events.read']));

    expect(result.current.error).toBeNull();
    expect(result.current.can('events.read')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
