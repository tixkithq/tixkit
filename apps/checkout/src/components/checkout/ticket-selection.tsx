'use client'

import { MinusIcon, PlusIcon, LockIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/format'
import type { AvailabilityItem } from '@/lib/api'

type Props = {
  tickets: AvailabilityItem[]
  quantities: Record<string, number>
  loading: boolean
  onDecrease: (ticketTypeId: string) => void
  onIncrease: (ticketTypeId: string) => void
  /** Donation amounts keyed by ticketTypeId. */
  donationAmounts?: Record<string, number>
  /** Callback when a donation amount changes. */
  onDonationAmountChange?: (ticketTypeId: string, amountCents: number) => void
  /** Locked ticket types unlocked by the current access code. */
  unlockedTicketTypeIds?: Set<string>
}

export function TicketSelection({
  tickets,
  quantities,
  loading,
  onDecrease,
  onIncrease,
  donationAmounts = {},
  onDonationAmountChange,
  unlockedTicketTypeIds = new Set(),
}: Props) {
  const hasLockedTicket = tickets.some((t) => t.requiresAccessCode)
  const unlockedLockedCount = tickets.filter(
    (ticket) =>
      ticket.requiresAccessCode && unlockedTicketTypeIds.has(ticket.ticketTypeId),
  ).length
  const accessCodeApplied = unlockedLockedCount > 0

  return (
    <div className='space-y-4'>
      {hasLockedTicket ? (
        <LockedTicketBanner
          hint={tickets.find((t) => t.requiresAccessCode)?.accessCodeHint}
          applied={accessCodeApplied}
        />
      ) : null}

      <ul className='space-y-3'>
        {tickets.map((ticket) => {
          const quantity = quantities[ticket.ticketTypeId] ?? 0
          const soldOut =
            ticket.status === 'sold_out' || ticket.available <= 0
          const atMax = quantity >= Math.min(ticket.maxPerOrder, ticket.available)
          const decreaseDisabled = quantity <= 0 || loading
          const isLocked =
            ticket.requiresAccessCode &&
            !unlockedTicketTypeIds.has(ticket.ticketTypeId)
          const increaseDisabled =
            soldOut || loading || atMax || isLocked
          const isDonation = ticket.kind === 'donation'
          const donationAmount = donationAmounts[ticket.ticketTypeId]
          const donationError =
            isDonation &&
            donationAmount !== undefined &&
            donationAmount < (ticket.minimumPriceCents ?? 0)
              ? `Minimum ${formatCurrency(ticket.minimumPriceCents ?? 0, ticket.currency)}`
              : undefined

          return (
            <li
              key={ticket.ticketTypeId}
              className={cn(
                'flex flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-xs sm:flex-row sm:items-center sm:justify-between',
                soldOut && 'opacity-70',
              )}
            >
              <div className='min-w-0 flex-1 space-y-1'>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className='font-medium'>{ticket.name}</span>
                  {soldOut ? (
                    <Badge variant='secondary'>Sold out</Badge>
                  ) : ticket.available <= 10 ? (
                    <Badge variant='outline'>{ticket.available} left</Badge>
                  ) : ticket.requiresAccessCode ? (
                    <Badge variant='outline' className='gap-1'>
                      <LockIcon className='size-3' />
                      Access code
                    </Badge>
                  ) : null}
                </div>
                {ticket.description ? (
                  <p className='text-sm text-muted-foreground'>
                    {ticket.description}
                  </p>
                ) : null}
                <p className='text-sm font-semibold text-foreground'>
                  {ticket.kind === 'free'
                    ? 'Free'
                    : ticket.kind === 'donation'
                      ? `From ${formatCurrency(ticket.minimumPriceCents ?? 0, ticket.currency)}`
                      : formatCurrency(ticket.priceCents, ticket.currency)}
                </p>
                {isDonation ? (
                  <div className='grid gap-1'>
                    <div className='flex items-center gap-2'>
                      <Label
                        htmlFor={`donation_${ticket.ticketTypeId}`}
                        className='text-sm text-muted-foreground'
                      >
                        Donation amount:
                      </Label>
                      <Input
                        id={`donation_${ticket.ticketTypeId}`}
                        name={`donation_${ticket.ticketTypeId}`}
                        type='number'
                        inputMode='decimal'
                        min={(ticket.minimumPriceCents ?? 0) / 100}
                        step='0.01'
                        value={
                          donationAmount !== undefined
                            ? (donationAmount / 100).toFixed(2)
                            : ''
                        }
                        onChange={(e) => {
                          const dollars = parseFloat(e.target.value) || 0
                          onDonationAmountChange?.(
                            ticket.ticketTypeId,
                            Math.round(dollars * 100),
                          )
                        }}
                        disabled={loading}
                        className='w-28'
                        aria-label={`Donation amount for ${ticket.name}`}
                      />
                    </div>
                    {donationError ? (
                      <p className='text-xs text-destructive'>
                        {donationError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <fieldset
                className='flex shrink-0 items-center gap-1 self-start rounded-md border-0 p-0 sm:self-center'
                aria-label={`${ticket.name} quantity`}
              >
                <Button
                  type='button'
                  variant='outline'
                  size='icon'
                  className='size-9'
                  aria-label={`Decrease ${ticket.name} quantity`}
                  disabled={decreaseDisabled}
                  onClick={() => onDecrease(ticket.ticketTypeId)}
                >
                  <MinusIcon className='size-4' />
                </Button>
                <output
                  aria-live='polite'
                  className='w-8 text-center text-sm font-semibold tabular-nums'
                >
                  {quantity}
                </output>
                <Button
                  type='button'
                  variant='outline'
                  size='icon'
                  className='size-9'
                  aria-label={`Increase ${ticket.name} quantity`}
                  disabled={increaseDisabled}
                  onClick={() => onIncrease(ticket.ticketTypeId)}
                >
                  <PlusIcon className='size-4' />
                </Button>
              </fieldset>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function LockedTicketBanner({
  hint,
  applied,
}: {
  hint?: string
  applied: boolean
}) {
  return (
    <div className='space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30'>
      <div className='flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300'>
        <LockIcon className='size-4' />
        {applied ? 'Access code verified' : 'Access code required'}
      </div>
      {hint ? (
        <p className='text-xs text-muted-foreground'>{hint}</p>
      ) : null}
      {!applied ? (
        <p className='text-xs text-muted-foreground'>
          Enter your access code in the field below to unlock locked tickets.
        </p>
      ) : null}
    </div>
  )
}
