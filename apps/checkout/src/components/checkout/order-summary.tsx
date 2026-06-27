'use client'

import { Separator } from '@/components/ui/separator'
import { formatCurrency } from '@/lib/format'
import type { AvailabilityItem, CartItem } from '@/lib/api'

type Props = {
  items: CartItem[]
  tickets: AvailabilityItem[]
  currency: string
  quote?: {
    subtotalCents: number
    discountCents: number
    feeCents: number
    taxCents: number
    totalCents: number
  }
  presetTotalCents?: number
}

export function OrderSummary({
  items,
  tickets,
  currency,
  quote,
  presetTotalCents,
}: Props) {
  const lines = items
    .map((item) => {
      const itemId = cartItemId(item)
      const ticket = tickets.find((t) => availabilityItemId(t) === itemId)
      if (!ticket) return null
      const unit =
        item.unitAmountCents ??
        (ticket.kind === 'donation'
          ? Math.max(ticket.minimumPriceCents ?? 0, ticket.priceCents)
          : ticket.priceCents)
      return {
        name: ticket.name,
        quantity: item.quantity,
        unit,
        subtotal: unit * item.quantity,
      }
    })
    .filter((line): line is NonNullable<typeof line> => line !== null)
  const subtotalCents = quote?.subtotalCents ?? lines.reduce((sum, l) => sum + l.subtotal, 0)
  const discountCents = quote?.discountCents ?? 0
  const feeCents = quote?.feeCents ?? 0
  const taxCents = quote?.taxCents ?? 0
  const totalCents =
    quote?.totalCents ?? presetTotalCents ?? subtotalCents - discountCents + feeCents + taxCents

  return (
    <div className='space-y-4'>
      {lines.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          Select tickets to see your order summary.
        </p>
      ) : (
        <ul className='space-y-3'>
          {lines.map((line) => (
            <li
              key={line.name}
              className='flex items-start justify-between gap-3 text-sm'
            >
              <div className='min-w-0'>
                <p className='font-medium'>{line.name}</p>
                <p className='text-muted-foreground'>
                  {line.quantity} × {formatCurrency(line.unit, currency)}
                </p>
              </div>
              <span className='shrink-0 font-medium tabular-nums'>
                {formatCurrency(line.subtotal, currency)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Separator />

      <dl className='space-y-2 text-sm'>
        <Row label='Subtotal' value={formatCurrency(subtotalCents, currency)} />
        {discountCents > 0 ? (
          <Row
            label='Discount'
            value={`-${formatCurrency(discountCents, currency)}`}
            className='text-emerald-600 dark:text-emerald-400'
          />
        ) : null}
        {feeCents > 0 ? (
          <Row label='Fees' value={formatCurrency(feeCents, currency)} />
        ) : null}
        {taxCents > 0 ? (
          <Row label='Tax' value={formatCurrency(taxCents, currency)} />
        ) : null}
      </dl>

      <Separator />

      <div className='flex items-baseline justify-between'>
        <span className='font-medium'>Total</span>
        <span className='text-xl font-bold tabular-nums'>
          {formatCurrency(totalCents, currency)}
        </span>
      </div>
    </div>
  )
}

function availabilityItemId(item: AvailabilityItem): string {
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.eventOccurrenceId ?? 'event'}`
  if (item.productId) return `product:${item.productId}`
  return item.name
}

function cartItemId(item: CartItem): string {
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.occurrenceId ?? 'event'}`
  if (item.productId) return `product:${item.productId}`
  return ''
}

function Row({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className='flex items-center justify-between'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className={`tabular-nums ${className ?? ''}`}>{value}</dd>
    </div>
  )
}
