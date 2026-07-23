/**
 * Pure confirmation-state derivation logic, extracted so it can be unit-tested
 * in isolation without importing the React component tree.
 *
 * This is the single source of truth for confirmation state derivation;
 * `confirmation-client.tsx` re-exports it.
 */
import type { CheckoutSession } from '@/lib/api';

export type ConfirmationState =
  | 'loading'
  | 'confirmed'
  | 'pending'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'error'
  | 'unknown';

export function deriveState(
  session: CheckoutSession | null,
  redirectStatus: string | null,
): ConfirmationState {
  if (!session) {
    // Redirect query parameters are hints from a browser/provider return, not
    // proof of a payment outcome. Never expose a terminal payment state until
    // the checkout service has supplied an authoritative session.
    return redirectStatus === 'succeeded' ? 'pending' : 'unknown';
  }

  const status = session.status;
  if (status === 'failed') return 'failed';
  if (status === 'expired') return 'expired';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'confirmed';
  // An open or pending session can still settle after a provider redirect
  // reports a failure. The server is authoritative while it remains pending.
  if (status === 'pending_payment') return 'pending';
  if (status === 'open') return 'pending';
  return 'unknown';
}
