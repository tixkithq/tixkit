import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

type GateKitClientConfig = {
  apiBaseUrl?: string;
  checkoutBaseUrl?: string;
  widgetBaseUrl?: string;
};

const GateKitContext = createContext<GateKitClientConfig | null>(null);

export function GateKitProvider({ children, config }: { children: ReactNode; config: GateKitClientConfig }) {
  return <GateKitContext.Provider value={config}>{children}</GateKitContext.Provider>;
}

export function useGateKit(): GateKitClientConfig {
  const ctx = useContext(GateKitContext);
  if (!ctx) throw new Error('useGateKit must be used within GateKitProvider');
  return ctx;
}

/**
 * Lifecycle events emitted by GateKit checkout widgets and buttons.
 */
export type GateKitCheckoutEvent =
  | 'loaded'
  | 'loading'
  | 'error'
  | 'opened'
  | 'closed'
  | 'checkout_started'
  | 'order_completed';

export type GateKitCheckoutEventCallback = (
  event: GateKitCheckoutEvent,
  detail: Record<string, unknown>,
) => void;

/** Derive the expected origin for postMessage validation from a base URL. */
function expectedOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '';
  }
}

function buildCheckoutUrl(
  base: string,
  params: {
    eventId: string;
    brand?: string;
    items?: { ticketTypeId: string; quantity: number }[];
    products?: string[];
    discountCode?: string;
    trackingId?: string;
    mode?: string;
  },
): string {
  const search = new URLSearchParams();
  search.set('eventId', params.eventId);
  if (params.brand) search.set('brand', params.brand);
  if (params.items?.length) {
    search.set('items', params.items.map((i) => `${i.ticketTypeId}=${i.quantity}`).join(','));
  }
  if (params.products?.length) search.set('products', params.products.join(','));
  if (params.discountCode) search.set('discount', params.discountCode);
  if (params.trackingId) search.set('tracking', params.trackingId);
  if (params.mode) search.set('mode', params.mode);
  return `${base}/checkout?${search.toString()}`;
}

export function GateKitCheckoutButton({
  eventId,
  items,
  brand,
  products,
  discountCode,
  trackingId,
  checkoutMode = 'redirect',
  onEvent,
  children,
}: {
  eventId: string;
  items: { ticketTypeId: string; quantity: number }[];
  brand?: string;
  products?: string[];
  discountCode?: string;
  trackingId?: string;
  checkoutMode?: 'inline' | 'modal' | 'redirect';
  onEvent?: GateKitCheckoutEventCallback;
  children: ReactNode;
}) {
  const config = useGateKit();
  const modalRef = useRef<Window | null>(null);
  const [inlineOpen, setInlineOpen] = useState(false);
  const base = config.checkoutBaseUrl ?? 'https://checkout.gatekit.com';
  const origin = expectedOrigin(base);

  useEffect(() => {
    if (!onEvent) return;
    const callback = onEvent;
    function handler(e: MessageEvent) {
      // Validate origin to prevent untrusted frames from triggering events.
      if (origin && e.origin !== origin) return;
      if (e.data?.source !== 'gatekit-checkout') return;
      // Match eventId to ensure the message is for this checkout instance.
      if (e.data?.eventId && e.data.eventId !== eventId) return;
      const evt = e.data.event as GateKitCheckoutEvent;
      if (evt) callback(evt, e.data);
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onEvent, origin, eventId]);

  const handleClick = () => {
    const checkoutUrl = buildCheckoutUrl(base, {
      eventId, items, brand, products, discountCode, trackingId, mode: checkoutMode,
    });
    if (checkoutMode === 'modal') {
      modalRef.current = window.open(checkoutUrl, 'gatekit-checkout', 'width=600,height=700');
      if (onEvent) onEvent('opened', { mode: 'modal' });
    } else if (checkoutMode === 'inline') {
      setInlineOpen(true);
      if (onEvent) onEvent('opened', { mode: 'inline' });
    } else {
      window.location.href = checkoutUrl;
    }
  };

  if (checkoutMode === 'inline' && inlineOpen) {
    return (
      <div style={{ position: 'relative', width: '100%', minHeight: '600px' }}>
        <iframe
          src={buildCheckoutUrl(base, { eventId, items, brand, products, discountCode, trackingId, mode: 'inline' })}
          style={{ border: 'none', width: '100%', minHeight: '600px' }}
          title="GateKit Checkout"
          loading="lazy"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow="payment; publickey-credentials-create *; publickey-credentials-get *"
        />
        <button
          onClick={() => { setInlineOpen(false); if (onEvent) onEvent('closed', {}); }}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
          aria-label="Close checkout"
        >
          ✕
        </button>
      </div>
    );
  }

  return <button onClick={handleClick}>{children}</button>;
}

export function GateKitTicketWidget({
  brand,
  event: eventId,
  locale = 'en-US',
  theme = 'auto',
  products,
  discountCode,
  trackingId,
  checkoutMode = 'inline',
  onEvent,
}: {
  brand: string;
  event: string;
  locale?: string;
  theme?: string;
  products?: string[];
  discountCode?: string;
  trackingId?: string;
  checkoutMode?: 'inline' | 'modal' | 'redirect';
  onEvent?: GateKitCheckoutEventCallback;
}) {
  const config = useGateKit();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const base = config.checkoutBaseUrl ?? config.widgetBaseUrl ?? 'https://checkout.gatekit.com';
  const origin = expectedOrigin(base);

  useEffect(() => {
    if (!onEvent) return;
    const callback = onEvent;
    function handler(e: MessageEvent) {
      // Validate origin to prevent untrusted frames from triggering events.
      if (origin && e.origin !== origin) return;
      if (e.data?.source !== 'gatekit-checkout') return;
      // Match eventId to ensure the message is for this widget instance.
      if (e.data?.eventId && e.data.eventId !== eventId) return;
      const evt = e.data.event as GateKitCheckoutEvent;
      if (evt) callback(evt, e.data);
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onEvent, origin, eventId]);

  const params = new URLSearchParams();
  if (brand) params.set('brand', brand);
  if (locale) params.set('locale', locale);
  if (theme) params.set('theme', theme);
  if (products?.length) params.set('products', products.join(','));
  if (discountCode) params.set('discount', discountCode);
  if (trackingId) params.set('tracking', trackingId);
  if (checkoutMode) params.set('mode', checkoutMode);
  const widgetUrl = `${base}/checkout?eventId=${encodeURIComponent(eventId)}&${params.toString()}`;

  return (
    <iframe
      ref={iframeRef}
      src={widgetUrl}
      style={{ border: 'none', width: '100%', minHeight: '400px' }}
      title="GateKit Ticket Widget"
      loading="lazy"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      allow="payment; publickey-credentials-create *; publickey-credentials-get *"
    />
  );
}
