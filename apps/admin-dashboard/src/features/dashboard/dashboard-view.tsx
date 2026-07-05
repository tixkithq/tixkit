'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarCheck, DollarSign, Ticket, TrendingUp, Plus } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { ApiErrorState } from '@/components/api-error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { EventStatusBadge } from '@/features/events/event-status-badge';
import { OrderStatusBadge } from '@/features/events/event-status-badge';
import { useAdminData } from '@/hooks/use-admin-data';
import { useAllEvents } from '@/hooks/use-all-events';
import { formatCurrency, formatNumber, formatDate } from '@/lib/format';

export function DashboardView() {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useAllEvents();
  const {
    data: ordersData,
    loading: ordersLoading,
    error: ordersError,
    refetch: refetchOrders,
  } = useAdminData(() => adminApi.listOrders({ limit: 5 }));

  const recentOrders = ordersData?.items ?? [];

  const grossSales = events.reduce((sum, e) => sum + e.grossSalesCents, 0);
  const ticketsSold = events.reduce((sum, e) => sum + e.ticketsSold, 0);
  const checkIns = events.reduce((sum, e) => sum + e.checkIns, 0);
  const activeEvents = events.filter((e) => e.status === 'published').length;

  const metrics = [
    {
      title: 'Gross Sales',
      value: formatCurrency(grossSales, 'USD'),
      hint: `${events.length} event${events.length === 1 ? '' : 's'}`,
      icon: DollarSign,
    },
    {
      title: 'Tickets Sold',
      value: formatNumber(ticketsSold),
      hint: 'Across all events',
      icon: Ticket,
    },
    {
      title: 'Check-ins',
      value: formatNumber(checkIns),
      hint: 'Verified at the door',
      icon: CalendarCheck,
    },
    {
      title: 'Active Events',
      value: formatNumber(activeEvents),
      hint: 'Published and selling',
      icon: TrendingUp,
    },
  ];

  // Lazy-load the create event drawer
  const CreateEventDrawer = React.lazy(() =>
    import('@/features/events/create-event-drawer').then((m) => ({
      default: m.CreateEventDrawer,
    })),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">Your box office at a glance</p>
        </div>
        <Button onClick={() => setDrawerOpen(true)}>
          <Plus className="size-4" />
          Create event
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {eventsLoading
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)
          : eventsError
            ? Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="h-28">
                  <CardContent className="flex items-center justify-center p-4">
                    <ApiErrorState
                      error={eventsError}
                      onRetry={refetchEvents}
                      className="border-0 bg-transparent p-0"
                    />
                  </CardContent>
                </Card>
              ))
            : metrics.map((m) => (
                <Card key={m.title}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{m.title}</CardTitle>
                    <m.icon className="size-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{m.value}</div>
                    <p className="text-xs text-muted-foreground">{m.hint}</p>
                  </CardContent>
                </Card>
              ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Events</CardTitle>
          </CardHeader>
          <CardContent>
            {eventsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : eventsError ? (
              <ApiErrorState error={eventsError} onRetry={refetchEvents} />
            ) : events.length === 0 ? (
              <EmptyState
                icon={Ticket}
                title="No events yet"
                description="Create your first event to start selling tickets and tracking sales."
                action={
                  <Button onClick={() => setDrawerOpen(true)}>
                    <Plus className="size-4" />
                    Create event
                  </Button>
                }
              />
            ) : (
              <div className="space-y-3">
                {events.slice(0, 5).map((event) => (
                  <Link
                    key={event.id}
                    href={routes.eventDetail(event.id)}
                    prefetch={false}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{event.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(event.startsAt)} · {formatNumber(event.ticketsSold)} tickets
                      </p>
                    </div>
                    <EventStatusBadge status={event.status} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Orders</CardTitle>
          </CardHeader>
          <CardContent>
            {ordersLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : ordersError ? (
              <ApiErrorState error={ordersError} onRetry={refetchOrders} />
            ) : recentOrders.length === 0 ? (
              <EmptyState
                icon={DollarSign}
                title="No orders yet"
                description="Orders will appear here once attendees start buying tickets."
              />
            ) : (
              <div className="space-y-3">
                {recentOrders.map((order) => (
                  <Link
                    key={order.id}
                    href={routes.orderDetail(order.id)}
                    prefetch={false}
                    className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{order.buyerName ?? order.buyerEmail}</p>
                      <p className="text-sm text-muted-foreground">
                        {formatCurrency(order.totalCents, order.currency)} ·{' '}
                        {formatDate(order.createdAt)}
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

      <React.Suspense fallback={null}>
        <CreateEventDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onSuccess={() => {
            // Refetch via the data hooks instead of a full page reload.
            refetchEvents();
            refetchOrders();
          }}
        />
      </React.Suspense>
    </div>
  );
}
