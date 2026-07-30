import { expect, it, describe, vi, beforeEach, afterEach } from 'vitest';
import {
  TixkitWidget,
  TixkitButton,
  createCheckoutCloseRequestedMessage,
  createCheckoutLifecycleMessage,
  createCheckoutReadyMessage,
  issueWidgetRuntimeUrl,
} from '../index.js';

const CHECKOUT_BASE = 'https://checkout.tixkit.com';
const mountedElements: Array<TixkitWidget | TixkitButton> = [];

/**
 * jsdom does not fully upgrade custom elements via `document.createElement`,
 * so this harness constructs the exported class directly and invokes the
 * observed lifecycle callbacks manually (the approach the contract allows).
 * We deliberately do NOT append to the document, because jsdom auto-invokes
 * connectedCallback on append for registered classes which would double-fire
 * events. This still asserts that events *actually dispatch* at runtime via
 * spies, rather than matching source strings.
 */
function createWidget(attrs: Record<string, string> = {}): TixkitWidget {
  const el = new TixkitWidget();
  el.setAttribute('api-base-url', CHECKOUT_BASE);
  el.setAttribute('brand', 'brand_demo');
  el.setAttribute('event', 'evt_demo');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  mountedElements.push(el);
  return el;
}

function createButton(attrs: Record<string, string> = {}): TixkitButton {
  const el = new TixkitButton();
  el.setAttribute('api-base-url', CHECKOUT_BASE);
  el.setAttribute('event', 'evt_demo');
  el.setAttribute('brand', 'brand_demo');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  mountedElements.push(el);
  return el;
}

function postCheckoutMessage(
  event: string,
  detail: Record<string, string> = {},
  origin = CHECKOUT_BASE,
  target?: TixkitWidget | TixkitButton,
): void {
  const eventId = detail.eventId ?? 'evt_demo';
  const candidates = [...mountedElements];
  // oxlint-disable-next-line unicorn/no-array-reverse -- only the local copy is mutated.
  candidates.reverse();
  const element =
    target ??
    candidates.find((candidate) => {
      const src = candidate.shadowRoot?.querySelector('iframe')?.getAttribute('src');
      return src ? new URL(src).searchParams.get('eventId') === eventId : false;
    });
  const frame = element?.shadowRoot?.querySelector('iframe');
  if (!frame) throw new Error(`No active iframe for ${eventId}`);
  const source = ensureFrameWindow(frame);
  const url = new URL(frame.src);
  const lifecycle =
    event === 'checkout_started'
      ? 'checkout-started'
      : event === 'order_completed'
        ? 'order-completed'
        : event;
  const binding = {
    widgetId: url.searchParams.get('embedWidgetId') ?? '',
    eventId,
    nonce: url.searchParams.get('embedNonce') ?? '',
  };
  const message =
    lifecycle === 'order-completed'
      ? createCheckoutLifecycleMessage({
          ...binding,
          lifecycle,
          ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
          orderId: detail.orderId ?? 'ord_test',
        })
      : createCheckoutLifecycleMessage({
          ...binding,
          lifecycle: 'checkout-started',
          ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
        });
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source,
      data: message,
    }),
  );
}

function ensureFrameWindow(frame: HTMLIFrameElement): Window {
  if (frame.contentWindow) return frame.contentWindow;
  const source = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    value: source,
  });
  return source;
}

function dispatchFrameLoad(frame: HTMLIFrameElement): void {
  const source = ensureFrameWindow(frame);
  frame.dispatchEvent(new Event('load'));
  const url = new URL(frame.src);
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: url.origin,
      source,
      data: createCheckoutReadyMessage({
        widgetId: url.searchParams.get('embedWidgetId') ?? '',
        eventId: url.searchParams.get('eventId') ?? '',
        nonce: url.searchParams.get('embedNonce') ?? '',
      }),
    }),
  );
}

function setDocumentReferrer(value: string): void {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value,
  });
}

function readWidgetImpressionBody(): Record<string, unknown> {
  const call = vi
    .mocked(globalThis.fetch)
    .mock.calls.find(([requestUrl]) => String(requestUrl).includes('/widget-impressions'));
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/marketing-integrations')
        ? { items: [] }
        : { tracked: true, deduped: false };
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });
  while (mountedElements.length > 0) {
    mountedElements.pop()?.disconnectedCallback();
  }
  window.history.replaceState({}, '', '/');
  setDocumentReferrer('');
  vi.unstubAllGlobals();
});

