/**
 * Browser-safe entrypoint for @tixkit/remix.
 *
 * This module is safe to import from client-side Remix code.
 * It contains no server-only dependencies.
 *
 * ```ts
 * import { checkoutWidgetUrl, checkoutUrl } from '@tixkit/remix/client';
 * ```
 */

/**
 * Build a hosted checkout URL with full widget/checkout contract params.
 * Use this for redirect-mode checkout or constructing iframe src URLs.
 */
export const checkoutUrl = (config: {
  checkoutBaseUrl?: string;
  apiBaseUrl?: string;
  event: string;
  brand?: string;
  items?: { ticketTypeId: string; quantity: number }[];
  products?: string[];
  discountCode?: string;
  trackingId?: string;
  mode?: 'inline' | 'modal' | 'redirect';
  locale?: string;
  theme?: string;
}) => {
  const base = config.checkoutBaseUrl ?? config.apiBaseUrl ?? 'https://checkout.tixkit.com';
  const params = new URLSearchParams();
  params.set('eventId', config.event);
  if (config.brand) params.set('brand', config.brand);
  if (config.items?.length) {
    params.set('items', config.items.map((i) => `${i.ticketTypeId}=${i.quantity}`).join(','));
  }
  if (config.products?.length) params.set('products', config.products.join(','));
  if (config.discountCode) params.set('discount', config.discountCode);
  if (config.trackingId) params.set('tracking', config.trackingId);
  if (config.mode) params.set('mode', config.mode);
  if (config.locale) params.set('locale', config.locale);
  if (config.theme) params.set('theme', config.theme);
  return `${base}/checkout?${params.toString()}`;
};

/**
 * Build a widget embed URL for iframe embedding.
 * Includes full widget/checkout contract params.
 */
export const checkoutWidgetUrl = (config: {
  widgetBaseUrl?: string;
  apiBaseUrl?: string;
  brand: string;
  event: string;
  locale?: string;
  theme?: string;
  products?: string[];
  discountCode?: string;
  trackingId?: string;
  mode?: 'inline' | 'modal' | 'redirect';
}) => {
  const base = config.widgetBaseUrl ?? config.apiBaseUrl ?? 'https://checkout.tixkit.com';
  const params = new URLSearchParams();
  if (config.brand) params.set('brand', config.brand);
  if (config.locale) params.set('locale', config.locale);
  if (config.theme) params.set('theme', config.theme);
  if (config.products?.length) params.set('products', config.products.join(','));
  if (config.discountCode) params.set('discount', config.discountCode);
  if (config.trackingId) params.set('tracking', config.trackingId);
  if (config.mode) params.set('mode', config.mode);
  return `${base}/checkout?eventId=${encodeURIComponent(config.event)}&${params.toString()}`;
};

/**
 * Lifecycle events emitted by Tixkit checkout widgets and buttons.
 */
export type TixkitCheckoutEvent =
  | 'loaded'
  | 'loading'
  | 'error'
  | 'opened'
  | 'closed'
  | 'checkout_started'
  | 'order_completed';

export type TixkitWidgetPostMessage = {
  type: TixkitCheckoutEvent;
  eventId?: string;
  orderId?: string;
  raw: Record<string, unknown>;
};

export type TixkitWidgetIframeConfig = Parameters<typeof checkoutWidgetUrl>[0] & {
  title?: string;
};

export type TixkitWidgetIframeAttributes = {
  src: string;
  title: string;
  sandbox: string;
  allow: string;
  referrerPolicy: string;
};

const CHECKOUT_EVENTS = new Set<TixkitCheckoutEvent>([
  'loaded',
  'loading',
  'error',
  'opened',
  'closed',
  'checkout_started',
  'order_completed',
]);

export function isTixkitCheckoutEvent(value: unknown): value is TixkitCheckoutEvent {
  return typeof value === 'string' && CHECKOUT_EVENTS.has(value as TixkitCheckoutEvent);
}

export function tixkitWidgetIframeAttributes(
  config: TixkitWidgetIframeConfig,
): TixkitWidgetIframeAttributes {
  return {
    src: checkoutWidgetUrl(config),
    title: config.title ?? 'Tixkit checkout',
    sandbox:
      'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin',
    allow: 'payment *',
    referrerPolicy: 'strict-origin-when-cross-origin',
  };
}

export function parseTixkitWidgetMessage(
  message: { origin: string; data: unknown },
  expectedOrigin?: string,
): TixkitWidgetPostMessage | null {
  if (expectedOrigin && message.origin !== expectedOrigin) return null;
  if (!message.data || typeof message.data !== 'object') return null;

  const raw = message.data as Record<string, unknown>;
  const type = raw.type ?? raw.event;
  if (!isTixkitCheckoutEvent(type)) return null;

  return {
    type,
    eventId: typeof raw.eventId === 'string' ? raw.eventId : undefined,
    orderId: typeof raw.orderId === 'string' ? raw.orderId : undefined,
    raw,
  };
}
