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
import { DashboardActionFeed } from './dashboard-action-feed';
import { OrderStatusBadge } from '@/features/events/event-status-badge';
import { useBootstrap } from '@/context/bootstrap-provider';
import { usePermissions } from '@/context/permission-provider';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { useAllEvents } from '@/hooks/use-all-events';
import { formatCurrency, formatNumber, formatDate } from '@/lib/format';
import { AuthenticatedEventImage } from '@/features/events/authenticated-event-image';

export function DashboardView() {
  const { organizationId, brandId } = useBootstrap();
  const { can } = usePermissions();
  const canReadOrders = can('orders.read');
  const workspaceSelected = Boolean(organizationId && brandId);
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useAllEvents({ organizationId, brandId, enabled: workspaceSelected });
  const {
    data: ordersData,
    loading: ordersLoading,
    error: ordersError,
    refetch: refetchOrders,
  } = useAdminQuery(
    ['listOrders', organizationId, brandId],
    () => {
      const params: {
        limit: number;
        organizationId?: string;
        brandId?: string;
      } = { limit: 5 };
      if (organizationId) params.organizationId = organizationId;
      if (brandId) params.brandId = brandId;
      return adminApi.listOrders(params);
    },
    { enabled: workspaceSelected && canReadOrders },
  );

  const recentOrders = ordersData?.items ?? [];

  const grossByCurrency = events.reduce<Record<string, number>>((totals, event) => {
    totals[event.currency] = (totals[event.currency] ?? 0) + event.grossSalesCents;
    return totals;
  }, {});
  const grossCurrencies = Object.entries(grossByCurrency);
  const ticketsSold = events.reduce((sum, e) => sum + e.ticketsSold, 0);
  const checkIns = events.reduce((sum, e) => sum + e.checkIns, 0);
  const activeEvents = events.filter((e) => e.status === 'published').length;
  const nextDraft = events.reduce<(typeof events)[number] | undefined>((latest, event) => {
    if (event.status !== 'draft') return latest;
    return !latest || event.updatedAt > latest.updatedAt ? event : latest;
  }, undefined);

  const metrics = [
    {
      title: 'Gross Sales',
      value:
        grossCurrencies.length === 0
          ? formatCurrency(0, 'USD')
          : grossCurrencies.length === 1
            ? formatCurrency(grossCurrencies[0]![1], grossCurrencies[0]![0])
            : `${grossCurrencies.length} currencies`,
      hint:
        grossCurrencies.length > 1
          ? grossCurrencies
              .map(([currency, amount]) => formatCurrency(amount, currency))
              .join(' · ')
          : `${events.length} event${events.length === 1 ? '' : 's'}`,
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">Your box office at a glance</p>
        </div>
        {can('events.write') ? (
          <Button asChild>
            <Link href={routes.newEvent}>
              <Plus className="size-4" />
              Create event
            </Link>
          </Button>
        ) : null}
      </div>

      <DashboardActionFeed />

      {!workspaceSelected ? (
        <Card>
          <CardHeader>
            <CardTitle>Select a workspace</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Choose an organization and brand to load scoped events, orders, and readiness.
          </CardContent>
        </Card>
      ) : null}

      {!eventsLoading && !eventsError && nextDraft ? (
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle>Continue launching {nextDraft.title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Resume the server-owned launch checklist from the most recently updated draft.
            </p>
            <Button asChild>
              <Link href={routes.eventDetail(nextDraft.id)}>Continue setup</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

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
                  can('events.write') ? (
                    <Button asChild>
                      <Link href={routes.newEvent}>
                        <Plus className="size-4" />
                        Create event
                      </Link>
                    </Button>
                  ) : undefined
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
                    <div className="flex min-w-0 items-center gap-3">
                      <AuthenticatedEventImage
                        source={event.thumbnail}
                        className="size-12 rounded-md"
                        fallbackClassName="size-12"
                      />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{event.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatDate(event.startsAt)} · {formatNumber(event.ticketsSold)} tickets
                        </p>
                      </div>
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
            {!canReadOrders ? (
              <p className="text-sm text-muted-foreground">
                Orders access is required to view recent purchases.
              </p>
            ) : ordersLoading ? (
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
    </div>
  );
}
