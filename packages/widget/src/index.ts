// Tixkit Embeddable Widget - TypeScript Web Components.
//
// Can be loaded once and mount multiple widgets on a page. No secret
// credentials are embedded in browser code.
//
// Lifecycle events (dispatched from the host element):
//   loaded            - widget mounted and ready
//   loading           - iframe/event is loading
//   error             - a load or runtime error occurred (detail.message)
//   opened            - checkout opened (iframe loaded / modal / redirect)
//   closed            - checkout modal closed / widget disconnected / page unload
//   checkout_started  - buyer began checkout (postMessage from hosted checkout)
//   order_completed   - buyer completed an order (postMessage from checkout)
//
// Style hooks (CSS custom properties on the host element):
//   --tk-radius   - border radius for widget surfaces (default 0.625rem)
//   --tk-primary  - primary accent color used for buttons/headers
//   --tk-bg       - widget background
//   --tk-fg       - widget foreground text
//
// The widget iframe posts messages back to the host for lifecycle integration.
// The hosted checkout posts { source: 'tixkit-checkout', event: 'order_completed', ... }
// and { source: 'tixkit-checkout', event: 'checkout_started', ... }.

type WidgetConfig = {
  brand: string;
  event: string;
  locale?: string;
  theme?: 'auto' | 'light' | 'dark';
  products?: string;
  discountCode?: string;
  accessCode?: string;
  trackingId?: string;
  affiliateCode?: string;
  checkoutMode?: 'inline' | 'modal' | 'redirect';
};

type CheckoutMode = 'inline' | 'modal' | 'redirect';
type CheckoutLifecycleEvent = 'checkout_started' | 'order_completed';
type CheckoutMessage = {
  source?: string;
  type?: string;
  event?: string;
  eventId?: string;
  sessionId?: string;
  orderId?: string;
};

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

const STYLES = `
  :host {
    display: block;
    width: 100%;
    --tk-radius: var(--tk-radius, 0.625rem);
    --tk-primary: var(--tk-primary, oklch(0.208 0.042 265.755));
    --tk-bg: var(--tk-bg, #ffffff);
    --tk-fg: var(--tk-fg, #171717);
    color: var(--tk-fg);
  }
  .tk-root {
    position: relative;
    width: 100%;
    min-height: 420px;
    border-radius: var(--tk-radius);
    overflow: hidden;
    background: var(--tk-bg);
    border: 1px solid rgba(23, 23, 23, 0.12);
  }
  .tk-frame {
    width: 100%;
    height: 100%;
    min-height: 420px;
    border: 0;
    display: block;
    background: var(--tk-bg);
  }
  .tk-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    background: var(--tk-bg);
    color: var(--tk-fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .tk-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(23, 23, 23, 0.18);
    border-top-color: var(--tk-primary);
    border-radius: 50%;
    animation: tk-spin 0.8s linear infinite;
  }
  @keyframes tk-spin { to { transform: rotate(360deg); } }
  .tk-error-icon {
    width: 32px;
    height: 32px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(220, 38, 38, 0.12);
    color: #b91c1c;
    font-size: 18px;
    font-weight: 700;
  }
  .tk-retry {
    border: 1px solid rgba(23, 23, 23, 0.18);
    background: var(--tk-bg);
    color: var(--tk-fg);
    border-radius: 6px;
    padding: 8px 14px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .tk-retry:hover { background: rgba(23, 23, 23, 0.05); }
  .tk-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .tk-modal {
    width: min(560px, 100%);
    max-height: 90vh;
    border-radius: var(--tk-radius);
    overflow: hidden;
    background: var(--tk-bg);
    display: flex;
    flex-direction: column;
  }
  .tk-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(23, 23, 23, 0.1);
    background: var(--tk-bg);
    color: var(--tk-fg);
  }
  .tk-modal-title {
    background: #ffffff;
    color: #171717;
    font-weight: 600;
  }
  .tk-modal-close {
    border: 0;
    background: transparent;
    color: var(--tk-fg);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .tk-modal-close:hover { background: rgba(23, 23, 23, 0.06); }
  .tk-modal-frame {
    width: 100%;
    height: 70vh;
    border: 0;
    background: var(--tk-bg);
  }
`;

