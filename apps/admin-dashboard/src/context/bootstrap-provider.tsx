'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  type AdminOrganization,
  type AdminBrand,
  adminApi,
} from '@/lib/api'

/**
 * Bootstrap context providing the current organization and brand IDs
 * resolved from the live API (or fixtures in test mode).
 *
 * This replaces the old `NEXT_PUBLIC_GATEKIT_ORGANIZATION_ID` /
 * `NEXT_PUBLIC_GATEKIT_BRAND_ID` env var fallbacks. Event creation, API key
 * creation, and webhook creation must pass these IDs explicitly from this
 * context rather than relying on hidden env defaults.
 */
type BootstrapContextValue = {
  organizations: AdminOrganization[]
  brands: AdminBrand[]
  /** Explicitly selected organization ID for the current principal, or undefined until selected. */
  organizationId: string | undefined
  /** Explicitly selected brand ID belonging to the current organization, or undefined until selected. */
  brandId: string | undefined
  availableBrands: AdminBrand[]
  setOrganizationId: (organizationId: string | undefined) => void
  setBrandId: (brandId: string | undefined) => void
  loading: boolean
  error: string | null
}

const BootstrapContext = createContext<BootstrapContextValue | null>(null)
const selectedOrganizationStorageKey = 'gatekit:selected-organization-id'
const selectedBrandStorageKey = 'gatekit:selected-brand-id'

function storedSelection(key: string): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = window.localStorage.getItem(key)
  return value && value.trim().length > 0 ? value : undefined
}

function persistSelection(key: string, value: string | undefined): void {
  if (typeof window === 'undefined') return
  if (value) window.localStorage.setItem(key, value)
  else window.localStorage.removeItem(key)
}

export function BootstrapProvider({ children }: { children: React.ReactNode }) {
  const [organizations, setOrganizations] = useState<AdminOrganization[]>([])
  const [brands, setBrands] = useState<AdminBrand[]>([])
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | undefined>(() =>
    storedSelection(selectedOrganizationStorageKey)
  )
  const [selectedBrandId, setSelectedBrandId] = useState<string | undefined>(() =>
    storedSelection(selectedBrandStorageKey)
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const [orgResult, brandResult] = await Promise.all([
          adminApi.listOrganizations(),
          adminApi.listBrands(),
        ])

        if (cancelled) return

        if (!orgResult.ok) {
          setError(orgResult.error.message)
          setOrganizations([])
          setBrands([])
          return
        }

        if (!brandResult.ok) {
          setError(brandResult.error.message)
          setOrganizations(orgResult.data)
          setBrands([])
          return
        }

        setError(null)
        setOrganizations(orgResult.data)
        setBrands(brandResult.data)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load organization context.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  const organizationId = organizations.some((org) => org.id === selectedOrganizationId)
    ? selectedOrganizationId
    : undefined
  const availableBrands = useMemo(
    () => (organizationId ? brands.filter((brand) => brand.organizationId === organizationId) : []),
    [brands, organizationId],
  )
  const brandId = availableBrands.some((brand) => brand.id === selectedBrandId)
    ? selectedBrandId
    : undefined

  useEffect(() => {
    if (loading) return

    const validOrganization = organizations.find((org) => org.id === selectedOrganizationId)
    if (!validOrganization) {
      const nextOrganizationId = organizations.length === 1 ? organizations[0]?.id : undefined
      setSelectedOrganizationId(nextOrganizationId)
      persistSelection(selectedOrganizationStorageKey, nextOrganizationId)
      setSelectedBrandId(undefined)
      persistSelection(selectedBrandStorageKey, undefined)
      return
    }

    persistSelection(selectedOrganizationStorageKey, validOrganization.id)
  }, [loading, organizations, selectedOrganizationId])

  useEffect(() => {
    if (loading || !organizationId) return

    const orgBrands = brands.filter((brand) => brand.organizationId === organizationId)
    const validBrand = orgBrands.find((brand) => brand.id === selectedBrandId)
    if (!validBrand) {
      const nextBrandId = orgBrands.length === 1 ? orgBrands[0]?.id : undefined
      setSelectedBrandId(nextBrandId)
      persistSelection(selectedBrandStorageKey, nextBrandId)
      return
    }

    persistSelection(selectedBrandStorageKey, validBrand.id)
  }, [brands, loading, organizationId, selectedBrandId])

  const setOrganizationId = useCallback((nextOrganizationId: string | undefined) => {
    setSelectedOrganizationId(nextOrganizationId)
    persistSelection(selectedOrganizationStorageKey, nextOrganizationId)
    setSelectedBrandId(undefined)
    persistSelection(selectedBrandStorageKey, undefined)
  }, [])

  const setBrandId = useCallback((nextBrandId: string | undefined) => {
    setSelectedBrandId(nextBrandId)
    persistSelection(selectedBrandStorageKey, nextBrandId)
  }, [])

  const value = useMemo<BootstrapContextValue>(
    () => ({
      organizations,
      brands,
      organizationId,
      brandId,
      availableBrands,
      setOrganizationId,
      setBrandId,
      loading,
      error,
    }),
    [organizations, brands, organizationId, brandId, availableBrands, setOrganizationId, setBrandId, loading, error],
  )

  return (
    <BootstrapContext value={value}>{children}</BootstrapContext>
  )
}

export function useBootstrap() {
  const context = useContext(BootstrapContext)
  if (!context) {
    throw new Error('useBootstrap must be used within a BootstrapProvider')
  }
  return context
}