describe('widget lifecycle events (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('dispatches loaded after the validated ready handshake', () => {
    const el = createWidget();
    const spy = vi.fn();
    const readySpy = vi.fn();
    el.addEventListener('loaded', spy);
    el.addEventListener('tixkit:v1:ready', readySpy);

    el.connectedCallback();
    expect(spy).not.toHaveBeenCalled();
    expect(readySpy).not.toHaveBeenCalled();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    expect(frame).not.toBeNull();
    dispatchFrameLoad(frame!);
    dispatchFrameLoad(frame!);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readySpy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent);
  });

  it('retries the bound hello until the checkout listener is ready', () => {
    vi.useFakeTimers();
    const el = createWidget();
    const loadedSpy = vi.fn();
    el.addEventListener('loaded', loadedSpy);
    el.connectedCallback();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    expect(frame).not.toBeNull();
    const source = ensureFrameWindow(frame!);
    const postMessageSpy = vi.spyOn(source, 'postMessage');
    frame!.dispatchEvent(new Event('load'));
    expect(postMessageSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    expect(postMessageSpy).toHaveBeenCalledTimes(2);

    const url = new URL(frame!.src);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: url.origin,
        source,
        data: createCheckoutReadyMessage({
          widgetId: url.searchParams.get('embedWidgetId') ?? '',
          eventId: url.searchParams.get('eventId') ?? '',
          nonce: url.searchParams.get('embedNonce') ?? '',
        }),
      }),
    );
    vi.advanceTimersByTime(500);

    expect(loadedSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy).toHaveBeenCalledTimes(2);
  });

  it('starts the handshake after declarative attributes replace transient upgrade errors', () => {
    const el = new TixkitWidget();
    mountedElements.push(el);
    (el as unknown as { showError(message: string): void }).showError(
      'Transient custom-element upgrade error',
    );

    el.setAttribute('api-base-url', CHECKOUT_BASE);
    el.setAttribute('brand', 'brand_demo');
    el.setAttribute('event', 'evt_demo');
    el.connectedCallback();

    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    expect(frame).not.toBeNull();
    const source = ensureFrameWindow(frame!);
    const postMessageSpy = vi.spyOn(source, 'postMessage');
    frame!.dispatchEvent(new Event('load'));

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]?.[0]).toMatchObject({
      source: 'tixkit-embed-host',
      type: 'host:hello',
      eventId: 'evt_demo',
    });
  });

  it('fails accessibly with a hosted fallback when the exact handshake times out', () => {
    vi.useFakeTimers();
    const el = createWidget();
    const errorSpy = vi.fn();
    el.addEventListener('tixkit:v1:recoverable-error', errorSpy);
    el.connectedCallback();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    expect(frame).not.toBeNull();
    ensureFrameWindow(frame!);
    frame!.dispatchEvent(new Event('load'));

    vi.advanceTimersByTime(10_000);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect((errorSpy.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({
      errorCode: 'handshake-timeout',
      retryable: true,
    });
    const fallback = el.shadowRoot?.querySelector<HTMLAnchorElement>('a');
    expect(fallback?.textContent).toBe('Open secure checkout');
    expect(fallback?.href).toContain('/checkout?');
    expect(el.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('classifies a handshake timeout as offline when the browser is offline', () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const el = createWidget();
    const errorSpy = vi.fn();
    el.addEventListener('tixkit:v1:recoverable-error', errorSpy);
    el.connectedCallback();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    ensureFrameWindow(frame!);
    frame!.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(10_000);
    expect((errorSpy.mock.calls[0]![0] as CustomEvent).detail.errorCode).toBe('checkout-offline');
  });

  it('records one persisted widget impression when loaded', () => {
    window.history.replaceState(
      {},
      '',
      '/events/evt_demo?email=buyer@example.test&token=checkout-token#payment',
    );
    const referrerWithUserinfo = new URL('https://partner.example.test/campaigns/summer');
    referrerWithUserinfo.username = 'userinfo';
    referrerWithUserinfo.searchParams.set('email', 'referrer@example.test');
    referrerWithUserinfo.searchParams.set('token', 'ref-token');
    referrerWithUserinfo.hash = 'cta';
    setDocumentReferrer(referrerWithUserinfo.toString());
    const el = createWidget({
      'reporting-api-url': 'https://api.test',
      'tracking-id': 'utm-widget',
      'affiliate-code': 'AFF123',
    });

    el.connectedCallback();

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls.find(([requestUrl]) =>
      String(requestUrl).includes('/widget-impressions'),
    )!;
    expect(String(url)).toBe('https://api.test/v1/public/events/evt_demo/widget-impressions');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.visitorId).toEqual(expect.any(String));
    expect(body.trackingId).toBe('utm-widget');
    expect(body.affiliateCode).toBe('AFF123');
    expect(body.pageUrl).toBe(window.location.origin);
    expect(body.referrer).toBe('https://partner.example.test');
    expect(String(init?.body)).not.toMatch(
      /[?#]|buyer@example\.test|checkout-token|userinfo@|referrer@example\.test|ref-token/,
    );
  });

  it('uses crypto byte generation for widget visitor IDs when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: vi.fn((bytes: Uint8Array) => {
        bytes.forEach((_, index) => {
          bytes[index] = index;
        });
        return bytes;
      }),
    });
    const el = createWidget({ 'reporting-api-url': 'https://api.test' });

    el.connectedCallback();

    const body = readWidgetImpressionBody();
    expect(body.visitorId).toBe('visitor_000102030405060708090a0b0c0d0e0f');
    expect(window.sessionStorage.getItem('tixkit:visitor-id')).toBe(body.visitorId);
  });

  it('does not send raw invalid widget impression referrers', () => {
    window.history.replaceState({}, '', '/events/evt_demo?token=checkout-token#payment');
    setDocumentReferrer('not a url with token=ref-token');
    const el = createWidget({ 'reporting-api-url': 'https://api.test' });

    el.connectedCallback();

    const body = readWidgetImpressionBody();
    expect(body.pageUrl).toBe(window.location.origin);
    expect(body.referrer).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('not a url with token=ref-token');
    expect(JSON.stringify(body)).not.toContain('ref-token');
  });

  it('does not record duplicate impressions across repeated connectedCallback calls for one element', () => {
    const el = createWidget({ 'reporting-api-url': 'https://api.test' });

    el.connectedCallback();
    el.connectedCallback();

    const impressionCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([url]) => String(url).includes('/widget-impressions'));
    expect(impressionCalls).toHaveLength(1);
  });

  it('loads consent-gated generic marketing tags only after host consent', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/marketing-integrations')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                provider: 'generic_tag',
                status: 'active',
                consentRequired: true,
                config: { pixelUrl: 'https://analytics.example/pixel' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ tracked: true, deduped: false }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const createdImages: HTMLImageElement[] = [];
    const imageSpy = vi.spyOn(document, 'createElement');
    imageSpy.mockImplementation(((tagName: string) => {
      const element = document.createElementNS(
        'http://www.w3.org/1999/xhtml',
        tagName,
      ) as HTMLElement;
      if (tagName.toLowerCase() === 'img') createdImages.push(element as HTMLImageElement);
      return element;
    }) as typeof document.createElement);

    const blocked = createWidget({
      event: 'evt_marketing',
      'reporting-api-url': 'https://api.test',
    });
    blocked.connectedCallback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createdImages).toHaveLength(0);

    window.localStorage.setItem('tixkit_marketing_consent', 'granted');
    const allowed = createButton({
      event: 'evt_marketing',
      'reporting-api-url': 'https://api.test',
    });
    allowed.connectedCallback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createdImages.at(-1)?.src).toContain('https://analytics.example/pixel?');
    expect(createdImages.at(-1)?.src).toContain('tk_event=view_item');
    imageSpy.mockRestore();
  });

  it('dispatches opened when the inline iframe finishes loading', () => {
    const el = createWidget(); // default inline mode

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('opened', spy);
    const iframe = el.shadowRoot?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    dispatchFrameLoad(iframe!);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('dispatches checkout_started on trusted postMessage from hosted checkout', () => {
    const el = createWidget();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('checkout_started', spy);
    postCheckoutMessage('checkout_started', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_demo',
        eventId: 'evt_demo',
        sessionId: 'cs_demo',
      },
    });
  });

  it('dispatches order_completed on trusted postMessage from hosted checkout', () => {
    const el = createWidget();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('order_completed', spy);
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
      orderId: 'ord_demo',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_demo',
        eventId: 'evt_demo',
        sessionId: 'cs_demo',
        orderId: 'ord_demo',
      },
    });
  });

  it('dispatches closed on disconnectedCallback', () => {
    const el = createWidget();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('closed', spy);
    el.disconnectedCallback();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: { name: 'closed', reason: 'disconnected' },
    });
  });

  it('renders HTML-looking error messages as text', () => {
    const el = createWidget();
    el.connectedCallback();

    (el as unknown as { showError(message: string): void }).showError(
      '<img src=x onerror=alert(1)>',
    );

    const state = el.shadowRoot?.querySelector('.tk-state');
    expect(state?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(state?.querySelector('img')).toBeNull();
  });

  it('all five required lifecycle events actually dispatch', () => {
    const el = createWidget();
    const spies: Record<string, ReturnType<typeof vi.fn>> = {
      loaded: vi.fn(),
      opened: vi.fn(),
      closed: vi.fn(),
      checkout_started: vi.fn(),
      order_completed: vi.fn(),
    };
    for (const [name, spy] of Object.entries(spies)) {
      el.addEventListener(name, spy as unknown as EventListener);
    }

    el.connectedCallback();
    const iframe = el.shadowRoot?.querySelector('iframe');
    if (iframe) dispatchFrameLoad(iframe); // ready/loaded and opened
    postCheckoutMessage('checkout_started'); // checkout_started
    postCheckoutMessage('order_completed'); // order_completed
    el.disconnectedCallback(); // closed
    for (const spy of Object.values(spies)) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('ignores postMessage from untrusted origins', () => {
    const el = createWidget();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('checkout_started', spy);
    postCheckoutMessage('checkout_started', { eventId: 'evt_demo' }, 'https://evil.example.com');
    expect(spy).not.toHaveBeenCalled();
  });

  it('filters checkout postMessage events to the matching widget event on multi-widget pages', () => {
    const first = createWidget({ event: 'evt_first' });
    const second = createWidget({ event: 'evt_second' });

    first.connectedCallback();
    second.connectedCallback();
    const firstSpy = vi.fn();
    const secondSpy = vi.fn();
    first.addEventListener('checkout_started', firstSpy);
    second.addEventListener('checkout_started', secondSpy);

    postCheckoutMessage('checkout_started', {
      eventId: 'evt_second',
      sessionId: 'cs_second',
    });

    expect(firstSpy).not.toHaveBeenCalled();
    expect(secondSpy).toHaveBeenCalledTimes(1);
    expect(secondSpy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_second',
        eventId: 'evt_second',
        sessionId: 'cs_second',
      },
    });
  });

  it('isolates widgets for the same event by iframe source, widget ID, and nonce', () => {
    const first = createWidget({ event: 'evt_shared' });
    const second = createWidget({ event: 'evt_shared' });
    first.connectedCallback();
    second.connectedCallback();
    const firstSpy = vi.fn();
    const secondSpy = vi.fn();
    first.addEventListener('order_completed', firstSpy);
    second.addEventListener('order_completed', secondSpy);

    postCheckoutMessage(
      'order_completed',
      { eventId: 'evt_shared', sessionId: 'cs_shared', orderId: 'ord_shared' },
      CHECKOUT_BASE,
      second,
    );

    expect(firstSpy).not.toHaveBeenCalled();
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });

  it('fails closed for unknown contract versions and stale nonces', () => {
    const el = createWidget();
    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('order_completed', spy);
    const frame = el.shadowRoot?.querySelector('iframe');
    expect(frame).not.toBeNull();
    const source = ensureFrameWindow(frame!);
    const url = new URL(frame!.src);
    const message = createCheckoutLifecycleMessage({
      widgetId: url.searchParams.get('embedWidgetId') ?? '',
      eventId: 'evt_demo',
      nonce: 'stale_nonce',
      lifecycle: 'order-completed',
      orderId: 'ord_stale',
    });
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: CHECKOUT_BASE,
        source,
        data: { ...message, contractVersion: '2.0' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: CHECKOUT_BASE,
        source,
        data: message,
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not duplicate postMessage listeners across repeated connectedCallback calls', () => {
    const el = createWidget();

    el.connectedCallback();
    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('order_completed', spy);
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      orderId: 'ord_demo',
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('cold-starts many inline widgets with isolated lifecycle and message delivery', () => {
    const widgets = Array.from({ length: 100 }, (_, index) =>
      createWidget({
        event: `evt_cold_${index}`,
        brand: `brand_cold_${index}`,
      }),
    );
    const loadedSpies = widgets.map(() => vi.fn());
    const openedSpies = widgets.map(() => vi.fn());
    const completedSpies = widgets.map(() => vi.fn());

    widgets.forEach((widget, index) => {
      widget.addEventListener('loaded', loadedSpies[index] as EventListener);
      widget.addEventListener('opened', openedSpies[index] as EventListener);
      widget.addEventListener('order_completed', completedSpies[index] as EventListener);
      widget.connectedCallback();
      const frame = widget.shadowRoot?.querySelector('iframe');
      if (frame) dispatchFrameLoad(frame);
    });

    loadedSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    openedSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    widgets.forEach((widget, index) => {
      const iframe = widget.shadowRoot?.querySelector('iframe');
      expect(iframe?.getAttribute('src')).toContain(`eventId=evt_cold_${index}`);
      expect(iframe?.getAttribute('src')).toContain(`brand=brand_cold_${index}`);
    });

    postCheckoutMessage('order_completed', {
      eventId: 'evt_cold_42',
      sessionId: 'cs_cold_42',
      orderId: 'ord_cold_42',
    });

    completedSpies.forEach((spy, index) => {
      expect(spy).toHaveBeenCalledTimes(index === 42 ? 1 : 0);
    });
    expect(completedSpies[42]?.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_cold_42',
        eventId: 'evt_cold_42',
        sessionId: 'cs_cold_42',
        orderId: 'ord_cold_42',
      },
    });

    widgets.forEach((widget) => widget.disconnectedCallback());
    postCheckoutMessage('order_completed', {
      eventId: 'evt_cold_42',
      sessionId: 'cs_after_disconnect',
      orderId: 'ord_after_disconnect',
    });
    expect(completedSpies[42]).toHaveBeenCalledTimes(1);
  });

  it('removes checkout message listeners on disconnectedCallback', () => {
    const el = createWidget();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('order_completed', spy);
    el.disconnectedCallback();
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      orderId: 'ord_demo',
    });

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('widget runtime target authority', () => {
  it('issues checkout and reporting targets only within an exact safe origin', () => {
    expect(issueWidgetRuntimeUrl('https://checkout.test', '/checkout?eventId=evt_1')).toBe(
      'https://checkout.test/checkout?eventId=evt_1',
    );
    expect(issueWidgetRuntimeUrl('http://localhost:4000', '/v1/health')).toBe(
      'http://localhost:4000/v1/health',
    );
    for (const [baseUrl, path] of [
      ['http://checkout.test', '/checkout'],
      ['https://user:secret@checkout.test', '/checkout'],
      ['https://checkout.test/path', '/checkout'],
      ['https://checkout.test', '//attacker.test/checkout'],
      ['https://checkout.test', '/checkout\n'],
    ]) {
      expect(() => issueWidgetRuntimeUrl(baseUrl, path)).toThrow();
    }
  });

  it('does not report or load marketing configuration when reporting origin is rejected', () => {
    const el = createWidget({
      'reporting-api-url': 'https://user:secret@api.test',
    });
    el.connectedCallback();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('widget iframe security (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not serialize API keys into widget URLs', () => {
    const el = createWidget({ 'discount-code': 'PROMO', 'tracking-id': 't-1' });

    el.connectedCallback();
    const iframe = el.shadowRoot?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute('src') ?? '';
    expect(src).not.toContain('apiKey');
    expect(src).not.toContain('key=');
  });

  it('reacts to api-base-url mutations by rebuilding the checkout frame', () => {
    const el = createWidget();
    document.body.appendChild(el);
    el.setAttribute('api-base-url', 'https://custom-checkout.example.test');
    expect(el.shadowRoot?.querySelector('iframe')?.src).toMatch(
      /^https:\/\/custom-checkout\.example\.test\/checkout\?/,
    );
    el.remove();
  });

  it('sets sandbox and allow attributes on the inline iframe', () => {
    const el = createWidget();

    el.connectedCallback();
    const iframe = el.shadowRoot?.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    );
    expect(iframe!.allow).toContain('payment');
    expect(iframe!.allow).toContain('publickey-credentials-get');
  });
});

describe('widget checkout modes (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('modal mode renders a buy-tickets button that opens a modal iframe', () => {
    const el = createWidget({ 'checkout-mode': 'modal' });

    el.connectedCallback();
    const button = el.shadowRoot?.querySelector('button');
    expect(button).not.toBeNull();
    // No inline iframe is rendered in modal mode.
    expect(el.shadowRoot?.querySelector('iframe.tk-frame')).toBeNull();
    // Clicking the button opens the modal (renders a modal iframe).
    button!.click();
    const modalFrame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    expect(modalFrame).not.toBeNull();
  });

  it('modal mode dispatches opened after the modal iframe loads and closed after close button click', () => {
    const el = createWidget({ 'checkout-mode': 'modal' });

    el.connectedCallback();
    const openedSpy = vi.fn();
    const closedSpy = vi.fn();
    el.addEventListener('opened', openedSpy);
    el.addEventListener('closed', closedSpy);

    el.shadowRoot?.querySelector('button')?.click();
    const modalFrame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    expect(modalFrame).not.toBeNull();
    dispatchFrameLoad(modalFrame!);
    expect(openedSpy).toHaveBeenCalledTimes(1);

    const close = el.shadowRoot?.querySelector<HTMLButtonElement>('button.tk-modal-close');
    expect(close).not.toBeNull();
    close!.click();
    expect(closedSpy).toHaveBeenCalledTimes(1);
    expect(el.shadowRoot?.querySelector('iframe.tk-modal-frame')).toBeNull();
  });

  it('closes a modal after a validated Escape request from the checkout frame', () => {
    const el = createWidget({ 'checkout-mode': 'modal' });
    el.connectedCallback();
    const launcher = el.shadowRoot?.querySelector<HTMLButtonElement>('button');
    launcher?.click();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    expect(frame).not.toBeNull();
    const source = ensureFrameWindow(frame!);
    const url = new URL(frame!.src);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: CHECKOUT_BASE,
        source,
        data: createCheckoutCloseRequestedMessage({
          widgetId: url.searchParams.get('embedWidgetId') ?? '',
          eventId: 'evt_demo',
          nonce: url.searchParams.get('embedNonce') ?? '',
        }),
      }),
    );
    expect(el.shadowRoot?.querySelector('iframe.tk-modal-frame')).toBeNull();
  });

  it('restores modal launcher focus and renders retry plus fallback after timeout', () => {
    vi.useFakeTimers();
    const el = createWidget({ 'checkout-mode': 'modal' });
    el.connectedCallback();
    const launcher = el.shadowRoot?.querySelector<HTMLButtonElement>('button');
    launcher?.focus();
    launcher?.click();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    expect(frame).not.toBeNull();
    ensureFrameWindow(frame!);
    frame!.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(10_000);
    expect(el.shadowRoot?.querySelector('iframe.tk-modal-frame')).toBeNull();
    expect(el.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('a')?.textContent).toBe('Open secure checkout');
    expect(el.shadowRoot?.querySelector<HTMLButtonElement>('button.tk-retry')).not.toBeNull();
  });

  it('redirect mode dispatches opened but not checkout_started on click', () => {
    const el = createWidget({ 'checkout-mode': 'redirect' });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    el.connectedCallback();
    const openedSpy = vi.fn();
    const startedSpy = vi.fn();
    el.addEventListener('opened', openedSpy);
    el.addEventListener('checkout_started', startedSpy);
    const button = el.shadowRoot?.querySelector('button');
    expect(button).not.toBeNull();
    button!.click();
    expect(openedSpy).toHaveBeenCalledTimes(1);
    expect(startedSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/checkout?eventId=evt_demo'),
      '_self',
      'noopener',
    );
    openSpy.mockRestore();
  });
});

