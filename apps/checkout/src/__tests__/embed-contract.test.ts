import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostHelloMessage } from '@tixkit/embed-core';
import { emitEmbedLifecycle, initializeEmbedHandshake } from '@/lib/embed-contract';

describe('checkout Embed Contract v1 peer', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
    window.sessionStorage.clear();
    Object.defineProperty(window, 'opener', { configurable: true, value: null });
    Object.defineProperty(document, 'referrer', { configurable: true, value: '' });
  });

  it('fails closed until an exact handshake and posts no buyer PII', () => {
    window.history.replaceState(
      {},
      '',
      '/checkout?eventId=evt_demo&embedContractVersion=1.0&embedWidgetId=tkw_demo&embedNonce=0123456789012345678901&embedHostOrigin=https%3A%2F%2Fmerchant.example.test',
    );
    const postMessage = vi.fn();
    const opener = { postMessage } as unknown as Window;
    Object.defineProperty(window, 'opener', { configurable: true, value: opener });
    const cleanup = initializeEmbedHandshake();
    const hello = createHostHelloMessage({
      widgetId: 'tkw_demo',
      eventId: 'evt_demo',
      nonce: '0123456789012345678901',
      hostOrigin: 'https://merchant.example.test',
    });

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://merchant.example.test',
        source: opener,
        data: { ...hello, contractVersion: '2.0' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://evil.example.test',
        source: opener,
        data: hello,
      }),
    );
    emitEmbedLifecycle('checkout-started', {
      eventId: 'evt_demo',
      sessionId: 'cs_before_handshake',
    });
    expect(postMessage).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://merchant.example.test',
        source: opener,
        data: hello,
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contractVersion: '1.0',
        type: 'checkout:ready',
        widgetId: 'tkw_demo',
      }),
      'https://merchant.example.test',
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contractVersion: '1.0',
        type: 'checkout:close-requested',
        widgetId: 'tkw_demo',
      }),
      'https://merchant.example.test',
    );

    emitEmbedLifecycle('checkout-session-created', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'checkout:lifecycle',
        lifecycle: 'checkout-session-created',
        sessionId: 'cs_demo',
      }),
      'https://merchant.example.test',
    );

    emitEmbedLifecycle('order-completed', {
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
      orderId: 'ord_demo',
      buyerEmail: 'buyer@example.test',
      buyerName: 'Private Buyer',
    });

    const payloads = postMessage.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    const lifecycle = payloads.find((payload) => payload.lifecycle === 'order-completed');
    expect(lifecycle).toMatchObject({
      contractVersion: '1.0',
      lifecycle: 'order-completed',
      eventId: 'evt_demo',
      sessionId: 'cs_demo',
      orderId: 'ord_demo',
    });
    expect(lifecycle).not.toHaveProperty('buyerEmail');
    expect(lifecycle).not.toHaveProperty('buyerName');
    for (const [, targetOrigin] of postMessage.mock.calls) {
      expect(targetOrigin).toBe('https://merchant.example.test');
    }
    cleanup();
  });
});
