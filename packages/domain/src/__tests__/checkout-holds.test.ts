import { describe, expect, it } from 'vitest';
import { validateCheckoutHolds } from '../checkout/index.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');

describe('validateCheckoutHolds', () => {
  it('accepts exact aggregated ticket quantities', () => {
    expect(
      validateCheckoutHolds({
        cartItems: [
          { ticketTypeId: 'tt_1', quantity: 1 },
          { ticketTypeId: 'tt_1', quantity: 2 },
          { quantity: 1 },
        ],
        holds: [
          {
            id: 'hld_1',
            ticketTypeId: 'tt_1',
            quantity: 3,
            expiresAt: new Date(NOW.getTime() + 60_000),
          },
        ],
        now: NOW,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects one expired hold even when another required hold remains active', () => {
    expect(
      validateCheckoutHolds({
        cartItems: [
          { ticketTypeId: 'tt_1', quantity: 1 },
          { ticketTypeId: 'tt_2', quantity: 1 },
        ],
        holds: [
          {
            id: 'hld_1',
            ticketTypeId: 'tt_1',
            quantity: 1,
            expiresAt: new Date(NOW.getTime() + 60_000),
          },
          {
            id: 'hld_2',
            ticketTypeId: 'tt_2',
            quantity: 1,
            expiresAt: new Date(NOW.getTime() - 1),
          },
        ],
        now: NOW,
      }),
    ).toEqual({
      ok: false,
      expiredHoldIds: ['hld_2'],
      message: 'Checkout hold hld_2 has expired',
    });
  });

  it('rejects missing, excess, and unexpected hold quantities', () => {
    expect(
      validateCheckoutHolds({
        cartItems: [{ ticketTypeId: 'tt_1', quantity: 2 }],
        holds: [
          {
            id: 'hld_1',
            ticketTypeId: 'tt_1',
            quantity: 1,
            expiresAt: new Date(NOW.getTime() + 60_000),
          },
        ],
        now: NOW,
      }),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('missing an active inventory hold'),
      }),
    );

    expect(
      validateCheckoutHolds({
        cartItems: [],
        holds: [
          {
            id: 'hld_extra',
            ticketTypeId: 'tt_extra',
            quantity: 1,
            expiresAt: new Date(NOW.getTime() + 60_000),
          },
        ],
        now: NOW,
      }),
    ).toEqual(
      expect.objectContaining({ ok: false, message: expect.stringContaining('unexpected') }),
    );
  });
});
