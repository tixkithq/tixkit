import { describe, expect, it } from 'vitest'
import type { CheckoutSession } from '../lib/api'
import {
  deriveState,
  type ConfirmationState,
} from '../app/checkout/confirmation/confirmation-state'

function makeSession(status: string): CheckoutSession {
  return {
    id: 'cs_test',
    eventId: 'evt_test',
    status,
    currency: 'USD',
    quote: {
      totalCents: 1000,
      subtotalCents: 1000,
      discountCents: 0,
      feeCents: 0,
      taxCents: 0,
    },
    expiresAt: new Date().toISOString(),
  }
}

describe('confirmation state derivation', () => {
  it('returns confirmed for completed session status', () => {
    expect(deriveState(makeSession('completed'), null)).toBe('confirmed')
  })

  it('returns confirmed for redirect_status=succeeded', () => {
    expect(deriveState(makeSession('pending_payment'), 'succeeded')).toBe(
      'confirmed',
    )
  })

  it('returns pending for pending_payment status', () => {
    expect(deriveState(makeSession('pending_payment'), null)).toBe('pending')
  })

  it('returns pending for open status (session not yet confirmed)', () => {
    expect(deriveState(makeSession('open'), null)).toBe('pending')
  })

  it('returns expired for expired status', () => {
    expect(deriveState(makeSession('expired'), null)).toBe('expired')
  })

  it('returns cancelled for cancelled status', () => {
    expect(deriveState(makeSession('cancelled'), null)).toBe('cancelled')
  })

  it('returns failed for failed status', () => {
    expect(deriveState(makeSession('failed'), null)).toBe('failed')
  })

  it('returns failed for redirect_status=failed regardless of session status', () => {
    expect(deriveState(makeSession('completed'), 'failed')).toBe('failed')
    expect(deriveState(null, 'failed')).toBe('failed')
  })

  it('returns unknown for null session and null redirect status', () => {
    expect(deriveState(null, null)).toBe('unknown')
  })

  it('redirect_status=succeeded overrides session status', () => {
    expect(deriveState(makeSession('pending_payment'), 'succeeded')).toBe(
      'confirmed',
    )
  })

  it('returns a valid ConfirmationState for every input', () => {
    const states: ConfirmationState[] = [
      'loading',
      'confirmed',
      'pending',
      'expired',
      'cancelled',
      'failed',
      'error',
      'unknown',
    ]
    const result = deriveState(makeSession('completed'), null)
    expect(states).toContain(result)
  })
})
