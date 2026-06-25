/**
 * Brand resolution boundary for hosted checkout/event surfaces.
 *
 * Resolves brand info from:
 *   1. A real fetch to `GET /v1/public/brands/:brandId` (cached in-memory)
 *   2. An explicit brand query, configured custom domain, or event ownership
 *   3. URL query params as fallback for dev / when the fetch fails
 *   4. A platform default that hides nothing and renders with dashboard tokens
 *
 * The component layer only ever consumes `ResolvedBrand`, so swapping the fetch
 * for a different source does not change any UI code.
 */

import { publicApi, type BrandViewModel } from './api'

export type BrandLegalUrls = {
  terms?: string
  privacy?: string
  refundPolicy?: string
}

export type BrandThemeTokens = {
  /** Full CSS custom property overrides applied to the checkout shell root. */
  background?: string
  foreground?: string
  card?: string
  muted?: string
  secondary?: string
  border?: string
  primary?: string
  accent?: string
  radius?: string
  [key: string]: string | undefined
}

export type ResolvedBrand = {
  id: string
  name: string
  slug?: string
  supportUrl?: string
  legalUrls: BrandLegalUrls
  theme: BrandThemeTokens
  whiteLabel: boolean
  /** True when the brand was resolved from defaults rather than a real source. */
  fallback: boolean
}

const PLATFORM_DEFAULT: ResolvedBrand = {
  id: 'brand_platform',
  name: 'GateKit',
  supportUrl: undefined,
  legalUrls: {},
  theme: {},
  whiteLabel: false,
  fallback: true,
}

type BrandResolveInput = {
  /** Explicit brand selected by hosted checkout/widget query params. */
  explicitBrandId?: string
  /** Backward-compatible alias for explicit brand IDs. */
  brandId?: string
  /** Brand owned by the selected event, used after explicit/domain resolution. */
  eventBrandId?: string
  /** Request/window host used for custom-domain brand resolution. */
  host?: string
  /** Optional domain mapping override for tests or embedded runtimes. */
  domainBrandMap?: string
  brandName?: string
  supportUrl?: string
  termsUrl?: string
  privacyUrl?: string
  refundUrl?: string
}

// In-memory brand cache keyed by brandId.
const brandCache = new Map<string, ResolvedBrand>()

