/**
 * Browser-safe entrypoint for @gatekit/sveltekit.
 *
 * This module is safe to import from client-side SvelteKit code.
 * It contains no server-only dependencies.
 *
 * ```ts
 * import { checkoutWidgetUrl, checkoutUrl } from '@gatekit/sveltekit/client';
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
  const base = config.checkoutBaseUrl ?? config.apiBaseUrl ?? 'https://checkout.gatekit.com';
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
  const base = config.widgetBaseUrl ?? config.apiBaseUrl ?? 'https://checkout.gatekit.com';
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
