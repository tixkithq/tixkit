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

type QuoteLineItem = NonNullable<CheckoutQuote['lineItems']>[number];

function cents(value: number | undefined): number {
  return value ?? 0;
}

function quoteLineIdentity(line: QuoteLineItem): string {
  if (line.resaleListingId) return `resale:${line.resaleListingId}`;
  if (line.ticketTypeId) return `ticket:${line.ticketTypeId}:${line.eventOccurrenceId ?? 'event'}`;
  if (line.productId) return `product:${line.productId}`;
  return `type:${line.type ?? ''}`;
}

function quoteLineSortKey(line: QuoteLineItem): string {
  return JSON.stringify([
    quoteLineIdentity(line),
    line.quantity,
    line.unitPriceCents ?? line.unitAmountCents,
    line.totalCents,
  ]);
}

function quoteLineChanged(previous: QuoteLineItem, next: QuoteLineItem): boolean {
  if (
    quoteLineIdentity(previous) !== quoteLineIdentity(next) ||
    previous.quantity !== next.quantity
  ) {
    return true;
  }

  const comparableFields = [
    [
      previous.unitPriceCents ?? previous.unitAmountCents,
      next.unitPriceCents ?? next.unitAmountCents,
    ],
    [previous.subtotalCents, next.subtotalCents],
    [previous.discountCents, next.discountCents],
    [previous.taxCents, next.taxCents],
    [previous.feeCents, next.feeCents],
    [previous.buyerFeeCents, next.buyerFeeCents],
    [previous.organizerAbsorbedFeeCents, next.organizerAbsorbedFeeCents],
    [previous.totalCents, next.totalCents],
  ];
  return comparableFields.some(
    ([previousValue, nextValue]) =>
      typeof previousValue === 'number' &&
      typeof nextValue === 'number' &&
      previousValue !== nextValue,
  );
}

function quoteChanged(previousQuote: CheckoutQuote, nextQuote: CheckoutQuote): boolean {
  const quoteAmountsChanged =
    previousQuote.totalCents !== nextQuote.totalCents ||
    previousQuote.subtotalCents !== nextQuote.subtotalCents ||
    previousQuote.discountCents !== nextQuote.discountCents ||
    previousQuote.taxCents !== nextQuote.taxCents ||
    previousQuote.feeCents !== nextQuote.feeCents ||
    cents(previousQuote.buyerFeeCents) !== cents(nextQuote.buyerFeeCents) ||
    cents(previousQuote.organizerAbsorbedFeeCents) !== cents(nextQuote.organizerAbsorbedFeeCents);
  if (quoteAmountsChanged) return true;

  // Some session responses intentionally omit line items. Their absence is not
  // evidence that every locally previewed line changed; compare line detail
  // only when both snapshots provide it.
  if (!previousQuote.lineItems || !nextQuote.lineItems) return false;

  const previousLines = [...previousQuote.lineItems].sort((left, right) =>
    quoteLineSortKey(left).localeCompare(quoteLineSortKey(right)),
  );
  const nextLines = [...nextQuote.lineItems].sort((left, right) =>
    quoteLineSortKey(left).localeCompare(quoteLineSortKey(right)),
  );
  return (
    previousLines.length !== nextLines.length ||
    previousLines.some((line, index) => {
      const nextLine = nextLines[index];
      return !nextLine || quoteLineChanged(line, nextLine);
    })
  );
}

function matchingAvailabilityItemId(
  line: QuoteLineItem,
  selectedItemIds: ReadonlySet<string>,
  availabilityById: ReadonlyMap<string, AvailabilityItem>,
): string | null {
  if (line.resaleListingId) {
    const itemId = `resale:${line.resaleListingId}`;
    return selectedItemIds.has(itemId) && availabilityById.has(itemId) ? itemId : null;
  }
  if (line.productId) {
    const itemId = `product:${line.productId}`;
    return selectedItemIds.has(itemId) && availabilityById.has(itemId) ? itemId : null;
  }
  if (!line.ticketTypeId) return null;

  // Modern quote lines carry the occurrence identity. It must be honored
  // exactly: falling back to ticket type here could attribute a price change
  // from one performance to another when the same ticket type is selected
  // across multiple occurrences.
  if (line.eventOccurrenceId != null) {
    const itemId = `ticket:${line.ticketTypeId}:${line.eventOccurrenceId}`;
    return selectedItemIds.has(itemId) && availabilityById.has(itemId) ? itemId : null;
  }

  // Older quotes did not include eventOccurrenceId. Only use the ticket-type
  // fallback when the selected line is unambiguous.
  const matchingTicketIds = [...selectedItemIds].filter(
    (itemId) => itemId.startsWith(`ticket:${line.ticketTypeId}:`) && availabilityById.has(itemId),
  );
  return matchingTicketIds.length === 1 ? (matchingTicketIds[0] ?? null) : null;
}

