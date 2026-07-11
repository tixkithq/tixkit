// Tixkit Embeddable Widget - TypeScript Web Components.
//
// Can be loaded once and mount multiple widgets on a page. No secret
// credentials are embedded in browser code.
//
import {
  EMBED_CONTRACT_VERSION,
  EMBED_LEGACY_EVENT_ALIASES,
  createEmbedNonce,
  createHostHelloMessage,
  createWidgetId,
  parseEmbedThemeTokens,
  validateCheckoutMessageEvent,
  versionedLifecycleEventName,
  type EmbedCheckoutLifecycleMessage,
  type EmbedElementConfig,
  type EmbedLifecycleName,
  type EmbedMode,
} from '@tixkit/embed-core';

export * from '@tixkit/embed-core';
//
// Style hooks (CSS custom properties on the host element):
//   --tk-radius   - border radius for widget surfaces (default 0.625rem)
//   --tk-primary  - primary accent color used for buttons/headers
//   --tk-bg       - widget background
//   --tk-fg       - widget foreground text
//
type WidgetConfig = {
  brand: string;
  event: string;
  locale?: string;
  theme?: 'auto' | 'light' | 'dark';
  themeTokens?: string;
  products?: string;
  discountCode?: string;
  accessCode?: string;
  trackingId?: string;
  affiliateCode?: string;
  checkoutMode?: 'inline' | 'modal' | 'redirect';
  checkoutBaseUrl?: string;
  reportingApiUrl?: string;
  hostOrigin?: string;
};

type CheckoutMode = 'inline' | 'modal' | 'redirect';

type MarketingIntegration = {
  provider: 'ga4' | 'meta_pixel' | 'generic_tag';
  config: Record<string, unknown>;
  consentRequired: boolean;
  status: string;
};

type MarketingEventName = 'view_item' | 'begin_checkout' | 'purchase';

const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
const IFRAME_ALLOW = 'payment; publickey-credentials-create *; publickey-credentials-get *';
export const TIXKIT_WIDGET_VERSION = '0.1.0';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const handshakeTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
const widgetStartedAt = new WeakMap<HTMLElement, number>();

function recordWidgetPerformance(
  element: HTMLElement,
  mode: CheckoutMode,
  outcome: 'ready' | 'error',
  errorCode?: string,
): void {
  const start = widgetStartedAt.get(element);
  if (start === undefined || typeof performance?.measure !== 'function') return;
  try {
    performance.measure(`tixkit.widget.${outcome}`, {
      start,
      end: performance.now(),
      detail: {
        widgetVersion: TIXKIT_WIDGET_VERSION,
        contractVersion: EMBED_CONTRACT_VERSION,
        mode,
        ...(errorCode ? { errorCode } : {}),
      },
    });
  } catch {
    // Performance measurement support is optional and never blocks checkout.
  }
}

function cancelHandshakeTimeout(element: HTMLElement): void {
  const timer = handshakeTimers.get(element);
  if (timer !== undefined) clearTimeout(timer);
  handshakeTimers.delete(element);
}

function scheduleHandshakeTimeout(element: HTMLElement, onTimeout: () => void): void {
  cancelHandshakeTimeout(element);
  handshakeTimers.set(
    element,
    setTimeout(() => {
      handshakeTimers.delete(element);
      onTimeout();
    }, HANDSHAKE_TIMEOUT_MS),
  );
}

// Keep the embedded stylesheet compact: template-literal whitespace is shipped
// byte-for-byte and is part of the public widget performance budget.
const STYLES = `:host{display:block;width:100%;--tk-radius:var(--tk-radius,0.625rem);--tk-primary:var(--tk-primary,oklch(0.208 0.042 265.755));--tk-bg:var(--tk-bg,#fff);--tk-fg:var(--tk-fg,#171717);color:var(--tk-fg)}.tk-root{position:relative;width:100%;min-height:420px;border-radius:var(--tk-radius);overflow:hidden;background:var(--tk-bg);border:1px solid rgba(23,23,23,.12)}.tk-frame{width:100%;height:100%;min-height:420px;border:0;display:block;background:var(--tk-bg)}.tk-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;background:var(--tk-bg);color:var(--tk-fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.tk-spinner{width:24px;height:24px;border:2px solid rgba(23,23,23,.18);border-top-color:var(--tk-primary);border-radius:50%;animation:tk-spin .8s linear infinite}@keyframes tk-spin{to{transform:rotate(360deg)}}.tk-error-icon{width:32px;height:32px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:rgba(220,38,38,.12);color:#b91c1c;font-size:18px;font-weight:700}.tk-retry{border:1px solid rgba(23,23,23,.18);background:var(--tk-bg);color:var(--tk-fg);border-radius:6px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}.tk-retry:hover{background:rgba(23,23,23,.05)}.tk-modal-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}.tk-modal{width:min(560px,100%);max-height:90vh;border-radius:var(--tk-radius);overflow:hidden;background:var(--tk-bg);display:flex;flex-direction:column}.tk-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(23,23,23,.1);background:var(--tk-bg);color:var(--tk-fg)}.tk-modal-title{background:#fff;color:#171717;font-weight:600}.tk-modal-close{border:0;background:transparent;color:var(--tk-fg);font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}.tk-modal-close:hover{background:rgba(23,23,23,.06)}.tk-modal-frame{width:100%;height:70vh;border:0;background:var(--tk-bg)}.tk-launcher{background:var(--tk-primary,oklch(0.208 0.042 265.755));color:#fff;border:0;padding:12px 24px;border-radius:var(--tk-radius,.5rem);font:600 16px var(--tk-font-family,ui-sans-serif,system-ui,sans-serif);cursor:pointer;transition:opacity .2s}.tk-launcher:hover{opacity:.9}.tk-launcher:disabled{opacity:.5;cursor:not-allowed}`;

