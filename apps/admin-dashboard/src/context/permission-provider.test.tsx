import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  PermissionProvider,
  usePermissions,
  resetPrincipalCache,
} from '@/context/permission-provider';
import { adminApi } from '@/lib/api';

function wrapper({ children }: { children: React.ReactNode }) {
  return <PermissionProvider>{children}</PermissionProvider>;
}

function usePermissionsHook() {
  return usePermissions();
}

afterEach(() => {
  resetPrincipalCache();
  delete process.env.AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
});

describe('PermissionProvider (local dev, no Clerk key)', () => {
  beforeEach(() => {
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

describe('PermissionProvider (production, Clerk key present)', () => {
  beforeEach(() => {
    process.env.AUTH_PROVIDER = 'clerk';
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = 'clerk';
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_123';
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
});
