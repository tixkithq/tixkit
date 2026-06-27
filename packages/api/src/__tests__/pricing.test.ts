import { describe, it, expect } from 'vitest';
import { PricingEngine, type ProductForPricing, type TicketTypeForPricing } from '../services/pricing.js';
import { DiscountInvalidError, ValidationError } from '@tixkit/domain';

describe('PricingEngine', () => {
  const pricingEngine = new PricingEngine();

  const freeTicket: TicketTypeForPricing = {
    id: 'tt_free',
    name: 'Free Ticket',
    kind: 'free',
    priceCents: 0,
    currency: 'USD',
    minPerOrder: 1,
    maxPerOrder: 10,
  };

  const paidTicket: TicketTypeForPricing = {
    id: 'tt_paid',
    name: 'VIP Ticket',
    kind: 'paid',
    priceCents: 10000,
    currency: 'USD',
    minPerOrder: 1,
    maxPerOrder: 5,
  };

  const donationTicket: TicketTypeForPricing = {
    id: 'tt_donation',
    name: 'Donation',
    kind: 'donation',
    priceCents: 0,
    minimumPriceCents: 500,
    currency: 'USD',
    minPerOrder: 1,
    maxPerOrder: 1,
  };

  const ticketTypes = new Map([
    ['tt_free', freeTicket],
    ['tt_paid', paidTicket],
    ['tt_donation', donationTicket],
  ]);

  const parkingPass: ProductForPricing = {
    id: 'prd_parking',
    name: 'Parking pass',
    priceCents: 1500,
    currency: 'USD',
    maxPerOrder: 2,
    status: 'active',
  };

  const products = new Map([['prd_parking', parkingPass]]);

  it('should calculate free order correctly', () => {
    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_free', quantity: 2 }] },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(0);
    expect(quote.discountCents).toBe(0);
    expect(quote.taxCents).toBe(0);
    expect(quote.feeCents).toBe(0);
    expect(quote.totalCents).toBe(0);
    expect(quote.lineItems).toHaveLength(1);
    expect(quote.lineItems[0].quantity).toBe(2);
  });

  it('should calculate paid order correctly', () => {
    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 3 }] },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(30000);
    expect(quote.totalCents).toBe(30000);
    expect(quote.lineItems[0].unitPriceCents).toBe(10000);
  });

  it('emits persisted tax breakdown data for tax snapshots', () => {
    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }] },
      ticketTypes,
      taxRules: [{
        id: 'tax_vat',
        eventId: 'evt_1',
        name: 'VAT',
        rate: 2000,
        type: 'exclusive',
        appliedTo: 'ticket',
        countries: ['GB'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      feeRules: [],
      discountCodes: [],
      buyerCountry: 'GB',
    });

    expect(quote.taxCents).toBe(2000);
    expect(quote.lineItems[0].taxBreakdown).toEqual([
      expect.objectContaining({
        taxRuleId: 'tax_vat',
        taxRuleName: 'VAT',
        rate: 2000,
        type: 'exclusive',
        appliedTo: 'ticket',
        taxableAmountCents: 10000,
        taxCents: 2000,
        jurisdictionCountry: 'GB',
        provider: 'tixkit_rules',
      }),
    ]);
  });

  it('calculates mixed ticket and product orders', () => {
    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: {
        items: [
          { ticketTypeId: 'tt_paid', quantity: 1 },
          { productId: 'prd_parking', quantity: 2 },
        ],
      },
      ticketTypes,
      products,
      taxRules: [],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(13000);
    expect(quote.totalCents).toBe(13000);
    expect(quote.lineItems).toEqual([
      expect.objectContaining({ type: 'ticket', ticketTypeId: 'tt_paid', productId: undefined }),
      expect.objectContaining({ type: 'product', productId: 'prd_parking', ticketTypeId: undefined }),
    ]);
  });

  it('rejects unavailable products', () => {
    expect(() =>
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ productId: 'prd_parking', quantity: 1 }] },
        ticketTypes,
        products: new Map([['prd_parking', { ...parkingPass, status: 'paused' }]]),
        taxRules: [],
        feeRules: [],
        discountCodes: [],
      }),
    ).toThrow(DiscountInvalidError);
  });

  it('uses server ticket price for paid tickets even when client supplies unitAmountCents', () => {
    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2, unitAmountCents: 1 }] },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(20000);
    expect(quote.totalCents).toBe(20000);
    expect(quote.lineItems[0].unitPriceCents).toBe(10000);
  });

  it('rejects ticket types with a different currency from the cart', () => {
    const eurTicketTypes = new Map(ticketTypes);
    eurTicketTypes.set('tt_eur', {
      ...paidTicket,
      id: 'tt_eur',
      currency: 'EUR',
    });

    expect(() =>
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_eur', quantity: 1 }] },
        ticketTypes: eurTicketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [],
      }),
    ).toThrow(ValidationError);
  });

  it('should apply percentage discount correctly', () => {
    const discount = {
      id: 'dc_1',
      eventId: 'evt_1',
      code: 'SAVE20',
      type: 'percentage' as const,
      value: 2000,
      currency: 'USD',
      maxUses: 100,
      usesCount: 0,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }], discountCode: 'SAVE20' },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [discount],
    });

    expect(quote.subtotalCents).toBe(20000);
    expect(quote.discountCents).toBe(4000);
    expect(quote.totalCents).toBe(16000);
  });

  it('should apply fixed amount discount correctly', () => {
    const discount = {
      id: 'dc_2',
      eventId: 'evt_1',
      code: 'FLAT500',
      type: 'fixed_amount' as const,
      value: 500,
      currency: 'USD',
      maxUses: 100,
      usesCount: 0,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }], discountCode: 'FLAT500' },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [discount],
    });

    expect(quote.subtotalCents).toBe(20000);
    expect(quote.discountCents).toBe(1000);
    expect(quote.totalCents).toBe(19000);
  });

  it('should apply free ticket discount correctly', () => {
    const discount = {
      id: 'dc_3',
      eventId: 'evt_1',
      code: 'FREEBIE',
      type: 'free_ticket' as const,
      value: 100,
      currency: 'USD',
      maxUses: 1,
      usesCount: 0,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }], discountCode: 'FREEBIE' },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [discount],
    });

    expect(quote.discountCents).toBe(10000);
    expect(quote.totalCents).toBe(0);
  });

  it('should calculate exclusive tax correctly', () => {
    const taxRule = {
      id: 'tax_1',
      eventId: 'evt_1',
      name: 'VAT',
      rate: 1000,
      type: 'exclusive' as const,
      appliedTo: 'ticket' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }] },
      ticketTypes,
      taxRules: [taxRule],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(10000);
    expect(quote.taxCents).toBe(1000);
    expect(quote.totalCents).toBe(11000);
  });

  it('should calculate inclusive tax correctly', () => {
    const taxRule = {
      id: 'tax_2',
      eventId: 'evt_1',
      name: 'Sales Tax',
      rate: 1000,
      type: 'inclusive' as const,
      appliedTo: 'ticket' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }] },
      ticketTypes,
      taxRules: [taxRule],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(10000);
    // 10000 / 1.1 = 9090.91, tax = 10000 - 9091 = 909
    expect(quote.taxCents).toBeGreaterThan(0);
    expect(quote.totalCents).toBe(10000);
  });

  it('should calculate per-ticket fee correctly', () => {
    const feeRule = {
      id: 'fee_1',
      eventId: 'evt_1',
      name: 'Service Fee',
      type: 'percentage' as const,
      value: 500,
      appliedTo: 'per_ticket' as const,
      absorbIntoPrice: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }] },
      ticketTypes,
      taxRules: [],
      feeRules: [feeRule],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(20000);
    expect(quote.feeCents).toBe(1000);
    expect(quote.totalCents).toBe(21000);
  });

  it('should calculate per-order fixed fee correctly', () => {
    const feeRule = {
      id: 'fee_2',
      eventId: 'evt_1',
      name: 'Order Fee',
      type: 'fixed' as const,
      value: 200,
      appliedTo: 'per_order' as const,
      absorbIntoPrice: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }] },
      ticketTypes,
      taxRules: [],
      feeRules: [feeRule as never],
      discountCodes: [],
    });

    expect(quote.feeCents).toBe(200);
    expect(quote.totalCents).toBe(20200);
  });

  it('calculates per-order percentage fees on the discounted subtotal', () => {
    const discount = {
      id: 'dc_fee_base',
      eventId: 'evt_1',
      code: 'HALF',
      type: 'percentage' as const,
      value: 5000,
      currency: 'USD',
      maxUses: 100,
      usesCount: 0,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const feeRule = {
      id: 'fee_pct_order',
      eventId: 'evt_1',
      name: 'Order Fee',
      type: 'percentage' as const,
      value: 1000,
      appliedTo: 'per_order' as const,
      absorbIntoPrice: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }], discountCode: 'HALF' },
      ticketTypes,
      taxRules: [],
      feeRules: [feeRule],
      discountCodes: [discount],
    });

    expect(quote.subtotalCents).toBe(20000);
    expect(quote.discountCents).toBe(10000);
    expect(quote.feeCents).toBe(1000);
    expect(quote.totalCents).toBe(11000);
  });

  it('should reject invalid discount code', () => {
    expect(() => {
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }], discountCode: 'INVALID' },
        ticketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [],
      });
    }).toThrow(DiscountInvalidError);
  });

  it('should reject exhausted discount code', () => {
    const discount = {
      id: 'dc_4',
      eventId: 'evt_1',
      code: 'EXHAUSTED',
      type: 'percentage' as const,
      value: 1000,
      currency: 'USD',
      maxUses: 10,
      usesCount: 10,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(() => {
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }], discountCode: 'EXHAUSTED' },
        ticketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [discount],
      });
    }).toThrow(DiscountInvalidError);
  });

  it('rejects discounts when the order is below minOrderCents', () => {
    const discount = {
      id: 'dc_min_order',
      eventId: 'evt_1',
      code: 'BIGORDER',
      type: 'percentage' as const,
      value: 1000,
      currency: 'USD',
      minOrderCents: 20000,
      maxUses: 100,
      usesCount: 0,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(() =>
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 1 }], discountCode: 'BIGORDER' },
        ticketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [discount],
      }),
    ).toThrow(DiscountInvalidError);
  });

  it('should validate donation minimum price', () => {
    expect(() => {
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_donation', quantity: 1, unitAmountCents: 100 }] },
        ticketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [],
      });
    }).toThrow(DiscountInvalidError);
  });

  it('should accept valid donation amount', () => {
    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_donation', quantity: 1, unitAmountCents: 1000 }] },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [],
    });

    expect(quote.subtotalCents).toBe(1000);
    expect(quote.totalCents).toBe(1000);
  });

  it('should validate quantity within min/max range', () => {
    expect(() => {
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 0 }] },
        ticketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [],
      });
    }).toThrow(DiscountInvalidError);

    expect(() => {
      pricingEngine.calculate({
        currency: 'USD',
        cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 10 }] },
        ticketTypes,
        taxRules: [],
        feeRules: [],
        discountCodes: [],
      });
    }).toThrow(DiscountInvalidError);
  });

  it('should produce deterministic quotes for same input', () => {
    const input = {
      currency: 'USD' as const,
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }] },
      ticketTypes,
      taxRules: [{
        id: 'tax_1',
        eventId: 'evt_1',
        name: 'VAT',
        rate: 1000,
        type: 'exclusive' as const,
        appliedTo: 'ticket' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      feeRules: [{
        id: 'fee_1',
        eventId: 'evt_1',
        name: 'Service Fee',
        type: 'percentage' as const,
        value: 500,
        appliedTo: 'per_ticket' as const,
        absorbIntoPrice: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      discountCodes: [],
    };

    const quote1 = pricingEngine.calculate(input);
    const quote2 = pricingEngine.calculate(input);

    expect(quote1.subtotalCents).toBe(quote2.subtotalCents);
    expect(quote1.discountCents).toBe(quote2.discountCents);
    expect(quote1.taxCents).toBe(quote2.taxCents);
    expect(quote1.feeCents).toBe(quote2.feeCents);
    expect(quote1.totalCents).toBe(quote2.totalCents);
  });

  it('should cap discount at maxDiscountCents', () => {
    const discount = {
      id: 'dc_5',
      eventId: 'evt_1',
      code: 'CAPPED',
      type: 'percentage' as const,
      value: 5000,
      currency: 'USD',
      maxUses: 100,
      usesCount: 0,
      maxDiscountCents: 5000,
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const quote = pricingEngine.calculate({
      currency: 'USD',
      cart: { items: [{ ticketTypeId: 'tt_paid', quantity: 2 }], discountCode: 'CAPPED' },
      ticketTypes,
      taxRules: [],
      feeRules: [],
      discountCodes: [discount],
    });

    expect(quote.discountCents).toBe(5000);
  });
});
