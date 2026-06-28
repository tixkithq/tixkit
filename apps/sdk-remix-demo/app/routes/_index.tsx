import { useState, useEffect } from 'react';
import { checkoutUrl } from '@tixkit/remix';

export default function Index() {
  const [events, setEvents] = useState<string[]>([]);

  const handoffUrl = checkoutUrl({
    event: 'evt_demo',
    brand: 'brd_demo',
    items: [{ ticketTypeId: 'tt_demo_general', quantity: 2 }],
    checkoutBaseUrl: 'http://localhost:3000',
  });

  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'http://localhost:3000/tixkit-widget.js';
    document.head.appendChild(script);

    const widget = document.getElementById('tixkit-widget-demo');
    const button = document.getElementById('tixkit-button-demo');

    for (const el of [widget, button]) {
      if (!el) continue;
      for (const name of ['loaded', 'opened', 'closed', 'checkout_started', 'order_completed', 'error']) {
        el.addEventListener(name, () => {
          setEvents((prev) => [...prev, name]);
        });
      }
    }
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '0 auto', padding: 32 }}>
      <h1>Tixkit Remix Demo</h1>
      <p>Demonstrates the @tixkit/remix SDK: widget, checkout handoff, and lifecycle events.</p>

      <section style={{ marginTop: 24 }}>
        <h2>Inline Widget</h2>
        <tixkit-widget
          id="tixkit-widget-demo"
          brand="brd_demo"
          event="evt_demo"
          checkout-mode="inline"
          api-base-url="http://localhost:3000"
        ></tixkit-widget>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Checkout Button</h2>
        <tixkit-button
          id="tixkit-button-demo"
          brand="brd_demo"
          event="evt_demo"
          checkout-mode="modal"
          items="tt_demo_general=2"
          api-base-url="http://localhost:3000"
        >
          Buy tickets
        </tixkit-button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Checkout Handoff URL</h2>
        <code>{handoffUrl}</code>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Lifecycle Events</h2>
        <output>{events.join(', ') || 'No events yet'}</output>
      </section>
    </div>
  );
}