const COMPACT_STYLES = `:host{display:block;width:100%;--tk-radius:.625rem;--tk-primary:oklch(.208 .042 265.755);--tk-bg:#fff;--tk-fg:#171717;color:var(--tk-fg)}.tk-root{position:relative;width:100%;min-height:420px;border-radius:var(--tk-radius);overflow:hidden;border:1px solid #1717171f}.tk-frame,.tk-modal-frame{width:100%;border:0}.tk-frame{height:100%;min-height:420px;display:block}.tk-state{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;font:14px/1.5 system-ui,sans-serif}.tk-spinner{width:24px;height:24px;border:2px solid #1717172e;border-top-color:var(--tk-primary);border-radius:50%;animation:tk-spin .8s linear infinite}@keyframes tk-spin{to{transform:rotate(360deg)}}.tk-error-icon{color:#b91c1c;font-size:18px;font-weight:700}.tk-retry{border:1px solid #1717172e;background:var(--tk-bg);color:inherit;border-radius:6px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}.tk-modal-backdrop{position:fixed;inset:0;z-index:9999;background:#0009;display:flex;align-items:center;justify-content:center;padding:16px}.tk-modal{width:min(560px,100%);max-height:90vh;border-radius:var(--tk-radius);overflow:hidden;background:var(--tk-bg);display:flex;flex-direction:column}.tk-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #1717171a}.tk-modal-title{font-weight:600}.tk-modal-close{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;padding:4px 8px}.tk-modal-frame{height:70vh}.tk-launcher{background:var(--tk-primary);color:#fff;border:0;padding:12px 24px;border-radius:var(--tk-radius);font:600 16px system-ui,sans-serif;cursor:pointer}.tk-launcher:disabled{opacity:.5;cursor:not-allowed}`;
void STYLES;

function injectStyles(shadow: ShadowRoot, themeCss = ''): void {
  if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`${COMPACT_STYLES}\n${themeCss}`);
    shadow.adoptedStyleSheets = [sheet];
    return;
  }
  const style = document.createElement('style');
  style.textContent = `${COMPACT_STYLES}\n${themeCss}`;
  shadow.appendChild(style);
}

function checkoutBase(element: HTMLElement): string {
  return (element.getAttribute('api-base-url') ?? 'https://checkout.tixkit.com').replace(/\/$/, '');
}

function readElementConfiguration(
  element: HTMLElement,
  defaultMode: CheckoutMode,
): EmbedElementConfig {
  const value = (name: string) => element.getAttribute(name) || undefined;
  const themeTokens = parseEmbedThemeTokens(value('theme-tokens'));
  return {
    brandId: value('brand') ?? '',
    eventId: value('event') ?? '',
    mode: (value('checkout-mode') ?? defaultMode) as EmbedElementConfig['mode'],
    ...(value('locale') ? { locale: value('locale') } : {}),
    ...(value('theme') ? { theme: value('theme') as EmbedElementConfig['theme'] } : {}),
    ...(themeTokens ? { themeTokens } : {}),
    ...(value('products') ? { products: value('products') } : {}),
    ...(value('items') ? { items: value('items') } : {}),
    ...(value('discount-code') ? { discountCode: value('discount-code') } : {}),
    ...(value('access-code') ? { accessCode: value('access-code') } : {}),
    ...(value('tracking-id') ? { trackingId: value('tracking-id') } : {}),
    ...(value('affiliate-code') ? { affiliateCode: value('affiliate-code') } : {}),
    ...(value('api-base-url') ? { checkoutBaseUrl: value('api-base-url') } : {}),
    ...(value('reporting-api-url') ? { reportingApiUrl: value('reporting-api-url') } : {}),
    ...(value('host-origin') ? { hostOrigin: value('host-origin') } : {}),
  };
}

function applyElementConfiguration(element: HTMLElement, config: EmbedElementConfig): void {
  const entries: Array<[string, string | undefined]> = [
    ['brand', config.brandId],
    ['event', config.eventId],
    ['checkout-mode', config.mode === 'button' ? 'modal' : config.mode],
    ['locale', config.locale],
    ['theme', config.theme],
    ['theme-tokens', config.themeTokens ? JSON.stringify(config.themeTokens) : undefined],
    ['products', config.products],
    ['items', config.items],
    ['discount-code', config.discountCode],
    ['access-code', config.accessCode],
    ['tracking-id', config.trackingId],
    ['affiliate-code', config.affiliateCode],
    ['api-base-url', config.checkoutBaseUrl],
    ['reporting-api-url', config.reportingApiUrl],
    ['host-origin', config.hostOrigin],
  ];
  for (const [name, value] of entries) {
    if (value === undefined || value === '') element.removeAttribute(name);
    else element.setAttribute(name, value);
  }
}

function themeTokenStyles(element: HTMLElement): string {
  const tokens = parseEmbedThemeTokens(element.getAttribute('theme-tokens'));
  const styles: Array<[string, string | undefined]> = [
    ['--tk-primary', tokens?.colorPrimary],
    ['--tk-bg', tokens?.colorSurface],
    ['--tk-fg', tokens?.colorText],
    ['--tk-muted', tokens?.colorMuted],
    ['--tk-border', tokens?.colorBorder],
    ['--tk-radius', tokens?.radius === undefined ? undefined : `${tokens.radius}px`],
    ['--tk-density', tokens?.density],
    ['--tk-font-family', tokens?.fontFamily],
    ['--tk-button-size', tokens?.buttonSize],
    ['--tk-button-variant', tokens?.buttonVariant],
  ];
  const declarations = styles
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return declarations ? `:host{${declarations}}` : '';
}

