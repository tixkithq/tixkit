'use client';

import * as React from 'react';
import Link from 'next/link';
import { Mail, Pencil, RefreshCw } from 'lucide-react';
import {
  TEMPLATE_LIFECYCLES,
  isTemplateKey,
  type TemplateKey,
  type TemplateLifecycle,
} from '@tixkit/domain';
import { type AdminContentDocument, type AdminEventDetail, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { formatDate } from '@/lib/format';

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
              data: { items: [] as AdminContentDocument[], nextCursor: null, hasMore: false },
            }),
        eventId
          ? adminApi.listContentDocuments({
              channel: 'email',
              eventId,
              limit: 100,
            })
          : Promise.resolve({
              ok: true as const,
              data: { items: [] as AdminContentDocument[], nextCursor: null, hasMore: false },
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

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
        Lifecycle emails are automation templates. Campaigns are concrete sends; these rows show
        which trigger-based templates have a brand default and whether this event overrides them.
      </div>
      <div className="flex flex-col gap-3 rounded-md border bg-background p-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-2">
          <label className="text-sm font-medium text-foreground" htmlFor="lifecycle-email-picker">
            Lifecycle template
          </label>
          <Select
            value={selectedTemplateKey}
            onValueChange={(value) => {
              if (isTemplateKey(value)) setSelectedTemplateKey(value);
            }}
          >
            <SelectTrigger
              id="lifecycle-email-picker"
              className="w-full sm:w-[24rem]"
              aria-label="Lifecycle template"
            >
              <SelectValue placeholder="Choose a lifecycle template" />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_LIFECYCLES.map((lifecycle) => (
                <SelectItem key={lifecycle.key} value={lifecycle.key}>
                  {lifecycle.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{selectedLifecycle.trigger}</p>
        </div>
        {eventId ? (
          <Button asChild className="sm:shrink-0">
            <Link href={editorHref(eventId, selectedLifecycle.key)}>
              <Pencil className="size-4" />
              Open in editor
            </Link>
          </Button>
        ) : (
          <Button disabled className="sm:shrink-0">
            <Pencil className="size-4" />
            Open in editor
          </Button>
        )}
      </div>
      {TEMPLATE_LIFECYCLES.map((lifecycle) => {
        const brandDefault = brandDefaults.find((document) => document.key === lifecycle.key);
        const eventOverride = eventOverrides.find((document) => document.key === lifecycle.key);
        const editHref = eventId ? editorHref(eventId, lifecycle.key) : undefined;

        return (
          <Card key={lifecycle.key}>
            <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold text-foreground">{lifecycle.name}</h3>
                  <Badge variant="outline">{lifecycle.tier}</Badge>
                  <Badge variant="secondary">{purposeLabel(lifecycle.category)}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{lifecycle.trigger}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{lifecycle.key}</span>
                  <span>{audienceLabel(lifecycle.defaultAudience)}</span>
                  <span>{lifecycle.family.replaceAll('_', ' ')}</span>
                </div>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-2 lg:w-[28rem]">
                <div className="rounded-md border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Brand default</span>
                    {brandDefault ? (
                      <Badge variant={statusVariant(brandDefault.status)}>
                        {brandDefault.status}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Missing</Badge>
                    )}
                  </div>
                  <p className="mt-2 truncate font-medium text-foreground">
                    {brandDefault?.name ?? 'No default template'}
                  </p>
                  {brandDefault ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Updated {formatDate(brandDefault.updatedAt)}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Event overrides can still be created.
                    </p>
                  )}
                </div>
                <div className="rounded-md border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      Event override
                    </span>
                    {eventOverride ? (
                      <Badge variant={statusVariant(eventOverride.status)}>
                        {eventOverride.status}
                      </Badge>
                    ) : (
                      <Badge variant="outline">Uses default</Badge>
                    )}
                  </div>
                  <p className="mt-2 truncate font-medium text-foreground">
                    {eventOverride?.name ??
                      (resolvedEventTitle ? `${resolvedEventTitle} default` : 'No override')}
                  </p>
                  <div className="mt-2">
                    {editHref ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={editHref}>Open in editor</Link>
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Select an event to create an override.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
