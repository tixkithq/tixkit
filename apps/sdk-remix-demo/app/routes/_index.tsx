import { useState, useEffect } from 'react';
import { useLoaderData } from '@remix-run/react';
import { checkoutUrl, tixkitWidgetIframeAttributes, parseTixkitWidgetMessage } from '@tixkit/remix';
import type { LoaderFunctionArgs } from '@remix-run/node';

export async function loader(_args: LoaderFunctionArgs) {
  return {
    checkoutBaseUrl: process.env.TIXKIT_CHECKOUT_URL ?? 'http://localhost:3201',
  };
}

export default function Index() {
  const [events, setEvents] = useState<string[]>([]);
  const { checkoutBaseUrl } = useLoaderData<typeof loader>();

  const widgetAttrs = tixkitWidgetIframeAttributes({
    widgetBaseUrl: checkoutBaseUrl,
    brand: 'brd_demo',
    event: 'evt_demo',
    mode: 'inline',
    title: 'Tixkit Ticket Widget',
  });

  const handoffUrl = checkoutUrl({
    event: 'evt_demo',
    brand: 'brd_demo',
    items: [{ ticketTypeId: 'tt_demo_general', quantity: 2 }],
    checkoutBaseUrl,
  });

  useEffect(() => {
    const origin = new URL(checkoutBaseUrl).origin;
    const handler = (message: MessageEvent) => {
      const parsed = parseTixkitWidgetMessage(message, origin);
      if (parsed) {
        setEvents((prev) => [...prev, parsed.type]);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [checkoutBaseUrl]);

  return (
    <main
      style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '0 auto', padding: 32 }}
    >
      <h1>Tixkit Remix Demo</h1>
      <p>
        Demonstrates the @tixkit/remix SDK: widget iframe, checkout handoff, and lifecycle events.
      </p>

      <section style={{ marginTop: 24 }}>
        <h2>Inline Widget</h2>
        <iframe
          id="tixkit-widget-demo"
          src={widgetAttrs.src}
          title={widgetAttrs.title}
          sandbox={widgetAttrs.sandbox}
          allow={widgetAttrs.allow}
          referrerPolicy={widgetAttrs.referrerPolicy as ReferrerPolicy}
          style={{ width: '100%', height: 560, border: 0 }}
        />
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Checkout Handoff URL</h2>
        <code data-testid="checkout-handoff-url">{handoffUrl}</code>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Lifecycle Events</h2>
        <output aria-label="Tixkit lifecycle events">{events.join(', ') || 'No events yet'}</output>
      </section>
    </main>
  );
}
