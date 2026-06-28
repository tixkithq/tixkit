/**
 * Root entrypoint for @tixkit/vue.
 *
 * This root entry is browser-safe and only re-exports client helpers.
 * Server-only helpers (which use Node.js crypto APIs) must be imported
 * explicitly from the dedicated subpath entries:
 *
 * - `@tixkit/vue/server` for server-only helpers (verifyTixkitWebhook, etc.)
 * - `@tixkit/vue/client` for browser-safe helpers (checkoutWidgetUrl, etc.)
 * - `@tixkit/vue` (this entry) for browser-safe helpers only
 *
 * Importing from the root in browser code will NOT pull in server-only modules.
 */
export {
  checkoutWidgetUrl,
  checkoutUrl,
  tixkitWidgetIframeAttributes,
  isTixkitCheckoutEvent,
  parseTixkitWidgetMessage,
} from './client.js';
export type {
  TixkitCheckoutEvent,
  TixkitWidgetIframeAttributes,
  TixkitWidgetIframeConfig,
  TixkitWidgetPostMessage,
} from './client.js';