function reportingApiBase(element: HTMLElement): string {
  const explicit = element.getAttribute('reporting-api-url');
  if (explicit) return explicit.replace(/\/$/, '');

  try {
    const url = new URL(checkoutBase(element));
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.port = '4000';
      return url.origin;
    }
    if (url.hostname.startsWith('checkout.')) {
      url.hostname = url.hostname.replace(/^checkout\./, 'api.');
      return url.origin;
    }
  } catch {
    return 'https://api.tixkit.com';
  }

  return 'https://api.tixkit.com';
}

function newWidgetVisitorId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) return randomUUID;

  try {
    const getRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
    if (getRandomValues) {
      const bytes = new Uint8Array(16);
      getRandomValues(bytes);
      const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `visitor_${token}`;
    }
  } catch {
    // Fall through to the compatibility path for older or restricted browser contexts.
  }

  return `visitor_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function widgetVisitorId(): string {
  const key = 'tixkit:visitor-id';
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const generated = newWidgetVisitorId();
    window.sessionStorage.setItem(key, generated);
    return generated;
  } catch {
    return newWidgetVisitorId();
  }
}

function normalizeAnalyticsUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function recordWidgetImpression(
  element: HTMLElement,
  input: { eventId: string; trackingId?: string; affiliateCode?: string },
): void {
  if (!input.eventId || typeof fetch !== 'function') return;
  const body = {
    visitorId: widgetVisitorId(),
    instanceId: element.id || undefined,
    trackingId: input.trackingId || undefined,
    affiliateCode: input.affiliateCode || undefined,
    host: window.location.host || undefined,
    pageUrl: normalizeAnalyticsUrl(window.location.href),
    referrer: normalizeAnalyticsUrl(document.referrer),
  };
  void fetch(
    `${reportingApiBase(element)}/v1/public/events/${encodeURIComponent(input.eventId)}/widget-impressions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: 'omit',
    },
  ).catch(() => {
    // Analytics must never block checkout rendering.
  });
}

const marketingCache = new Map<string, Promise<MarketingIntegration[]>>();

function marketingConsentGranted(integration: MarketingIntegration): boolean {
  if (!integration.consentRequired) return true;
  try {
    const value = window.localStorage.getItem('tixkit_marketing_consent');
    return value === 'granted' || value === 'true' || value === '1';
  } catch {
    return false;
  }
}

function marketingConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function ensureMarketingScript(id: string, src: string): void {
  if (document.getElementById(id)) return;
  const script = document.createElement('script');
  script.id = id;
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

function trackGa4(
  integration: MarketingIntegration,
  name: MarketingEventName,
  eventId: string,
): void {
  const measurementId = marketingConfigString(integration.config, 'measurementId');
  if (!measurementId) return;
  const win = window as Window & { dataLayer?: unknown[]; gtag?: (...args: unknown[]) => void };
  win.dataLayer = win.dataLayer ?? [];
  win.gtag =
    win.gtag ??
    ((...args: unknown[]) => {
      win.dataLayer?.push(args);
    });
  ensureMarketingScript(
    `tixkit-ga4-${measurementId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`,
  );
  win.gtag('js', new Date());
  win.gtag('config', measurementId, { send_page_view: false });
  win.gtag('event', name, { event_id: eventId, items: [{ item_id: eventId }] });
}

function trackMeta(
  integration: MarketingIntegration,
  name: MarketingEventName,
  eventId: string,
): void {
  const pixelId = marketingConfigString(integration.config, 'pixelId');
  if (!pixelId) return;
  const win = window as Window & { fbq?: (...args: unknown[]) => void };
  if (!win.fbq) {
    const queue: unknown[] = [];
    win.fbq = (...args: unknown[]) => {
      queue.push(args);
    };
    (win.fbq as unknown as { queue: unknown[]; loaded: boolean; version: string }).queue = queue;
    (win.fbq as unknown as { queue: unknown[]; loaded: boolean; version: string }).loaded = true;
    (win.fbq as unknown as { queue: unknown[]; loaded: boolean; version: string }).version = '2.0';
    (win as unknown as Record<string, unknown>)['_fbq'] = win.fbq;
    ensureMarketingScript('tixkit-meta-pixel', 'https://connect.facebook.net/en_US/fbevents.js');
  }
  win.fbq('init', pixelId);
  win.fbq(
    'track',
    name === 'view_item' ? 'PageView' : name === 'begin_checkout' ? 'InitiateCheckout' : 'Purchase',
    {
      content_type: 'event',
      content_ids: [eventId],
    },
  );
}

function trackGeneric(
  integration: MarketingIntegration,
  name: MarketingEventName,
  eventId: string,
): void {
  const pixelUrl = marketingConfigString(integration.config, 'pixelUrl');
  if (!pixelUrl) return;
  try {
    const url = new URL(pixelUrl);
    if (url.protocol !== 'https:') return;
    url.searchParams.set('tk_event', name);
    url.searchParams.set('event_id', eventId);
    const beacon = document.createElement('img');
    beacon.referrerPolicy = 'strict-origin-when-cross-origin';
    beacon.src = url.toString();
  } catch {
    return;
  }
}

function fetchMarketingIntegrations(
  element: HTMLElement,
  eventId: string,
): Promise<MarketingIntegration[]> {
  if (!eventId || typeof fetch !== 'function') return Promise.resolve([]);
  const cacheKey = `${reportingApiBase(element)}:${eventId}`;
  const existing = marketingCache.get(cacheKey);
  if (existing) return existing;
  const request = fetch(
    `${reportingApiBase(element)}/v1/public/events/${encodeURIComponent(eventId)}/marketing-integrations`,
    {
      credentials: 'omit',
    },
  )
    .then(async (response) => {
      if (!response.ok) return [];
      const body = (await response.json()) as
        | { items?: MarketingIntegration[] }
        | MarketingIntegration[];
      return Array.isArray(body) ? body : (body.items ?? []);
    })
    .catch(() => []);
  marketingCache.set(cacheKey, request);
  return request;
}

function trackWidgetMarketingEvent(
  element: HTMLElement,
  eventId: string,
  name: MarketingEventName,
): void {
  void fetchMarketingIntegrations(element, eventId).then((integrations) => {
    for (const integration of integrations) {
      if (integration.status !== 'active' || !marketingConsentGranted(integration)) continue;
      if (integration.provider === 'ga4') trackGa4(integration, name, eventId);
      if (integration.provider === 'meta_pixel') trackMeta(integration, name, eventId);
      if (integration.provider === 'generic_tag') trackGeneric(integration, name, eventId);
    }
  });
}

function checkoutMessageDetail(
  eventId: string,
  data: EmbedCheckoutLifecycleMessage,
): Record<string, string | boolean> {
  const detail: Record<string, string> = {
    event: eventId,
    eventId,
  };
  if ('sessionId' in data && data.sessionId) detail.sessionId = data.sessionId;
  if ('orderId' in data && data.orderId) detail.orderId = data.orderId;
  if ('errorCode' in data && data.errorCode) detail.errorCode = data.errorCode;
  if ('message' in data && data.message) detail.message = data.message;
  if ('retryable' in data && data.retryable !== undefined) {
    return { ...detail, retryable: data.retryable };
  }
  return detail;
}

const LEGACY_TO_CANONICAL: Readonly<Record<string, EmbedLifecycleName>> = Object.freeze({
  loaded: 'ready',
  loading: 'loading',
  opened: 'opened',
  closed: 'closed',
  checkout_started: 'checkout-started',
  order_completed: 'order-completed',
  error: 'recoverable-error',
});

function dispatchLifecycle(
  element: HTMLElement,
  inputName: string,
  eventId: string,
  detail: Record<string, string | boolean> = {},
): void {
  const name = LEGACY_TO_CANONICAL[inputName] ?? (inputName as EmbedLifecycleName);
  const mode = (element.getAttribute('checkout-mode') ??
    (element.tagName.toLowerCase() === 'tixkit-button' ? 'modal' : 'inline')) as EmbedMode;
  const normalizedDetail =
    name === 'closed' && typeof detail.reason !== 'string'
      ? { ...detail, reason: 'unknown' }
      : detail;
  const payload = {
    contractVersion: EMBED_CONTRACT_VERSION,
    widgetId: element.getAttribute('data-tixkit-widget-id') ?? '',
    event: eventId,
    eventId,
    mode,
    timestamp: new Date().toISOString(),
    name,
    ...normalizedDetail,
  };
  element.dispatchEvent(new CustomEvent(versionedLifecycleEventName(name), { detail: payload }));
  element.dispatchEvent(new CustomEvent(name, { detail: payload }));
  for (const alias of EMBED_LEGACY_EVENT_ALIASES[name] ?? []) {
    element.dispatchEvent(new CustomEvent(alias, { detail: payload }));
  }
}

function expectedHostOrigin(element: HTMLElement): string | null {
  const configured = element.getAttribute('host-origin');
  const current = window.location.origin;
  if (!configured) return current;
  try {
    return new URL(configured).origin === configured && configured === current ? configured : null;
  } catch {
    return null;
  }
}

function beginHandshake(
  element: HTMLElement,
  frame: HTMLIFrameElement,
  widgetId: string,
  eventId: string,
  nonce: string,
): boolean {
  const hostOrigin = expectedHostOrigin(element);
  if (!hostOrigin || !frame.contentWindow) return false;
  frame.contentWindow.postMessage(
    createHostHelloMessage({ widgetId, eventId, nonce, hostOrigin }),
    new URL(checkoutBase(element)).origin,
  );
  return true;
}

class TixkitWidget extends HTMLElement {
  private shadow: ShadowRoot;
  private config: WidgetConfig = {
    brand: '',
    event: '',
    locale: 'en-US',
    theme: 'auto',
    checkoutMode: 'inline',
  };
  private stateEl: HTMLDivElement | null = null;
  private errored = false;
  private modal: HTMLDivElement | null = null;
  private modalRestoreFocus: HTMLElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private modalKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private impressionRecorded = false;
  private readonly widgetId = createWidgetId();
  private handshakeNonce = createEmbedNonce();
  private activeFrame: HTMLIFrameElement | null = null;
  private readyReceived = false;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  get configuration(): EmbedElementConfig {
    return readElementConfiguration(this, 'inline');
  }

  set configuration(config: EmbedElementConfig) {
    applyElementConfiguration(this, config);
  }

  static get observedAttributes(): string[] {
    return [
      'brand',
      'event',
      'locale',
      'theme',
      'theme-tokens',
      'products',
      'discount-code',
      'access-code',
      'tracking-id',
      'affiliate-code',
      'checkout-mode',
      'api-base-url',
      'reporting-api-url',
      'host-origin',
    ];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string): void {
    const mapping: Record<string, keyof WidgetConfig> = {
      brand: 'brand',
      event: 'event',
      locale: 'locale',
      theme: 'theme',
      'theme-tokens': 'themeTokens',
      products: 'products',
      'discount-code': 'discountCode',
      'access-code': 'accessCode',
      'tracking-id': 'trackingId',
      'affiliate-code': 'affiliateCode',
      'checkout-mode': 'checkoutMode',
      'api-base-url': 'checkoutBaseUrl',
      'reporting-api-url': 'reportingApiUrl',
      'host-origin': 'hostOrigin',
    };
    const key = mapping[name];
    if (key) {
      (this.config as Record<string, unknown>)[key] = newValue;
    }
    if (this.isConnected) {
      this.render();
      this.listenForCheckoutMessages();
    }
  }

  connectedCallback(): void {
    widgetStartedAt.set(this, performance.now());
    this.setAttribute('data-tixkit-widget-id', this.widgetId);
    this.render();
    this.listenForCheckoutMessages();
    if (!this.impressionRecorded) {
      this.impressionRecorded = true;
      recordWidgetImpression(this, {
        eventId: this.config.event,
        trackingId: this.config.trackingId,
        affiliateCode: this.config.affiliateCode,
      });
      trackWidgetMarketingEvent(this, this.config.event, 'view_item');
    }

    // Dispatch 'closed' on host page unload.
    if (this.unloadHandler) window.removeEventListener('beforeunload', this.unloadHandler);
    this.unloadHandler = () => {
      dispatchLifecycle(this, 'closed', this.config.event, { reason: 'navigation' });
    };
    window.addEventListener('beforeunload', this.unloadHandler);
  }

  disconnectedCallback(): void {
    cancelHandshakeTimeout(this);
    this.closeModal(false);
    // Dispatch 'closed' when the widget is removed from the DOM.
    dispatchLifecycle(this, 'closed', this.config.event, { reason: 'disconnected' });
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
  }

  private listenForCheckoutMessages(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.messageHandler = (event: MessageEvent) => {
      const source = this.activeFrame?.contentWindow;
      if (!source) return;
      const validation = validateCheckoutMessageEvent(event, {
        origin: new URL(checkoutBase(this)).origin,
        source,
        widgetId: this.widgetId,
        eventId: this.config.event,
        nonce: this.handshakeNonce,
      });
      if (!validation.ok) return;
      if (validation.message.type === 'checkout:ready') {
        if (this.readyReceived) return;
        this.readyReceived = true;
        cancelHandshakeTimeout(this);
        this.hideState();
        recordWidgetPerformance(this, this.config.checkoutMode ?? 'inline', 'ready');
        dispatchLifecycle(this, 'ready', this.config.event);
        return;
      }
      if (validation.message.type === 'checkout:close-requested') {
        this.closeModal();
        return;
      }
      const data = validation.message;
      const name = data.lifecycle;
      if (name === 'checkout-started')
        trackWidgetMarketingEvent(this, this.config.event, 'begin_checkout');
      if (name === 'order-completed')
        trackWidgetMarketingEvent(this, this.config.event, 'purchase');
      dispatchLifecycle(
        this,
        name,
        this.config.event,
        checkoutMessageDetail(this.config.event, data),
      );
    };
    window.addEventListener('message', this.messageHandler);
  }

  private showLoading(): void {
    if (!this.stateEl) return;
    this.stateEl.style.display = 'flex';
    this.stateEl.setAttribute('role', 'status');
    this.stateEl.setAttribute('aria-live', 'polite');
    this.stateEl.innerHTML = `<div class="tk-spinner"></div><p>Loading tickets…</p>`;
    dispatchLifecycle(this, 'loading', this.config.event);
  }

  private showError(
    message: string,
    errorCode: 'checkout-unreachable' | 'checkout-offline' | 'handshake-timeout' = navigator.onLine
      ? 'checkout-unreachable'
      : 'checkout-offline',
    focusRetry = false,
  ): void {
    this.errored = true;
    recordWidgetPerformance(this, this.config.checkoutMode ?? 'inline', 'error', errorCode);
    if (!this.stateEl) return;
    this.stateEl.style.display = 'flex';
    this.stateEl.setAttribute('role', 'alert');
    this.stateEl.setAttribute('aria-live', 'assertive');
    this.stateEl.replaceChildren();

    const icon = document.createElement('div');
    icon.className = 'tk-error-icon';
    icon.textContent = '!';

    const text = document.createElement('p');
    text.textContent = message;

    const retry = document.createElement('button');
    retry.className = 'tk-retry';
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      this.errored = false;
      this.render();
    });

    const fallback = document.createElement('a');
    fallback.href = this.buildWidgetUrl();
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.textContent = 'Open secure checkout';

    this.stateEl.append(icon, text, retry, fallback);
    if (focusRetry) retry.focus();
    dispatchLifecycle(this, 'recoverable-error', this.config.event, {
      errorCode,
      message,
      retryable: true,
    });
  }

  private hideState(): void {
    if (this.stateEl) this.stateEl.style.display = 'none';
  }

  private buildWidgetUrl(): string {
    const params = new URLSearchParams();
    params.set('eventId', this.config.event);
    if (this.config.brand) params.set('brand', this.config.brand);
    if (this.config.locale) params.set('locale', this.config.locale);
    if (this.config.theme) params.set('theme', this.config.theme);
    if (this.config.products) params.set('products', this.config.products);
    if (this.config.discountCode) params.set('discount', this.config.discountCode);
    if (this.config.accessCode) params.set('accessCode', this.config.accessCode);
    if (this.config.trackingId) params.set('tracking', this.config.trackingId);
    if (this.config.affiliateCode) params.set('affiliateCode', this.config.affiliateCode);
    params.set('embedContractVersion', EMBED_CONTRACT_VERSION);
    params.set('embedWidgetId', this.widgetId);
    params.set('embedNonce', this.handshakeNonce);
    const hostOrigin = expectedHostOrigin(this);
    if (hostOrigin) params.set('embedHostOrigin', hostOrigin);
    return `${checkoutBase(this)}/checkout?${params.toString()}`;
  }

  private render(): void {
    cancelHandshakeTimeout(this);
    this.handshakeNonce = createEmbedNonce();
    this.activeFrame = null;
    this.readyReceived = false;
    this.shadow.innerHTML = '';
    injectStyles(this.shadow, themeTokenStyles(this));

    if (!expectedHostOrigin(this)) {
      const state = document.createElement('div');
      state.className = 'tk-state';
      this.shadow.appendChild(state);
      this.stateEl = state;
      this.showError('The host-origin attribute must exactly match this page origin.');
      return;
    }

    if (!this.config.brand || !this.config.event) {
      const state = document.createElement('div');
      state.className = 'tk-state';
      state.textContent = 'Tixkit widget: brand and event attributes are required.';
      this.shadow.appendChild(state);
      this.showError('Brand and event attributes are required.');
      return;
    }

    const mode = this.config.checkoutMode ?? 'inline';

    if (mode === 'redirect') {
      this.renderRedirect();
      return;
    }

    if (mode === 'modal') {
      this.renderModalButton();
      return;
    }

    // Default: inline iframe.
    this.renderInline();
  }

  private renderInline(): void {
    const root = document.createElement('div');
    root.className = 'tk-root';

    this.stateEl = document.createElement('div');
    this.stateEl.className = 'tk-state';
    root.appendChild(this.stateEl);
    this.showLoading();

    const iframe = document.createElement('iframe');
    iframe.name = `${this.widgetId}`;
    iframe.className = 'tk-frame';
    iframe.title = 'Tixkit Tickets';
    iframe.loading = 'lazy';
    iframe.allow = IFRAME_ALLOW;
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.src = this.buildWidgetUrl();
    this.activeFrame = iframe;
    iframe.addEventListener('load', () => {
      if (!this.errored) {
        if (!beginHandshake(this, iframe, this.widgetId, this.config.event, this.handshakeNonce)) {
          this.showError('Checkout handshake could not be started.');
          return;
        }
        scheduleHandshakeTimeout(this, () =>
          this.showError(
            'Checkout did not complete its secure handshake.',
            navigator.onLine ? 'handshake-timeout' : 'checkout-offline',
          ),
        );
        // Dispatch 'opened' when the inline iframe finishes loading.
        dispatchLifecycle(this, 'opened', this.config.event);
      }
    });
    iframe.addEventListener('error', () => {
      this.showError('Tickets could not be loaded.');
    });

    root.appendChild(iframe);
    this.shadow.appendChild(root);
  }

  private renderModalButton(): void {
    const root = document.createElement('div');
    root.className = 'tk-root';

    const state = document.createElement('div');
    this.stateEl = state;
    state.className = 'tk-state';
    state.style.display = 'flex';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tk-retry';
    btn.textContent = 'Buy tickets';
    btn.addEventListener('click', () => this.openModal(this.buildWidgetUrl()));

    state.appendChild(btn);
    root.appendChild(state);
    this.shadow.appendChild(root);
  }

  private renderRedirect(): void {
    const root = document.createElement('div');
    root.className = 'tk-root';

    const state = document.createElement('div');
    state.className = 'tk-state';
    state.style.display = 'flex';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tk-retry';
    btn.textContent = 'Buy tickets';
    btn.addEventListener('click', () => {
      // A redirect opens the hosted checkout. checkout_started is emitted only
      // after the hosted checkout confirms buyer intent via postMessage.
      dispatchLifecycle(this, 'opened', this.config.event);
      window.open(this.buildWidgetUrl(), '_self', 'noopener');
    });

    state.appendChild(btn);
    root.appendChild(state);
    this.shadow.appendChild(root);
  }

  private openModal(url: string): void {
    this.closeModal();
    this.modalRestoreFocus =
      this.shadow.activeElement instanceof HTMLElement
        ? this.shadow.activeElement
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    const backdrop = document.createElement('div');
    backdrop.className = 'tk-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.closeModal();
    });

    const modal = document.createElement('div');
    modal.className = 'tk-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'tk-widget-modal-title');
    modal.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'tk-modal-head';
    const title = document.createElement('span');
    title.id = 'tk-widget-modal-title';
    title.className = 'tk-modal-title';
    title.textContent = 'Checkout';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tk-modal-close';
    close.setAttribute('aria-label', 'Close checkout');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeModal());
    head.appendChild(title);
    head.appendChild(close);

    const frame = document.createElement('iframe');
    frame.name = `${this.widgetId}`;
    frame.className = 'tk-modal-frame';
    frame.title = 'Tixkit Checkout';
    frame.src = url;
    frame.allow = IFRAME_ALLOW;
    frame.setAttribute('sandbox', IFRAME_SANDBOX);
    this.activeFrame = frame;
    frame.addEventListener('load', () => {
      if (!beginHandshake(this, frame, this.widgetId, this.config.event, this.handshakeNonce)) {
        this.showError('Checkout handshake could not be started.');
        return;
      }
      scheduleHandshakeTimeout(this, () => {
        this.closeModal(false);
        this.showError(
          'Checkout did not complete its secure handshake.',
          navigator.onLine ? 'handshake-timeout' : 'checkout-offline',
          true,
        );
      });
      // Dispatch 'opened' when the modal iframe finishes loading.
      dispatchLifecycle(this, 'opened', this.config.event);
    });

    modal.appendChild(head);
    modal.appendChild(frame);
    backdrop.appendChild(modal);
    this.shadow.appendChild(backdrop);
    this.modal = backdrop;

    this.modalKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal();
        return;
      }
      if (e.key !== 'Tab' || !this.modal) return;
      const focusable = Array.from(
        this.modal.querySelectorAll<HTMLElement>(
          'button, iframe, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (e.shiftKey && this.shadow.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && this.shadow.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler);
    close.focus();
  }

  private closeModal(emit = true): void {
    cancelHandshakeTimeout(this);
    if (this.modalKeyHandler) {
      document.removeEventListener('keydown', this.modalKeyHandler);
      this.modalKeyHandler = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
      this.activeFrame = null;
      if (emit) dispatchLifecycle(this, 'closed', this.config.event, { reason: 'buyer' });
    }
    if (this.modalRestoreFocus?.isConnected) {
      this.modalRestoreFocus.focus();
    }
    this.modalRestoreFocus = null;
  }

  // Public methods for programmatic control.
  openCheckout(): void {
    const mode = this.config.checkoutMode ?? 'inline';
    const url = this.buildWidgetUrl();
    if (mode === 'modal') {
      this.openModal(url);
      return;
    }
    if (mode === 'redirect') {
      dispatchLifecycle(this, 'opened', this.config.event);
      window.location.href = url;
    }
  }

  closeCheckout(): void {
    this.closeModal(false);
    dispatchLifecycle(this, 'closed', this.config.event, { reason: 'host' });
  }
}

