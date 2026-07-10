'use client';

import * as React from 'react';
import Link from 'next/link';
import { Mail, Pencil, RefreshCw, Search } from 'lucide-react';
import { TEMPLATE_LIFECYCLES, type TemplateKey, type TemplateLifecycle } from '@tixkit/domain';
import { type AdminContentDocument, type AdminEventDetail, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

type LifecycleEmailCoverage = {
  event?: AdminEventDetail;
  brandDocuments: AdminContentDocument[];
  eventDocuments: AdminContentDocument[];
};

export type LifecycleEmailsViewProps = {
  brandId?: string;
  eventId?: string;
  eventTitle?: string;
  initialTemplateKey?: TemplateKey;
};

const LIFECYCLE_GROUPS = [
  {
    tier: 'P0',
    title: 'Essential',
    description: 'Orders, tickets, event updates, and check-in',
  },
  {
    tier: 'P1',
    title: 'Attendee journey',
    description: 'Waitlists, transfers, retention, and reporting',
  },
  {
    tier: 'P2',
    title: 'Operations',
    description: 'Payouts, integrations, delivery, and disputes',
  },
] as const satisfies ReadonlyArray<{
  tier: TemplateLifecycle['tier'];
  title: string;
  description: string;
}>;

function listItemsFromResponse<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return [];
  const keyed = value as { items?: unknown };
  if (Array.isArray(keyed.items)) return keyed.items as T[];
  return Object.values(value).filter(
    (item): item is T => Boolean(item) && typeof item === 'object',
  );
}

function statusVariant(status: AdminContentDocument['status']) {
  return status === 'published' ? 'default' : status === 'archived' ? 'destructive' : 'outline';
}

