import type { BaseEntity, CurrencyCode, ISO8601Date, Ulid } from '../shared/index.js';
import { AccessCodeRequiredError, ValidationError } from '../errors/index.js';

export type TicketTypeKind = 'free' | 'paid' | 'donation';
export type TicketTypeStatus = 'draft' | 'active' | 'paused' | 'sold_out' | 'ended';
export type TicketVisibility = 'public' | 'hidden' | 'locked';

export type TicketType = BaseEntity & {
  eventId: Ulid;
  name: string;
  description?: string;
  kind: TicketTypeKind;
  status: TicketTypeStatus;
  visibility: TicketVisibility;
  currency: CurrencyCode;
  priceCents: number;
  minimumPriceCents?: number;
  salesStartAt?: ISO8601Date;
  salesEndAt?: ISO8601Date;
  minPerOrder: number;
  maxPerOrder: number;
  inventoryPoolId: Ulid;
  sortOrder: number;
  requiresAccessCode: boolean;
  accessCodeHint?: string;
};

export type TicketTier = BaseEntity & {
  ticketTypeId: Ulid;
  name: string;
  priceCents: number;
  currency: CurrencyCode;
  availableFrom?: ISO8601Date;
  availableUntil?: ISO8601Date;
  maxQuantity?: number;
  sortOrder: number;
};

export type InventoryPool = BaseEntity & {
  eventId: Ulid;
  name: string;
  totalCapacity: number;
  reservedCount: number;
  soldCount: number;
  holdTtlSeconds: number;
};

export type CheckoutHold = BaseEntity & {
  inventoryPoolId: Ulid;
  checkoutSessionId: Ulid;
  ticketTypeId: Ulid;
  quantity: number;
  expiresAt: ISO8601Date;
  status: 'active' | 'released' | 'converted' | 'expired' | 'restored';
};

export type Product = BaseEntity & {
  eventId: Ulid;
  name: string;
  description?: string;
  priceCents: number;
  currency: CurrencyCode;
  categoryId?: Ulid;
  maxPerOrder: number;
  availableFrom?: ISO8601Date;
  availableUntil?: ISO8601Date;
  status: 'active' | 'inactive';
  sortOrder: number;
};

export type ProductCategory = BaseEntity & {
  eventId: Ulid;
  name: string;
  sortOrder: number;
};

export type AccessRule = BaseEntity & {
  ticketTypeId: Ulid;
  type: 'access_code' | 'voucher' | 'allowlist';
  value: string;
  maxUses?: number;
  usesCount: number;
  expiresAt?: ISO8601Date;
};

export type AvailabilityResult = {
  ticketTypeId: Ulid;
  available: number;
  total: number;
  reserved: number;
  sold: number;
  status: TicketTypeStatus;
};

export type CreateTicketTypeInput = {
  eventId: Ulid;
  name: string;
  description?: string;
  kind: TicketTypeKind;
  visibility?: TicketVisibility;
  currency: CurrencyCode;
  priceCents: number;
  minimumPriceCents?: number;
  salesStartAt?: ISO8601Date;
  salesEndAt?: ISO8601Date;
  minPerOrder?: number;
  maxPerOrder?: number;
  inventoryPoolId: Ulid;
  requiresAccessCode?: boolean;
  accessCodeHint?: string;
};

export type UpdateTicketTypeInput = Partial<
  Pick<
    TicketType,
    'name' | 'description' | 'kind' | 'status' | 'visibility' | 'currency' | 'priceCents' | 'minimumPriceCents' | 'salesStartAt' | 'salesEndAt' | 'minPerOrder' | 'maxPerOrder' | 'requiresAccessCode' | 'accessCodeHint' | 'sortOrder'
  >
>;

export type CreateInventoryPoolInput = {
  eventId: Ulid;
  name: string;
  totalCapacity: number;
  holdTtlSeconds?: number;
};