class TixkitButton extends HTMLElement {
  private shadow: ShadowRoot;
  private eventId = '';
  private items = '';
  private brand = '';
  private products = '';
  private discountCode = '';
  private accessCode = '';
  private trackingId = '';
  private affiliateCode = '';
  private locale = 'en-US';
  private theme = 'auto';
  private checkoutMode: CheckoutMode = 'modal';
  private modal: HTMLDivElement | null = null;
  private modalRestoreFocus: HTMLElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private modalKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private impressionRecorded = false;
  private readonly widgetId = createWidgetId();
  private handshakeNonce = createEmbedNonce();
  private activeFrame: HTMLIFrameElement | null = null;
  private readyReceived = false;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  get configuration(): EmbedElementConfig {
    return readElementConfiguration(this, 'modal');
  }

  set configuration(config: EmbedElementConfig) {
    applyElementConfiguration(this, config);
  }

  static get observedAttributes(): string[] {
    return [
      'event',
      'items',
      'brand',
      'products',
      'discount-code',
      'access-code',
      'tracking-id',
      'affiliate-code',
      'checkout-mode',
      'locale',
      'theme',
      'theme-tokens',
      'api-base-url',
      'reporting-api-url',
      'host-origin',
    ];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string): void {
    if (name === 'event') this.eventId = newValue;
    if (name === 'items') this.items = newValue;
    if (name === 'brand') this.brand = newValue;
    if (name === 'products') this.products = newValue;
    if (name === 'discount-code') this.discountCode = newValue;
    if (name === 'access-code') this.accessCode = newValue;
    if (name === 'tracking-id') this.trackingId = newValue;
    if (name === 'affiliate-code') this.affiliateCode = newValue;
    if (name === 'checkout-mode') this.checkoutMode = newValue as CheckoutMode;
    if (name === 'locale') this.locale = newValue;
    if (name === 'theme') this.theme = newValue;
    this.render();
    if (this.isConnected) this.listenForCheckoutMessages();
  }

