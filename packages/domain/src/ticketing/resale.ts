/**
 * Paid resale / secondary-market listings (C-073).
 *
 * Domain lifecycle for ticket resale listings: list (price within
 * configurable face-value caps), delist, mark-sold, and expire. Ownership
 * reassignment on a completed resale is modeled as a state transition that
 * the workflow layer consumes to reissue/void credentials. Built on the
 * existing transfer + idempotency machinery; payment/escrow is provider-delegated.
 */

export type TicketListingStatus = 'listed' | 'delisted' | 'sold' | 'expired';

export type TicketListing = {
  id: string;
  ticketId: string;
  sellerId: string;
  eventId: string;
  status: TicketListingStatus;
  priceCents: number;
  currency: string;
  faceValueCents: number;
  createdAt: string;
  updatedAt: string;
  soldToId?: string;
};

export type ResalePriceCapPolicy = {
  /** Multiplier cap on the face value (e.g. 1.0 = no markup, 1.2 = 20% max). */
  maxMultiplier: number;
  /** Absolute maximum price in cents, if set. */
  maxAbsoluteCents?: number;
  /** Whether resale is enabled at all for the event. */
  enabled: boolean;
};

export type ListingTransition =
  | { action: 'list'; priceCents: number; faceValueCents: number; policy: ResalePriceCapPolicy }
  | { action: 'delist' }
  | { action: 'mark_sold'; buyerId: string }
  | { action: 'expire' };

export class ResaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResaleError';
  }
}

export function validateResalePrice(
  priceCents: number,
  faceValueCents: number,
  policy: ResalePriceCapPolicy,
): void {
  if (!policy.enabled) {
    throw new ResaleError('Resale is not enabled for this event');
  }
  if (priceCents < 0) {
    throw new ResaleError('Resale price cannot be negative');
  }
  const capByMultiplier = Math.round(faceValueCents * policy.maxMultiplier);
  const cap =
    policy.maxAbsoluteCents !== undefined
      ? Math.min(capByMultiplier, policy.maxAbsoluteCents)
      : capByMultiplier;
  if (priceCents > cap) {
    throw new ResaleError(
      `Resale price ${priceCents} exceeds cap ${cap} (face value ${faceValueCents} * ${policy.maxMultiplier}${policy.maxAbsoluteCents !== undefined ? `, absolute ${policy.maxAbsoluteCents}` : ''})`,
    );
  }
}

const VALID_TRANSITIONS: Record<TicketListingStatus, Set<ListingTransition['action']>> = {
  listed: new Set(['delist', 'mark_sold', 'expire']),
  delisted: new Set(['list']),
  sold: new Set([]),
  expired: new Set([]),
};

export function transitionListing(
  listing: TicketListing,
  transition: ListingTransition,
  now: Date = new Date(),
): TicketListing {
  if (transition.action === 'list') {
    // Listing (or re-listing) requires price validation against the policy.
    validateResalePrice(transition.priceCents, transition.faceValueCents, transition.policy);
    if (listing.status !== 'listed' && listing.status !== 'delisted') {
      throw new ResaleError(`Cannot list a ticket in status ${listing.status}`);
    }
    return {
      ...listing,
      status: 'listed',
      priceCents: transition.priceCents,
      faceValueCents: transition.faceValueCents,
      updatedAt: now.toISOString(),
    };
  }
  const allowed = VALID_TRANSITIONS[listing.status];
  if (!allowed.has(transition.action)) {
    throw new ResaleError(`Cannot ${transition.action} a listing in status ${listing.status}`);
  }
  const next: TicketListing = { ...listing, updatedAt: now.toISOString() };
  if (transition.action === 'delist') next.status = 'delisted';
  if (transition.action === 'expire') next.status = 'expired';
  if (transition.action === 'mark_sold') {
    next.status = 'sold';
    next.soldToId = transition.buyerId;
  }
  return next;
}

/** Guard against double-sell: a ticket can only have one active listing. */
export function assertNoActiveListing(ticketId: string, listings: TicketListing[]): void {
  const active = listings.find((l) => l.ticketId === ticketId && l.status === 'listed');
  if (active) {
    throw new ResaleError(`Ticket ${ticketId} already has an active listing ${active.id}`);
  }
}
