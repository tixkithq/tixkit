'use client'

import { useEffect, useState } from 'react'
import {
  resolveBrand,
  fetchBrand,
  type ResolvedBrand,
} from './brand'

type BrandResolveInput = {
  brandId?: string
  brandName?: string
  supportUrl?: string
  termsUrl?: string
  privacyUrl?: string
  refundUrl?: string
}

/**
 * Hook that resolves a brand synchronously from cache/URL params and then
 * fetches the real brand from the backend, updating state when the fetch
 * resolves. This keeps the UI responsive while supporting real brand data.
 */
export function useResolvedBrand(input: BrandResolveInput): ResolvedBrand {
  const [brand, setBrand] = useState<ResolvedBrand>(() => resolveBrand(input))

  useEffect(() => {
    const initial = resolveBrand(input)
    setBrand(initial)

    if (!input.brandId?.trim()) return
    if (!initial.fallback) return

    let cancelled = false
    void fetchBrand(input).then((resolved) => {
      if (cancelled) return
      if (!resolved.fallback) {
        setBrand(resolved)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    input.brandId,
    input.brandName,
    input.supportUrl,
    input.termsUrl,
    input.privacyUrl,
    input.refundUrl,
  ])

  return brand
}