  connectedCallback(): void {
    widgetStartedAt.set(this, performance.now());
    this.setAttribute('data-tixkit-widget-id', this.widgetId);
    this.render();
    this.listenForCheckoutMessages();
    if (!this.impressionRecorded) {
      this.impressionRecorded = true;
      recordWidgetImpression(this, {
        eventId: this.eventId,
        trackingId: this.trackingId,
        affiliateCode: this.affiliateCode,
      });
      trackWidgetMarketingEvent(this, this.eventId, 'view_item');
    }

    if (this.unloadHandler) window.removeEventListener('beforeunload', this.unloadHandler);
    this.unloadHandler = () => {
      dispatchLifecycle(this, 'closed', this.eventId, { reason: 'navigation' });
    };
    window.addEventListener('beforeunload', this.unloadHandler);
  }

  disconnectedCallback(): void {
    cancelHandshakeTimeout(this);
    this.closeModal(false);
    dispatchLifecycle(this, 'closed', this.eventId, { reason: 'disconnected' });
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
  }

  private listenForCheckoutMessages(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.messageHandler = (event: MessageEvent) => {
      const source = this.activeFrame?.contentWindow;
      if (!source) return;
      const validation = validateCheckoutMessageEvent(event, {
        origin: new URL(checkoutBase(this)).origin,
        source,
        widgetId: this.widgetId,
        eventId: this.eventId,
        nonce: this.handshakeNonce,
      });
      if (!validation.ok) return;
      if (validation.message.type === 'checkout:ready') {
        if (this.readyReceived) return;
        this.readyReceived = true;
        cancelHandshakeTimeout(this);
        recordWidgetPerformance(this, this.checkoutMode, 'ready');
        dispatchLifecycle(this, 'ready', this.eventId);
        return;
      }
      if (validation.message.type === 'checkout:close-requested') {
        this.closeModal();
        return;
      }
      const data = validation.message;
      const name = data.lifecycle;
      if (name === 'checkout-started')
        trackWidgetMarketingEvent(this, this.eventId, 'begin_checkout');
      if (name === 'order-completed') trackWidgetMarketingEvent(this, this.eventId, 'purchase');
      dispatchLifecycle(this, name, this.eventId, checkoutMessageDetail(this.eventId, data));
    };
    window.addEventListener('message', this.messageHandler);
  }

