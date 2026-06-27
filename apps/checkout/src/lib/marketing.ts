export type MarketingProvider = 'ga4' | 'meta_pixel' | 'generic_tag'

export type MarketingIntegration = {
  provider: MarketingProvider
  config: Record<string, unknown>
  consentRequired: boolean
  status: string
}

export type MarketingEventName = 'view_item' | 'begin_checkout' | 'purchase'

export type MarketingEventItem = {
  id?: string
  name?: string
  quantity?: number
  priceCents?: number
}

export type MarketingEventPayload = {
  eventId: string
  sessionId?: string
  orderId?: string
  currency?: string
  valueCents?: number
  items?: MarketingEventItem[]
}

type MarketingWindow = Window & {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
  fbq?: (...args: unknown[]) => void
}

const CONSENT_KEY = 'tixkit_marketing_consent'
const GA4_SCRIPT_PREFIX = 'tixkit-ga4-'
const META_SCRIPT_ID = 'tixkit-meta-pixel'

function browserWindow(): MarketingWindow | null {
  return typeof window === 'undefined' ? null : window as MarketingWindow
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function hasConsent(integration: MarketingIntegration): boolean {
  if (!integration.consentRequired) return true
  try {
    const value = window.localStorage.getItem(CONSENT_KEY)
    return value === 'granted' || value === 'true' || value === '1'
  } catch {
    return false
  }
}

function centsToAmount(valueCents?: number): number | undefined {
  if (!Number.isFinite(valueCents)) return undefined
  return Math.max(0, Number(valueCents)) / 100
}

function safeItems(items: MarketingEventItem[] | undefined) {
  return (items ?? []).map((item) => ({
    item_id: item.id,
    item_name: item.name,
    quantity: item.quantity,
    price: centsToAmount(item.priceCents),
  })).filter((item) => item.item_id || item.item_name)
}

function scriptId(prefix: string, id: string): string {
  return `${prefix}${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function ensureScript(id: string, src: string): void {
  if (document.getElementById(id)) return
  const script = document.createElement('script')
  script.id = id
  script.async = true
  script.src = src
  document.head.appendChild(script)
}

function trackGa4(integration: MarketingIntegration, name: MarketingEventName, payload: MarketingEventPayload): void {
  const win = browserWindow()
  if (!win) return
  const measurementId = configString(integration.config, 'measurementId')
  if (!measurementId) return

  win.dataLayer = win.dataLayer ?? []
  win.gtag = win.gtag ?? function gtag(...args: unknown[]) {
    win.dataLayer?.push(args)
  }
  ensureScript(scriptId(GA4_SCRIPT_PREFIX, measurementId), `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`)
  win.gtag('js', new Date())
  win.gtag('config', measurementId, { send_page_view: false })
  win.gtag('event', name, {
    event_id: payload.eventId,
    transaction_id: payload.orderId,
    currency: payload.currency,
    value: centsToAmount(payload.valueCents),
    items: safeItems(payload.items),
  })
}

function trackMeta(integration: MarketingIntegration, name: MarketingEventName, payload: MarketingEventPayload): void {
  const win = browserWindow()
  if (!win) return
  const pixelId = configString(integration.config, 'pixelId')
  if (!pixelId) return

  if (!win.fbq) {
    const queue: unknown[] = []
    win.fbq = (...args: unknown[]) => {
      queue.push(args)
    }
    ;(win.fbq as unknown as { queue: unknown[]; loaded: boolean; version: string }).queue = queue
    ;(win.fbq as unknown as { queue: unknown[]; loaded: boolean; version: string }).loaded = true
    ;(win.fbq as unknown as { queue: unknown[]; loaded: boolean; version: string }).version = '2.0'
    ;(win as unknown as Record<string, unknown>)['_fbq'] = win.fbq
    ensureScript(META_SCRIPT_ID, 'https://connect.facebook.net/en_US/fbevents.js')
  }

  win.fbq('init', pixelId)
  const eventName = name === 'view_item'
    ? 'PageView'
    : name === 'begin_checkout'
      ? 'InitiateCheckout'
      : 'Purchase'
  win.fbq('track', eventName, {
    content_type: 'event',
    content_ids: [payload.eventId],
    currency: payload.currency,
    value: centsToAmount(payload.valueCents),
  })
}

function trackGeneric(integration: MarketingIntegration, name: MarketingEventName, payload: MarketingEventPayload): void {
  const pixelUrl = configString(integration.config, 'pixelUrl')
  if (!pixelUrl) return
  let url: URL
  try {
    url = new URL(pixelUrl)
  } catch {
    return
  }
  if (url.protocol !== 'https:') return
  url.searchParams.set('tk_event', name)
  url.searchParams.set('event_id', payload.eventId)
  if (payload.sessionId) url.searchParams.set('session_id', payload.sessionId)
  if (payload.orderId) url.searchParams.set('order_id', payload.orderId)
  if (payload.currency) url.searchParams.set('currency', payload.currency)
  const value = centsToAmount(payload.valueCents)
  if (value !== undefined) url.searchParams.set('value', String(value))
  const beacon = document.createElement('img')
  beacon.referrerPolicy = 'strict-origin-when-cross-origin'
  beacon.src = url.toString()
}

export function trackMarketingEvent(
  integrations: MarketingIntegration[] | undefined,
  name: MarketingEventName,
  payload: MarketingEventPayload,
): void {
  if (!integrations?.length || typeof document === 'undefined') return
  for (const integration of integrations) {
    if (integration.status !== 'active' || !hasConsent(integration)) continue
    if (integration.provider === 'ga4') trackGa4(integration, name, payload)
    if (integration.provider === 'meta_pixel') trackMeta(integration, name, payload)
    if (integration.provider === 'generic_tag') trackGeneric(integration, name, payload)
  }
}
