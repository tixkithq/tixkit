/**
 * Pure inventory / quote change recovery helpers for hosted checkout.
 * Server error details and refreshed availability are the authority;
 * the browser never silently rewrites the buyer selection.
 */

import type { AvailabilityItem, CartItem, CheckoutQuote } from './api';

export type InventoryChangeKind =
  | 'unavailable'
  | 'quantity_reduced'
  | 'price_changed'
  | 'occurrence_invalid'
  | 'quote_changed';

export type InventorySelectionChange = {
  kind: InventoryChangeKind;
  itemId: string;
  name: string;
  previousQuantity?: number;
  nextQuantity?: number;
  previousPriceCents?: number;
  nextPriceCents?: number;
  previousTotalCents?: number;
  nextTotalCents?: number;
  message: string;
};

export type InventoryRecoveryPlan = {
  changes: InventorySelectionChange[];
  /** Quantities the buyer must acknowledge before continuing. */
  proposedQuantities: Record<string, number>;
  requiresAcknowledgement: boolean;
  summary: string;
  focusItemId: string | null;
};

/** Must match checkout-flow / ticket-selection id scheme. */
export function availabilityItemId(item: AvailabilityItem): string {
  if (item.resaleListingId) return `resale:${item.resaleListingId}`;
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.eventOccurrenceId ?? 'event'}`;
  if (item.productId) return `product:${item.productId}`;
  return item.name;
}

/** Must match checkout-flow cart line id scheme. */
export function cartItemId(item: CartItem): string {
  if (item.resaleListingId) return `resale:${item.resaleListingId}`;
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.occurrenceId ?? 'event'}`;
  if (item.productId) return `product:${item.productId}`;
  return '';
}

function formatMoney(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

/**
 * Diff buyer quantities against the latest availability snapshot.
 * Does not mutate the cart; returns a plan the UI must acknowledge.
 */
export function planInventoryRecovery(input: {
  quantities: Record<string, number>;
  availability: AvailabilityItem[];
  currency?: string;
  previousQuote?: CheckoutQuote | null;
  nextQuote?: CheckoutQuote | null;
}): InventoryRecoveryPlan {
  const currency = input.currency ?? 'USD';
  const byId = new Map(input.availability.map((item) => [availabilityItemId(item), item]));
  const changes: InventorySelectionChange[] = [];
  const proposedQuantities: Record<string, number> = { ...input.quantities };

  for (const [itemId, quantity] of Object.entries(input.quantities)) {
    if (!quantity || quantity <= 0) continue;
    const ticket = byId.get(itemId);
    if (!ticket) {
      changes.push({
        kind: 'unavailable',
        itemId,
        name: itemId,
        previousQuantity: quantity,
        nextQuantity: 0,
        message: 'One of your selected items is no longer available.',
      });
      proposedQuantities[itemId] = 0;
      continue;
    }

    const soldOut = ticket.status === 'sold_out' || ticket.available <= 0;
    if (soldOut) {
      changes.push({
        kind: 'unavailable',
        itemId,
        name: ticket.name,
        previousQuantity: quantity,
        nextQuantity: 0,
        message: `${ticket.name} is sold out.`,
      });
      proposedQuantities[itemId] = 0;
      continue;
    }

    const maxAllowed = Math.min(
      ticket.maxPerOrder > 0 ? ticket.maxPerOrder : Number.POSITIVE_INFINITY,
      ticket.available,
    );
    if (quantity > maxAllowed) {
      const nextQuantity = Math.max(0, Math.floor(maxAllowed));
      changes.push({
        kind: 'quantity_reduced',
        itemId,
        name: ticket.name,
        previousQuantity: quantity,
        nextQuantity,
        message:
          nextQuantity === 0
            ? `${ticket.name} no longer has enough inventory for your selection.`
            : `${ticket.name} availability dropped to ${nextQuantity} (you had ${quantity}).`,
      });
      proposedQuantities[itemId] = nextQuantity;
    }

    // Occurrence-bound items that lost their occurrence id are invalid.
    if (ticket.eventOccurrenceId === '' || ticket.status === 'unavailable') {
      changes.push({
        kind: 'occurrence_invalid',
        itemId,
        name: ticket.name,
        previousQuantity: quantity,
        nextQuantity: 0,
        message: `${ticket.name} is no longer valid for the selected time.`,
      });
      proposedQuantities[itemId] = 0;
    }
  }

  if (
    input.previousQuote &&
    input.nextQuote &&
    input.previousQuote.totalCents !== input.nextQuote.totalCents
  ) {
    changes.push({
      kind: 'quote_changed',
      itemId: 'quote',
      name: 'Order total',
      previousTotalCents: input.previousQuote.totalCents,
      nextTotalCents: input.nextQuote.totalCents,
      message: `Order total changed from ${formatMoney(input.previousQuote.totalCents, currency)} to ${formatMoney(input.nextQuote.totalCents, currency)}.`,
    });
  }

  const summary =
    changes.length === 0
      ? ''
      : changes.length === 1
        ? (changes[0]?.message ?? 'Your selection changed.')
        : `${changes.length} items in your order need attention before you continue.`;

  return {
    changes,
    proposedQuantities,
    requiresAcknowledgement: changes.length > 0,
    summary,
    focusItemId: changes.find((c) => c.itemId !== 'quote')?.itemId ?? null,
  };
}

export type InventoryApiDetails = {
  ticketTypeId?: string;
  productId?: string;
  occurrenceId?: string;
  eventOccurrenceId?: string;
  resaleListingId?: string;
  requested?: number;
  available?: number;
  name?: string;
};

/**
 * Map structured API error details (when present) into a buyer-facing change list.
 */
export function planFromInventoryErrorDetails(
  details: InventoryApiDetails | null | undefined,
  quantities: Record<string, number>,
  availability: AvailabilityItem[],
): InventoryRecoveryPlan | null {
  if (!details) return null;
  const itemId =
    details.resaleListingId != null
      ? `resale:${details.resaleListingId}`
      : details.ticketTypeId != null
        ? `ticket:${details.ticketTypeId}:${details.occurrenceId ?? details.eventOccurrenceId ?? 'event'}`
        : details.productId != null
          ? `product:${details.productId}`
          : null;
  if (!itemId) return null;

  const ticket = availability.find((item) => availabilityItemId(item) === itemId);
  const name = details.name ?? ticket?.name ?? 'Selected item';
  const previousQuantity = quantities[itemId] ?? details.requested ?? 0;
  const available =
    typeof details.available === 'number' ? details.available : (ticket?.available ?? 0);
  const nextQuantity = Math.max(0, Math.min(previousQuantity, available));
  const kind: InventoryChangeKind = nextQuantity <= 0 ? 'unavailable' : 'quantity_reduced';

  const change: InventorySelectionChange = {
    kind,
    itemId,
    name,
    previousQuantity,
    nextQuantity,
    message:
      kind === 'unavailable'
        ? `${name} is no longer available.`
        : `${name} availability dropped to ${nextQuantity} (you had ${previousQuantity}).`,
  };

  return {
    changes: [change],
    proposedQuantities: { ...quantities, [itemId]: nextQuantity },
    requiresAcknowledgement: true,
    summary: change.message,
    focusItemId: itemId,
  };
}

export function isInventoryConflictCode(code: string | undefined | null): boolean {
  if (!code) return false;
  return (
    code === 'INVENTORY_EXHAUSTED' ||
    code === 'HOLD_EXPIRED' ||
    code === 'CONFLICT' ||
    code === 'OCCURRENCE_UNAVAILABLE' ||
    code === 'SELECTION_INVALID'
  );
}
