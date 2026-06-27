import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trackMarketingEvent, type MarketingIntegration } from '@/lib/marketing'

const ga4Integration: MarketingIntegration = {
  provider: 'ga4',
  config: { measurementId: 'G-TEST123' },
  consentRequired: true,
  status: 'active',
}

describe('checkout marketing tracking', () => {
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    window.localStorage.clear()
    delete (window as Window & { dataLayer?: unknown[] }).dataLayer
    delete (window as Window & { gtag?: unknown }).gtag
  })

  it('does not inject consent-gated tags before consent is granted', () => {
    trackMarketingEvent([ga4Integration], 'view_item', {
      eventId: 'evt_1',
    })

    expect(document.head.querySelector('script[src*="googletagmanager.com"]')).toBeNull()
    expect((window as Window & { dataLayer?: unknown[] }).dataLayer).toBeUndefined()
  })

  it('injects GA4 and sends a PII-safe ecommerce event after consent', () => {
    window.localStorage.setItem('tixkit_marketing_consent', 'granted')

    trackMarketingEvent([ga4Integration], 'begin_checkout', {
      eventId: 'evt_1',
      sessionId: 'cs_1',
      currency: 'USD',
      valueCents: 2599,
      items: [{ id: 'tt_1', name: 'General Admission', quantity: 1, priceCents: 2599 }],
    })

    const script = document.head.querySelector('script[src*="googletagmanager.com"]')
    const dataLayer = (window as Window & { dataLayer?: unknown[] }).dataLayer ?? []
    expect(script?.getAttribute('src')).toContain('G-TEST123')
    expect(dataLayer).toContainEqual([
      'event',
      'begin_checkout',
      expect.objectContaining({
        event_id: 'evt_1',
        currency: 'USD',
        value: 25.99,
        items: [expect.objectContaining({ item_id: 'tt_1', item_name: 'General Admission' })],
      }),
    ])
    expect(JSON.stringify(dataLayer)).not.toContain('@')
  })

  it('fires generic HTTPS pixel beacons without buyer PII', () => {
    const createdImages: HTMLImageElement[] = []
    const createSpy = vi.spyOn(document, 'createElement')
    createSpy.mockImplementation(((tagName: string) => {
      const element = document.createElementNS('http://www.w3.org/1999/xhtml', tagName) as HTMLElement
      if (tagName.toLowerCase() === 'img') createdImages.push(element as HTMLImageElement)
      return element
    }) as typeof document.createElement)

    trackMarketingEvent([
      {
        provider: 'generic_tag',
        config: { pixelUrl: 'https://analytics.example/pixel' },
        consentRequired: false,
        status: 'active',
      },
    ], 'purchase', {
      eventId: 'evt_1',
      sessionId: 'cs_1',
      orderId: 'ord_1',
      currency: 'USD',
      valueCents: 5000,
    })

    expect(createdImages.at(-1)?.src).toContain('https://analytics.example/pixel?')
    expect(createdImages.at(-1)?.src).toContain('tk_event=purchase')
    expect(createdImages.at(-1)?.src).toContain('order_id=ord_1')
    expect(createdImages.at(-1)?.src).not.toContain('@')
    createSpy.mockRestore()
  })
})
