'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Ticket,
  Users,
  QrCode,
  MessageSquare,
  BarChart3,
  ClipboardList,
  Calendar,
  Package,
  MapPin,
  Globe,
  Pencil,
  Save,
  Copy,
  ExternalLink,
} from 'lucide-react';
import {
  adminApi,
  type AdminMarketingIntegration,
  type AdminMarketingIntegrationProvider,
} from '@/lib/api';
import { routes } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { EventStatusBadge, TicketTypeStatusBadge, OrderStatusBadge } from './event-status-badge';
import { useAdminData } from '@/hooks/use-admin-data';
import { formatCurrency, formatDate, formatNumber } from '@/lib/format';
import { publicEventUrl } from '@/lib/event-links';
import { useBootstrap } from '@/context/bootstrap-provider';
import { CreateEventDrawer } from './create-event-drawer';

const EMPTY_MARKETING_INTEGRATIONS: AdminMarketingIntegration[] = [];

export function EventDetailView({ eventId }: { eventId: string }) {
  const {
    data: event,
    loading,
    error,
    refetch,
  } = useAdminData(() => adminApi.getEvent(eventId), [eventId]);
  const { data: ticketTypes } = useAdminData(() => adminApi.listTicketTypes(eventId), [eventId]);
  const { data: ordersData } = useAdminData(
    () => adminApi.listOrders({ eventId, limit: 5 }),
    [eventId],
  );
  const { data: marketingIntegrations, refetch: refetchMarketing } = useAdminData(
    () => adminApi.listMarketingIntegrations(eventId),
    [eventId],
  );
  const { brands } = useBootstrap();
  const [editOpen, setEditOpen] = React.useState(false);

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
  const shareUrl = publicEventUrl(event, brands);

  const copyShareUrl = async () => {
    await navigator.clipboard?.writeText(shareUrl);
    toast.success('Public event link copied');
  };

  const quickLinks = [
    { title: 'Tickets', icon: Ticket, href: routes.eventTickets(eventId) },
    { title: 'Products', icon: Package, href: routes.eventProducts(eventId) },
    { title: 'Checkout Form', icon: ClipboardList, href: routes.eventCheckoutForm(eventId) },
    { title: 'Attendees', icon: Users, href: routes.eventAttendees(eventId) },
    { title: 'Check-in', icon: QrCode, href: routes.eventCheckIn(eventId) },
    { title: 'Messages', icon: MessageSquare, href: routes.eventMessages(eventId) },
    { title: 'Reports', icon: BarChart3, href: routes.eventReports(eventId) },
  ];

  return (
    <div className="space-y-6">
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
          <Button variant="outline" asChild>
            <a href={shareUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" />
              Open public page
            </a>
          </Button>
          <Button variant="outline" onClick={copyShareUrl}>
            <Copy className="size-4" />
            Copy link
          </Button>
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="size-4" />
            Edit
          </Button>
        </div>
      </div>

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

      <MarketingIntegrationsPanel
        eventId={eventId}
        integrations={marketingIntegrations ?? EMPTY_MARKETING_INTEGRATIONS}
        onSaved={refetchMarketing}
      />

      <CreateEventDrawer
        open={editOpen}
        onOpenChange={setEditOpen}
        event={event}
        onSuccess={refetch}
      />
    </div>
  );
}

type MarketingDraft = {
  value: string;
  consentRequired: boolean;
  status: 'active' | 'disabled';
  saving: boolean;
  error?: string;
};

const MARKETING_PROVIDERS: Array<{
  provider: AdminMarketingIntegrationProvider;
  title: string;
  field: 'measurementId' | 'pixelId' | 'pixelUrl';
  placeholder: string;
}> = [
  {
    provider: 'ga4',
    title: 'Google Analytics 4',
    field: 'measurementId',
    placeholder: 'G-XXXXXXXXXX',
  },
  { provider: 'meta_pixel', title: 'Meta Pixel', field: 'pixelId', placeholder: '123456789012345' },
  {
    provider: 'generic_tag',
    title: 'Generic HTTPS Pixel',
    field: 'pixelUrl',
    placeholder: 'https://analytics.example/pixel',
  },
];

function MarketingIntegrationsPanel({
  eventId,
  integrations,
  onSaved,
}: {
  eventId: string;
  integrations: AdminMarketingIntegration[];
  onSaved: () => void | Promise<void>;
}) {
  const [drafts, setDrafts] = React.useState<
    Record<AdminMarketingIntegrationProvider, MarketingDraft>
  >({
    ga4: { value: '', consentRequired: true, status: 'disabled', saving: false },
    meta_pixel: { value: '', consentRequired: true, status: 'disabled', saving: false },
    generic_tag: { value: '', consentRequired: true, status: 'disabled', saving: false },
  });

  React.useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const spec of MARKETING_PROVIDERS) {
        const integration = integrations.find((item) => item.provider === spec.provider);
        next[spec.provider] = {
          value:
            typeof integration?.config[spec.field] === 'string'
              ? String(integration.config[spec.field])
              : '',
          consentRequired: integration?.consentRequired ?? true,
          status: integration?.status ?? 'disabled',
          saving: false,
        };
      }
      return next;
    });
  }, [integrations]);

  async function saveProvider(spec: (typeof MARKETING_PROVIDERS)[number]) {
    const draft = drafts[spec.provider];
    setDrafts((current) => ({
      ...current,
      [spec.provider]: { ...current[spec.provider], saving: true, error: undefined },
    }));
    const result = await adminApi.upsertMarketingIntegration(eventId, {
      provider: spec.provider,
      config: { [spec.field]: draft.value.trim() },
      consentRequired: draft.consentRequired,
      status: draft.status,
    });
    setDrafts((current) => ({
      ...current,
      [spec.provider]: {
        ...current[spec.provider],
        saving: false,
        error: result.ok ? undefined : result.error.message,
      },
    }));
    if (result.ok) await onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Marketing Integrations</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-3">
        {MARKETING_PROVIDERS.map((spec) => {
          const draft = drafts[spec.provider];
          const disabled = draft.saving || (draft.status === 'active' && !draft.value.trim());
          return (
            <div key={spec.provider} className="rounded-md border p-4">
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold">{spec.title}</p>
                  {draft.error ? (
                    <p className="mt-1 text-xs text-destructive">{draft.error}</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${spec.provider}-value`}>{spec.field}</Label>
                  <Input
                    id={`${spec.provider}-value`}
                    value={draft.value}
                    placeholder={spec.placeholder}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [spec.provider]: { ...current[spec.provider], value: event.target.value },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${spec.provider}-status`}>Active</Label>
                  <Switch
                    id={`${spec.provider}-status`}
                    checked={draft.status === 'active'}
                    onCheckedChange={(checked) =>
                      setDrafts((current) => ({
                        ...current,
                        [spec.provider]: {
                          ...current[spec.provider],
                          status: checked ? 'active' : 'disabled',
                        },
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor={`${spec.provider}-consent`}>Require consent</Label>
                  <Switch
                    id={`${spec.provider}-consent`}
                    checked={draft.consentRequired}
                    onCheckedChange={(checked) =>
                      setDrafts((current) => ({
                        ...current,
                        [spec.provider]: { ...current[spec.provider], consentRequired: checked },
                      }))
                    }
                  />
                </div>
                <Button size="sm" onClick={() => void saveProvider(spec)} disabled={disabled}>
                  <Save className="size-4" />
                  {draft.saving ? 'Saving' : 'Save'}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
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
