import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveBrand,
  fetchBrand,
  brandThemeStyle,
  resolveBrandFromHost,
  type ResolvedBrand,
} from '../lib/brand'

// Mock the publicApi so fetchBrand doesn't hit the network.
vi.mock('../lib/api', () => ({
  publicApi: {
    getBrand: vi.fn(),
  },
}))

import { publicApi } from '../lib/api'

describe('resolveBrand', () => {
  it('returns the platform default when no brand id is provided', () => {
    const brand = resolveBrand({})
    expect(brand.fallback).toBe(true)
    expect(brand.id).toBe('brand_platform')
    expect(brand.name).toBe('GateKit')
    expect(brand.legalUrls).toEqual({})
  })

  it('synthesizes a brand from url params and legal overrides when not cached', () => {
    const brand = resolveBrand({
      brandId: 'brand_test_uncached_1',
      brandName: 'Acme Events',
      supportUrl: 'https://help.acme.com',
      termsUrl: 'https://acme.com/terms',
      privacyUrl: 'https://acme.com/privacy',
      refundUrl: 'https://acme.com/refunds',
    })
    expect(brand.fallback).toBe(true)
    expect(brand.id).toBe('brand_test_uncached_1')
    expect(brand.name).toBe('Acme Events')
    expect(brand.supportUrl).toBe('https://help.acme.com')
    expect(brand.legalUrls.terms).toBe('https://acme.com/terms')
    expect(brand.legalUrls.privacy).toBe('https://acme.com/privacy')
    expect(brand.legalUrls.refundPolicy).toBe('https://acme.com/refunds')
    expect(brand.whiteLabel).toBe(false)
  })

  it('falls back to a generic organizer name when brandName is empty', () => {
    const brand = resolveBrand({ brandId: 'brand_test_uncached_2' })
    expect(brand.name).toBe('Event organizer')
  })

  it('trims whitespace from urls and ignores empty strings', () => {
    const brand = resolveBrand({
      brandId: 'brand_test_uncached_3',
      supportUrl: '  ',
      termsUrl: 'https://x.com/t  ',
    })
    expect(brand.supportUrl).toBeUndefined()
    expect(brand.legalUrls.terms).toBe('https://x.com/t')
  })

  it('resolves an explicit brand before domain and event ownership', () => {
    const brand = resolveBrand({
      explicitBrandId: 'brand_explicit',
      host: 'tickets.acme.test',
      domainBrandMap: 'tickets.acme.test:brand_domain',
      eventBrandId: 'brand_event',
    })

    expect(brand.id).toBe('brand_explicit')
  })

  it('resolves a configured custom domain before event ownership', () => {
    const brand = resolveBrand({
      host: 'https://tickets.acme.test/checkout',
      domainBrandMap: 'tickets.acme.test=brand_domain,event.test=brand_other',
      eventBrandId: 'brand_event',
    })

    expect(brand.id).toBe('brand_domain')
  })

  it('uses event ownership when no explicit or domain brand is available', () => {
    const brand = resolveBrand({
      host: 'checkout.gatekit.test',
      domainBrandMap: 'tickets.acme.test:brand_domain',
      eventBrandId: 'brand_event',
    })

    expect(brand.id).toBe('brand_event')
  })
})

describe('fetchBrand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(publicApi.getBrand).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('fetches and caches a brand from the backend', async () => {
    vi.mocked(publicApi.getBrand).mockResolvedValue({
      id: 'brand_fetch_1',
      name: 'Fetched Brand',
      slug: 'fetched',
      status: 'active',
      theme: { primary: 'oklch(0.5 0.2 20)', background: '#fff' },
      supportUrl: 'https://help.fetched.com',
      legalUrls: {
        terms: 'https://fetched.com/terms',
        privacy: 'https://fetched.com/privacy',
        refundPolicy: 'https://fetched.com/refunds',
      },
      whiteLabel: true,
    })

    const brand = await fetchBrand({ brandId: 'brand_fetch_1' })
    expect(brand.fallback).toBe(false)
    expect(brand.id).toBe('brand_fetch_1')
    expect(brand.name).toBe('Fetched Brand')
    expect(brand.whiteLabel).toBe(true)
    expect(brand.theme.primary).toBe('oklch(0.5 0.2 20)')
    expect(brand.legalUrls.terms).toBe('https://fetched.com/terms')

    // Second call should use cache (no additional fetch).
    await fetchBrand({ brandId: 'brand_fetch_1' })
    expect(publicApi.getBrand).toHaveBeenCalledTimes(1)
  })

  it('falls back to URL params when the fetch fails', async () => {
    vi.mocked(publicApi.getBrand).mockRejectedValue(new Error('Network error'))

    const brand = await fetchBrand({
      brandId: 'brand_fetch_fail_1',
      brandName: 'Fallback Brand',
    })
    expect(brand.name).toBe('Fallback Brand')
    expect(brand.fallback).toBe(true)
  })

  it('returns platform default when no brand id is provided', async () => {
    const brand = await fetchBrand({})
    expect(brand.fallback).toBe(true)
    expect(brand.id).toBe('brand_platform')
  })

  it('fetches the brand selected by custom domain resolution', async () => {
    vi.mocked(publicApi.getBrand).mockResolvedValue({
      id: 'brand_domain_fetch',
      name: 'Domain Brand',
      slug: 'domain-brand',
      status: 'active',
      theme: {},
      supportUrl: undefined,
      legalUrls: {},
      whiteLabel: true,
    })

    const brand = await fetchBrand({
      host: 'tickets.domain.test',
      domainBrandMap: '{"tickets.domain.test":"brand_domain_fetch"}',
      eventBrandId: 'brand_event_fetch',
    })

    expect(publicApi.getBrand).toHaveBeenCalledWith('brand_domain_fetch')
    expect(brand.id).toBe('brand_domain_fetch')
    expect(brand.whiteLabel).toBe(true)
    expect(brand.fallback).toBe(false)
  })
})

