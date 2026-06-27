'use client';

import { useState } from 'react';
import {
  TixkitCheckoutButton,
  TixkitProvider,
  TixkitTicketWidget,
  type TixkitCheckoutEventCallback,
} from '@tixkit/next/client';

const checkoutBaseUrl = process.env.NEXT_PUBLIC_TIXKIT_CHECKOUT_URL ?? 'http://localhost:3201';

export function TixkitDemo() {
  const [events, setEvents] = useState<string[]>([]);
  const onEvent: TixkitCheckoutEventCallback = (event, detail) => {
    const mode = typeof detail.mode === 'string' ? `:${detail.mode}` : '';
    setEvents((current) => [...current, `${event}${mode}`]);
  };

  return (
    <TixkitProvider config={{ checkoutBaseUrl }}>
      <main style={{ display: 'grid', gap: 24, margin: '0 auto', maxWidth: 960, padding: 32 }}>
        <section>
          <h1>Tixkit Next SDK Demo</h1>
          <p>External App Router demo for checkout buttons, widgets, lifecycle callbacks, and route handlers.</p>
        </section>

        <section aria-label="Inline checkout button">
          <TixkitCheckoutButton
            eventId="evt_demo_next"
            brand="brd_demo"
            checkoutMode="inline"
            items={[{ ticketTypeId: 'tt_demo_general', quantity: 1 }]}
            trackingId="next-demo"
            onEvent={onEvent}
          >
            Start inline checkout
          </TixkitCheckoutButton>
        </section>

        <section aria-label="Embedded ticket widget">
          <TixkitTicketWidget
            brand="brd_demo"
            event="evt_demo_next"
            checkoutMode="inline"
            trackingId="next-widget-demo"
            onEvent={onEvent}
          />
        </section>

        <output aria-label="Tixkit lifecycle events">{events.join(', ') || 'No events yet'}</output>
      </main>
    </TixkitProvider>
  );
}
