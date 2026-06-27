import { describe, it, expect } from 'vitest';
import { validateTicketPurchase, type PurchasableTicketType, type AccessRuleRecord } from '../ticketing/index.js';
import { ValidationError, AccessCodeRequiredError } from '../errors/index.js';

function makeTicketType(overrides: Partial<PurchasableTicketType> = {}): PurchasableTicketType {
  return {
    id: 'tt_1',
    kind: 'paid',
    status: 'active',
    visibility: 'public',
    priceCents: 10000,
    minPerOrder: 1,
    maxPerOrder: 5,
    requiresAccessCode: false,
    ...overrides,
  };
}

const fixedNow = new Date('2026-06-15T12:00:00Z');

describe('validateTicketPurchase', () => {
  it('accepts a valid paid ticket purchase', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType(),
        quantity: 3,
        now: fixedNow,
      }),
    ).not.toThrow();
  });

  it('accepts a free ticket purchase', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ kind: 'free', priceCents: 0 }),
        quantity: 2,
        now: fixedNow,
      }),
    ).not.toThrow();
  });

  it('rejects client supplied amounts for paid tickets', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType(),
        quantity: 1,
        unitAmountCents: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects draft status', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ status: 'draft' }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects paused status', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ status: 'paused' }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects ended status', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ status: 'ended' }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects purchase before sales start', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ salesStartAt: '2026-07-01T00:00:00Z' }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects purchase after sales end', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ salesEndAt: '2026-01-01T00:00:00Z' }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('accepts purchase within sales window', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({
          salesStartAt: '2026-06-01T00:00:00Z',
          salesEndAt: '2026-07-01T00:00:00Z',
        }),
        quantity: 1,
        now: fixedNow,
      }),
    ).not.toThrow();
  });

  it('rejects quantity below 1', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType(),
        quantity: 0,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects quantity below minPerOrder', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ minPerOrder: 2 }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects quantity above maxPerOrder', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ maxPerOrder: 3 }),
        quantity: 5,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects donation without unitAmountCents', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ kind: 'donation', priceCents: 0, minimumPriceCents: 500 }),
        quantity: 1,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects donation below minimum', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ kind: 'donation', priceCents: 0, minimumPriceCents: 500 }),
        quantity: 1,
        unitAmountCents: 100,
        now: fixedNow,
      }),
    ).toThrow(ValidationError);
  });

  it('accepts donation at minimum', () => {
    expect(() =>
      validateTicketPurchase({
        ticketType: makeTicketType({ kind: 'donation', priceCents: 0, minimumPriceCents: 500 }),
        quantity: 1,
        unitAmountCents: 500,
        now: fixedNow,
      }),
    ).not.toThrow();
  });

  describe('access control', () => {
    it('rejects locked ticket without access code or email', () => {
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          now: fixedNow,
        }),
      ).toThrow(AccessCodeRequiredError);
    });

    it('accepts locked ticket with valid access code', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'access_code', value: 'SECRET123', usesCount: 0, maxUses: 10 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          accessCode: 'SECRET123',
          accessRules: rules,
          now: fixedNow,
        }),
      ).not.toThrow();
    });

    it('rejects locked ticket with wrong access code', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'access_code', value: 'SECRET123', usesCount: 0, maxUses: 10 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          accessCode: 'WRONG',
          accessRules: rules,
          now: fixedNow,
        }),
      ).toThrow(AccessCodeRequiredError);
    });

    it('rejects access code with exhausted uses', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'access_code', value: 'SECRET123', usesCount: 10, maxUses: 10 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          accessCode: 'SECRET123',
          accessRules: rules,
          now: fixedNow,
        }),
      ).toThrow(AccessCodeRequiredError);
    });

    it('rejects expired access code', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'access_code', value: 'SECRET123', usesCount: 0, maxUses: 10, expiresAt: '2026-01-01T00:00:00Z' },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          accessCode: 'SECRET123',
          accessRules: rules,
          now: fixedNow,
        }),
      ).toThrow(AccessCodeRequiredError);
    });

    it('accepts allowlisted email', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'allowlist', value: 'vip@tixkit.com', usesCount: 0 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          buyerEmail: 'vip@tixkit.com',
          accessRules: rules,
          now: fixedNow,
        }),
      ).not.toThrow();
    });

    it('rejects non-allowlisted email', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'allowlist', value: 'vip@tixkit.com', usesCount: 0 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          buyerEmail: 'other@tixkit.com',
          accessRules: rules,
          now: fixedNow,
        }),
      ).toThrow(AccessCodeRequiredError);
    });

    it('allowlist match is case-insensitive', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'allowlist', value: 'VIP@Tixkit.com', usesCount: 0 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          buyerEmail: 'vip@tixkit.com',
          accessRules: rules,
          now: fixedNow,
        }),
      ).not.toThrow();
    });

    it('accepts requiresAccessCode ticket with valid code', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'access_code', value: 'PROMO', usesCount: 5, maxUses: 100 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ requiresAccessCode: true }),
          quantity: 1,
          accessCode: 'PROMO',
          accessRules: rules,
          now: fixedNow,
        }),
      ).not.toThrow();
    });

    it('hidden ticket is purchasable (direct-link only)', () => {
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'hidden' }),
          quantity: 1,
          now: fixedNow,
        }),
      ).not.toThrow();
    });

    it('voucher type matches access code', () => {
      const rules: AccessRuleRecord[] = [
        { type: 'voucher', value: 'VOUCHER1', usesCount: 0, maxUses: 5 },
      ];
      expect(() =>
        validateTicketPurchase({
          ticketType: makeTicketType({ visibility: 'locked' }),
          quantity: 1,
          accessCode: 'VOUCHER1',
          accessRules: rules,
          now: fixedNow,
        }),
      ).not.toThrow();
    });
  });
});
