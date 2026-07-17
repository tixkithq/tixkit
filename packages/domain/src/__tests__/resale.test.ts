import { describe, it, expect } from 'vitest';
import {
  assertCurrentResaleTermsAcceptance,
  validateResalePrice,
  transitionListing,
  assertNoActiveListing,
  RESALE_REFUND_MODEL,
  RESALE_SETTLEMENT_MODEL,
  RESALE_TERMS_VERSION,
  ResaleError,
  type TicketListing,
  type ResalePriceCapPolicy,
} from '../ticketing/resale.js';

describe('assertCurrentResaleTermsAcceptance', () => {
  const currentAcceptance = {
    accepted: true,
    termsVersion: RESALE_TERMS_VERSION,
    settlementModel: RESALE_SETTLEMENT_MODEL,
    refundModel: RESALE_REFUND_MODEL,
  } as const;

  it('accepts the exact current organizer-managed settlement contract', () => {
    expect(() => assertCurrentResaleTermsAcceptance(currentAcceptance)).not.toThrow();
  });

  it.each([
    undefined,
    null,
    { ...currentAcceptance, accepted: false },
    { ...currentAcceptance, termsVersion: '2026-07-15' },
    { ...currentAcceptance, settlementModel: 'provider_managed' },
    { ...currentAcceptance, refundModel: 'automatic' },
  ])('fails closed for missing, declined, or stale terms: %j', (acceptance) => {
    expect(() => assertCurrentResaleTermsAcceptance(acceptance)).toThrow(ResaleError);
  });
});

const cap: ResalePriceCapPolicy = { maxMultiplier: 1.2, enabled: true };
const faceValue = 5000; // $50.00

function listed(overrides: Partial<TicketListing> = {}): TicketListing {
  return {
    id: 'lst_1',
    ticketId: 'tkt_1',
    sellerId: 'usr_seller',
    eventId: 'evt_1',
    status: 'listed',
    priceCents: 5500,
    currency: 'USD',
    faceValueCents: faceValue,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

describe('validateResalePrice', () => {
  it('allows prices at or below the multiplier cap', () => {
    expect(() => validateResalePrice(5000, faceValue, cap)).not.toThrow();
    expect(() => validateResalePrice(6000, faceValue, cap)).not.toThrow(); // 1.2 * 5000 = 6000
  });

  it('rejects prices above the multiplier cap', () => {
    expect(() => validateResalePrice(6001, faceValue, cap)).toThrow(ResaleError);
  });

  it('honors an absolute cap when lower than the multiplier cap', () => {
    const withAbsolute: ResalePriceCapPolicy = {
      maxMultiplier: 1.2,
      maxAbsoluteCents: 5500,
      enabled: true,
    };
    expect(() => validateResalePrice(5600, faceValue, withAbsolute)).toThrow(ResaleError);
    expect(() => validateResalePrice(5500, faceValue, withAbsolute)).not.toThrow();
  });

  it('rejects resale when disabled', () => {
    expect(() => validateResalePrice(5000, faceValue, { ...cap, enabled: false })).toThrow(
      ResaleError,
    );
  });

  it('rejects zero and negative prices', () => {
    expect(() => validateResalePrice(0, faceValue, cap)).toThrow(ResaleError);
    expect(() => validateResalePrice(-1, faceValue, cap)).toThrow(ResaleError);
  });
});

describe('transitionListing', () => {
  it('delists a listed listing', () => {
    const result = transitionListing(listed(), { action: 'delist' });
    expect(result.status).toBe('delisted');
  });

  it('marks a listing sold and records the buyer', () => {
    const result = transitionListing(listed(), { action: 'mark_sold', buyerId: 'usr_buyer' });
    expect(result.status).toBe('sold');
    expect(result.soldToId).toBe('usr_buyer');
  });

  it('expires a listed listing', () => {
    expect(transitionListing(listed(), { action: 'expire' }).status).toBe('expired');
  });

  it('re-lists a delisted listing with price validation', () => {
    const delisted = listed({ status: 'delisted' });
    const result = transitionListing(delisted, {
      action: 'list',
      priceCents: 5200,
      faceValueCents: faceValue,
      policy: cap,
    });
    expect(result.status).toBe('listed');
    expect(result.priceCents).toBe(5200);
  });

  it('rejects listing a price above the cap', () => {
    expect(() =>
      transitionListing(listed({ status: 'delisted' }), {
        action: 'list',
        priceCents: 99999,
        faceValueCents: faceValue,
        policy: cap,
      }),
    ).toThrow(ResaleError);
  });

  it('rejects invalid transitions (sold cannot be re-sold)', () => {
    expect(() =>
      transitionListing(listed({ status: 'sold' }), { action: 'mark_sold', buyerId: 'x' }),
    ).toThrow(ResaleError);
    expect(() => transitionListing(listed({ status: 'expired' }), { action: 'delist' })).toThrow(
      ResaleError,
    );
  });
});

describe('assertNoActiveListing', () => {
  it('passes when a ticket has no active listing', () => {
    expect(() => assertNoActiveListing('tkt_1', [listed({ status: 'sold' })])).not.toThrow();
  });

  it('throws when a ticket already has an active (listed) listing (anti-double-sell)', () => {
    expect(() => assertNoActiveListing('tkt_1', [listed()])).toThrow(ResaleError);
  });
});
