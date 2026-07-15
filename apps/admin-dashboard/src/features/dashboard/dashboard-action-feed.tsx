'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import type { DashboardAction, DashboardActionOwner, DashboardRemediationId } from '@tixkit/domain';
import { ApiErrorState } from '@/components/api-error-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useBootstrap } from '@/context/bootstrap-provider';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';

const ownerLabels: Readonly<Record<DashboardActionOwner, string>> = {
  organizer: 'Organizer',
  finance: 'Finance',
  marketing: 'Marketing',
  support: 'Support',
  door_operations: 'Door operations',
};

const reasonLabels: Readonly<Record<DashboardAction['reasonCode'], string>> = {
  event_unpublished: 'Finish launch and publish this event.',
  event_starting_soon: 'Configure door operations before the event starts.',
  event_sales_paused: 'Review why sales are paused before the event starts.',
  failed_exports: 'Review failed report exports and create a replacement export if needed.',
};

function remediationHref(action: DashboardAction): string | undefined {
  const eventId = action.resource.eventId;
  const remediation: DashboardRemediationId = action.remediation.id;
  switch (remediation) {
    case 'continue_event_setup':
    case 'review_paused_event':
      return routes.eventDetail(eventId);
    case 'prepare_door_operations':
      return routes.eventCheckIn(eventId);
    case 'review_failed_exports':
      return routes.eventReports(eventId);
    default: {
      const exhaustive: never = remediation;
      return exhaustive;
    }
  }
}

function actionLabel(action: DashboardAction): string {
  switch (action.remediation.id) {
    case 'continue_event_setup':
      return 'Continue launch';
    case 'prepare_door_operations':
      return 'Configure check-in';
    case 'review_paused_event':
      return 'Review paused sales';
    case 'review_failed_exports':
      return 'Review exports';
  }
}

