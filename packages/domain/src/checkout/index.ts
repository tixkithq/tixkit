import type {
  BaseEntity,
  CurrencyCode,
  IdempotencyKey,
  ISO8601Date,
  Ulid,
} from '../shared/index.js';
import type { PriceQuote, CartInput } from '../pricing/index.js';

export type CheckoutSessionStatus =
  | 'open'
  | 'pending_payment'
  | 'completed'
  | 'expired'
  | 'cancelled';

export type BuyerInfo = {
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  dateOfBirth?: string;
};

export type CheckoutSession = BaseEntity & {
  eventId: Ulid;
  brandId: Ulid;
  tenantId: Ulid;
  status: CheckoutSessionStatus;
  holdId: Ulid;
  currency: CurrencyCode;
  cart: CartInput;
  buyer: BuyerInfo;
  quote: PriceQuote;
  paymentIntentId?: string;
  orderId?: Ulid;
  successUrl?: string;
  cancelUrl?: string;
  expiresAt: ISO8601Date;
};

export type OrderStatus =
  | 'draft'
  | 'pending_payment'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'cancelled'
  | 'expired'
  | 'disputed';

export type OrderLineItem = BaseEntity & {
  orderId: Ulid;
  ticketTypeId: Ulid;
  eventOccurrenceId?: Ulid;
  attendeeId?: Ulid;
  description: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  currency: CurrencyCode;
};

export type Order = BaseEntity & {
  tenantId: Ulid;
  organizationId: Ulid;
  brandId: Ulid;
  eventId: Ulid;
  checkoutSessionId: Ulid;
  orderNumber: string;
  status: OrderStatus;
  currency: CurrencyCode;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  refundedCents: number;
  buyerEmail: string;
  buyerFirstName?: string;
  buyerLastName?: string;
  buyerPhone?: string;
  paymentIntentId?: string;
  paymentProvider?: string;
  paidAt?: ISO8601Date;
  refundedAt?: ISO8601Date;
  cancelledAt?: ISO8601Date;
};

export type Attendee = BaseEntity & {
  orderId: Ulid;
  eventId: Ulid;
  ticketTypeId: Ulid;
  eventOccurrenceId?: Ulid;
  ticketId?: Ulid;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'refunded' | 'checked_in';
  customAnswers?: Record<string, unknown>;
  checkedInAt?: ISO8601Date;
  checkInDeviceId?: Ulid;
};

export type OrderTimelineEvent = BaseEntity & {
  orderId: Ulid;
  type: string;
  description: string;
  metadata?: Record<string, unknown>;
  actorId?: string;
};

export type CreateCheckoutSessionInput = {
  eventId: Ulid;
  items: {
    ticketTypeId?: Ulid;
    occurrenceId?: Ulid;
    productId?: Ulid;
    resaleListingId?: Ulid;
    quantity: number;
    unitAmountCents?: number;
    attendeeFields?: Record<string, unknown>[];
  }[];
  discountCode?: string;
  affiliateCode?: string;
  trackingId?: string;
  buyerFields?: Record<string, unknown>;
  buyer: BuyerInfo & { email: string; dateOfBirth?: string };
  successUrl?: string;
  cancelUrl?: string;
  accessCode?: string;
  waitlistClaimToken?: string;
  idempotencyKey: IdempotencyKey;
};

export type UpdateCheckoutSessionInput = Partial<
  Pick<CheckoutSession, 'buyer' | 'successUrl' | 'cancelUrl'>
>;

export type ConfirmCheckoutInput = {
  sessionId: Ulid;
  paymentMethodId?: string;
  idempotencyKey: IdempotencyKey;
};

export type CheckoutHoldValidationResult =
  | { ok: true }
  | { ok: false; expiredHoldIds: string[]; message: string };

/**
 * Validates that every ticket line in a checkout has exactly the active,
 * unexpired inventory quantity that finalization will consume.
 */
export function validateCheckoutHolds(input: {
  cartItems: Array<{ ticketTypeId?: string; quantity: number }>;
  holds: Array<{
    id: string;
    ticketTypeId: string;
    quantity: number;
    expiresAt: Date | string;
  }>;
  now: Date;
}): CheckoutHoldValidationResult {
  const expectedByTicketType = new Map<string, number>();
  for (const item of input.cartItems) {
    if (!item.ticketTypeId) continue;
    expectedByTicketType.set(
      item.ticketTypeId,
      (expectedByTicketType.get(item.ticketTypeId) ?? 0) + item.quantity,
    );
  }

  const heldByTicketType = new Map<string, number>();
  const expiredHoldIds: string[] = [];
  for (const hold of input.holds) {
    if (new Date(hold.expiresAt) <= input.now) {
      expiredHoldIds.push(hold.id);
      continue;
    }
    heldByTicketType.set(
      hold.ticketTypeId,
      (heldByTicketType.get(hold.ticketTypeId) ?? 0) + Number(hold.quantity),
    );
  }

  if (expiredHoldIds.length > 0) {
    return {
      ok: false,
      expiredHoldIds,
      message: `Checkout hold ${expiredHoldIds[0]} has expired`,
    };
  }

  for (const [ticketTypeId, expected] of expectedByTicketType) {
    if ((heldByTicketType.get(ticketTypeId) ?? 0) !== expected) {
      return {
        ok: false,
        expiredHoldIds,
        message: `Checkout session is missing an active inventory hold for ticket type ${ticketTypeId}`,
      };
    }
  }

  for (const [ticketTypeId, held] of heldByTicketType) {
    if (
      !expectedByTicketType.has(ticketTypeId) ||
      expectedByTicketType.get(ticketTypeId) !== held
    ) {
      return {
        ok: false,
        expiredHoldIds,
        message: `Checkout session has an unexpected inventory hold for ticket type ${ticketTypeId}`,
      };
    }
  }

  return { ok: true };
}

export type RefundInput = {
  orderId: Ulid;
  amountCents?: number;
  reason: string;
  idempotencyKey: IdempotencyKey;
};
