'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Ticket,
  Users,
  QrCode,
  MessageSquare,
  PenTool,
  BarChart3,
  ClipboardList,
  Package,
  MapPin,
  Globe,
  Pencil,
  ExternalLink,
  Calendar,
  FileText,
} from 'lucide-react';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiErrorState } from '@/components/api-error-state';
import { toast } from 'sonner';
import { EventStatusBadge, TicketTypeStatusBadge, OrderStatusBadge } from './event-status-badge';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { formatCurrency, formatDate, formatNumber } from '@/lib/format';
import { publicEventUrl } from '@/lib/event-links';
import { useBootstrap } from '@/context/bootstrap-provider';
import { usePermissions } from '@/context/permission-provider';
import { EventLaunchPanel } from './event-launch-panel';
import { PublishPreflightDialog } from './publish-preflight-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PublishedEventNextActions } from './published-event-next-actions';
import { useRuntimeConfig } from '@/context/runtime-config-provider';

export function EventDetailView({ eventId }: { eventId: string }) {
  const runtimeConfig = useRuntimeConfig();
  const {
    data: event,
    loading,
    error,
  } = useAdminQuery(['getEvent', eventId], () => adminApi.getEvent(eventId));
  const {
    data: ticketTypes,
    loading: ticketsLoading,
    error: ticketsError,
    refetch: refetchTickets,
  } = useAdminQuery(['listTicketTypes', eventId], () => adminApi.listTicketTypes(eventId));
  const { data: ordersData } = useAdminQuery(['listOrders', eventId], () =>
    adminApi.listOrders({
      filters: { eventId: { type: 'select', values: [eventId] } },
      limit: 5,
    }),
  );
  const {
    data: messages,
    loading: messagesLoading,
    error: messagesError,
    refetch: refetchMessages,
  } = useAdminQuery(['listMessages', eventId, 'operational-health'], () =>
    adminApi.listMessages(eventId),
  );
  const {
    data: launchReadiness,
    loading: readinessLoading,
    error: readinessError,
    refetch: refetchReadiness,
  } = useAdminQuery(['eventLaunchReadiness', eventId], () =>
    adminApi.getEventLaunchReadiness(eventId),
  );
  const {
    data: operationalHealth,
    loading: operationalHealthLoading,
    error: operationalHealthError,
    refetch: refetchOperationalHealth,
  } = useAdminQuery(['eventOperationalHealth', eventId], () =>
    adminApi.getEventOperationalHealth(eventId),
  );
  const { brands } = useBootstrap();
  const { can } = usePermissions();
  const [preflightOpen, setPreflightOpen] = React.useState(false);
  const [lifecycleAction, setLifecycleAction] = React.useState<'pause' | 'archive'>();
  const [lifecycleError, setLifecycleError] = React.useState<string>();
  const [setupWarning, setSetupWarning] = React.useState<string>();
  const [showCreationFollowUp, setShowCreationFollowUp] = React.useState(false);
  React.useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const warning = search.get('setupWarning');
    const created = search.get('created') === '1';
    if (!warning && !created) return;
    if (warning) setSetupWarning(warning);
    if (created) setShowCreationFollowUp(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('setupWarning');
    url.searchParams.delete('created');
    window.history.replaceState(window.history.state, '', url);
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-full max-w-xs" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !event) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Event not found</h1>
        <p className="text-muted-foreground">
          {error?.message ?? 'The event you are looking for does not exist.'}
        </p>
        <Button asChild>
          <Link href={routes.events} prefetch={false}>
            Back to events
          </Link>
        </Button>
      </div>
    );
  }

  const recentOrders = ordersData?.items ?? [];
  const tickets = ticketTypes ?? [];
  const shareUrl = publicEventUrl(event, brands, runtimeConfig);
  const eventDescription =
    typeof event.description === 'string' && event.description.trim().length > 0
      ? event.description.trim()
      : undefined;
  const paymentStep = launchReadiness?.steps.find((step) => step.id === 'payment_readiness');
  const checkInStep = launchReadiness?.steps.find((step) => step.id === 'check_in_configuration');
  const lowInventory = tickets.filter((ticket) => {
    if (ticket.status !== 'active') return false;
    if (!ticket.quantityTotal) return false;
    return ticket.quantityTotal - ticket.quantitySold <= Math.max(ticket.maxPerOrder ?? 1, 5);
  });
  const messagingFailures = (messages ?? []).reduce(
    (total, message) => total + message.failedCount,
    0,
  );
  const messagingSuppressions = (messages ?? []).reduce(
    (total, message) => total + message.suppressedCount,
    0,
  );
  const publishedSignalState =
    ticketsLoading || messagesLoading || readinessLoading
      ? 'checking'
      : ticketsError || messagesError || readinessError || !launchReadiness
        ? 'incomplete'
        : 'ready';
  const messagingHealthCopy = (() => {
    if (messagesLoading || messagesError) return 'Messaging health unavailable.';
    const suppressionCopy = messagingSuppressions
      ? `${messagingSuppressions} recipient${messagingSuppressions === 1 ? ' was' : 's were'} safely suppressed by consent or delivery policy.`
      : '';
    if (messagingFailures) {
      return `${messagingFailures} failed delivery outcome${messagingFailures === 1 ? '' : 's'}.${suppressionCopy ? ` ${suppressionCopy}` : ''}`;
    }
    return suppressionCopy
      ? `No failed deliveries. ${suppressionCopy}`
      : 'No failed deliveries or policy suppressions detected.';
  })();

  const copyShareUrl = async () => {
    const writeText = navigator.clipboard?.writeText;
    if (!writeText) {
      toast.error('Copy unavailable. Select and copy the public event URL manually.');
      return;
    }

    try {
      await writeText.call(navigator.clipboard, shareUrl);
      toast.success('Public event link copied');
    } catch {
      toast.error('Unable to copy public event link. Select and copy it manually.');
    }
  };

  const quickLinks = [
    { title: 'Tickets', icon: Ticket, href: routes.eventTickets(eventId) },
    { title: 'Products', icon: Package, href: routes.eventProducts(eventId) },
    {
      title: 'Checkout Form',
      icon: ClipboardList,
      href: routes.eventCheckoutForm(eventId),
    },
    {
      title: 'Event Page',
      icon: PenTool,
      href: routes.eventContentEventPage(eventId),
    },
    {
      title: 'Embed studio',
      icon: Globe,
      href: routes.eventEmbedStudio(eventId),
    },
    { title: 'Attendees', icon: Users, href: routes.eventAttendees(eventId) },
    { title: 'Check-in', icon: QrCode, href: routes.eventCheckIn(eventId) },
    ...(can('messages.write')
      ? [
          {
            title: 'Messages',
            icon: MessageSquare,
            href: routes.eventMessages(eventId),
          },
        ]
      : []),
    { title: 'Reports', icon: BarChart3, href: routes.eventReports(eventId) },
  ];

  return (
    <div className="space-y-6">
      {showCreationFollowUp && can('events.write') ? (
        <output className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 p-4 text-sm">
          <span>
            <span className="block font-semibold">Your event draft is ready.</span>
            <span className="block text-foreground">
              Add a poster or cover next so dashboard, event-page, and social previews use optimized
              event media.
            </span>
          </span>
          <Button asChild size="sm">
            <Link href={`${routes.eventSettings(eventId)}#media`}>Add event media</Link>
          </Button>
        </output>
      ) : null}
      {setupWarning ? (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <p className="font-semibold">Your draft was created, but its preset needs attention.</p>
          <p>{setupWarning}</p>
          <p className="mt-1">Use the launch checklist below to finish the missing setup.</p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{event.title}</h1>
            <EventStatusBadge status={event.status} />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Calendar className="size-4" />
              {formatDate(event.startsAt)}
            </span>
            {event.venueName && (
              <span className="flex items-center gap-1">
                <MapPin className="size-4" />
                {event.venueName}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Globe className="size-4" />
              {event.timezone}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can('events.write') && event.status !== 'published' && event.status !== 'archived' ? (
            <Button
              className="disabled:bg-slate-700 disabled:text-white disabled:opacity-100"
              disabled={readinessLoading || Boolean(readinessError) || !launchReadiness}
              onClick={() => setPreflightOpen(true)}
            >
              {readinessLoading ? 'Checking readiness…' : 'Review and publish'}
            </Button>
          ) : null}
          {can('events.write') && event.status === 'published' ? (
            <Button variant="outline" onClick={() => setLifecycleAction('pause')}>
              Pause sales
            </Button>
          ) : null}
          {can('events.write') && event.status !== 'archived' ? (
            <Button variant="destructive" onClick={() => setLifecycleAction('archive')}>
              Archive
            </Button>
          ) : null}
          {event.status === 'published' ? null : (
            <Button variant="outline" asChild>
              <Link href={routes.eventPreview(eventId)}>
                <ExternalLink className="size-4" />
                Authenticated preview
              </Link>
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href={routes.eventSettings(eventId)}>
              <Pencil className="size-4" />
              Settings
            </Link>
          </Button>
        </div>
      </div>

      {event.status !== 'published' && readinessLoading ? (
        <Skeleton className="h-72 w-full" aria-label="Loading launch readiness" />
      ) : null}
      {event.status !== 'published' && readinessError ? (
        <ApiErrorState error={readinessError} onRetry={() => void refetchReadiness()} />
      ) : null}
      {launchReadiness && event.status !== 'published' ? (
        <EventLaunchPanel eventId={eventId} readiness={launchReadiness} />
      ) : null}
      {event.status === 'published' ? (
        <PublishedEventNextActions
          eventId={eventId}
          publicUrl={shareUrl}
          lowInventoryCount={lowInventory.length}
          checkInNeedsAttention={Boolean(
            checkInStep &&
            checkInStep.status !== 'complete' &&
            checkInStep.status !== 'not_applicable',
          )}
          messagingFailureCount={messagingFailures}
          signalState={publishedSignalState}
          can={can}
          onCopyPublicUrl={copyShareUrl}
          onRetrySignals={() => {
            void refetchTickets();
            void refetchMessages();
            void refetchReadiness();
          }}
        />
      ) : null}
      {launchReadiness && event.status === 'published' ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Operational health</CardTitle>
            </CardHeader>
            <CardContent>
              {ticketsLoading || messagesLoading ? (
                <output className="mb-3 block text-sm text-muted-foreground">
                  Checking inventory and messaging health…
                </output>
              ) : null}
              {ticketsError || messagesError ? (
                <div
                  role="alert"
                  className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-3 text-sm"
                >
                  <span>
                    Operational health is incomplete. Some live signals could not be loaded.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void refetchTickets();
                      void refetchMessages();
                    }}
                  >
                    Retry health checks
                  </Button>
                </div>
              ) : null}
              <ul
                className="grid gap-3 text-sm sm:grid-cols-2"
                aria-label="Event operational health"
              >
                <li className="rounded-md border p-3">
                  <span className="font-medium">Payments</span>
                  <p className="text-muted-foreground">
                    {paymentStep?.status === 'complete' || paymentStep?.status === 'not_applicable'
                      ? 'No payment restriction detected.'
                      : 'Payment readiness needs attention.'}
                  </p>
                </li>
                <li className="rounded-md border p-3">
                  <span className="font-medium">Inventory</span>
                  <p className="text-muted-foreground">
                    {ticketsLoading || ticketsError
                      ? 'Inventory health unavailable.'
                      : lowInventory.length
                        ? `${lowInventory.length} ticket type${lowInventory.length === 1 ? '' : 's'} at inventory risk.`
                        : 'No low-inventory risk detected.'}
                  </p>
                </li>
                <li className="rounded-md border p-3">
                  <span className="font-medium">Messaging</span>
                  <p className="text-muted-foreground">{messagingHealthCopy}</p>
                </li>
                <li className="rounded-md border p-3">
                  <span className="font-medium">Schedule and check-in</span>
                  <p className="text-muted-foreground">
                    {checkInStep?.status === 'complete' || checkInStep?.status === 'not_applicable'
                      ? 'Check-in configuration is healthy.'
                      : 'Review check-in configuration before doors open.'}
                  </p>
                </li>
                <li className="rounded-md border p-3">
                  <span className="font-medium">Organization webhooks</span>
                  <p className="text-muted-foreground">
                    {operationalHealthLoading
                      ? 'Checking webhook delivery health…'
                      : operationalHealthError
                        ? 'Webhook delivery health unavailable.'
                        : operationalHealth?.organizationFailedWebhookDeliveries
                          ? `${operationalHealth.organizationFailedWebhookDeliveries} failed or dead-lettered ${operationalHealth.organizationFailedWebhookDeliveries === 1 ? 'webhook delivery' : 'webhook deliveries'} across this organization.`
                          : 'No failed webhook deliveries detected across this organization.'}
                  </p>
                  <Link className="text-primary hover:underline" href={routes.developerWebhooks}>
                    Review webhooks
                  </Link>
                </li>
                <li className="rounded-md border p-3">
                  <span className="font-medium">Exports</span>
                  <p className="text-muted-foreground">
                    {operationalHealthLoading
                      ? 'Checking export health…'
                      : operationalHealthError
                        ? 'Export health unavailable.'
                        : operationalHealth?.failedExports
                          ? `${operationalHealth.failedExports} failed export${operationalHealth.failedExports === 1 ? '' : 's'}.`
                          : 'No failed exports detected.'}
                  </p>
                  <Link
                    className="text-primary hover:underline"
                    href={routes.eventReports(eventId)}
                  >
                    Review exports
                  </Link>
                </li>
              </ul>
              {operationalHealthError ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refetchOperationalHealth()}
                >
                  Retry webhook and export health
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <details className="rounded-lg border p-4">
            <summary className="cursor-pointer font-medium">Setup and launch readiness</summary>
            <div className="mt-4">
              <EventLaunchPanel eventId={eventId} readiness={launchReadiness} />
            </div>
          </details>
        </>
      ) : null}

      {launchReadiness ? (
        <PublishPreflightDialog
          open={preflightOpen}
          onOpenChange={setPreflightOpen}
          eventId={eventId}
          readiness={launchReadiness}
          onPublished={() => {
            void refetchReadiness();
            window.location.reload();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={lifecycleAction !== undefined}
        onOpenChange={(open) => {
          if (!open) setLifecycleAction(undefined);
        }}
        title={lifecycleAction === 'archive' ? 'Archive this event?' : 'Pause ticket sales?'}
        description={
          lifecycleAction === 'archive'
            ? 'Archiving is an audited lifecycle transition. The event can no longer be published.'
            : 'Public sales pause until the event passes preflight and is published again.'
        }
        confirmText={lifecycleAction === 'archive' ? 'Archive event' : 'Pause sales'}
        variant={lifecycleAction === 'archive' ? 'destructive' : 'default'}
        onConfirm={async () => {
          if (!lifecycleAction) return;
          setLifecycleError(undefined);
          const result =
            lifecycleAction === 'archive'
              ? await adminApi.archiveEvent(eventId)
              : await adminApi.pauseEvent(eventId);
          if (!result.ok) {
            setLifecycleError(result.error.message);
            return;
          }
          window.location.reload();
        }}
      >
        {lifecycleError ? (
          <p role="alert" className="text-sm text-destructive">
            {lifecycleError}
          </p>
        ) : null}
      </ConfirmDialog>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Gross Sales"
          value={formatCurrency(event.grossSalesCents, event.currency)}
        />
        <MetricCard
          title="Tickets Sold"
          value={formatNumber(event.ticketsSold)}
          sub={event.capacity ? `of ${formatNumber(event.capacity)}` : undefined}
        />
        <MetricCard title="Check-ins" value={formatNumber(event.checkIns)} />
        <MetricCard title="Currency" value={event.currency} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-5 text-muted-foreground" />
            Event Description
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Shared event copy used by previews, merge tags, and hosted event page defaults.
          </p>
        </CardHeader>
        <CardContent>
          {eventDescription ? (
            <p className="whitespace-pre-line text-sm leading-6 text-foreground">
              {eventDescription}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No description yet. Add the canonical event copy in Settings, then place or style it
              in the Event Page editor.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Quick Links</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2">
              {quickLinks.map((link) => (
                <Link
                  key={link.title}
                  href={link.href}
                  prefetch={false}
                  className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent/50 transition-colors"
                >
                  <link.icon className="size-5 text-muted-foreground" />
                  <span className="font-medium">{link.title}</span>
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
              <p className="text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <div className="space-y-2">
                {recentOrders.map((order) => (
                  <Link
                    key={order.id}
                    href={routes.orderDetail(order.id)}
                    prefetch={false}
                    className="flex items-center justify-between rounded-lg border p-2 hover:bg-accent/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {order.buyerName ?? order.buyerEmail}
                      </p>
                      <p className="text-xs text-muted-foreground">
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
            <p className="text-sm text-muted-foreground">
              No ticket types configured.{' '}
              <Link
                href={routes.eventTickets(eventId)}
                prefetch={false}
                className="font-medium underline"
              >
                Add tickets →
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              {tickets.map((tt) => (
                <div
                  key={tt.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium">{tt.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatCurrency(tt.priceCents, tt.currency)} · {formatNumber(tt.quantitySold)}
                      {tt.quantityTotal ? ` / ${formatNumber(tt.quantityTotal)}` : ''} sold
                    </p>
                  </div>
                  <TicketTypeStatusBadge status={tt.status} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