function priorQuoteLinesByAvailabilityItemId(
  quote: CheckoutQuote,
  selectedItemIds: ReadonlySet<string>,
  availabilityById: ReadonlyMap<string, AvailabilityItem>,
): Map<string, QuoteLineItem> {
  const candidates = new Map<string, QuoteLineItem[]>();
  for (const line of quote.lineItems ?? []) {
    const itemId = matchingAvailabilityItemId(line, selectedItemIds, availabilityById);
    if (!itemId) continue;
    const lines = candidates.get(itemId) ?? [];
    lines.push(line);
    candidates.set(itemId, lines);
  }

  return new Map(
    [...candidates].flatMap(([itemId, lines]) =>
      lines.length === 1 && lines[0] ? [[itemId, lines[0]] as const] : [],
    ),
  );
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

  if (input.previousQuote) {
    const selectedItemIds = new Set(
      Object.entries(input.quantities)
        .filter(([, quantity]) => quantity > 0)
        .map(([itemId]) => itemId),
    );
    const priorQuoteLines = priorQuoteLinesByAvailabilityItemId(
      input.previousQuote,
      selectedItemIds,
      byId,
    );
    const nextQuoteLines = input.nextQuote
      ? priorQuoteLinesByAvailabilityItemId(input.nextQuote, selectedItemIds, byId)
      : new Map<string, QuoteLineItem>();

    for (const itemId of [...selectedItemIds].sort()) {
      const priorLine = priorQuoteLines.get(itemId);
      const nextLine = nextQuoteLines.get(itemId);
      const ticket = byId.get(itemId);
      const previousPriceCents = priorLine?.unitPriceCents ?? priorLine?.unitAmountCents;
      const quotedNextPriceCents = nextLine?.unitPriceCents ?? nextLine?.unitAmountCents;
      const nextPriceCents =
        typeof quotedNextPriceCents === 'number' && quotedNextPriceCents !== previousPriceCents
          ? quotedNextPriceCents
          : ticket?.priceCents;
      if (
        !ticket ||
        ticket.kind === 'donation' ||
        typeof previousPriceCents !== 'number' ||
        typeof nextPriceCents !== 'number' ||
        previousPriceCents === nextPriceCents
      ) {
        continue;
      }

      changes.push({
        kind: 'price_changed',
        itemId,
        name: ticket.name,
        previousPriceCents,
        nextPriceCents,
        message: `${ticket.name} price changed from ${formatMoney(previousPriceCents, currency)} to ${formatMoney(nextPriceCents, currency)}.`,
      });
    }
  }

  if (
    input.previousQuote &&
    input.nextQuote &&
    quoteChanged(input.previousQuote, input.nextQuote)
  ) {
    const totalChanged = input.previousQuote.totalCents !== input.nextQuote.totalCents;
    changes.push({
      kind: 'quote_changed',
      itemId: 'quote',
      name: totalChanged ? 'Order total' : 'Order pricing details',
      previousTotalCents: input.previousQuote.totalCents,
      nextTotalCents: input.nextQuote.totalCents,
      message: totalChanged
        ? `Order total changed from ${formatMoney(input.previousQuote.totalCents, currency)} to ${formatMoney(input.nextQuote.totalCents, currency)}.`
        : 'Order pricing details changed. Please review your updated total.',
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
  const explicitOccurrenceId = details.occurrenceId ?? details.eventOccurrenceId;
  if (details.ticketTypeId != null && explicitOccurrenceId == null) {
    const selectedOccurrenceItemIds = Object.entries(quantities)
      .filter(
        ([itemId, quantity]) =>
          quantity > 0 && itemId.startsWith(`ticket:${details.ticketTypeId}:`),
      )
      .map(([itemId]) => itemId)
      .sort();

    if (selectedOccurrenceItemIds.length > 1) {
      const proposedQuantities = { ...quantities };
      const changes = selectedOccurrenceItemIds.map((itemId) => {
        proposedQuantities[itemId] = 0;
        const ticket = availability.find((item) => availabilityItemId(item) === itemId);
        const previousQuantity = quantities[itemId] ?? 0;
        const name = details.name ?? ticket?.name ?? 'Selected performance';
        return {
          kind: 'occurrence_invalid' as const,
          itemId,
          name,
          previousQuantity,
          nextQuantity: 0,
          message: `${name} could not be matched to a specific performance. Please choose your performance again.`,
        };
      });
      return {
        changes,
        proposedQuantities,
        requiresAcknowledgement: true,
        summary: 'Your selected performances need to be chosen again before checkout can continue.',
        focusItemId: selectedOccurrenceItemIds[0] ?? null,
      };
    }

    // A legacy, occurrence-less error may safely map only to one selected
    // ticket line. Do not invent a `:event` identifier when it is ambiguous.
    if (selectedOccurrenceItemIds.length === 1) {
      const itemId = selectedOccurrenceItemIds[0]!;
      const ticket = availability.find((item) => availabilityItemId(item) === itemId);
      const previousQuantity = quantities[itemId] ?? details.requested ?? 0;
      const available =
        typeof details.available === 'number' ? details.available : (ticket?.available ?? 0);
      const nextQuantity = Math.max(0, Math.min(previousQuantity, available));
      const kind: InventoryChangeKind = nextQuantity <= 0 ? 'unavailable' : 'quantity_reduced';
      const name = details.name ?? ticket?.name ?? 'Selected item';
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

    // Backend inventory errors may identify a capacity pool or occurrence
    // rather than the buyer's concrete ticket line. Without a selected match,
    // let the refreshed availability plan decide; inventing `:event` here can
    // leave the real quantities untouched and create an acknowledgement loop.
    return null;
  }

  const itemId =
    details.resaleListingId != null
      ? `resale:${details.resaleListingId}`
      : details.ticketTypeId != null
        ? `ticket:${details.ticketTypeId}:${explicitOccurrenceId ?? 'event'}`
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
