import { expect, it, describe, vi, beforeEach, afterEach } from 'vitest'
import { GateKitWidget, GateKitButton } from '../index.js'

const CHECKOUT_BASE = 'https://checkout.gatekit.com'
const mountedElements: Array<GateKitWidget | GateKitButton> = []

/**
 * jsdom does not fully upgrade custom elements via `document.createElement`,
 * so this harness constructs the exported class directly and invokes the
 * observed lifecycle callbacks manually (the approach the contract allows).
 * We deliberately do NOT append to the document, because jsdom auto-invokes
 * connectedCallback on append for registered classes which would double-fire
 * events. This still asserts that events *actually dispatch* at runtime via
 * spies, rather than matching source strings.
 */
function createWidget(attrs: Record<string, string> = {}): GateKitWidget {
  const el = new GateKitWidget()
  el.setAttribute('api-base-url', CHECKOUT_BASE)
  el.setAttribute('brand', 'brand_demo')
  el.setAttribute('event', 'evt_demo')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  mountedElements.push(el)
  return el
}

function createButton(attrs: Record<string, string> = {}): GateKitButton {
  const el = new GateKitButton()
  el.setAttribute('api-base-url', CHECKOUT_BASE)
  el.setAttribute('event', 'evt_demo')
  el.setAttribute('brand', 'brand_demo')
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  mountedElements.push(el)
  return el
}

function postCheckoutMessage(
  event: string,
  detail: Record<string, string> = {},
  origin = CHECKOUT_BASE,
): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      data: { source: 'gatekit-checkout', event, ...detail },
    }),
  )
}

afterEach(() => {
  while (mountedElements.length > 0) {
    mountedElements.pop()?.disconnectedCallback()
  }
})

describe('widget lifecycle events (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('dispatches loaded on connectedCallback', () => {
    const el = createWidget()
    const spy = vi.fn()
    el.addEventListener('loaded', spy)

    el.connectedCallback()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(CustomEvent)
  })

  it('dispatches opened when the inline iframe finishes loading', () => {
    const el = createWidget() // default inline mode

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('opened', spy)
    const iframe = el.shadowRoot?.querySelector('iframe')
    expect(iframe).not.toBeNull()
    iframe!.dispatchEvent(new Event('load'))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('dispatches checkout_started on trusted postMessage from hosted checkout', () => {
    const el = createWidget()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('checkout_started', spy)
    postCheckoutMessage('checkout_started', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_demo',
        eventId: 'evt_demo',
        sessionId: 'cs_demo',
      },
    })
  })

  it('dispatches order_completed on trusted postMessage from hosted checkout', () => {
    const el = createWidget()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('order_completed', spy)
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
      orderId: 'ord_demo',
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_demo',
        eventId: 'evt_demo',
        sessionId: 'cs_demo',
        orderId: 'ord_demo',
      },
    })
  })

  it('dispatches closed on disconnectedCallback', () => {
    const el = createWidget()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('closed', spy)
    el.disconnectedCallback()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('all five required lifecycle events actually dispatch', () => {
    const el = createWidget()
    const spies: Record<string, ReturnType<typeof vi.fn>> = {
      loaded: vi.fn(),
      opened: vi.fn(),
      closed: vi.fn(),
      checkout_started: vi.fn(),
      order_completed: vi.fn(),
    }
    for (const [name, spy] of Object.entries(spies)) {
      el.addEventListener(name, spy as unknown as EventListener)
    }

    el.connectedCallback() // loaded
    const iframe = el.shadowRoot?.querySelector('iframe')
    iframe?.dispatchEvent(new Event('load')) // opened
    postCheckoutMessage('checkout_started') // checkout_started
    postCheckoutMessage('order_completed') // order_completed
    el.disconnectedCallback() // closed
    for (const spy of Object.values(spies)) {
      expect(spy).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores postMessage from untrusted origins', () => {
    const el = createWidget()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('checkout_started', spy)
    postCheckoutMessage('checkout_started', { eventId: 'evt_demo' }, 'https://evil.example.com')
    expect(spy).not.toHaveBeenCalled()
  })

  it('filters checkout postMessage events to the matching widget event on multi-widget pages', () => {
    const first = createWidget({ event: 'evt_first' })
    const second = createWidget({ event: 'evt_second' })

    first.connectedCallback()
    second.connectedCallback()
    const firstSpy = vi.fn()
    const secondSpy = vi.fn()
    first.addEventListener('checkout_started', firstSpy)
    second.addEventListener('checkout_started', secondSpy)

    postCheckoutMessage('checkout_started', {
      eventId: 'evt_second',
      sessionId: 'cs_second',
    })

    expect(firstSpy).not.toHaveBeenCalled()
    expect(secondSpy).toHaveBeenCalledTimes(1)
    expect(secondSpy.mock.calls[0]?.[0]).toMatchObject({
      detail: { event: 'evt_second', eventId: 'evt_second', sessionId: 'cs_second' },
    })
  })

  it('does not duplicate postMessage listeners across repeated connectedCallback calls', () => {
    const el = createWidget()

    el.connectedCallback()
    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('order_completed', spy)
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      orderId: 'ord_demo',
    })

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('removes checkout message listeners on disconnectedCallback', () => {
    const el = createWidget()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('order_completed', spy)
    el.disconnectedCallback()
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      orderId: 'ord_demo',
    })

    expect(spy).not.toHaveBeenCalled()
  })
})

