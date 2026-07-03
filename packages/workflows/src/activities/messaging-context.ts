import { formatCurrency, type MergeTagContext } from '@tixkit/domain';

/**
 * Builders that assemble a {@link MergeTagContext} from DB rows loaded by the
 * transactional notification activities (order-confirmed, tickets-issued,
 * order-refunded). The notification delivery workflow passes `variables`
 * straight to `renderEmailTemplate`, which treats them as a `MergeTagContext`,
 * so populating these objects makes lifecycle merge tags resolve at send time
 * (C-101). Only data that is meaningfully available at the activity call site is
 * populated; hosted URLs without a source are left undefined so the merge-tag
 * engine renders its empty fallback rather than a broken link.
 */

const CHECKOUT_BASE_URL =
  process.env.CHECKOUT_URL ?? process.env.NEXT_PUBLIC_CHECKOUT_URL ?? 'https://checkout.tixkit.com';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseVenue(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalIso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? stringValue(value) : date.toISOString();
}

function personName(first: unknown, last: unknown): string | undefined {
  return [stringValue(first), stringValue(last)].filter(Boolean).join(' ') || undefined;
}

function checkoutUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, CHECKOUT_BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  return url.toString();
}

export type EventContextRow = {
  id: string;
  title: string | null;
  starts_at: Date | string | null;
  timezone: string | null;
  venue: string | null;
};

export function buildEventContext(
  event: EventContextRow | null | undefined,
): MergeTagContext['event'] {
  if (!event) return undefined;
  const id = stringValue(event.id);
  const venue = parseVenue(event.venue);
  return {
    title: stringValue(event.title),
    startsAt: optionalIso(event.starts_at),
    timezone: stringValue(event.timezone),
    venueName: venue ? stringValue(venue.name) : undefined,
    venueCity: venue ? stringValue(venue.city) : undefined,
    publicUrl: id ? checkoutUrl(`/e/${encodeURIComponent(id)}`) : undefined,
    checkoutUrl: id ? checkoutUrl('/checkout', { eventId: id }) : undefined,
  };
}

export type BrandContextRow = { id: string; name: string | null };

export function buildBrandContext(
  brand: BrandContextRow | null | undefined,
): MergeTagContext['brand'] {
  if (!brand) return undefined;
  return { name: stringValue(brand.name) };
}

export type OrderContextRow = {
  id: string;
  order_number: string;
  total_cents: number | bigint | string | null;
  refunded_cents: number | bigint | string | null;
  currency: string | null;
  buyer_email: string | null;
  buyer_first_name: string | null;
  buyer_last_name: string | null;
  buyer_phone: string | null;
};

export function buildRecipientContext(order: OrderContextRow): MergeTagContext['recipient'] {
  return {
    name: personName(order.buyer_first_name, order.buyer_last_name),
    email: stringValue(order.buyer_email),
    phone: stringValue(order.buyer_phone),
  };
}

export function buildOrderContext(order: OrderContextRow): MergeTagContext['order'] {
  const currency = stringValue(order.currency) ?? 'USD';
  return {
    id: stringValue(order.order_number) ?? stringValue(order.id),
    total: formatCurrency(Number(order.total_cents ?? 0), currency),
    buyerName: personName(order.buyer_first_name, order.buyer_last_name),
    buyerEmail: stringValue(order.buyer_email),
  };
}

export type RefundContextRow = {
  amount_cents: number | bigint | string | null;
  currency: string | null;
  status: string | null;
  created_at: Date | string | null;
};

export function buildRefundContext(
  refund: RefundContextRow | null | undefined,
  fallbackOrder: OrderContextRow | null | undefined,
): MergeTagContext['refund'] {
  const currency = stringValue(refund?.currency) ?? stringValue(fallbackOrder?.currency) ?? 'USD';
  const amountCents =
    refund && refund.amount_cents != null
      ? Number(refund.amount_cents)
      : fallbackOrder
        ? Number(fallbackOrder.refunded_cents ?? 0)
        : 0;
  if (amountCents <= 0) return undefined;
  return {
    amount: formatCurrency(amountCents, currency),
    processedAt: refund?.status === 'succeeded' ? optionalIso(refund.created_at) : undefined,
  };
}

export type TicketContextRow = {
  id: string | null;
  code: string | null;
  ticket_type_id: string | null;
};

export type WalletPassLinkRow = {
  ticketId: string;
  provider: 'apple' | 'google';
  passUrl: string;
};

export function buildTicketContext(
  ticket: TicketContextRow | null | undefined,
  ticketTypeName: string | null | undefined,
  walletPassLinks: WalletPassLinkRow[] | null | undefined,
): MergeTagContext['ticket'] {
  if (!ticket) return undefined;
  const ticketId = stringValue(ticket.id);
  const linksForTicket =
    walletPassLinks?.filter((link) => link.ticketId === ticketId) ?? [];
  return {
    type: stringValue(ticketTypeName),
    code: stringValue(ticket.code),
    walletAppleUrl: linksForTicket.find((link) => link.provider === 'apple')?.passUrl,
    walletGoogleUrl: linksForTicket.find((link) => link.provider === 'google')?.passUrl,
  };
}

export type TransactionalContextInput = {
  order: OrderContextRow;
  event?: EventContextRow | null;
  brand?: BrandContextRow | null;
  refund?: RefundContextRow | null;
  ticket?: TicketContextRow | null;
  ticketTypeName?: string | null;
  walletPassLinks?: WalletPassLinkRow[] | null;
};

export function buildTransactionalMergeTagContext(
  input: TransactionalContextInput,
): MergeTagContext {
  return {
    event: buildEventContext(input.event),
    brand: buildBrandContext(input.brand),
    recipient: buildRecipientContext(input.order),
    order: buildOrderContext(input.order),
    refund: buildRefundContext(input.refund, input.order),
    ticket: buildTicketContext(input.ticket, input.ticketTypeName, input.walletPassLinks),
  };
}
