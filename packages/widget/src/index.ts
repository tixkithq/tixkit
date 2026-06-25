// GateKit Embeddable Widget - TypeScript Web Components.
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
//   --gk-radius   - border radius for widget surfaces (default 0.625rem)
//   --gk-primary  - primary accent color used for buttons/headers
//   --gk-bg       - widget background
//   --gk-fg       - widget foreground text
//
// The widget iframe posts messages back to the host for lifecycle integration.
// The hosted checkout posts { source: 'gatekit-checkout', event: 'order_completed', ... }
// and { source: 'gatekit-checkout', event: 'checkout_started', ... }.

type WidgetConfig = {
  brand: string;
  event: string;
  locale?: string;
  theme?: 'auto' | 'light' | 'dark';
  products?: string;
  discountCode?: string;
  trackingId?: string;
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

const IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
const IFRAME_ALLOW = 'payment; publickey-credentials-create *; publickey-credentials-get *';

const STYLES = `
  :host {
    display: block;
    width: 100%;
    --gk-radius: var(--gk-radius, 0.625rem);
    --gk-primary: var(--gk-primary, oklch(0.208 0.042 265.755));
    --gk-bg: var(--gk-bg, #ffffff);
    --gk-fg: var(--gk-fg, #171717);
    color: var(--gk-fg);
  }
  .gk-root {
    position: relative;
    width: 100%;
    min-height: 420px;
    border-radius: var(--gk-radius);
    overflow: hidden;
    background: var(--gk-bg);
    border: 1px solid rgba(23, 23, 23, 0.12);
  }
  .gk-frame {
    width: 100%;
    height: 100%;
    min-height: 420px;
    border: 0;
    display: block;
    background: var(--gk-bg);
  }
  .gk-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    background: var(--gk-bg);
    color: var(--gk-fg);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .gk-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(23, 23, 23, 0.18);
    border-top-color: var(--gk-primary);
    border-radius: 50%;
    animation: gk-spin 0.8s linear infinite;
  }
  @keyframes gk-spin { to { transform: rotate(360deg); } }
  .gk-error-icon {
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
  .gk-retry {
    border: 1px solid rgba(23, 23, 23, 0.18);
    background: var(--gk-bg);
    color: var(--gk-fg);
    border-radius: 6px;
    padding: 8px 14px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .gk-retry:hover { background: rgba(23, 23, 23, 0.05); }
  .gk-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .gk-modal {
    width: min(560px, 100%);
    max-height: 90vh;
    border-radius: var(--gk-radius);
    overflow: hidden;
    background: var(--gk-bg);
    display: flex;
    flex-direction: column;
  }
  .gk-modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid rgba(23, 23, 23, 0.1);
    color: var(--gk-fg);
  }
  .gk-modal-title { font-weight: 600; }
  .gk-modal-close {
    border: 0;
    background: transparent;
    color: var(--gk-fg);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
  }
  .gk-modal-close:hover { background: rgba(23, 23, 23, 0.06); }
  .gk-modal-frame {
    width: 100%;
    height: 70vh;
    border: 0;
    background: var(--gk-bg);
  }
`;

function injectStyles(shadow: ShadowRoot): void {
  const style = document.createElement('style');
  style.textContent = STYLES;
  shadow.appendChild(style);
}

function checkoutBase(element: HTMLElement): string {
  return (element.getAttribute('api-base-url') ?? 'https://checkout.gatekit.com').replace(/\/$/, '');
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

class GateKitWidget extends HTMLElement {
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
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private modalKeyHandler: ((event: KeyboardEvent) => void) | null = null;

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
      'tracking-id',
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
      'tracking-id': 'trackingId',
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
      if (!data || data.source !== 'gatekit-checkout') return;
      if (!checkoutMessageMatchesEvent(data, this.config.event)) return;

      const name = checkoutEventName(data);
      if (!name) return;
      dispatchLifecycle(this, name, this.config.event, checkoutMessageDetail(this.config.event, data));
    };
    window.addEventListener('message', this.messageHandler);
  }

  private showLoading(): void {
    if (!this.stateEl) return;
    this.stateEl.style.display = 'flex';
    this.stateEl.innerHTML = `<div class="gk-spinner"></div><p>Loading tickets…</p>`;
    dispatchLifecycle(this, 'loading', this.config.event);
  }

  private showError(message: string): void {
    this.errored = true;
    if (!this.stateEl) return;
    this.stateEl.style.display = 'flex';
    this.stateEl.innerHTML = `
      <div class="gk-error-icon">!</div>
      <p>${message}</p>
      <button class="gk-retry" type="button">Retry</button>
    `;
    const retry = this.stateEl.querySelector('.gk-retry');
    retry?.addEventListener('click', () => {
      this.errored = false;
      this.render();
    });
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
    if (this.config.trackingId) params.set('tracking', this.config.trackingId);
    return `${checkoutBase(this)}/checkout?${params.toString()}`;
  }

  private render(): void {
    this.shadow.innerHTML = '';
    injectStyles(this.shadow);

    if (!this.config.brand || !this.config.event) {
      const state = document.createElement('div');
      state.className = 'gk-state';
      state.textContent = 'GateKit widget: brand and event attributes are required.';
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
    root.className = 'gk-root';

    this.stateEl = document.createElement('div');
    this.stateEl.className = 'gk-state';
    root.appendChild(this.stateEl);
    this.showLoading();

    const iframe = document.createElement('iframe');
    iframe.className = 'gk-frame';
    iframe.title = 'GateKit Tickets';
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
    root.className = 'gk-root';

    const state = document.createElement('div');
    state.className = 'gk-state';
    state.style.display = 'flex';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gk-retry';
    btn.textContent = 'Buy tickets';
    btn.addEventListener('click', () => this.openModal(this.buildWidgetUrl()));

    state.appendChild(btn);
    root.appendChild(state);
    this.shadow.appendChild(root);
  }

  private renderRedirect(): void {
    const root = document.createElement('div');
    root.className = 'gk-root';

    const state = document.createElement('div');
    state.className = 'gk-state';
    state.style.display = 'flex';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gk-retry';
    btn.textContent = 'Buy tickets';
    btn.addEventListener('click', () => {
      // Dispatch opened + checkout_started before redirecting.
      dispatchLifecycle(this, 'opened', this.config.event);
      dispatchLifecycle(this, 'checkout_started', this.config.event);
      window.location.href = this.buildWidgetUrl();
    });

    state.appendChild(btn);
    root.appendChild(state);
    this.shadow.appendChild(root);
  }

  private openModal(url: string): void {
    this.closeModal();
    const backdrop = document.createElement('div');
    backdrop.className = 'gk-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.closeModal();
    });

    const modal = document.createElement('div');
    modal.className = 'gk-modal';

    const head = document.createElement('div');
    head.className = 'gk-modal-head';
    const title = document.createElement('span');
    title.className = 'gk-modal-title';
    title.textContent = 'Checkout';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gk-modal-close';
    close.setAttribute('aria-label', 'Close checkout');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeModal());
    head.appendChild(title);
    head.appendChild(close);

    const frame = document.createElement('iframe');
    frame.className = 'gk-modal-frame';
    frame.title = 'GateKit Checkout';
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
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler);
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
  }

  // Public methods for programmatic control.
  openCheckout(): void {
    dispatchLifecycle(this, 'checkout_started', this.config.event);
  }

  closeCheckout(): void {
    dispatchLifecycle(this, 'closed', this.config.event);
  }
}

