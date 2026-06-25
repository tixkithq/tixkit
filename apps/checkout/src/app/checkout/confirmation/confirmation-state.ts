/**
 * Pure confirmation-state derivation logic, extracted so it can be unit-tested
 * in isolation without importing the React component tree.
 *
 * This is the single source of truth for confirmation state derivation;
 * `confirmation-client.tsx` re-exports it.
 */
import type { CheckoutSession } from '@/lib/api'

export type ConfirmationState =
  | 'loading'
  | 'confirmed'
  | 'pending'
  | 'expired'
  | 'cancelled'
  | 'failed'
  | 'error'
  | 'unknown'

export function deriveState(
  session: CheckoutSession | null,
  redirectStatus: string | null,
): ConfirmationState {
  if (redirectStatus === 'failed') return 'failed'
  if (redirectStatus === 'succeeded') return 'confirmed'
  if (!session) return 'unknown'
  const status = session.status
  if (status === 'completed') return 'confirmed'
  if (status === 'pending_payment') return 'pending'
  if (status === 'expired') return 'expired'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'failed') return 'failed'
  // Paid orders have session status "completed" but the order status may be "paid".
  if (status === 'open') return 'pending'
  return 'unknown'
}
