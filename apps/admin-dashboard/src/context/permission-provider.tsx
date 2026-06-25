'use client'

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  LOCAL_DEV_PERMISSIONS,
  type GateKitPermission,
  hasPermission,
} from '@/lib/permissions'
import { hasClerkKey } from '@/lib/auth'
import { adminApi } from '@/lib/api'

type PermissionContextValue = {
  permissions: GateKitPermission[]
  can: (permission?: GateKitPermission) => boolean
  /** True while the principal/permissions are being resolved in production. */
  loading: boolean
  /** Set when the principal fetch failed (production). Null when OK or in dev. */
  error: string | null
}

const PermissionContext = createContext<PermissionContextValue | null>(null)

/**
 * Module-level cache for the resolved principal so the fetch happens at most
 * once per browser session (the GateKit principal is stable for a session).
 */
let principalCache: GateKitPermission[] | null = null
let principalFetchPromise: Promise<GateKitPermission[]> | null = null

async function resolvePermissions(): Promise<GateKitPermission[]> {
  if (!hasClerkKey()) {
    return LOCAL_DEV_PERMISSIONS
  }

  if (principalCache) return principalCache
  if (principalFetchPromise) return principalFetchPromise

  principalFetchPromise = (async () => {
    const result = await adminApi.getPrincipal()
    if (result.ok) {
      // Fail closed: only honor permissions the backend actually granted.
      const granted = result.data.permissions.filter(
        (p): p is GateKitPermission =>
          typeof p === 'string' && p.length > 0,
      )
      principalCache = granted
      return granted
    }
    // Fetch failed: fail closed with no permissions. Callers surface the
    // error; we never default to full access in production.
    principalCache = []
    throw new Error(
      result.error.message || 'Failed to load permissions for your account.',
    )
  })()

  try {
    return await principalFetchPromise
  } finally {
    principalFetchPromise = null
  }
}

/** Reset the principal cache. Exposed for tests and sign-out flows. */
export function resetPrincipalCache(): void {
  principalCache = null
  principalFetchPromise = null
}

export function PermissionProvider({ children }: { children: React.ReactNode }) {
  const [permissions, setPermissions] = useState<GateKitPermission[]>(
    () => []
  )
  const [loading, setLoading] = useState<boolean>(() => hasClerkKey())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!hasClerkKey()) {
      setPermissions(LOCAL_DEV_PERMISSIONS)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    resolvePermissions()
      .then((granted) => {
        if (cancelled) return
        setPermissions(granted)
        setError(null)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setPermissions([])
        setError(e instanceof Error ? e.message : 'Failed to load permissions.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo<PermissionContextValue>(
    () => ({
      permissions,
      can: (permission?: GateKitPermission) =>
        hasPermission(permissions, permission),
      loading,
      error,
    }),
    [permissions, loading, error],
  )

  return (
    <PermissionContext value={value}>{children}</PermissionContext>
  )
}

export function usePermissions() {
  const context = useContext(PermissionContext)
  if (!context) {
    throw new Error('usePermissions must be used within a PermissionProvider')
  }
  return context
}