  private render(): void {
    cancelHandshakeTimeout(this);
    this.shadow.innerHTML = '';
    injectStyles(this.shadow, themeTokenStyles(this));

    const btn = document.createElement('button');
    btn.className = 'tk-launcher';
    btn.type = 'button';
    btn.textContent = this.textContent || 'Buy tickets';
    btn.addEventListener('click', () => this.openCheckout());
    this.shadow.appendChild(btn);
  }

  private showCheckoutFailure(
    message: string,
    errorCode: 'handshake-timeout' | 'checkout-unreachable' | 'checkout-offline',
  ): void {
    this.closeModal(false);
    this.shadow.querySelector('.tk-button-error')?.remove();
    const alert = document.createElement('div');
    alert.className = 'tk-button-error';
    alert.setAttribute('role', 'alert');
    alert.setAttribute('aria-live', 'assertive');
    const text = document.createElement('p');
    text.textContent = message;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'tk-retry';
    retry.textContent = 'Retry checkout';
    retry.addEventListener('click', () => {
      alert.remove();
      this.openCheckout();
    });
    const fallback = document.createElement('a');
    fallback.href = this.buildCheckoutUrl();
    fallback.target = '_blank';
    fallback.rel = 'noopener noreferrer';
    fallback.textContent = 'Open secure checkout';
    alert.append(text, retry, fallback);
    this.shadow.appendChild(alert);
    retry.focus();
    recordWidgetPerformance(this, this.checkoutMode, 'error', errorCode);
    dispatchLifecycle(this, 'recoverable-error', this.eventId, {
      errorCode,
      message,
      retryable: true,
    });
  }

