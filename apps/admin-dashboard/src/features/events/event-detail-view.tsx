'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  Ticket,
  Users,
  QrCode,
  MessageSquare,
  BarChart3,
  ClipboardList,
  Calendar,
  MapPin,
  Globe,
  Pencil,
} from 'lucide-react'
import { adminApi } from '@/lib/api'
import { routes } from '@/lib/routes'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EventStatusBadge, TicketTypeStatusBadge, OrderStatusBadge } from './event-status-badge'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatDate, formatNumber } from '@/lib/format'
import { CreateEventDrawer } from './create-event-drawer'

export function EventDetailView({ eventId }: { eventId: string }) {
  const { data: event, loading, error, refetch } = useAdminData(
    () => adminApi.getEvent(eventId),
    [eventId]
  )
  const { data: ticketTypes } = useAdminData(
    () => adminApi.listTicketTypes(eventId),
    [eventId]
  )
  const { data: ordersData } = useAdminData(
    () => adminApi.listOrders({ eventId, limit: 5 }),
    [eventId]
  )
  const [editOpen, setEditOpen] = React.useState(false)

  if (loading) {
    return (
      <div className='space-y-6'>
        <Skeleton className='h-10 w-full max-w-xs' />
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className='h-28 w-full' />
          ))}
        </div>
        <Skeleton className='h-64 w-full' />
      </div>
    )
  }

  if (error || !event) {
    return (
      <div className='space-y-4'>
        <h1 className='text-2xl font-bold'>Event not found</h1>
        <p className='text-muted-foreground'>
          {error?.message ?? 'The event you are looking for does not exist.'}
        </p>
        <Button asChild>
          <Link href={routes.events}>Back to events</Link>
        </Button>
      </div>
    )
  }

  const recentOrders = ordersData?.items ?? []
  const tickets = ticketTypes ?? []

  const quickLinks = [
    { title: 'Tickets', icon: Ticket, href: routes.eventTickets(eventId) },
    { title: 'Checkout Form', icon: ClipboardList, href: routes.eventCheckoutForm(eventId) },
    { title: 'Attendees', icon: Users, href: routes.eventAttendees(eventId) },
    { title: 'Check-in', icon: QrCode, href: routes.eventCheckIn(eventId) },
    { title: 'Messages', icon: MessageSquare, href: routes.eventMessages(eventId) },
    { title: 'Reports', icon: BarChart3, href: routes.eventReports(eventId) },
  ]

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='space-y-1'>
          <div className='flex items-center gap-3'>
            <h1 className='text-2xl font-bold tracking-tight'>{event.title}</h1>
            <EventStatusBadge status={event.status} />
          </div>
          <div className='flex flex-wrap items-center gap-3 text-sm text-muted-foreground'>
            <span className='flex items-center gap-1'>
              <Calendar className='size-4' />
              {formatDate(event.startsAt)}
            </span>
            {event.venueName && (
              <span className='flex items-center gap-1'>
                <MapPin className='size-4' />
                {event.venueName}
              </span>
            )}
            <span className='flex items-center gap-1'>
              <Globe className='size-4' />
              {event.timezone}
            </span>
          </div>
        </div>
        <Button variant='outline' onClick={() => setEditOpen(true)}>
          <Pencil className='size-4' />
          Edit
        </Button>
      </div>

      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <MetricCard title='Gross Sales' value={formatCurrency(event.grossSalesCents, event.currency)} />
        <MetricCard title='Tickets Sold' value={formatNumber(event.ticketsSold)} sub={event.capacity ? `of ${formatNumber(event.capacity)}` : undefined} />
        <MetricCard title='Check-ins' value={formatNumber(event.checkIns)} />
        <MetricCard title='Currency' value={event.currency} />
      </div>

      <div className='grid gap-6 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>Quick Links</CardTitle>
          </CardHeader>
          <CardContent>
            <div className='grid gap-2 sm:grid-cols-2'>
              {quickLinks.map((link) => (
                <Link
                  key={link.title}
                  href={link.href}
                  className='flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors'
                >
                  <link.icon className='size-5 text-muted-foreground' />
                  <span className='font-medium'>{link.title}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Orders</CardTitle>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <p className='text-sm text-muted-foreground'>No orders yet.</p>
            ) : (
              <div className='space-y-2'>
                {recentOrders.map((order) => (
                  <Link
                    key={order.id}
                    href={routes.orderDetail(order.id)}
                    className='flex items-center justify-between rounded-lg border p-2 hover:bg-accent/50 transition-colors'
                  >
                    <div className='min-w-0'>
                      <p className='truncate text-sm font-medium'>
                        {order.buyerName ?? order.buyerEmail}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {formatCurrency(order.totalCents, order.currency)}
                      </p>
                    </div>
                    <OrderStatusBadge status={order.status} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ticket Types</CardTitle>
        </CardHeader>
        <CardContent>
          {tickets.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              No ticket types configured.{' '}
              <Link
                href={routes.eventTickets(eventId)}
                className='font-medium underline'
              >
                Add tickets →
              </Link>
            </p>
          ) : (
            <div className='space-y-2'>
              {tickets.map((tt) => (
                <div
                  key={tt.id}
                  className='flex items-center justify-between rounded-lg border p-3'
                >
                  <div>
                    <p className='font-medium'>{tt.name}</p>
                    <p className='text-sm text-muted-foreground'>
                      {formatCurrency(tt.priceCents, tt.currency)} ·{' '}
                      {formatNumber(tt.quantitySold)}
                      {tt.quantityTotal
                        ? ` / ${formatNumber(tt.quantityTotal)}`
                        : ''}{' '}
                      sold
                    </p>
                  </div>
                  <TicketTypeStatusBadge status={tt.status} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateEventDrawer
        open={editOpen}
        onOpenChange={setEditOpen}
        event={event}
        onSuccess={refetch}
      />
    </div>
  )
}

function MetricCard({
  title,
  value,
  sub,
}: {
  title: string
  value: string
  sub?: string
}) {
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-medium'>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className='text-2xl font-bold'>{value}</div>
        {sub && <p className='text-xs text-muted-foreground'>{sub}</p>}
      </CardContent>
    </Card>
  )
}
