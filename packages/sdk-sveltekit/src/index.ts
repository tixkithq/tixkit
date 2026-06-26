/**
 * Root entrypoint for @gatekit/sveltekit.
 *
 * This root entry is browser-safe and only re-exports client helpers.
 * Server-only helpers (which use Node.js crypto APIs) must be imported
 * explicitly from the dedicated subpath entries:
 *
 * - `@gatekit/sveltekit/server` for server-only helpers (verifyGateKitWebhook, etc.)
 * - `@gatekit/sveltekit/client` for browser-safe helpers (checkoutWidgetUrl, etc.)
 * - `@gatekit/sveltekit` (this entry) for browser-safe helpers only
 *
 * Importing from the root in browser code will NOT pull in server-only modules.
 */
export { checkoutWidgetUrl, checkoutUrl } from './client.js';
export type { GateKitCheckoutEvent } from './client.js';
