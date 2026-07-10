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

export type RefundInput = {
  orderId: Ulid;
  amountCents?: number;
  reason: string;
  idempotencyKey: IdempotencyKey;
};
