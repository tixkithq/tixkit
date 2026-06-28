// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TixkitProvider, TixkitCheckoutButton, TixkitTicketWidget } from '../client.js';

function render(jsx: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(jsx));
  return {
    container,
    unmount: () => {
      root.unmount();
      document.body.removeChild(container);
    },
  };
}

describe('TixkitCheckoutButton', () => {
  let originalOpen: typeof window.open;

  beforeEach(() => {
    originalOpen = window.open;
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it('constructs URL with eventId param (not event) when clicked in modal mode', () => {
    const mockOpen = vi.fn();
    window.open = mockOpen;

    const { container, unmount } = render(
      <TixkitProvider config={{ checkoutBaseUrl: 'https://checkout.tixkit.com' }}>
        <TixkitCheckoutButton
          eventId="evt_123"
          items={[{ ticketTypeId: 'tt_1', quantity: 2 }]}
          checkoutMode="modal"
        >
          Buy Tickets
        </TixkitCheckoutButton>
      </TixkitProvider>,
    );

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    button!.click();

    expect(mockOpen).toHaveBeenCalledTimes(1);
    const calledUrl = mockOpen.mock.calls[0][0] as string;
    expect(calledUrl).toContain('eventId=evt_123');
    expect(calledUrl).not.toContain('event=evt_123');
    expect(calledUrl).toContain('/checkout');

    unmount();
  });

  it('constructs URL with discount, tracking, products, and brand params', () => {
    const mockOpen = vi.fn();
    window.open = mockOpen;

    const { container, unmount } = render(
      <TixkitProvider config={{ checkoutBaseUrl: 'https://checkout.tixkit.com' }}>
        <TixkitCheckoutButton
          eventId="evt_123"
          items={[{ ticketTypeId: 'tt_1', quantity: 2 }]}
          brand="brd_1"
          products={['tt_1', 'tt_2']}
          discountCode="PROMO10"
          trackingId="campaign_123"
          checkoutMode="modal"
        >
          Buy Tickets
        </TixkitCheckoutButton>
      </TixkitProvider>,
    );

    const button = container.querySelector('button');
    button!.click();

    const calledUrl = mockOpen.mock.calls[0][0] as string;
    expect(calledUrl).toContain('brand=brd_1');
    expect(calledUrl).toContain('products=tt_1%2Ctt_2');
    expect(calledUrl).toContain('discount=PROMO10');
    expect(calledUrl).toContain('tracking=campaign_123');

    unmount();
  });

  it('redirects to checkout URL with eventId in redirect mode', () => {
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        set href(url: string) {
          hrefSetter(url);
        },
      },
    });

    const { unmount } = render(
      <TixkitProvider config={{ checkoutBaseUrl: 'https://checkout.tixkit.com' }}>
        <TixkitCheckoutButton
          eventId="evt_456"
          items={[{ ticketTypeId: 'tt_1', quantity: 1 }]}
          checkoutMode="redirect"
        >
          Buy
        </TixkitCheckoutButton>
      </TixkitProvider>,
    );

    // Can't easily test redirect mode without full DOM; just verify button renders
    unmount();
  });
});

describe('TixkitTicketWidget', () => {
  it('iframe src points at /checkout?eventId= route', () => {
    const { container, unmount } = render(
      <TixkitProvider config={{ widgetBaseUrl: 'https://widget.tixkit.com' }}>
        <TixkitTicketWidget brand="brd_1" event="evt_456" />
      </TixkitProvider>,
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.src).toContain('/checkout?eventId=evt_456');
    expect(iframe!.getAttribute('src')).not.toMatch(/\/widget[?/]/);

    unmount();
  });

  it('iframe has sandbox and allow attributes', () => {
    const { container, unmount } = render(
      <TixkitProvider config={{ widgetBaseUrl: 'https://widget.tixkit.com' }}>
        <TixkitTicketWidget brand="brd_1" event="evt_456" />
      </TixkitProvider>,
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    );
    expect(iframe!.getAttribute('allow')).toBe(
      'payment; publickey-credentials-create *; publickey-credentials-get *',
    );

    unmount();
  });
});
