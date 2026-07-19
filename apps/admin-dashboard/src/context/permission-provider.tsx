'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { LOCAL_DEV_PERMISSIONS, type TixkitPermission, hasPermission } from '@/lib/permissions';
import { hasClerkKey, usesLocalDevAuth } from '@/lib/auth';
import { adminApi } from '@/lib/api';
import { useRuntimeConfig } from '@/context/runtime-config-provider';

type PermissionContextValue = {
  permissions: TixkitPermission[];
  can: (permission?: TixkitPermission) => boolean;
  /** True while the principal/permissions are being resolved in production. */
  loading: boolean;
  /** Set when the principal fetch failed (production). Null when OK or in dev. */
  error: string | null;
  /** Re-resolve the active principal after a transient failure. */
  retry: () => void;
};

const PermissionContext = createContext<PermissionContextValue | null>(null);

type PrincipalCacheKey = string;

/**
 * Module-level cache for the resolved principal, scoped to the active Clerk
 * identity. This prevents stale permissions from surviving sign-out/sign-in,
 * account switches, organization switches, and Clerk multi-tab updates.
 */
let principalCache: TixkitPermission[] | null = null;
let principalFetchPromise: Promise<TixkitPermission[]> | null = null;
let principalCacheKey: PrincipalCacheKey | null = null;
let principalFetchKey: PrincipalCacheKey | null = null;
let principalResetGeneration = 0;
const principalResetListeners = new Set<() => void>();

function cacheKeyForPrincipal(input: {
  sessionId?: string | null;
  userId?: string | null;
  orgId?: string | null;
}): PrincipalCacheKey {
  return [input.sessionId ?? 'no-session', input.userId ?? 'no-user', input.orgId ?? 'no-org'].join(
    ':',
  );
}

async function resolvePermissions(cacheKey: PrincipalCacheKey): Promise<TixkitPermission[]> {
  if (principalCacheKey !== cacheKey) {
    principalCache = null;
  }

  if (principalCache && principalCacheKey === cacheKey) return principalCache;
  if (principalFetchPromise && principalFetchKey === cacheKey) return principalFetchPromise;

  principalFetchPromise = null;
  principalFetchKey = cacheKey;
  const fetchGeneration = principalResetGeneration;

  principalFetchPromise = (async () => {
    const result = await adminApi.getPrincipal();
    if (result.ok) {
      // Fail closed: only honor permissions the backend actually granted.
      const granted = result.data.permissions.filter(
        (p): p is TixkitPermission => typeof p === 'string' && p.length > 0,
      );
      if (principalResetGeneration === fetchGeneration && principalFetchKey === cacheKey) {
        principalCache = granted;
        principalCacheKey = cacheKey;
      }
      return granted;
    }
    // Fetch failed: fail closed with no permissions. Callers surface the
    // error; keep failures uncached so remounts retry instead of presenting a
    // silent empty-permissions success state.
    principalCache = null;
    principalCacheKey = null;
    throw new Error(result.error.message || 'Failed to load permissions for your account.');
  })();

  try {
    return await principalFetchPromise;
  } finally {
    if (principalFetchKey === cacheKey) {
      principalFetchPromise = null;
      principalFetchKey = null;
    }
  }
}

/** Reset the principal cache. Exposed for tests and sign-out flows. */
export function resetPrincipalCache(): void {
  principalResetGeneration += 1;
  principalCache = null;
  principalFetchPromise = null;
  principalCacheKey = null;
  principalFetchKey = null;
  for (const listener of principalResetListeners) listener();
}

function subscribePrincipalReset(listener: () => void): () => void {
  principalResetListeners.add(listener);
  return () => {
    principalResetListeners.delete(listener);
  };
}

function LocalPermissionProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<PermissionContextValue>(
    () => ({
      permissions: LOCAL_DEV_PERMISSIONS,
      can: (permission?: TixkitPermission) => hasPermission(LOCAL_DEV_PERMISSIONS, permission),
      loading: false,
      error: null,
      retry: () => undefined,
    }),
    [],
  );

  return <PermissionContext value={value}>{children}</PermissionContext>;
}

function UnavailablePermissionProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<PermissionContextValue>(
    () => ({
      permissions: [],
      can: () => false,
      loading: false,
      error: 'Dashboard authentication is not configured.',
      retry: () => undefined,
    }),
    [],
  );

  return <PermissionContext value={value}>{children}</PermissionContext>;
}

function ClerkPermissionProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, sessionId, userId, orgId } = useAuth();
  const [permissions, setPermissions] = useState<TixkitPermission[]>(() => []);
  const [loading, setLoading] = useState<boolean>(() => true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => {
    resetPrincipalCache();
    setPermissions([]);
    setLoading(true);
    setError(null);
    setRetryNonce((current) => current + 1);
  }, []);

  useEffect(
    () =>
      subscribePrincipalReset(() => {
        setPermissions([]);
        setLoading(false);
        setError(null);
      }),
    [],
  );

  useEffect(() => {
    if (!isLoaded) {
      resetPrincipalCache();
      setPermissions([]);
      setLoading(true);
      setError(null);
      return;
    }

    if (!isSignedIn || !sessionId || !userId) {
      resetPrincipalCache();
      setPermissions([]);
      setLoading(false);
      setError(null);
      return;
    }

    const cacheKey = cacheKeyForPrincipal({ sessionId, userId, orgId });
    const resetGeneration = principalResetGeneration;
    let cancelled = false;
    setPermissions([]);
    setLoading(true);
    setError(null);
    resolvePermissions(cacheKey)
      .then((granted) => {
        if (cancelled || resetGeneration !== principalResetGeneration) return;
        setPermissions(granted);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled || resetGeneration !== principalResetGeneration) return;
        setPermissions([]);
        setError(e instanceof Error ? e.message : 'Failed to load permissions.');
      })
      .finally(() => {
        if (!cancelled && resetGeneration === principalResetGeneration) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, sessionId, userId, orgId, retryNonce]);

  const value = useMemo<PermissionContextValue>(
    () => ({
      permissions,
      can: (permission?: TixkitPermission) => hasPermission(permissions, permission),
      loading,
      error,
      retry,
    }),
    [permissions, loading, error, retry],
  );

  return <PermissionContext value={value}>{children}</PermissionContext>;
}

export function PermissionProvider({ children }: { children: React.ReactNode }) {
  const runtimeConfig = useRuntimeConfig();
  if (hasClerkKey(runtimeConfig))
    return <ClerkPermissionProvider>{children}</ClerkPermissionProvider>;
  if (usesLocalDevAuth(runtimeConfig))
    return <LocalPermissionProvider>{children}</LocalPermissionProvider>;
  return <UnavailablePermissionProvider>{children}</UnavailablePermissionProvider>;
}

export function usePermissions() {
  const context = useContext(PermissionContext);
  if (!context) {
    throw new Error('usePermissions must be used within a PermissionProvider');
  }
  return context;
}
