'use client';

import { MinusIcon, PlusIcon, LockIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatCurrency } from '@/lib/format';
import type { AvailabilityItem } from '@/lib/api';

type Props = {
  tickets: AvailabilityItem[];
  quantities: Record<string, number>;
  loading: boolean;
  onDecrease: (itemId: string) => void;
  onIncrease: (itemId: string) => void;
  onJoinWaitlist?: (ticket: AvailabilityItem) => void;
  waitlistTicketTypeIds?: Set<string>;
  /** Donation amounts keyed by availability item id. */
  donationAmounts?: Record<string, number>;
  /** Callback when a donation amount changes. */
  onDonationAmountChange?: (itemId: string, amountCents: number) => void;
  /** Locked ticket types unlocked by the current access code. */
  unlockedTicketTypeIds?: Set<string>;
};

const EMPTY_DONATION_AMOUNTS: Record<string, number> = {};
const EMPTY_UNLOCKED_TICKET_TYPE_IDS = new Set<string>();

export function TicketSelection({
  tickets,
  quantities,
  loading,
  onDecrease,
  onIncrease,
  onJoinWaitlist,
  waitlistTicketTypeIds,
  donationAmounts = EMPTY_DONATION_AMOUNTS,
  onDonationAmountChange,
  unlockedTicketTypeIds = EMPTY_UNLOCKED_TICKET_TYPE_IDS,
}: Props) {
  const hasLockedTicket = tickets.some((t) => t.requiresAccessCode);
  const unlockedLockedCount = tickets.filter(
    (ticket) =>
      ticket.requiresAccessCode &&
      ticket.ticketTypeId &&
      unlockedTicketTypeIds.has(ticket.ticketTypeId),
  ).length;
  const accessCodeApplied = unlockedLockedCount > 0;

  return (
    <div className="space-y-4">
      {hasLockedTicket ? (
        <LockedTicketBanner
          hint={tickets.find((t) => t.requiresAccessCode)?.accessCodeHint}
          applied={accessCodeApplied}
        />
      ) : null}

      <ul className="space-y-3">
        {tickets.map((ticket) => {
          const itemId = availabilityItemId(ticket);
          const quantity = quantities[itemId] ?? 0;
          const soldOut = ticket.status === 'sold_out' || ticket.available <= 0;
          const atMax = quantity >= Math.min(ticket.maxPerOrder, ticket.available);
          const decreaseDisabled = quantity <= 0 || loading;
          const isLocked =
            Boolean(ticket.requiresAccessCode) &&
            Boolean(ticket.ticketTypeId) &&
            !unlockedTicketTypeIds.has(ticket.ticketTypeId!);
          const increaseDisabled = soldOut || loading || atMax || isLocked;
          const isDonation = ticket.kind === 'donation';
          const waitlistJoined = ticket.ticketTypeId
            ? (waitlistTicketTypeIds?.has(ticket.ticketTypeId) ?? false)
            : false;
          const donationAmount = donationAmounts[itemId];
          const donationError =
            isDonation &&
            donationAmount !== undefined &&
            donationAmount < (ticket.minimumPriceCents ?? 0)
              ? `Minimum ${formatCurrency(ticket.minimumPriceCents ?? 0, ticket.currency)}`
              : undefined;

          return (
            <li
              key={itemId}
              className={cn(
                'flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-xs sm:flex-row sm:items-center sm:justify-between',
                soldOut && 'opacity-70',
              )}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{ticket.name}</span>
                  {soldOut ? (
                    <Badge variant="secondary">Sold out</Badge>
                  ) : ticket.kind !== 'product' && ticket.available <= 10 ? (
                    <Badge variant="outline">{ticket.available} left</Badge>
                  ) : ticket.requiresAccessCode ? (
                    <Badge variant="outline" className="gap-1">
                      <LockIcon className="size-3" />
                      Access code
                    </Badge>
                  ) : null}
                </div>
                {ticket.description ? (
                  <p className="text-sm text-muted-foreground">{ticket.description}</p>
                ) : null}
                <p className="text-sm font-semibold text-foreground">
                  {ticket.kind === 'free'
                    ? 'Free'
                    : ticket.kind === 'donation'
                      ? `From ${formatCurrency(ticket.minimumPriceCents ?? 0, ticket.currency)}`
                      : formatCurrency(ticket.priceCents, ticket.currency)}
                </p>
                {isDonation ? (
                  <div className="grid gap-1">
                    <div className="flex items-center gap-2">
                      <Label
                        htmlFor={`donation_${itemId}`}
                        className="text-sm text-muted-foreground"
                      >
                        Donation amount:
                      </Label>
                      <Input
                        id={`donation_${itemId}`}
                        name={`donation_${itemId}`}
                        type="number"
                        inputMode="decimal"
                        min={(ticket.minimumPriceCents ?? 0) / 100}
                        step="0.01"
                        value={
                          donationAmount !== undefined ? (donationAmount / 100).toFixed(2) : ''
                        }
                        onChange={(e) => {
                          const dollars = parseFloat(e.target.value) || 0;
                          onDonationAmountChange?.(itemId, Math.round(dollars * 100));
                        }}
                        disabled={loading}
                        className="w-28"
                        aria-label={`Donation amount for ${ticket.name}`}
                      />
                    </div>
                    {donationError ? (
                      <p className="text-xs text-destructive">{donationError}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                <fieldset
                  className="flex items-center gap-1 rounded-md border-0 p-0"
                  aria-label={`${ticket.name} quantity`}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-9"
                    aria-label={`Decrease ${ticket.name} quantity`}
                    disabled={decreaseDisabled}
                    onClick={() => onDecrease(itemId)}
                  >
                    <MinusIcon className="size-4" />
                  </Button>
                  <output
                    aria-live="polite"
                    className="w-8 text-center text-sm font-semibold tabular-nums"
                  >
                    {quantity}
                  </output>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-9"
                    aria-label={`Increase ${ticket.name} quantity`}
                    disabled={increaseDisabled}
                    onClick={() => onIncrease(itemId)}
                  >
                    <PlusIcon className="size-4" />
                  </Button>
                </fieldset>
                {soldOut && ticket.ticketTypeId && onJoinWaitlist ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || waitlistJoined}
                    onClick={() => onJoinWaitlist(ticket)}
                  >
                    {waitlistJoined ? 'Waitlist joined' : 'Join waitlist'}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function availabilityItemId(item: AvailabilityItem): string {
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.eventOccurrenceId ?? 'event'}`;
  if (item.productId) return `product:${item.productId}`;
  return item.name;
}

function LockedTicketBanner({ hint, applied }: { hint?: string; applied: boolean }) {
  return (
    <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
        <LockIcon className="size-4" />
        {applied ? 'Access code verified' : 'Access code required'}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {!applied ? (
        <p className="text-xs text-muted-foreground">
          Enter your access code in the field below to unlock locked tickets.
        </p>
      ) : null}
    </div>
  );
}