describe('widget iframe security (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('does not serialize API keys into widget URLs', () => {
    const el = createWidget({ 'discount-code': 'PROMO', 'tracking-id': 't-1' })

    el.connectedCallback()
    const iframe = el.shadowRoot?.querySelector('iframe')
    expect(iframe).not.toBeNull()
    const src = iframe!.getAttribute('src') ?? ''
    expect(src).not.toContain('apiKey')
    expect(src).not.toContain('key=')
  })

  it('sets sandbox and allow attributes on the inline iframe', () => {
    const el = createWidget()

    el.connectedCallback()
    const iframe = el.shadowRoot?.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe!.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
    )
    expect(iframe!.allow).toContain('payment')
    expect(iframe!.allow).toContain('publickey-credentials-get')
  })
})

describe('widget checkout modes (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('modal mode renders a buy-tickets button that opens a modal iframe', () => {
    const el = createWidget({ 'checkout-mode': 'modal' })

    el.connectedCallback()
    const button = el.shadowRoot?.querySelector('button')
    expect(button).not.toBeNull()
    // No inline iframe is rendered in modal mode.
    expect(el.shadowRoot?.querySelector('iframe.gk-frame')).toBeNull()
    // Clicking the button opens the modal (renders a modal iframe).
    button!.click()
    const modalFrame = el.shadowRoot?.querySelector('iframe.gk-modal-frame')
    expect(modalFrame).not.toBeNull()
  })

  it('modal mode dispatches opened after the modal iframe loads and closed after close button click', () => {
    const el = createWidget({ 'checkout-mode': 'modal' })

    el.connectedCallback()
    const openedSpy = vi.fn()
    const closedSpy = vi.fn()
    el.addEventListener('opened', openedSpy)
    el.addEventListener('closed', closedSpy)

    el.shadowRoot?.querySelector('button')?.click()
    const modalFrame = el.shadowRoot?.querySelector('iframe.gk-modal-frame')
    expect(modalFrame).not.toBeNull()
    modalFrame!.dispatchEvent(new Event('load'))
    expect(openedSpy).toHaveBeenCalledTimes(1)

    const close = el.shadowRoot?.querySelector<HTMLButtonElement>('button.gk-modal-close')
    expect(close).not.toBeNull()
    close!.click()
    expect(closedSpy).toHaveBeenCalledTimes(1)
    expect(el.shadowRoot?.querySelector('iframe.gk-modal-frame')).toBeNull()
  })

  it('redirect mode dispatches opened + checkout_started on click', () => {
    const el = createWidget({ 'checkout-mode': 'redirect' })

    el.connectedCallback()
    const openedSpy = vi.fn()
    const startedSpy = vi.fn()
    el.addEventListener('opened', openedSpy)
    el.addEventListener('checkout_started', startedSpy)
    const button = el.shadowRoot?.querySelector('button')
    expect(button).not.toBeNull()
    // jsdom ignores window.location navigation; the events dispatch before
    // the navigation attempt regardless.
    button!.click()
    expect(openedSpy).toHaveBeenCalledTimes(1)
    expect(startedSpy).toHaveBeenCalledTimes(1)
  })
})

describe('GateKitButton lifecycle (runtime)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('dispatches loaded on connectedCallback', () => {
    const el = createButton()
    const spy = vi.fn()
    el.addEventListener('loaded', spy)

    el.connectedCallback()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('passes button prefill, product, discount, and tracking params to checkout', () => {
    const el = createButton({
      items: 'tt_1=2',
      products: 'tt_1,tt_2',
      'discount-code': 'PROMO',
      'tracking-id': 'aff_123',
    })

    el.connectedCallback()
    const button = el.shadowRoot?.querySelector('button')
    expect(button).not.toBeNull()
    button!.click()

    const frame = el.shadowRoot?.querySelector('iframe.gk-modal-frame')
    expect(frame).not.toBeNull()
    const url = new URL(frame!.getAttribute('src') ?? '')
    expect(url.searchParams.get('eventId')).toBe('evt_demo')
    expect(url.searchParams.get('brand')).toBe('brand_demo')
    expect(url.searchParams.get('items')).toBe('tt_1=2')
    expect(url.searchParams.get('products')).toBe('tt_1,tt_2')
    expect(url.searchParams.get('discount')).toBe('PROMO')
    expect(url.searchParams.get('tracking')).toBe('aff_123')
  })

  it('dispatches order_completed from trusted checkout postMessage in modal button flows', () => {
    const el = createButton()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('order_completed', spy)
    el.shadowRoot?.querySelector('button')?.click()
    postCheckoutMessage('order_completed', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
      orderId: 'ord_demo',
    })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        event: 'evt_demo',
        eventId: 'evt_demo',
        sessionId: 'cs_demo',
        orderId: 'ord_demo',
      },
    })
  })

  it('ignores button checkout postMessage events for other event IDs', () => {
    const el = createButton({ event: 'evt_button' })

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('order_completed', spy)
    postCheckoutMessage('order_completed', {
      eventId: 'evt_other',
      orderId: 'ord_other',
    })

    expect(spy).not.toHaveBeenCalled()
  })

  it('closes modal button checkouts with a closed lifecycle event', () => {
    const el = createButton()

    el.connectedCallback()
    const spy = vi.fn()
    el.addEventListener('closed', spy)
    el.shadowRoot?.querySelector('button')?.click()
    const close = el.shadowRoot?.querySelector<HTMLButtonElement>('button.gk-modal-close')
    expect(close).not.toBeNull()
    close!.click()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(el.shadowRoot?.querySelector('iframe.gk-modal-frame')).toBeNull()
  })
})
