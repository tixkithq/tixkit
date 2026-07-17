import type { BaseEntity, CurrencyCode, ISO8601Date, Ulid } from '../shared/index.js';

export type PriceLineItem = {
  type: 'ticket' | 'product' | 'resale';
  ticketTypeId?: Ulid;
  eventOccurrenceId?: Ulid;
  productId?: Ulid;
  resaleListingId?: Ulid;
  name: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  taxBreakdown?: Array<{
    taxRuleId?: Ulid;
    taxRuleName: string;
    rate: number;
    type: 'inclusive' | 'exclusive';
    appliedTo: 'ticket' | 'fee' | 'all';
    taxableAmountCents: number;
    taxCents: number;
    jurisdictionCountry?: string;
    jurisdictionRegion?: string;
    provider?: string;
    providerCalculationId?: string;
  }>;
  feeCents: number;
  buyerFeeCents?: number;
  organizerAbsorbedFeeCents?: number;
  totalCents: number;
};

export type PriceQuote = {
  id: Ulid;
  currency: CurrencyCode;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  buyerFeeCents?: number;
  organizerAbsorbedFeeCents?: number;
  totalCents: number;
  lineItems: PriceLineItem[];
  expiresAt: ISO8601Date;
};

export type TaxRule = BaseEntity & {
  eventId: Ulid;
  name: string;
  rate: number;
  type: 'inclusive' | 'exclusive';
  appliedTo: 'ticket' | 'fee' | 'all';
  countries?: string[];
  regions?: string[];
};

export type FeeRule = BaseEntity & {
  eventId: Ulid;
  name: string;
  type: 'percentage' | 'fixed';
  value: number;
  appliedTo: 'per_ticket' | 'per_order';
  absorbIntoPrice: boolean;
};

export type DiscountCode = BaseEntity & {
  eventId: Ulid;
  code: string;
  type: 'percentage' | 'fixed_amount' | 'free_ticket';
  value: number;
  currency: CurrencyCode;
  maxUses: number;
  usesCount: number;
  validFrom?: ISO8601Date;
  validUntil?: ISO8601Date;
  minOrderCents?: number;
  maxDiscountCents?: number;
  ticketTypeIds?: Ulid[];
  status: 'active' | 'paused' | 'exhausted' | 'expired';
};

export type Voucher = BaseEntity & {
  eventId: Ulid;
  code: string;
  ticketTypeId: Ulid;
  discountType: 'percentage' | 'fixed_amount' | 'free';
  discountValue: number;
  maxUses: number;
  usesCount: number;
  validFrom?: ISO8601Date;
  validUntil?: ISO8601Date;
  status: 'active' | 'used' | 'expired';
};

export type Affiliate = BaseEntity & {
  organizationId: Ulid;
  code: string;
  name: string;
  commissionPercentage: number;
  status: 'active' | 'inactive';
};

export type Attribution = BaseEntity & {
  orderId: Ulid;
  affiliateId: Ulid;
  affiliateCode: string;
  commissionCents: number;
  attributedAt: ISO8601Date;
};

export type CartItem = {
  ticketTypeId?: Ulid;
  occurrenceId?: Ulid;
  productId?: Ulid;
  resaleListingId?: Ulid;
  quantity: number;
  unitAmountCents?: number;
  attendeeFields?: Record<string, unknown>[];
};

export type CartInput = {
  items: CartItem[];
  discountCode?: string;
  accessRuleRedemptions?: Array<{
    accessRuleId: Ulid;
    ticketTypeId: Ulid;
  }>;
  affiliateCode?: string;
  trackingId?: string;
  buyerFields?: Record<string, unknown>;
  attendeeFields?: Record<string, unknown[]>;
  waitlistEntryId?: Ulid;
  resaleTermsAcceptance?: {
    accepted: true;
    termsVersion: '2026-07-16';
    settlementModel: 'organizer_managed';
    refundModel: 'manual_coordinated_resolution';
  };
};

export type PricingContext = {
  eventId: Ulid;
  currency: CurrencyCode;
  cart: CartInput;
  taxRules: TaxRule[];
  feeRules: FeeRule[];
  discountCodes: DiscountCode[];
  buyerCountry?: string;
  buyerRegion?: string;
};
