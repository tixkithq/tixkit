import { describe, expect, it } from 'vitest';
import { resolveCheckoutSessionAuthority } from '../routes/modules/checkout.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function resolve(input: {
  status?: string;
  orderId?: string | null;
  expiresAt?: Date;
  cartItems?: Array<{ ticketTypeId?: string; quantity: number }>;
  holds?: Array<{ id: string; ticketTypeId?: string; quantity?: number; expiresAt: Date }>;
  paymentIntents?: Array<{ orderId?: string | null; status: string }>;
}) {
  return resolveCheckoutSessionAuthority({
    session: {
      status: input.status ?? 'open',
      order_id: input.orderId ?? null,
      expires_at: input.expiresAt ?? new Date(NOW.getTime() + 60_000),
    },
    cartItems: input.cartItems ?? [{ ticketTypeId: 'tt_1', quantity: 1 }],
    activeHolds: (input.holds ?? []).map((hold) => ({
      id: hold.id,
      ticketTypeId: hold.ticketTypeId ?? 'tt_1',
      quantity: hold.quantity ?? 1,
      expires_at: hold.expiresAt,
    })),
    paymentIntents: (input.paymentIntents ?? []).map((paymentIntent) => ({
      order_id: paymentIntent.orderId ?? null,
      status: paymentIntent.status,
    })),
    now: NOW,
  });
}

describe('checkout session authority', () => {
  it('expires a session whose timestamp elapsed and releases any active holds', () => {
    expect(
      resolve({
        expiresAt: new Date(NOW.getTime() - 1),
        holds: [{ id: 'hld_active', expiresAt: new Date(NOW.getTime() + 60_000) }],
      }),
    ).toEqual({ shouldExpire: true, expiredHoldIds: [], releaseActiveHolds: true });
  });

  it('expires a reserving session with only expired holds and marks those holds expired', () => {
    expect(
      resolve({
        holds: [{ id: 'hld_expired', expiresAt: new Date(NOW.getTime() - 1) }],
      }),
    ).toEqual({
      shouldExpire: true,
      expiredHoldIds: ['hld_expired'],
      releaseActiveHolds: true,
    });
  });

  it('expires a reserving session when its active holds are missing', () => {
    expect(resolve({ holds: [] })).toEqual({
      shouldExpire: true,
      expiredHoldIds: [],
      releaseActiveHolds: true,
    });
  });

  it('keeps a session payable while it has an active unexpired hold', () => {
    expect(
      resolve({
        holds: [{ id: 'hld_active', expiresAt: new Date(NOW.getTime() + 1) }],
      }),
    ).toEqual({ shouldExpire: false, expiredHoldIds: [], releaseActiveHolds: false });
  });

  it('expires a multi-ticket session when one required hold expired', () => {
    expect(
      resolve({
        cartItems: [
          { ticketTypeId: 'tt_1', quantity: 1 },
          { ticketTypeId: 'tt_vip', quantity: 1 },
        ],
        holds: [
          { id: 'hld_1', ticketTypeId: 'tt_1', expiresAt: new Date(NOW.getTime() + 60_000) },
          { id: 'hld_vip', ticketTypeId: 'tt_vip', expiresAt: new Date(NOW.getTime() - 1) },
        ],
      }),
    ).toEqual({ shouldExpire: true, expiredHoldIds: ['hld_vip'], releaseActiveHolds: true });
  });

  it('expires a multi-ticket session when one required hold is missing', () => {
    expect(
      resolve({
        cartItems: [
          { ticketTypeId: 'tt_1', quantity: 1 },
          { ticketTypeId: 'tt_vip', quantity: 1 },
        ],
        holds: [{ id: 'hld_1', ticketTypeId: 'tt_1', expiresAt: new Date(NOW.getTime() + 60_000) }],
      }),
    ).toEqual({ shouldExpire: true, expiredHoldIds: [], releaseActiveHolds: true });
  });

  it('never expires a completed session', () => {
    expect(
      resolve({
        status: 'completed',
        orderId: 'ord_1',
        expiresAt: new Date(NOW.getTime() - 1),
      }),
    ).toEqual({ shouldExpire: false, expiredHoldIds: [], releaseActiveHolds: false });
  });

  it('does not race a succeeded payment finalization after holds were converted', () => {
    expect(
      resolve({
        status: 'pending_payment',
        holds: [],
        paymentIntents: [{ status: 'succeeded' }],
      }),
    ).toEqual({ shouldExpire: false, expiredHoldIds: [], releaseActiveHolds: false });
  });

  it('does not expire an authorized payment awaiting server-side capture', () => {
    expect(
      resolve({
        status: 'pending_payment',
        expiresAt: new Date(NOW.getTime() - 1),
        holds: [],
        paymentIntents: [{ status: 'requires_capture' }],
      }),
    ).toEqual({ shouldExpire: false, expiredHoldIds: [], releaseActiveHolds: false });
  });
});