function DashboardActionRow({ action }: { action: DashboardAction }) {
  const href = remediationHref(action);
  return (
    <li className="flex flex-wrap items-start gap-3 border-t py-4 first:border-t-0">
      {action.overdue ? (
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">{action.resource.eventTitle}</p>
        <p className="text-sm text-foreground/80">{reasonLabels[action.reasonCode]}</p>
        <p
          className="text-xs text-muted-foreground"
          aria-label={`${action.severity} action owned by ${ownerLabels[action.owner]}`}
        >
          <span className="capitalize">{action.severity}</span> · Owner: {ownerLabels[action.owner]}
          {action.deadlineAt ? (
            <>
              {' '}
              · {action.overdue ? 'Overdue since' : 'Due'}{' '}
              <time dateTime={action.deadlineAt}>
                {new Date(action.deadlineAt).toLocaleString()}
              </time>
            </>
          ) : (
            ' · No fixed deadline'
          )}
          {action.occurrenceCount > 1 ? ` · ${action.occurrenceCount} occurrences` : ''}
        </p>
      </div>
      {action.remediation.availability === 'available' && href ? (
        <Button size="sm" variant="outline" asChild>
          <Link href={href} aria-label={`${actionLabel(action)} for ${action.resource.eventTitle}`}>
            {actionLabel(action)}
          </Link>
        </Button>
      ) : action.remediation.availability === 'permission_required' ? (
        <span className="text-xs text-muted-foreground">
          {ownerLabels[action.owner]} permission required
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">Review action unavailable</span>
      )}
    </li>
  );
}

function ScopedDashboardActionFeed({
  organizationId,
  brandId,
}: {
  organizationId: string;
  brandId: string;
}) {
  const { data, loading, error, refetch } = useAdminQuery(
    ['getDashboardActions', organizationId, brandId],
    () => adminApi.getDashboardActions(organizationId, brandId, { limit: 20 }),
    { staleTime: 30_000 },
  );
  const [actions, setActions] = React.useState<DashboardAction[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = React.useState<string | null>(null);
  const [snapshotInvalid, setSnapshotInvalid] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [owner, setOwner] = React.useState<'all' | DashboardActionOwner>('all');
  const [clock, setClock] = React.useState(() => Date.now());
  const snapshotGeneration = React.useRef(0);

  React.useEffect(() => {
    if (!data) return;
    snapshotGeneration.current += 1;
    const expiry = Date.parse(data.expiresAt);
    const now = Date.now();
    const usable = Array.isArray(data.actions) && Number.isFinite(expiry) && expiry > now;
    setActions(usable ? [...data.actions] : []);
    setNextCursor(usable ? data.nextCursor : null);
    setLoadMoreError(null);
    setSnapshotInvalid(!usable);
    setClock(now);
    if (!usable) return;
    const timeout = window.setTimeout(
      () => {
        snapshotGeneration.current += 1;
        setClock(Date.now());
        setSnapshotInvalid(true);
        setActions([]);
        setNextCursor(null);
      },
      Math.min(2_147_483_647, Math.max(0, expiry - now)),
    );
    return () => window.clearTimeout(timeout);
  }, [data]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    const requestGeneration = snapshotGeneration.current;
    try {
      const result = await adminApi.getDashboardActions(organizationId, brandId, {
        limit: 20,
        cursor: nextCursor,
      });
      if (requestGeneration !== snapshotGeneration.current) return;
      if (!result.ok) {
        snapshotGeneration.current += 1;
        setSnapshotInvalid(true);
        setActions([]);
        setNextCursor(null);
        setLoadMoreError(result.error.message);
        return;
      }
      if (
        result.data.generatedAt !== data?.generatedAt ||
        result.data.expiresAt !== data?.expiresAt
      ) {
        snapshotGeneration.current += 1;
        setSnapshotInvalid(true);
        setActions([]);
        setNextCursor(null);
        setLoadMoreError('The action snapshot changed. Refresh before loading more actions.');
        return;
      }
      setActions((current) => {
        const knownIds = new Set(current.map((action) => action.id));
        return [...current, ...result.data.actions.filter((action) => !knownIds.has(action.id))];
      });
      setNextCursor(result.data.nextCursor);
    } catch (loadError) {
      if (requestGeneration !== snapshotGeneration.current) return;
      snapshotGeneration.current += 1;
      setSnapshotInvalid(true);
      setActions([]);
      setNextCursor(null);
      setLoadMoreError(
        loadError instanceof Error ? loadError.message : 'Could not load more actions.',
      );
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (error) return <ApiErrorState error={error} onRetry={refetch} />;
  if (!data) return null;
  const expiry = Date.parse(data.expiresAt);
  const expired = !Number.isFinite(expiry) || clock >= expiry;
  const valid = Array.isArray(data.actions);
  const usable = valid && !snapshotInvalid && !expired;
  const owners = [...new Set(actions.map((action) => action.owner))];
  const visibleActions =
    owner === 'all' ? actions : actions.filter((action) => action.owner === owner);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Prioritized actions</CardTitle>
          <p className="text-sm text-muted-foreground">
            Server-evaluated event and operational work, ordered by urgency.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm" htmlFor="dashboard-action-owner">
            Show actions for
          </label>
          <select
            id="dashboard-action-owner"
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={owner}
            onChange={(event) => setOwner(event.target.value as 'all' | DashboardActionOwner)}
          >
            <option value="all">All roles</option>
            {owners.map((value) => (
              <option key={value} value={value}>
                {ownerLabels[value]}
              </option>
            ))}
          </select>
          <Button type="button" size="sm" variant="ghost" onClick={() => void refetch()}>
            <RefreshCw className="size-4" aria-hidden="true" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!valid ? (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 p-3 text-sm"
          >
            <span>
              Dashboard actions are unavailable from this API version. Refresh before acting.
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
              Retry dashboard actions
            </Button>
          </div>
        ) : null}
        {expired ? (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          >
            <span>This action snapshot expired. Refresh before acting.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
              Refresh actions
            </Button>
          </div>
        ) : null}
        {usable && visibleActions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {owner === 'all'
              ? 'No current event or operational actions.'
              : `No current actions for ${ownerLabels[owner]}.`}
          </p>
        ) : usable ? (
          <ul aria-label="Prioritized event and operational actions">
            {visibleActions.map((action) => (
              <DashboardActionRow key={action.id} action={action} />
            ))}
          </ul>
        ) : null}
        {loadMoreError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {loadMoreError}
          </p>
        ) : null}
        {usable && nextCursor ? (
          <Button
            type="button"
            className="mt-3"
            variant="outline"
            disabled={loadingMore || expired}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading more…' : 'Load more actions'}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function DashboardActionFeed() {
  const { organizationId, brandId, loading } = useBootstrap();
  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!organizationId || !brandId) return null;
  return (
    <ScopedDashboardActionFeed
      key={`${organizationId}:${brandId}`}
      organizationId={organizationId}
      brandId={brandId}
    />
  );
}