export type PurchasableTicketType = {
  id: string;
  kind: TicketTypeKind;
  status: TicketTypeStatus;
  visibility: TicketVisibility;
  priceCents: number;
  minimumPriceCents?: number | null;
  salesStartAt?: Date | string | null;
  salesEndAt?: Date | string | null;
  minPerOrder: number;
  maxPerOrder: number;
  requiresAccessCode: boolean;
};

export type AccessRuleRecord = {
  type: 'access_code' | 'voucher' | 'allowlist';
  value: string;
  maxUses?: number | null;
  usesCount: number;
  expiresAt?: Date | string | null;
};

export type ValidateTicketPurchaseInput = {
  ticketType: PurchasableTicketType;
  quantity: number;
  unitAmountCents?: number;
  accessCode?: string;
  buyerEmail?: string;
  accessRules?: AccessRuleRecord[];
  now?: Date;
};

function toDate(value?: Date | string | null): Date | undefined {
  if (value === undefined || value === null) return undefined;
  return value instanceof Date ? value : new Date(value);
}

/**
 * Validates whether a ticket type may be purchased in the requested quantity.
 *
 * Enforces sales status, sales window, per-order min/max, donation minimum
 * price, and access control for locked / access-code tickets. Hidden tickets
 * are intentionally purchasable here (direct-link purchase); they are excluded
 * only from public listing APIs.
 *
 * Throws a domain error when the purchase is not permitted.
 */
export function validateTicketPurchase(input: ValidateTicketPurchaseInput): void {
  const { ticketType: tt, quantity } = input;
  const now = input.now ?? new Date();

  if (tt.status === 'draft' || tt.status === 'paused' || tt.status === 'ended') {
    throw new ValidationError(`Ticket type ${tt.id} is not on sale (status: ${tt.status})`);
  }

  const salesStart = toDate(tt.salesStartAt);
  const salesEnd = toDate(tt.salesEndAt);
  if (salesStart && now < salesStart) {
    throw new ValidationError(`Ticket type ${tt.id} sales have not started yet`);
  }
  if (salesEnd && now > salesEnd) {
    throw new ValidationError(`Ticket type ${tt.id} sales have ended`);
  }

  if (quantity < 1) {
    throw new ValidationError(`Quantity for ticket type ${tt.id} must be at least 1`);
  }
  if (quantity < tt.minPerOrder) {
    throw new ValidationError(
      `Ticket type ${tt.id} requires a minimum of ${tt.minPerOrder} per order`,
    );
  }
  if (quantity > tt.maxPerOrder) {
    throw new ValidationError(
      `Ticket type ${tt.id} allows a maximum of ${tt.maxPerOrder} per order`,
    );
  }

  if (tt.kind !== 'donation' && input.unitAmountCents !== undefined) {
    throw new ValidationError(`unitAmountCents is only accepted for donation ticket ${tt.id}`);
  }

  if (tt.kind === 'donation') {
    const minimum = tt.minimumPriceCents ?? 0;
    if (input.unitAmountCents === undefined) {
      throw new ValidationError(`Donation ticket ${tt.id} requires an amount`);
    }
    if (input.unitAmountCents < minimum) {
      throw new ValidationError(
        `Donation ticket ${tt.id} requires at least ${minimum} cents`,
      );
    }
  }

  const needsAccessCode = tt.visibility === 'locked' || tt.requiresAccessCode;
  if (needsAccessCode) {
    if (!input.accessCode && !input.buyerEmail) {
      throw new AccessCodeRequiredError(tt.id);
    }
    const rules = input.accessRules ?? [];
    const matched = rules.some((rule) => {
      const expiresAt = toDate(rule.expiresAt);
      if (expiresAt && now > expiresAt) return false;
      if (rule.maxUses != null && rule.usesCount >= rule.maxUses) return false;
      if (rule.type === 'allowlist') {
        return Boolean(input.buyerEmail) && rule.value.toLowerCase() === input.buyerEmail!.toLowerCase();
      }
      return Boolean(input.accessCode) && rule.value === input.accessCode;
    });
    if (!matched) {
      throw new AccessCodeRequiredError(tt.id);
    }
  }
}
