/**
 * Session token storage boundary.
 *
 * The checkout session bearer token (clientToken) must NEVER appear in URLs,
 * browser history, or third-party return URLs. It lives only in:
 *   1. React state (in-memory)
 *   2. The `X-Checkout-Session-Token` HTTP header
 *   3. sessionStorage (as a resume mechanism keyed by sessionId)
 *
 * This module provides the sessionStorage resume mechanism so the confirmation
 * page can resolve a session after a Stripe redirect without the token in the URL.
 */

const STORAGE_PREFIX = 'tk:session:';

export function storeSessionToken(sessionId: string, token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + sessionId, token);
  } catch {
    // sessionStorage may be unavailable in private browsing; fail silently.
  }
}

export function getSessionToken(sessionId: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const token = window.sessionStorage.getItem(STORAGE_PREFIX + sessionId);
    return token ?? undefined;
  } catch {
    return undefined;
  }
}

export function clearSessionToken(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_PREFIX + sessionId);
  } catch {
    // ignore
  }
}
