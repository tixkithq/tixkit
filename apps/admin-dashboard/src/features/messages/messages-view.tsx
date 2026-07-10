'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Mail, MessageSquare, Plus, Smartphone } from 'lucide-react';
import {
  type AdminMessageCampaign,
  type AdminMessageDeliveryLog,
  type AdminMessageJob,
  type AdminMessageProviderEvent,
  adminApi,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { useAllEvents } from '@/hooks/use-all-events';
import { useBootstrap } from '@/context/bootstrap-provider';
import { formatDate } from '@/lib/format';
import { LifecycleEmailsView } from './lifecycle-emails-view';
import { MessageFormDialog } from './message-form';

type MessagesViewProps = {
  initialEventId?: string;
  initialLifecycleTemplateKey?: import('@tixkit/domain').TemplateKey;
  initialTab?: 'campaigns' | 'lifecycle';
};

function EventPicker({
  disabled,
  events,
  onValueChange,
  value,
}: {
  disabled: boolean;
  events: Array<{ id: string; title: string }>;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selectedEvent = events.find((event) => event.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-haspopup="listbox"
          className="w-full justify-between sm:w-[24rem]"
          disabled={disabled}
          variant="outline"
        >
          <span className="sr-only">Event: </span>
          <span className="truncate">{selectedEvent?.title ?? 'Select an event'}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput id="message-event-search" name="eventSearch" placeholder="Search events…" />
          <CommandList>
            <CommandEmpty>No events found.</CommandEmpty>
            {events.map((event) => (
              <CommandItem
                key={event.id}
                onSelect={() => {
                  onValueChange(event.id);
                  setOpen(false);
                }}
                value={`${event.title} ${event.id}`}
              >
                <Check className={event.id === value ? 'opacity-100' : 'opacity-0'} />
                <span className="truncate">{event.title}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function MessagesView({
  initialEventId,
  initialLifecycleTemplateKey,
  initialTab = 'campaigns',
}: MessagesViewProps = {}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [selectedEventId, setSelectedEventId] = React.useState<string>('');
  const [selectedCampaignId, setSelectedCampaignId] = React.useState<string>('');
  const [activeTab, setActiveTab] = React.useState<'campaigns' | 'lifecycle'>(initialTab);

  const { organizationId, brandId } = useBootstrap();
  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useAllEvents({ organizationId, brandId });

  const { data, loading, error, refetch } = useAdminQuery(['listMessages', selectedEventId], () =>
    selectedEventId
      ? adminApi.listMessages(selectedEventId)
      : Promise.resolve({
          ok: true as const,
          data: [] as AdminMessageCampaign[],
        }),
  );

  // Reset the selected event/campaign when the workspace/brand scope changes so
  // the selector does not retain an event that is no longer in the narrowed list.
  React.useEffect(() => {
    setSelectedEventId('');
    setSelectedCampaignId('');
  }, [organizationId, brandId]);

  React.useEffect(() => {
    if (eventsLoading || events.length === 0 || selectedEventId) return;
    const requestedEvent = initialEventId
      ? events.find((event) => event.id === initialEventId)
      : undefined;
    setSelectedEventId(requestedEvent?.id ?? events[0].id);
  }, [events, eventsLoading, initialEventId, selectedEventId]);

  const campaigns = data ?? [];
  const selectedEvent = events.find((event) => event.id === selectedEventId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <EventPicker
          disabled={eventsLoading || Boolean(eventsError)}
          events={events}
          value={selectedEventId}
          onValueChange={(value) => {
            setSelectedEventId(value);
            setSelectedCampaignId('');
          }}
        />
        {activeTab === 'campaigns' && (
          <Button
            onClick={() => setDialogOpen(true)}
            disabled={!selectedEventId || eventsLoading || Boolean(eventsError)}
          >
            <Plus className="size-4" />
            New campaign
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="lifecycle">Lifecycle emails</TabsTrigger>
        </TabsList>
        <TabsContent value="campaigns" className="mt-4">
          {eventsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : eventsError ? (
            <EmptyState
              icon={MessageSquare}
              title="Failed to load events"
              description={eventsError.message}
              action={<Button onClick={refetchEvents}>Try again</Button>}
            />
          ) : !selectedEventId ? (
            <EmptyState
              icon={MessageSquare}
              title="Select an event"
              description="Choose an event to view and create message campaigns for its attendees."
            />
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : error ? (
            <EmptyState
              icon={MessageSquare}
              title="Failed to load campaigns"
              description={error.message}
              action={<Button onClick={refetch}>Try again</Button>}
            />
          ) : campaigns.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No campaigns yet"
              description="Create a campaign to message attendees by channel and audience segment."
              action={
                <Button onClick={() => setDialogOpen(true)}>
                  <Plus className="size-4" />
                  New campaign
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              {campaigns.map((campaign) => (
                <Card key={campaign.id}>
                  <CardContent className="flex flex-col items-start justify-between gap-3 p-4 sm:flex-row sm:items-center">
                    <div className="flex min-w-0 items-start gap-3">
                      {campaign.channel === 'email' ? (
                        <Mail className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      ) : (
                        <Smartphone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="break-words font-medium">{campaign.name}</p>
                        <p className="break-words text-sm text-muted-foreground">
                          {campaign.audienceLabel} · {campaign.queuedCount} queued
                          {campaign.sentCount > 0 && ` · ${campaign.sentCount} sent`}
                          {campaign.deliveredCount > 0 && ` · ${campaign.deliveredCount} delivered`}
                          {campaign.failedCount > 0 && ` · ${campaign.failedCount} failed`}
                          {campaign.suppressedCount > 0 &&
                            ` · ${campaign.suppressedCount} suppressed`}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 sm:shrink-0 sm:justify-end">
                      <span className="text-sm text-muted-foreground">
                        {formatDate(campaign.createdAt)}
                      </span>
                      <Badge variant="outline" className="shrink-0">
                        {campaign.status}
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setSelectedCampaignId(campaign.id)}
                      >
                        Details
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {selectedEventId && selectedCampaignId && (
            <MessageCampaignDetailPanel eventId={selectedEventId} campaignId={selectedCampaignId} />
          )}
        </TabsContent>
        <TabsContent value="lifecycle" className="mt-4">
          <LifecycleEmailsView
            brandId={brandId}
            eventId={selectedEventId || undefined}
            eventTitle={selectedEvent?.title}
            initialTemplateKey={initialLifecycleTemplateKey}
          />
        </TabsContent>
      </Tabs>

      <MessageFormDialog
        eventId={selectedEventId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={refetch}
      />
    </div>
  );
}

export function MessageCampaignDetailPanel({
  eventId,
  campaignId,
}: {
  eventId: string;
  campaignId: string;
}) {
  const detailState = useAdminQuery(['getMessage', eventId, campaignId], () =>
    adminApi.getMessage(eventId, campaignId),
  );
  const jobsState = useAdminQuery(['listMessageJobs', eventId, campaignId], () =>
    adminApi.listMessageJobs(eventId, campaignId),
  );
  const deliveriesState = useAdminQuery(['listMessageDeliveryLogs', eventId, campaignId], () =>
    adminApi.listMessageDeliveryLogs(eventId, campaignId),
  );
  const providerEventsState = useAdminQuery(
    ['listMessageProviderEvents', eventId, campaignId],
    () => adminApi.listMessageProviderEvents(eventId, campaignId),
  );
  const detail = detailState.data;

  if (detailState.loading) return <Skeleton className="h-64 w-full" />;

  if (detailState.error || !detail) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Failed to load campaign detail"
        description={detailState.error?.message ?? 'Campaign detail was unavailable.'}
        action={<Button onClick={detailState.refetch}>Try again</Button>}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{detail.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-5">
          <Metric label="Queued" value={detail.queuedCount} />
          <Metric label="Sent" value={detail.sentCount} />
          <Metric label="Delivered" value={detail.deliveredCount} />
          <Metric label="Failed" value={detail.failedCount} />
          <Metric label="Suppressed" value={detail.suppressedCount} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Email jobs" value={detail.queuedEmailJobs} />
          <Metric label="SMS jobs" value={detail.queuedSmsJobs} />
          <Metric label="Consent exclusions" value={detail.consentExclusions} />
        </div>
        <JobTable
          rows={jobsState.data ?? []}
          loading={jobsState.loading}
          error={jobsState.error?.message}
          onRetry={jobsState.refetch}
        />
        <DeliveryLogTable
          rows={deliveriesState.data ?? []}
          loading={deliveriesState.loading}
          error={deliveriesState.error?.message}
          onRetry={deliveriesState.refetch}
        />
        <ProviderEventTable
          rows={providerEventsState.data ?? []}
          loading={providerEventsState.loading}
          error={providerEventsState.error?.message}
          onRetry={providerEventsState.refetch}
        />
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function JobTable({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: AdminMessageJob[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <RecordTable
      title="Jobs"
      loading={loading}
      error={error}
      onRetry={onRetry}
      rows={rows.map((row) => ({
        id: stringField(row.job, 'id'),
        channel: row.channel,
        status: stringField(row.job, 'status'),
        subject: stringField(row.job, 'recipient') || stringField(row.job, 'template_key'),
        updatedAt: stringField(row.job, 'updated_at'),
      }))}
    />
  );
}

function DeliveryLogTable({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: AdminMessageDeliveryLog[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <RecordTable
      title="Delivery logs"
      loading={loading}
      error={error}
      onRetry={onRetry}
      rows={rows.map((row) => ({
        id: stringField(row.delivery, 'id'),
        channel: row.channel,
        status: stringField(row.delivery, 'status'),
        subject:
          stringField(row.delivery, 'provider_message_id') || stringField(row.delivery, 'job_id'),
        updatedAt:
          stringField(row.delivery, 'updated_at') || stringField(row.delivery, 'created_at'),
      }))}
    />
  );
}

function ProviderEventTable({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: AdminMessageProviderEvent[];
  loading: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <RecordTable
      title="Provider events"
      loading={loading}
      error={error}
      onRetry={onRetry}
      rows={rows.map((row) => ({
        id: stringField(row.event, 'id') || stringField(row.event, 'provider_event_id'),
        channel: row.channel,
        status: stringField(row.event, 'event_type'),
        subject: stringField(row.event, 'provider_message_id') || stringField(row.event, 'job_id'),
        updatedAt: stringField(row.event, 'occurred_at') || stringField(row.event, 'created_at'),
      }))}
    />
  );
}

function RecordTable({
  title,
  loading,
  error,
  onRetry,
  rows,
}: {
  title: string;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  rows: Array<{ id: string; channel: string; status: string; subject: string; updatedAt: string }>;
}) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm">
        <p className="font-medium">{title}</p>
        <Badge variant={error ? 'destructive' : 'outline'}>{error ? 'error' : rows.length}</Badge>
      </div>
      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : rows.length === 0 ? (
        <p className="p-3 text-sm text-muted-foreground">No records.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">ID</th>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Subject</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${title}-${row.channel}-${row.id}`} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{row.id || '-'}</td>
                  <td className="px-3 py-2">{row.channel}</td>
                  <td className="px-3 py-2">{row.status || '-'}</td>
                  <td className="px-3 py-2">{row.subject || '-'}</td>
                  <td className="px-3 py-2">{row.updatedAt ? formatDate(row.updatedAt) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}