class GateKitButton extends HTMLElement {
  private shadow: ShadowRoot;
  private eventId = '';
  private items = '';
  private brand = '';
  private products = '';
  private discountCode = '';
  private trackingId = '';
  private checkoutMode: CheckoutMode = 'modal';
  private modal: HTMLDivElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private unloadHandler: (() => void) | null = null;
  private modalKeyHandler: ((event: KeyboardEvent) => void) | null = null;

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
      'tracking-id',
      'checkout-mode',
    ];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string): void {
    if (name === 'event') this.eventId = newValue;
    if (name === 'items') this.items = newValue;
    if (name === 'brand') this.brand = newValue;
    if (name === 'products') this.products = newValue;
    if (name === 'discount-code') this.discountCode = newValue;
    if (name === 'tracking-id') this.trackingId = newValue;
    if (name === 'checkout-mode') this.checkoutMode = newValue as CheckoutMode;
    this.render();
  }

  connectedCallback(): void {
    this.render();
    this.listenForCheckoutMessages();
    dispatchLifecycle(this, 'loaded', this.eventId);

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
      if (!data || data.source !== 'gatekit-checkout') return;
      if (!checkoutMessageMatchesEvent(data, this.eventId)) return;

      const name = checkoutEventName(data);
      if (!name) return;
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
        background: var(--gk-primary, oklch(0.208 0.042 265.755));
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: var(--gk-radius, 0.5rem);
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
    if (this.trackingId) params.set('tracking', this.trackingId);
    params.set('mode', this.checkoutMode);
    return `${checkoutBase(this)}/checkout?${params.toString()}`;
  }

  private handleClick(): void {
    if (!this.eventId) {
      this.dispatchEvent(
        new CustomEvent('error', { detail: { message: 'Missing event attribute', event: '', eventId: '' } }),
      );
      return;
    }
    dispatchLifecycle(this, 'opened', this.eventId);
    dispatchLifecycle(this, 'checkout_started', this.eventId);

    const url = this.buildCheckoutUrl();

    if (this.checkoutMode === 'redirect') {
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
    const backdrop = document.createElement('div');
    backdrop.className = 'gk-modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.closeModal();
    });

    const modal = document.createElement('div');
    modal.className = 'gk-modal';

    const head = document.createElement('div');
    head.className = 'gk-modal-head';
    const title = document.createElement('span');
    title.className = 'gk-modal-title';
    title.textContent = 'Checkout';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gk-modal-close';
    close.setAttribute('aria-label', 'Close checkout');
    close.textContent = '×';
    close.addEventListener('click', () => this.closeModal());
    head.appendChild(title);
    head.appendChild(close);

    const frame = document.createElement('iframe');
    frame.className = 'gk-modal-frame';
    frame.title = 'GateKit Checkout';
    frame.src = url;
    frame.allow = IFRAME_ALLOW;
    frame.setAttribute('sandbox', IFRAME_SANDBOX);

    modal.appendChild(head);
    modal.appendChild(frame);
    backdrop.appendChild(modal);
    this.shadow.appendChild(backdrop);
    this.modal = backdrop;

    this.modalKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal();
      }
    };
    document.addEventListener('keydown', this.modalKeyHandler);
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
  }
}

if (typeof window !== 'undefined' && 'customElements' in window) {
  if (!customElements.get('gatekit-widget')) {
    customElements.define('gatekit-widget', GateKitWidget);
  }
  if (!customElements.get('gatekit-button')) {
    customElements.define('gatekit-button', GateKitButton);
  }
}

export { GateKitWidget, GateKitButton };