  private buildCheckoutUrl(): string {
    const params = new URLSearchParams();
    params.set('eventId', this.eventId);
    if (this.brand) params.set('brand', this.brand);
    if (this.items) params.set('items', this.items);
    if (this.products) params.set('products', this.products);
    if (this.discountCode) params.set('discount', this.discountCode);
    if (this.accessCode) params.set('accessCode', this.accessCode);
    if (this.trackingId) params.set('tracking', this.trackingId);
    if (this.affiliateCode) params.set('affiliateCode', this.affiliateCode);
    if (this.locale) params.set('locale', this.locale);
    if (this.theme) params.set('theme', this.theme);
    params.set('mode', this.checkoutMode);
    params.set('embedContractVersion', EMBED_CONTRACT_VERSION);
    params.set('embedWidgetId', this.widgetId);
    params.set('embedNonce', this.handshakeNonce);
    const hostOrigin = expectedHostOrigin(this);
    if (hostOrigin) params.set('embedHostOrigin', hostOrigin);
    return `${checkoutBase(this)}/checkout?${params.toString()}`;
  }

  openCheckout(): void {
    if (!this.eventId) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: { message: 'Missing event attribute', event: '', eventId: '' },
        }),
      );
      return;
    }
    if (!expectedHostOrigin(this)) {
      dispatchLifecycle(this, 'fatal-error', this.eventId, {
        errorCode: 'invalid-origin',
        message: 'The host-origin attribute must exactly match this page origin.',
        retryable: false,
      });
      return;
    }
    this.handshakeNonce = createEmbedNonce();
    this.activeFrame = null;
    this.readyReceived = false;
    const url = this.buildCheckoutUrl();

    if (this.checkoutMode === 'redirect') {
      dispatchLifecycle(this, 'opened', this.eventId);
      window.location.href = url;
      return;
    }

    if (this.checkoutMode === 'modal') {
      this.openModal(url);
      return;
    }

    // inline fallback: open in a new tab as a safe default
    window.open(url, '_blank', 'noopener');
  }

  closeCheckout(): void {
    this.closeModal(false);
    dispatchLifecycle(this, 'closed', this.eventId, { reason: 'host' });
  }

  private openModal(url: string): void {
    this.closeModal();
    this.modalRestoreFocus =
      this.shadow.activeElement instanceof HTMLElement
        ? this.shadow.activeElement
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    const backdrop = document.createElement('div');
    backdrop.className = 'tk-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.closeModal();
    });

    const modal = document.createElement('div');
    modal.className = 'tk-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'tk-button-modal-title');
    modal.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'tk-modal-head';
    const title = document.createElement('span');
    title.id = 'tk-button-modal-title';
    title.className = 'tk-modal-title';
    title.textContent = 'Checkout';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tk-modal-close';
    close.setAttribute('aria-label', 'Close checkout');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeModal());
    head.appendChild(title);
    head.appendChild(close);

    const frame = document.createElement('iframe');
    frame.name = `${this.widgetId}`;
    frame.className = 'tk-modal-frame';
    frame.title = 'Tixkit Checkout';
    frame.src = url;
    frame.allow = IFRAME_ALLOW;
    frame.setAttribute('sandbox', IFRAME_SANDBOX);
    this.activeFrame = frame;
    frame.addEventListener('load', () => {
      if (!beginHandshake(this, frame, this.widgetId, this.eventId, this.handshakeNonce)) {
        dispatchLifecycle(this, 'recoverable-error', this.eventId, {
          errorCode: 'handshake-timeout',
          message: 'Checkout handshake could not be started.',
          retryable: true,
        });
        return;
      }
      scheduleHandshakeTimeout(this, () => {
        this.showCheckoutFailure(
          'Checkout did not complete its secure handshake.',
          navigator.onLine ? 'handshake-timeout' : 'checkout-offline',
        );
      });
      dispatchLifecycle(this, 'opened', this.eventId);
    });
    frame.addEventListener('error', () => {
      this.showCheckoutFailure('Checkout could not be loaded.', 'checkout-unreachable');
    });

    modal.appendChild(head);
    modal.appendChild(frame);
    backdrop.appendChild(modal);
    this.shadow.appendChild(backdrop);
    this.modal = backdrop;

    this.modalKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal();
        return;
      }
      if (e.key !== 'Tab' || !this.modal) return;
      const focusable = Array.from(
        this.modal.querySelectorAll<HTMLElement>(
          'button, iframe, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled') && element.tabIndex >= 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (e.shiftKey && this.shadow.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && this.shadow.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler);
    close.focus();
  }

  private closeModal(emit = true): void {
    cancelHandshakeTimeout(this);
    if (this.modalKeyHandler) {
      document.removeEventListener('keydown', this.modalKeyHandler);
      this.modalKeyHandler = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
      this.activeFrame = null;
      if (emit) dispatchLifecycle(this, 'closed', this.eventId, { reason: 'buyer' });
    }
    if (this.modalRestoreFocus?.isConnected) {
      this.modalRestoreFocus.focus();
    }
    this.modalRestoreFocus = null;
  }
}

if (typeof window !== 'undefined' && 'customElements' in window) {
  if (!customElements.get('tixkit-widget')) {
    customElements.define('tixkit-widget', TixkitWidget);
  }
  if (!customElements.get('tixkit-button')) {
    customElements.define('tixkit-button', TixkitButton);
  }
}

export { TixkitWidget, TixkitButton };