function injectStyles(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);
}

function checkoutBase(element: HTMLElement): string {
  return (element.getAttribute('api-base-url') ?? 'https://checkout.tixkit.com').replace(/\/$/, '');
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

function widgetVisitorId(): string {
  const key = 'tixkit:visitor-id';
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const generated =
      globalThis.crypto?.randomUUID?.() ??
      `visitor_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.localStorage.setItem(key, generated);
    return generated;
  } catch {
    return `visitor_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

function normalizeAnalyticsUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`;
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

function isTrustedCheckoutOrigin(element: HTMLElement, origin: string): boolean {
  const base = checkoutBase(element);
  try {
    return new URL(base).origin === origin;
  } catch {
    return false;
  }
}

function checkoutEventName(data: CheckoutMessage): CheckoutLifecycleEvent | null {
  const name = data.event ?? data.type;
  if (name === 'checkout_started' || name === 'order_completed') return name;
  return null;
}

function checkoutMessageMatchesEvent(data: CheckoutMessage, eventId: string): boolean {
  if (!data.eventId) return true;
  return data.eventId === eventId;
}

function checkoutMessageDetail(eventId: string, data: CheckoutMessage): Record<string, string> {
  const detail: Record<string, string> = {
    event: eventId,
    eventId,
  };
  if (data.sessionId) detail.sessionId = data.sessionId;
  if (data.orderId) detail.orderId = data.orderId;
  return detail;
}

function dispatchLifecycle(
  element: HTMLElement,
  name: string,
  eventId: string,
  detail: Record<string, string> = {},
): void {
  element.dispatchEvent(
    new CustomEvent(name, {
      detail: {
        event: eventId,
        eventId,
        ...detail,
      },
    }),
  );
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

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes(): string[] {
    return [
      'brand',
      'event',
      'locale',
      'theme',
      'products',
      'discount-code',
      'access-code',
      'tracking-id',
      'affiliate-code',
      'checkout-mode',
    ];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string): void {
    const mapping: Record<string, keyof WidgetConfig> = {
      brand: 'brand',
      event: 'event',
      locale: 'locale',
      theme: 'theme',
      products: 'products',
      'discount-code': 'discountCode',
      'access-code': 'accessCode',
      'tracking-id': 'trackingId',
      'affiliate-code': 'affiliateCode',
      'checkout-mode': 'checkoutMode',
    };
    const key = mapping[name];
    if (key) {
      (this.config as Record<string, unknown>)[key] = newValue;
    }
    if (this.isConnected) this.render();
  }

  connectedCallback(): void {
    this.render();
    this.listenForCheckoutMessages();
    dispatchLifecycle(this, 'loaded', this.config.event);
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
      dispatchLifecycle(this, 'closed', this.config.event);
    };
    window.addEventListener('beforeunload', this.unloadHandler);
  }

  disconnectedCallback(): void {
    this.closeModal(false);
    // Dispatch 'closed' when the widget is removed from the DOM.
    dispatchLifecycle(this, 'closed', this.config.event);
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
      if (!isTrustedCheckoutOrigin(this, event.origin)) return;
      const data = event.data as CheckoutMessage | undefined;
      if (!data || data.source !== 'tixkit-checkout') return;
      if (!checkoutMessageMatchesEvent(data, this.config.event)) return;

      const name = checkoutEventName(data);
      if (!name) return;
      trackWidgetMarketingEvent(
        this,
        this.config.event,
        name === 'checkout_started' ? 'begin_checkout' : 'purchase',
      );
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
    this.stateEl.innerHTML = `<div class="tk-spinner"></div><p>Loading tickets…</p>`;
    dispatchLifecycle(this, 'loading', this.config.event);
  }

  private showError(message: string): void {
    this.errored = true;
    if (!this.stateEl) return;
    this.stateEl.style.display = 'flex';
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

    this.stateEl.append(icon, text, retry);
    this.dispatchEvent(
      new CustomEvent('error', {
        detail: { message, event: this.config.event, eventId: this.config.event },
      }),
    );
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
    return `${checkoutBase(this)}/checkout?${params.toString()}`;
  }

  private render(): void {
    this.shadow.innerHTML = '';
    injectStyles(this.shadow);

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
    iframe.className = 'tk-frame';
    iframe.title = 'Tixkit Tickets';
    iframe.loading = 'lazy';
    iframe.allow = IFRAME_ALLOW;
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.src = this.buildWidgetUrl();
    iframe.addEventListener('load', () => {
      if (!this.errored) {
        this.hideState();
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
    frame.className = 'tk-modal-frame';
    frame.title = 'Tixkit Checkout';
    frame.src = url;
    frame.allow = IFRAME_ALLOW;
    frame.setAttribute('sandbox', IFRAME_SANDBOX);
    frame.addEventListener('load', () => {
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
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler);
    close.focus();
  }

  private closeModal(emit = true): void {
    if (this.modalKeyHandler) {
      document.removeEventListener('keydown', this.modalKeyHandler);
      this.modalKeyHandler = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
      if (emit) dispatchLifecycle(this, 'closed', this.config.event);
    }
    if (emit && this.modalRestoreFocus?.isConnected) {
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
    dispatchLifecycle(this, 'closed', this.config.event);
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
  private checkoutMode: CheckoutMode = 'modal';
  private modal: HTMLDivElement | null = null;
  private modalRestoreFocus: HTMLElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private modalKeyHandler: ((event: KeyboardEvent) => void) | null = null;
  private impressionRecorded = false;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
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
    this.render();
  }

  connectedCallback(): void {
    this.render();
    this.listenForCheckoutMessages();
    dispatchLifecycle(this, 'loaded', this.eventId);
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
      dispatchLifecycle(this, 'closed', this.eventId);
    };
    window.addEventListener('beforeunload', this.unloadHandler);
  }

  disconnectedCallback(): void {
    this.closeModal(false);
    dispatchLifecycle(this, 'closed', this.eventId);
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
      if (!isTrustedCheckoutOrigin(this, event.origin)) return;
      const data = event.data as CheckoutMessage | undefined;
      if (!data || data.source !== 'tixkit-checkout') return;
      if (!checkoutMessageMatchesEvent(data, this.eventId)) return;

      const name = checkoutEventName(data);
      if (!name) return;
      trackWidgetMarketingEvent(
        this,
        this.eventId,
        name === 'checkout_started' ? 'begin_checkout' : 'purchase',
      );
      dispatchLifecycle(this, name, this.eventId, checkoutMessageDetail(this.eventId, data));
    };
    window.addEventListener('message', this.messageHandler);
  }

  private render(): void {
    this.shadow.innerHTML = '';
    injectStyles(this.shadow);

    const style = document.createElement('style');
    style.textContent = `
      button {
        background: var(--tk-primary, oklch(0.208 0.042 265.755));
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: var(--tk-radius, 0.5rem);
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button:hover { opacity: 0.9; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
    `;
    this.shadow.appendChild(style);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = this.textContent || 'Buy tickets';
    btn.addEventListener('click', () => this.handleClick());
    this.shadow.appendChild(btn);
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
    params.set('mode', this.checkoutMode);
    return `${checkoutBase(this)}/checkout?${params.toString()}`;
  }

  private handleClick(): void {
    if (!this.eventId) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: { message: 'Missing event attribute', event: '', eventId: '' },
        }),
      );
      return;
    }
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
    frame.className = 'tk-modal-frame';
    frame.title = 'Tixkit Checkout';
    frame.src = url;
    frame.allow = IFRAME_ALLOW;
    frame.setAttribute('sandbox', IFRAME_SANDBOX);
    frame.addEventListener('load', () => {
      dispatchLifecycle(this, 'opened', this.eventId);
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
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler);
    close.focus();
  }

  private closeModal(emit = true): void {
    if (this.modalKeyHandler) {
      document.removeEventListener('keydown', this.modalKeyHandler);
      this.modalKeyHandler = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
      if (emit) dispatchLifecycle(this, 'closed', this.eventId);
    }
    if (emit && this.modalRestoreFocus?.isConnected) {
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