function audienceLabel(audience: TemplateLifecycle['defaultAudience']) {
  return audience
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function purposeLabel(category: TemplateLifecycle['category']) {
  if (category === 'bulk') return 'Bulk';
  if (category === 'staff') return 'Staff';
  if (category === 'system') return 'System';
  return 'Transactional';
}

function editorHref(eventId: string, key: string) {
  const returnTo = `/events/${eventId}/messages?tab=lifecycle&templateKey=${encodeURIComponent(key)}`;
  return `/events/${eventId}/content/email?templateKey=${encodeURIComponent(key)}&returnTo=${encodeURIComponent(returnTo)}`;
}

export function LifecycleEmailsView({
  brandId,
  eventId,
  eventTitle,
  initialTemplateKey,
}: LifecycleEmailsViewProps) {
  const [selectedTemplateKey, setSelectedTemplateKey] = React.useState(
    initialTemplateKey ?? TEMPLATE_LIFECYCLES[0].key,
  );
  const [searchQuery, setSearchQuery] = React.useState('');
  React.useEffect(() => {
    if (initialTemplateKey) setSelectedTemplateKey(initialTemplateKey);
  }, [initialTemplateKey]);
  const selectedLifecycle =
    TEMPLATE_LIFECYCLES.find((lifecycle) => lifecycle.key === selectedTemplateKey) ??
    TEMPLATE_LIFECYCLES[0];
  const coverageState = useAdminQuery<LifecycleEmailCoverage>(
    ['lifecycleEmailCoverage', brandId, eventId],
    async () => {
      let resolvedBrandId = brandId;
      let event: AdminEventDetail | undefined;

      if (eventId && !resolvedBrandId) {
        const eventResult = await adminApi.getEvent(eventId);
        if (!eventResult.ok) return eventResult;
        event = eventResult.data;
        resolvedBrandId = event.brandId;
      }

      const [brandDocumentsResult, eventDocumentsResult] = await Promise.all([
        resolvedBrandId
          ? adminApi.listContentDocuments({
              brandId: resolvedBrandId,
              channel: 'email',
              limit: 100,
            })
          : Promise.resolve({
              ok: true as const,
              data: {
                items: [] as AdminContentDocument[],
                nextCursor: null,
                hasMore: false,
              },
            }),
        eventId
          ? adminApi.listContentDocuments({
              channel: 'email',
              eventId,
              limit: 100,
            })
          : Promise.resolve({
              ok: true as const,
              data: {
                items: [] as AdminContentDocument[],
                nextCursor: null,
                hasMore: false,
              },
            }),
      ]);

      if (!brandDocumentsResult.ok) return brandDocumentsResult;
      if (!eventDocumentsResult.ok) return eventDocumentsResult;

      return {
        ok: true as const,
        data: {
          event,
          brandDocuments: listItemsFromResponse<AdminContentDocument>(brandDocumentsResult.data),
          eventDocuments: listItemsFromResponse<AdminContentDocument>(eventDocumentsResult.data),
        },
      };
    },
    { enabled: Boolean(brandId || eventId) },
  );

  if (!brandId && !eventId) {
    return (
      <EmptyState
        icon={Mail}
        title="Choose an event"
        description="Select an event to review lifecycle email defaults and event overrides."
      />
    );
  }

  if (coverageState.loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton className="h-32 w-full" key={index} />
        ))}
      </div>
    );
  }

  if (coverageState.error || !coverageState.data) {
    return (
      <EmptyState
        icon={Mail}
        title="Failed to load lifecycle emails"
        description={coverageState.error?.message ?? 'Lifecycle email coverage was unavailable.'}
        action={
          <Button onClick={coverageState.refetch} type="button">
            <RefreshCw className="size-4" />
            Try again
          </Button>
        }
      />
    );
  }

  const resolvedEventTitle = eventTitle ?? coverageState.data.event?.title;
  const brandDefaults = coverageState.data.brandDocuments.filter(
    (document) =>
      document.channel === 'email' && !document.eventId && document.status !== 'archived',
  );
  const eventOverrides = coverageState.data.eventDocuments.filter(
    (document) => document.channel === 'email' && document.eventId === eventId,
  );
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredLifecycles = TEMPLATE_LIFECYCLES.filter((lifecycle) =>
    [
      lifecycle.name,
      lifecycle.key,
      lifecycle.trigger,
      lifecycle.family,
      lifecycle.category,
      lifecycle.defaultAudience,
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalizedSearch),
  );
  const selectedBrandDefault = brandDefaults.find(
    (document) => document.key === selectedLifecycle.key,
  );
  const selectedEventOverride = eventOverrides.find(
    (document) => document.key === selectedLifecycle.key,
  );
  const selectedEditorHref = eventId ? editorHref(eventId, selectedLifecycle.key) : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="font-medium text-foreground">Automated emails for the attendee journey</p>
          <p className="text-sm text-muted-foreground">
            Choose a template, review its coverage, then customize it for{' '}
            {resolvedEventTitle ?? 'an event'}.
          </p>
        </div>
        <Badge className="w-fit" variant="outline">
          {TEMPLATE_LIFECYCLES.length} templates
        </Badge>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader className="space-y-3 border-b pb-4">
            <div>
              <h2 className="text-base font-semibold text-foreground">Lifecycle library</h2>
              <CardDescription>Search by name, trigger, audience, or template key.</CardDescription>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search lifecycle emails"
                className="pl-9"
                id="lifecycle-email-search"
                name="lifecycleEmailSearch"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search 31 templates…"
                type="search"
                value={searchQuery}
              />
            </div>
          </CardHeader>
          <CardContent className="max-h-[42rem] space-y-5 overflow-y-auto p-3">
            {LIFECYCLE_GROUPS.map((group) => {
              const groupLifecycles = filteredLifecycles.filter(
                (lifecycle) => lifecycle.tier === group.tier,
              );
              if (groupLifecycles.length === 0) return null;
              return (
                <section aria-labelledby={`lifecycle-group-${group.tier}`} key={group.tier}>
                  <div className="mb-2 flex items-start justify-between gap-3 px-2">
                    <div>
                      <h3
                        className="text-xs font-semibold tracking-wide text-foreground uppercase"
                        id={`lifecycle-group-${group.tier}`}
                      >
                        {group.title}
                      </h3>
                      <p className="text-xs text-muted-foreground">{group.description}</p>
                    </div>
                    <Badge variant="secondary">{groupLifecycles.length}</Badge>
                  </div>
                  <div className="space-y-1">
                    {groupLifecycles.map((lifecycle) => {
                      const brandDefault = brandDefaults.find(
                        (document) => document.key === lifecycle.key,
                      );
                      const eventOverride = eventOverrides.find(
                        (document) => document.key === lifecycle.key,
                      );
                      const selected = lifecycle.key === selectedLifecycle.key;
                      return (
                        <button
                          aria-pressed={selected}
                          className={cn(
                            'group flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors',
                            selected
                              ? 'border-primary/20 bg-primary/8 text-foreground'
                              : 'hover:bg-muted/70',
                          )}
                          key={lifecycle.key}
                          onClick={() => setSelectedTemplateKey(lifecycle.key)}
                          type="button"
                        >
                          <span className="sr-only">Select template: </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {lifecycle.name}
                            </span>
                            <span
                              className={cn(
                                'block truncate text-xs',
                                selected ? 'text-foreground/75' : 'text-muted-foreground',
                              )}
                            >
                              {lifecycle.trigger}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
                            <span
                              className={cn(
                                'size-2 rounded-full',
                                brandDefault ? 'bg-emerald-500' : 'bg-muted-foreground/30',
                              )}
                            />
                            <span
                              className={cn(
                                'size-2 rounded-full',
                                eventOverride ? 'bg-blue-500' : 'bg-muted-foreground/30',
                              )}
                            />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
            {filteredLifecycles.length === 0 && (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">
                No lifecycle emails match “{searchQuery}”.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:sticky lg:top-4">
          <CardHeader className="border-b">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{selectedLifecycle.tier}</Badge>
              <Badge variant="secondary">{purposeLabel(selectedLifecycle.category)}</Badge>
            </div>
            <h2 className="text-xl font-semibold text-foreground">{selectedLifecycle.name}</h2>
            <CardDescription className="text-sm">{selectedLifecycle.trigger}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Default subject
                </p>
                <p className="text-sm font-medium text-foreground">
                  {selectedLifecycle.defaultSubject}
                </p>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Preview text
                </p>
                <p className="text-sm text-foreground">
                  {selectedLifecycle.defaultPreviewText ?? 'No preview text'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{audienceLabel(selectedLifecycle.defaultAudience)}</Badge>
              <Badge className="capitalize" variant="outline">
                {selectedLifecycle.family.replaceAll('_', ' ')}
              </Badge>
              <code className="rounded-md bg-muted px-2 py-1 text-xs text-foreground/80">
                {selectedLifecycle.key}
              </code>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">Brand template</p>
                  <Badge
                    variant={
                      selectedBrandDefault ? statusVariant(selectedBrandDefault.status) : 'outline'
                    }
                  >
                    {selectedBrandDefault?.status ?? 'Studio starter'}
                  </Badge>
                </div>
                <p className="mt-2 truncate text-sm font-medium text-foreground">
                  {selectedBrandDefault?.name ?? 'Ready to customize'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedBrandDefault
                    ? `Updated ${formatDate(selectedBrandDefault.updatedAt)}`
                    : 'The built-in Studio design will be used.'}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-muted-foreground">Event customization</p>
                  <Badge
                    variant={
                      selectedEventOverride
                        ? statusVariant(selectedEventOverride.status)
                        : 'outline'
                    }
                  >
                    {selectedEventOverride?.status ?? 'Not customized'}
                  </Badge>
                </div>
                <p className="mt-2 truncate text-sm font-medium text-foreground">
                  {selectedEventOverride?.name ?? resolvedEventTitle ?? 'Choose an event'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedEventOverride
                    ? `Updated ${formatDate(selectedEventOverride.updatedAt)}`
                    : 'Opening the editor creates an event version.'}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Delivered automatically when this lifecycle trigger occurs.
              </p>
              {selectedEditorHref ? (
                <Button asChild>
                  <Link href={selectedEditorHref}>
                    <Pencil className="size-4" />
                    {selectedEventOverride ? 'Edit email' : 'Customize email'}
                  </Link>
                </Button>
              ) : (
                <Button disabled>
                  <Pencil className="size-4" />
                  Select an event
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