describe('TixkitButton lifecycle (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('dispatches loaded after a button checkout ready handshake', () => {
    const el = createButton();
    const spy = vi.fn();
    el.addEventListener('loaded', spy);

    el.connectedCallback();
    el.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    expect(frame).not.toBeNull();
    dispatchFrameLoad(frame!);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('announces a button-modal timeout with retry and hosted fallback', () => {
    vi.useFakeTimers();
    const el = createButton();
    el.connectedCallback();
    const launcher = el.shadowRoot?.querySelector<HTMLButtonElement>('button.tk-launcher');
    launcher?.click();
    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe');
    expect(frame).not.toBeNull();
    ensureFrameWindow(frame!);
    frame!.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(10_000);
    expect(el.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('a')?.textContent).toBe('Open secure checkout');
    expect(el.shadowRoot?.querySelector('button.tk-retry')?.textContent).toBe('Retry checkout');
  });

  it('records button impressions using the reporting API origin', () => {
    const el = createButton({ 'reporting-api-url': 'https://api.test' });

    el.connectedCallback();

    const [url] = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([requestUrl]) => String(requestUrl).includes('/widget-impressions'))!;
    expect(String(url)).toBe('https://api.test/v1/public/events/evt_demo/widget-impressions');
  });

  it('passes button prefill, product, discount, access code, tracking, and affiliate params to checkout', () => {
    const el = createButton({
      items: 'tt_1=2',
      products: 'tt_1,tt_2',
      'discount-code': 'PROMO',
      'access-code': 'VIP123',
      'tracking-id': 'campaign_123',
      'affiliate-code': 'aff_123',
    });

    el.connectedCallback();
    const button = el.shadowRoot?.querySelector('button');
    expect(button).not.toBeNull();
    button!.click();

    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    expect(frame).not.toBeNull();
    const url = new URL(frame!.getAttribute('src') ?? '');
    expect(url.searchParams.get('eventId')).toBe('evt_demo');
    expect(url.searchParams.get('brand')).toBe('brand_demo');
    expect(url.searchParams.get('items')).toBe('tt_1=2');
    expect(url.searchParams.get('products')).toBe('tt_1,tt_2');
    expect(url.searchParams.get('discount')).toBe('PROMO');
    expect(url.searchParams.get('accessCode')).toBe('VIP123');
    expect(url.searchParams.get('tracking')).toBe('campaign_123');
    expect(url.searchParams.get('affiliateCode')).toBe('aff_123');
  });

  it('does not dispatch checkout_started from a button click before hosted checkout postMessage', () => {
    const el = createButton();

    el.connectedCallback();
    const openedSpy = vi.fn();
    const startedSpy = vi.fn();
    el.addEventListener('opened', openedSpy);
    el.addEventListener('checkout_started', startedSpy);
    el.shadowRoot?.querySelector('button')?.click();

    expect(startedSpy).not.toHaveBeenCalled();
    expect(openedSpy).not.toHaveBeenCalled();

    const frame = el.shadowRoot?.querySelector<HTMLIFrameElement>('iframe.tk-modal-frame');
    expect(frame).not.toBeNull();
    dispatchFrameLoad(frame!);
    expect(openedSpy).toHaveBeenCalledTimes(1);
    expect(startedSpy).not.toHaveBeenCalled();
  });

  it('forwards locale and theme from button attributes to hosted checkout', () => {
    const el = createButton({ locale: 'fr-FR', theme: 'dark' });
    el.connectedCallback();
    el.shadowRoot?.querySelector<HTMLButtonElement>('button')?.click();
    const url = new URL(el.shadowRoot?.querySelector('iframe')?.src ?? 'about:blank');
    expect(url.searchParams.get('locale')).toBe('fr-FR');
    expect(url.searchParams.get('theme')).toBe('dark');
  });

  it('dispatches order_completed from trusted checkout postMessage in modal button flows', () => {
    const el = createButton();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('order_completed', spy);
    el.shadowRoot?.querySelector('button')?.click();
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
      orderId: 'ord_demo',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_demo',
        eventId: 'evt_demo',
        sessionId: 'cs_demo',
        orderId: 'ord_demo',
      },
    });
  });

  it('ignores button checkout postMessage events for other event IDs', () => {
    const el = createButton({ event: 'evt_button' });

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('order_completed', spy);
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: CHECKOUT_BASE,
        data: createCheckoutLifecycleMessage({
          widgetId: 'tkw_other',
          eventId: 'evt_other',
          nonce: 'nonce_other',
          lifecycle: 'order-completed',
          orderId: 'ord_other',
        }),
      }),
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('closes modal button checkouts with a closed lifecycle event', () => {
    const el = createButton();

    el.connectedCallback();
    const spy = vi.fn();
    el.addEventListener('closed', spy);
    el.shadowRoot?.querySelector('button')?.click();
    const close = el.shadowRoot?.querySelector<HTMLButtonElement>('button.tk-modal-close');
    expect(close).not.toBeNull();
    close!.click();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(el.shadowRoot?.querySelector('iframe.tk-modal-frame')).toBeNull();
  });
});