describe('brandThemeStyle', () => {
  it('returns undefined when the brand has no theme tokens', () => {
    const brand: ResolvedBrand = {
      id: 'b',
      name: 'x',
      legalUrls: {},
      theme: {},
      whiteLabel: false,
      fallback: true,
    }
    expect(brandThemeStyle(brand)).toBeUndefined()
  })

  it('maps theme tokens to css custom properties', () => {
    const brand: ResolvedBrand = {
      id: 'b',
      name: 'x',
      legalUrls: {},
      theme: {
        primary: 'oklch(0.5 0.2 20)',
        accent: '#ff0000',
        radius: '0.5rem',
      },
      whiteLabel: true,
      fallback: false,
    }
    const style = brandThemeStyle(brand) as Record<string, string>
    expect(style['--primary']).toBe('oklch(0.5 0.2 20)')
    expect(style['--accent']).toBe('#ff0000')
    expect(style['--radius']).toBe('0.5rem')
  })

  it('maps the full token set including background, foreground, card, muted, secondary, border', () => {
    const brand: ResolvedBrand = {
      id: 'b',
      name: 'x',
      legalUrls: {},
      theme: {
        background: '#ffffff',
        foreground: '#000000',
        card: '#f8f8f8',
        muted: '#e0e0e0',
        secondary: '#cccccc',
        border: '#dddddd',
        primary: '#0066cc',
        accent: '#00cccc',
        radius: '0.75rem',
      },
      whiteLabel: false,
      fallback: false,
    }
    const style = brandThemeStyle(brand) as Record<string, string>
    expect(style['--background']).toBe('#ffffff')
    expect(style['--foreground']).toBe('#000000')
    expect(style['--card']).toBe('#f8f8f8')
    expect(style['--muted']).toBe('#e0e0e0')
    expect(style['--secondary']).toBe('#cccccc')
    expect(style['--border']).toBe('#dddddd')
    expect(style['--primary']).toBe('#0066cc')
    expect(style['--accent']).toBe('#00cccc')
    expect(style['--radius']).toBe('0.75rem')
  })

  it('handles custom properties that already have -- prefix', () => {
    const brand: ResolvedBrand = {
      id: 'b',
      name: 'x',
      legalUrls: {},
      theme: {
        '--sidebar-bg': '#333',
      },
      whiteLabel: false,
      fallback: false,
    }
    const style = brandThemeStyle(brand) as Record<string, string>
    expect(style['--sidebar-bg']).toBe('#333')
  })
})

describe('resolveBrandFromHost', () => {
  it('returns undefined when no x-gatekit-brand param is present', () => {
    // jsdom or node environment without window
    if (typeof window === 'undefined') {
      expect(resolveBrandFromHost()).toBeUndefined()
    } else {
      // In jsdom, URLSearchParams will read from window.location.search
      expect(resolveBrandFromHost()).toBeUndefined()
    }
  })

  it('prefers explicit brand query over configured host mapping', () => {
    const brandId = resolveBrandFromHost({
      search: '?brand=brand_query',
      host: 'tickets.acme.test',
      domainBrandMap: 'tickets.acme.test:brand_domain',
      eventBrandId: 'brand_event',
    })

    expect(brandId).toBe('brand_query')
  })

  it('resolves mapped custom domains and wildcard subdomains', () => {
    expect(
      resolveBrandFromHost({
        host: 'tickets.acme.test:443',
        domainBrandMap: 'tickets.acme.test:brand_exact',
      }),
    ).toBe('brand_exact')

    expect(
      resolveBrandFromHost({
        host: 'vip.events.acme.test',
        domainBrandMap: '*.events.acme.test:brand_wildcard',
      }),
    ).toBe('brand_wildcard')
  })

  it('falls back to event ownership when query and domain do not resolve', () => {
    const brandId = resolveBrandFromHost({
      search: '?mode=inline',
      host: 'checkout.gatekit.test',
      domainBrandMap: 'tickets.acme.test:brand_domain',
      eventBrandId: 'brand_event',
    })

    expect(brandId).toBe('brand_event')
  })
})
