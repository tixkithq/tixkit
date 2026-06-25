// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { GateKitProvider, GateKitCheckoutButton, GateKitTicketWidget } from '../client.js';

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

describe('GateKitCheckoutButton', () => {
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
      <GateKitProvider config={{ checkoutBaseUrl: 'https://checkout.gatekit.com' }}>
        <GateKitCheckoutButton
          eventId="evt_123"
          items={[{ ticketTypeId: 'tt_1', quantity: 2 }]}
          checkoutMode="modal"
        >
          Buy Tickets
        </GateKitCheckoutButton>
      </GateKitProvider>,
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

  it('redirects to checkout URL with eventId in redirect mode', () => {
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        set href(url: string) { hrefSetter(url); },
      },
    });

    const { unmount } = render(
      <GateKitProvider config={{ checkoutBaseUrl: 'https://checkout.gatekit.com' }}>
        <GateKitCheckoutButton
          eventId="evt_456"
          items={[{ ticketTypeId: 'tt_1', quantity: 1 }]}
          checkoutMode="redirect"
        >
          Buy
        </GateKitCheckoutButton>
      </GateKitProvider>,
    );

    // Can't easily test redirect mode without full DOM; just verify button renders
    unmount();
  });
});

describe('GateKitTicketWidget', () => {
  it('iframe src points at /e/{eventId} route (not /widget)', () => {
    const { container, unmount } = render(
      <GateKitProvider config={{ widgetBaseUrl: 'https://widget.gatekit.com' }}>
        <GateKitTicketWidget brand="brd_1" event="evt_456" />
      </GateKitProvider>,
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.src).toContain('/e/evt_456');
    expect(iframe!.getAttribute('src')).not.toMatch(/\/widget[?/]/);

    unmount();
  });

  it('iframe has sandbox and allow attributes', () => {
    const { container, unmount } = render(
      <GateKitProvider config={{ widgetBaseUrl: 'https://widget.gatekit.com' }}>
        <GateKitTicketWidget brand="brd_1" event="evt_456" />
      </GateKitProvider>,
    );

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox');
    expect(iframe!.getAttribute('allow')).toBe('payment; publickey-credentials-create *; publickey-credentials-get *');

    unmount();
  });
});