function allowsUnverifiedBrandFallback(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * Map a backend BrandViewModel to a ResolvedBrand.
 */
function mapBrandViewModel(vm: BrandViewModel): ResolvedBrand {
  const legalUrls = vm.legalUrls ?? {}

  return {
    id: vm.id,
    name: vm.name,
    slug: vm.slug,
    supportUrl: vm.supportUrl,
    legalUrls: {
      terms: legalUrls.terms,
      privacy: legalUrls.privacy,
      refundPolicy: legalUrls.refundPolicy,
    },
    theme: vm.theme as BrandThemeTokens,
    whiteLabel: vm.whiteLabel,
    fallback: false,
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function configuredDomainBrandMap(): string | undefined {
  return clean(process.env.NEXT_PUBLIC_GATEKIT_DOMAIN_BRANDS)
}

function normalizeHost(host: string | undefined): string | undefined {
  const trimmed = clean(host)
  if (!trimmed) return undefined

  try {
    const url = trimmed.includes('://')
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`)
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return trimmed
      .split('/')[0]
      ?.split(':')[0]
      ?.toLowerCase()
      .replace(/\.$/, '')
  }
}

function parseDomainBrandMap(config: string | undefined): Array<[string, string]> {
  const value = clean(config)
  if (!value) return []

  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>)
        .map(([domain, brandId]) => [
          normalizeHost(domain),
          typeof brandId === 'string' ? clean(brandId) : undefined,
        ])
        .filter(
          (entry): entry is [string, string] =>
            Boolean(entry[0]) && Boolean(entry[1]),
        )
    }
  } catch {
    // Non-JSON comma-separated mappings are handled below.
  }

  return value
    .split(',')
    .map((entry) => {
      const separator = entry.includes('=') ? '=' : ':'
      const separatorIndex = entry.lastIndexOf(separator)
      if (separatorIndex < 1) return undefined
      return [
        normalizeHost(entry.slice(0, separatorIndex)),
        clean(entry.slice(separatorIndex + 1)),
      ]
    })
    .filter(
      (entry): entry is [string, string] =>
        Boolean(entry?.[0]) && Boolean(entry?.[1]),
    )
}

function findMappedBrandId(
  host: string | undefined,
  domainBrandMap: string | undefined,
): string | undefined {
  const normalizedHost = normalizeHost(host)
  if (!normalizedHost) return undefined

  for (const [domain, brandId] of parseDomainBrandMap(domainBrandMap)) {
    if (domain === normalizedHost) return brandId
    if (domain.startsWith('*.')) {
      const suffix = domain.slice(1)
      if (normalizedHost.endsWith(suffix)) return brandId
    }
  }

  return undefined
}

function currentWindowHost(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return window.location.host
}

function resolveBrandId(input: BrandResolveInput): string | undefined {
  const explicit = clean(input.explicitBrandId) ?? clean(input.brandId)
  if (explicit) return explicit

  const mapped = findMappedBrandId(
    input.host ?? currentWindowHost(),
    input.domainBrandMap ?? configuredDomainBrandMap(),
  )
  if (mapped) return mapped

  return clean(input.eventBrandId)
}

/**
 * Resolve a brand synchronously from cache or URL params.
 *
 * This returns immediately from the in-memory cache or a URL-param-based
 * fallback. Use `fetchBrand` to trigger an async fetch that populates the cache.
 */
export function resolveBrand(input: BrandResolveInput): ResolvedBrand {
  const id = resolveBrandId(input)

  if (!id) return { ...PLATFORM_DEFAULT }

  // Return from cache if available.
  const cached = brandCache.get(id)
  if (cached) return cached

  // Fallback: synthesize from URL params.
  return {
    id,
    name: input.brandName?.trim() || 'Event organizer',
    supportUrl: input.supportUrl?.trim() || undefined,
    legalUrls: {
      terms: input.termsUrl?.trim() || undefined,
      privacy: input.privacyUrl?.trim() || undefined,
      refundPolicy: input.refundUrl?.trim() || undefined,
    },
    theme: {},
    whiteLabel: false,
    fallback: true,
  }
}

/**
 * Fetch a brand from the backend and cache it.
 *
 * Returns the resolved brand, or a URL-param fallback if the fetch fails
 * (so dev still renders without a running backend).
 */
export async function fetchBrand(
  input: BrandResolveInput,
): Promise<ResolvedBrand> {
  const id = resolveBrandId(input)

  if (!id) return { ...PLATFORM_DEFAULT }

  // Return from cache if available.
  const cached = brandCache.get(id)
  if (cached) return cached

  try {
    const vm = await publicApi.getBrand(id)
    const resolved = mapBrandViewModel(vm)
    brandCache.set(id, resolved)
    return resolved
  } catch {
    if (allowsUnverifiedBrandFallback()) {
      return resolveBrand(input)
    }
    return { ...PLATFORM_DEFAULT }
  }
}

/**
 * Resolve brand from the host header or a custom domain.
 *
 * Query params are explicit and take precedence over custom-domain mappings.
 * Event ownership is the final fallback so branded checkout still works when a
 * customer lands on the platform hostname.
 */
export function resolveBrandFromHost(input: {
  search?: string
  host?: string
  domainBrandMap?: string
  eventBrandId?: string
} = {}): string | undefined {
  try {
    const search =
      input.search ??
      (typeof window === 'undefined' ? '' : window.location.search)
    const params = new URLSearchParams(search)
    const explicitBrand =
      clean(params.get('brand') ?? undefined) ??
      clean(params.get('x-gatekit-brand') ?? undefined)
    if (explicitBrand) return explicitBrand

    const mapped = findMappedBrandId(
      input.host ?? currentWindowHost(),
      input.domainBrandMap ?? configuredDomainBrandMap(),
    )
    if (mapped) return mapped

    return clean(input.eventBrandId)
  } catch {
    return undefined
  }
}

/**
 * Convert brand theme tokens into a CSS style object applied to the surface
 * root so white-label customers can tint the checkout without a new design
 * system.
 *
 * Maps the full token set: --background, --foreground, --card, --muted,
 * --secondary, --border, --primary, --accent, --radius, and any additional
 * custom properties the brand provides.
 */
export function brandThemeStyle(
  brand: ResolvedBrand,
): React.CSSProperties | undefined {
  const style: Record<string, string> = {}
  const theme = brand.theme
  if (!theme) return undefined

  for (const [key, value] of Object.entries(theme)) {
    if (!value) continue
    // Convert camelCase token names to CSS custom property names.
    // e.g. "primary" -> "--primary", "secondary" -> "--secondary"
    const tokenKey = key === 'primaryColor' ? 'primary' : key
    const cssKey = tokenKey.startsWith('--') ? tokenKey : `--${tokenKey}`
    style[cssKey] = value
  }

  if (Object.keys(style).length === 0) return undefined
  return style as React.CSSProperties
}
