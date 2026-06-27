import { type EventStatus, type TicketTypeStatus, type OrderStatus, type AttendeeStatus, type CheckInStatus } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const eventStatusConfig: Record<EventStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-foreground border-transparent' },
  published: { label: 'Published', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent' },
  paused: { label: 'Paused', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent' },
  archived: { label: 'Archived', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-transparent' },
}

export function EventStatusBadge({ status }: { status: EventStatus }) {
  const config = eventStatusConfig[status]
  return (
    <Badge variant='outline' className={cn(config.className)}>
      {config.label}
    </Badge>
  )
}

const ticketStatusConfig: Record<TicketTypeStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-foreground border-transparent' },
  active: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent' },
  paused: { label: 'Paused', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent' },
  sold_out: { label: 'Sold Out', className: 'bg-red-500/15 text-red-700 dark:text-red-400 border-transparent' },
  ended: { label: 'Ended', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-transparent' },
}

export function TicketTypeStatusBadge({ status }: { status: TicketTypeStatus }) {
  const config = ticketStatusConfig[status]
  return (
    <Badge variant='outline' className={cn(config.className)}>
      {config.label}
    </Badge>
  )
}

const orderStatusConfig: Record<OrderStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent' },
  paid: { label: 'Paid', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent' },
  failed: { label: 'Failed', className: 'bg-red-500/15 text-red-700 dark:text-red-400 border-transparent' },
  cancelled: { label: 'Cancelled', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-transparent' },
  refunded: { label: 'Refunded', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-transparent' },
  partially_refunded: { label: 'Partially Refunded', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-transparent' },
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const config = orderStatusConfig[status]
  return (
    <Badge variant='outline' className={cn(config.className)}>
      {config.label}
    </Badge>
  )
}

const attendeeStatusConfig: Record<AttendeeStatus, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent' },
  cancelled: { label: 'Cancelled', className: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-transparent' },
  refunded: { label: 'Refunded', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-transparent' },
  transferred: { label: 'Transferred', className: 'bg-purple-500/15 text-purple-700 dark:text-purple-400 border-transparent' },
}

export function AttendeeStatusBadge({ status }: { status: AttendeeStatus }) {
  const config = attendeeStatusConfig[status]
  return (
    <Badge variant='outline' className={cn(config.className)}>
      {config.label}
    </Badge>
  )
}

const checkInStatusConfig: Record<CheckInStatus, { label: string; className: string }> = {
  not_checked_in: { label: 'Not Checked In', className: 'bg-muted text-foreground border-transparent' },
  checked_in: { label: 'Checked In', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent' },
  duplicate: { label: 'Duplicate', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-transparent' },
  revoked: { label: 'Revoked', className: 'bg-red-500/15 text-red-700 dark:text-red-400 border-transparent' },
}

export function CheckInStatusBadge({ status }: { status: CheckInStatus }) {
  const config = checkInStatusConfig[status]
  return (
    <Badge variant='outline' className={cn(config.className)}>
      {config.label}
    </Badge>
  )
}
