import { describe, expect, it } from 'vitest';
import type { CheckoutSession } from '../lib/api';
import {
  deriveState,
  type ConfirmationState,
} from '../app/checkout/confirmation/confirmation-state';

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
  };
}

describe('confirmation state derivation', () => {
  it('returns confirmed for completed session status', () => {
    expect(deriveState(makeSession('completed'), null)).toBe('confirmed');
  });

  it('keeps pending_payment pending even when redirect_status=succeeded', () => {
    expect(deriveState(makeSession('pending_payment'), 'succeeded')).toBe('pending');
  });

  it.each([
    ['failed', 'failed'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'returns %s for %s session status even when redirect_status=succeeded',
    (status, expected) => {
      expect(deriveState(makeSession(status), 'succeeded')).toBe(expected);
    },
  );

  it('returns pending for pending_payment status', () => {
    expect(deriveState(makeSession('pending_payment'), null)).toBe('pending');
  });

  it('returns pending for open status (session not yet confirmed)', () => {
    expect(deriveState(makeSession('open'), null)).toBe('pending');
  });

  it('returns expired for expired status', () => {
    expect(deriveState(makeSession('expired'), null)).toBe('expired');
  });

  it('returns cancelled for cancelled status', () => {
    expect(deriveState(makeSession('cancelled'), null)).toBe('cancelled');
  });

  it('returns failed for failed status', () => {
    expect(deriveState(makeSession('failed'), null)).toBe('failed');
  });

  it.each([
    ['confirmed', 'completed'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
    ['failed', 'failed'],
  ] as const)(
    'returns %s when %s session status wins over redirect_status=failed',
    (expected, status) => {
      expect(deriveState(makeSession(status), 'failed')).toBe(expected);
    },
  );

  it('returns failed for redirect_status=failed when the session is absent or non-terminal', () => {
    expect(deriveState(null, 'failed')).toBe('failed');
    expect(deriveState(makeSession('pending_payment'), 'failed')).toBe('failed');
    expect(deriveState(makeSession('open'), 'failed')).toBe('failed');
  });

  it('returns unknown for null session and null redirect status', () => {
    expect(deriveState(null, null)).toBe('unknown');
  });

  it('redirect_status=succeeded does not confirm non-terminal session status', () => {
    expect(deriveState(makeSession('pending_payment'), 'succeeded')).toBe('pending');
    expect(deriveState(makeSession('open'), 'succeeded')).toBe('pending');
    expect(deriveState(null, 'succeeded')).toBe('pending');
  });

  it('treats redirect_status=processing as non-authoritative for terminal outcomes', () => {
    expect(deriveState(makeSession('pending_payment'), 'processing')).toBe('pending');
    expect(deriveState(makeSession('open'), 'processing')).toBe('pending');
    expect(deriveState(makeSession('completed'), 'processing')).toBe('confirmed');
    expect(deriveState(makeSession('failed'), 'processing')).toBe('failed');
    expect(deriveState(makeSession('cancelled'), 'processing')).toBe('cancelled');
    expect(deriveState(null, 'processing')).toBe('unknown');
  });

  it('never lets a client redirect_status invent an order without a completed session', () => {
    for (const redirect of ['succeeded', 'processing', 'failed', null] as const) {
      expect(deriveState(makeSession('pending_payment'), redirect) === 'confirmed').toBe(false);
      expect(deriveState(makeSession('open'), redirect) === 'confirmed').toBe(false);
    }
    expect(deriveState(makeSession('completed'), 'failed')).toBe('confirmed');
  });

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
    ];
    const result = deriveState(makeSession('completed'), null);
    expect(states).toContain(result);
  });
});
