'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, Ban, RotateCcw, Mail, User } from 'lucide-react'
import { type AdminAttendeeListItem, adminApi } from '@/lib/api'
import { routes } from '@/lib/routes'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'
import { OrderStatusBadge } from '@/features/events/event-status-badge'
import { toast } from 'sonner'

export function OrderDetailView({ orderId }: { orderId: string }) {
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const [refundOpen, setRefundOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const { data: order, loading, error, refetch } = useAdminData(
    () => adminApi.getOrder(orderId),
    [orderId]
  )
  const { data: attendeesData } = useAdminData(
    () =>
      order
        ? adminApi.listAttendees({ eventId: order.eventId })
        : Promise.resolve({ ok: true as const, data: { items: [] } as { items: AdminAttendeeListItem[] } }),
    [order?.eventId]
  )

  const attendees = (attendeesData?.items ?? []).filter(
    (a) => a.orderId === orderId
  )

  const handleCancel = async () => {
    setPending(true)
    const result = await adminApi.cancelOrder(orderId)
    setPending(false)
    if (result.ok) {
      toast.success('Order cancelled')
      setCancelOpen(false)
      refetch()
    } else {
      toast.error(result.error.message)
    }
  }

  const handleRefund = async () => {
    setPending(true)
    const result = await adminApi.refundOrder(orderId, {})
    setPending(false)
    if (result.ok) {
      toast.success(result.data.message || 'Refund workflow queued')
      setRefundOpen(false)
      refetch()
    } else {
      toast.error(result.error.message)
    }
  }

  if (loading) {
    return (
      <div className='space-y-6'>
        <Skeleton className='h-8 w-32' />
        <Skeleton className='h-10 w-full max-w-xs' />
        <div className='grid gap-4 sm:grid-cols-2'>
          <Skeleton className='h-48 w-full' />
          <Skeleton className='h-48 w-full' />
        </div>
      </div>
    )
  }

  if (error || !order) {
    return (
      <div className='space-y-4'>
        <Button variant='ghost' asChild>
          <Link href={routes.orders}>
            <ArrowLeft className='size-4' />
            Back to orders
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>Order not found</h1>
        <p className='text-muted-foreground'>
          {error?.message ?? 'The order you are looking for does not exist.'}
        </p>
      </div>
    )
  }

  const canCancel = order.status === 'pending' || order.status === 'paid'
  const canRefund =
    order.status === 'paid' || order.status === 'partially_refunded'

  return (
    <div className='space-y-6'>
      <Button variant='ghost' asChild>
        <Link href={routes.orders}>
          <ArrowLeft className='size-4' />
          Back to orders
        </Link>
      </Button>

      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='space-y-1'>
          <div className='flex items-center gap-3'>
            <h1 className='text-2xl font-bold tracking-tight font-mono'>
              {order.id}
            </h1>
            <OrderStatusBadge status={order.status} />
          </div>
          <p className='text-sm text-muted-foreground'>
            {order.eventTitle} · {formatDate(order.createdAt)}
          </p>
        </div>
        <div className='flex gap-2'>
          {canCancel && (
            <Button
              variant='outline'
              onClick={() => setCancelOpen(true)}
            >
              <Ban className='size-4' />
              Cancel
            </Button>
          )}
          {canRefund && (
            <Button
              variant='destructive'
              onClick={() => setRefundOpen(true)}
            >
              <RotateCcw className='size-4' />
              Refund
            </Button>
          )}
        </div>
      </div>

      <div className='grid gap-6 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>Buyer Details</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            <div className='flex items-center gap-3'>
              <User className='size-5 text-muted-foreground' />
              <div>
                <p className='font-medium'>
                  {order.buyerName ?? 'Unknown'}
                </p>
                <p className='text-sm text-muted-foreground'>
                  {order.buyerEmail}
                </p>
              </div>
            </div>
            <div className='border-t pt-3'>
              <div className='flex justify-between text-sm'>
                <span className='text-muted-foreground'>Total</span>
                <span className='font-medium'>
                  {formatCurrency(order.totalCents, order.currency)}
                </span>
              </div>
              {order.refundedCents > 0 && (
                <div className='flex justify-between text-sm'>
                  <span className='text-muted-foreground'>Refunded</span>
                  <span className='font-medium text-red-600 dark:text-red-400'>
                    -{formatCurrency(order.refundedCents, order.currency)}
                  </span>
                </div>
              )}
              <div className='flex justify-between text-sm'>
                <span className='text-muted-foreground'>Attendees</span>
                <span className='font-medium'>
                  {order.attendeeCount}
                </span>
              </div>
              <div className='flex justify-between text-sm'>
                <span className='text-muted-foreground'>Payment</span>
                <Badge variant='outline'>
                  {order.paymentProvider ?? '—'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Attendees</CardTitle>
          </CardHeader>
          <CardContent>
            {attendees.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                No attendee details available.
              </p>
            ) : (
              <div className='space-y-2'>
                {attendees.map((attendee) => (
                  <div
                    key={attendee.id}
                    className='flex items-center justify-between rounded-lg border p-3'
                  >
                    <div className='flex items-center gap-3'>
                      <Mail className='size-4 text-muted-foreground' />
                      <div>
                        <p className='text-sm font-medium'>{attendee.name}</p>
                        <p className='text-xs text-muted-foreground'>
                          {attendee.ticketTypeName}
                          {attendee.email && ` · ${attendee.email}`}
                        </p>
                      </div>
                    </div>
                    <Badge variant='outline'>{attendee.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className='space-y-3'>
            <TimelineItem
              label='Order Created'
              date={order.createdAt}
              icon={User}
            />
            {order.status === 'paid' && (
              <TimelineItem
                label='Payment Confirmed'
                date={order.paidAt ?? order.createdAt}
                icon={User}
              />
            )}
            {(order.status === 'refunded' || order.status === 'partially_refunded') && (
              <TimelineItem
                label='Refund Processed'
                date={order.refundedAt ?? order.createdAt}
                icon={RotateCcw}
              />
            )}
            {order.status === 'cancelled' && (
              <TimelineItem
                label='Order Cancelled'
                date={order.cancelledAt ?? order.createdAt}
                icon={Ban}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title='Cancel order'
        description={`Are you sure you want to cancel order ${order.id}? This cannot be undone.`}
        confirmText='Cancel order'
        variant='destructive'
        pending={pending}
        onConfirm={handleCancel}
      />
      <ConfirmDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        title='Refund order'
        description={`Refund the full balance (${formatCurrency(order.totalCents - order.refundedCents, order.currency)}) to the buyer?`}
        confirmText='Refund order'
        variant='destructive'
        pending={pending}
        onConfirm={handleRefund}
      />
    </div>
  )
}

function TimelineItem({
  label,
  date,
  icon: Icon,
}: {
  label: string
  date: string
  icon: React.ElementType
}) {
  return (
    <div className='flex items-center gap-3'>
      <div className='flex size-8 items-center justify-center rounded-full bg-muted'>
        <Icon className='size-4 text-muted-foreground' />
      </div>
      <div className='flex-1'>
        <p className='text-sm font-medium'>{label}</p>
        <p className='text-xs text-muted-foreground'>{formatDateTime(date)}</p>
      </div>
    </div>
  )
}
