'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  Banknote,
  ChevronDown,
  LayoutDashboard,
  QrCode,
  RefreshCw,
  Maximize2,
  ScanLine,
  Search,
  Settings2,
  Ticket,
  UsersRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  type AdminCheckInList,
  type AdminEventListItem,
  type CheckInActivityItem,
  type CheckInActivitySummary,
  adminApi,
} from '@/lib/api';
import { routes } from '@/lib/routes';
import { usePermissions } from '@/context/permission-provider';
import { useBootstrap } from '@/context/bootstrap-provider';
import { useAllEvents } from '@/hooks/use-all-events';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { useTicketScanner } from '@/features/check-in/use-ticket-scanner';
import { ScannerPanel } from '@/features/check-in/scanner-panel';
import { ManualLookup } from '@/features/check-in/manual-lookup';
import { CreateCheckInListDialog } from '@/features/check-in/create-check-in-list-dialog';
import { BoxOfficeOrderPanel } from '@/features/events/box-office-order-panel';
import { AuthenticatedEventImage } from '@/features/events/authenticated-event-image';
import { subscribeToCheckInActivity } from '@/lib/scan-activity';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/empty-state';
import { ApiErrorState } from '@/components/api-error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const EMPTY_CHECK_IN_LISTS: AdminCheckInList[] = [];

export type CheckInConsoleMode = 'embedded' | 'kiosk';
export type CheckInConsoleTab = 'scan' | 'activity' | 'sales';

export function CheckInConsole({
  mode = 'kiosk',
  initialEventId,
  initialListId,
  initialTab,
  lockEvent = false,
}: {
  mode?: CheckInConsoleMode;
  initialEventId?: string;
  initialListId?: string;
  initialTab?: CheckInConsoleTab;
  /** When true, keep the console on the provided event (event-scoped dashboard page). */
  lockEvent?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  const { organizationId, brandId } = useBootstrap();
  const canScan = can('checkins.write');
  const canSell = can('box_office.write') || can('orders.write');
  const canReadActivity = can('checkins.read');
  const isKiosk = mode === 'kiosk';

  const [selectedEventId, setSelectedEventId] = React.useState(initialEventId ?? '');
  const [selectedCheckInListId, setSelectedCheckInListId] = React.useState(initialListId ?? '');
  const [manualSearch, setManualSearch] = React.useState('');
  const [tab, setTab] = React.useState<CheckInConsoleTab>(() => {
    if (initialTab === 'sales' && canSell) return 'sales';
    if (initialTab === 'scan' && canScan) return 'scan';
    if (initialTab === 'activity' && canReadActivity) return 'activity';
    if (canScan) return 'scan';
    if (canSell) return 'sales';
    return 'activity';
  });
  const [activity, setActivity] = React.useState<CheckInActivityItem[]>([]);
  const [summary, setSummary] = React.useState<CheckInActivitySummary | null>(null);
  const activityGenerationRef = React.useRef(0);
  const [streamStatus, setStreamStatus] = React.useState<
    'connecting' | 'live' | 'reconnecting' | 'offline'
  >('connecting');
  const [streamError, setStreamError] = React.useState<string | null>(null);

  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useAllEvents({ organizationId, brandId });

  React.useEffect(() => {
    setSelectedEventId(initialEventId ?? '');
    setSelectedCheckInListId(initialListId ?? '');
  }, [initialEventId, initialListId, organizationId, brandId]);

  const selectedEvent = events.find((event) => event.id === selectedEventId);
  const [checkInBaseline, setCheckInBaseline] = React.useState<number | null>(null);

  React.useEffect(() => {
    setCheckInBaseline(null);
  }, [selectedEventId]);

  React.useEffect(() => {
    if (selectedEvent && checkInBaseline === null) {
      setCheckInBaseline(selectedEvent.checkIns);
    }
  }, [selectedEvent, checkInBaseline]);

  const needsCheckInLists = tab !== 'sales' && (canScan || canReadActivity);
  const {
    data: checkInListsData,
    loading: checkInListsLoading,
    error: checkInListsError,
    refetch: refetchLists,
  } = useAdminQuery(
    ['listCheckInLists', selectedEventId],
    () => adminApi.listCheckInLists(selectedEventId),
    { enabled: Boolean(selectedEventId && needsCheckInLists) },
  );
  const checkInLists = checkInListsData ?? EMPTY_CHECK_IN_LISTS;

  const { data: ticketTypesData, loading: ticketTypesLoading } = useAdminQuery(
    ['listTicketTypes', selectedEventId],
    () => adminApi.listTicketTypes(selectedEventId),
    { enabled: Boolean(selectedEventId && tab === 'sales' && canSell) },
  );

  const { data: occurrencesData, loading: occurrencesLoading } = useAdminQuery(
    ['listEventOccurrences', selectedEventId],
    () => adminApi.listEventOccurrences(selectedEventId),
    { enabled: Boolean(selectedEventId && tab === 'sales' && canSell) },
  );

  const scanner = useTicketScanner({
    eventId: selectedEventId,
    checkInListId: selectedCheckInListId,
    enabled: Boolean(tab === 'scan' && selectedEventId && selectedCheckInListId && canScan),
  });

  // Clear the selected list when the event changes so we never scan/stream against
  // a list that belongs to a previous event.
  const previousEventIdRef = React.useRef(selectedEventId);
  React.useEffect(() => {
    if (previousEventIdRef.current === selectedEventId) return;
    previousEventIdRef.current = selectedEventId;
    setSelectedCheckInListId('');
    setManualSearch('');
    scanner.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only event transitions should clear list/scanner state
  }, [selectedEventId]);

  // Reset local scanner state when the active list changes so accepted counts and
  // last results never carry across entrances.
  const previousListIdRef = React.useRef(selectedCheckInListId);
  React.useEffect(() => {
    if (previousListIdRef.current === selectedCheckInListId) return;
    previousListIdRef.current = selectedCheckInListId;
    setManualSearch('');
    scanner.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only list transitions should clear scanner state
  }, [selectedCheckInListId]);

  React.useEffect(() => {
    if (!selectedEventId && events.length === 1) {
      setSelectedEventId(events[0].id);
    }
  }, [events, selectedEventId]);

  React.useEffect(() => {
    if (!selectedCheckInListId && checkInLists.length === 1) {
      setSelectedCheckInListId(checkInLists[0].id);
      return;
    }
    if (
      selectedCheckInListId &&
      !checkInListsLoading &&
      checkInListsData &&
      !checkInLists.some((list) => list.id === selectedCheckInListId)
    ) {
      setSelectedCheckInListId('');
    }
  }, [checkInLists, checkInListsData, checkInListsLoading, selectedCheckInListId]);

  React.useEffect(() => {
    const currentSearch = searchParams?.toString() ?? '';
    const params = new URLSearchParams(currentSearch);
    if (isKiosk || lockEvent) {
      params.delete('eventId');
    } else if (selectedEventId) {
      params.set('eventId', selectedEventId);
    } else {
      params.delete('eventId');
    }
    if (selectedCheckInListId) params.set('listId', selectedCheckInListId);
    else params.delete('listId');
    if (tab) params.set('tab', tab);
    const next = params.toString();
    const href = isKiosk
      ? selectedEventId
        ? `${routes.kioskEvent(selectedEventId)}${next ? `?${next}` : ''}`
        : `${routes.kiosk}${next ? `?${next}` : ''}`
      : lockEvent && selectedEventId
        ? `${routes.eventCheckIn(selectedEventId)}${next ? `?${next}` : ''}`
        : `${routes.checkIn}${next ? `?${next}` : ''}`;
    const current = `${pathname}${currentSearch ? `?${currentSearch}` : ''}`;
    if (href === current) return;
    router.replace(href, { scroll: false });
  }, [
    selectedEventId,
    selectedCheckInListId,
    tab,
    pathname,
    router,
    searchParams,
    isKiosk,
    lockEvent,
  ]);

  React.useEffect(() => {
    if (tab !== 'activity' || !selectedEventId || !selectedCheckInListId || !canReadActivity) {
      setActivity([]);
      setSummary(null);
      return;
    }

    let cancelled = false;
    let unsubscribe: () => void = () => undefined;
    setActivity([]);
    setSummary(null);
    activityGenerationRef.current += 1;
    setStreamStatus('connecting');
    setStreamError(null);

    const handlers = {
      onReady: () => {
        if (!cancelled) {
          setStreamStatus('live' as const);
          setStreamError(null);
        }
      },
      onScan: (item: CheckInActivityItem) => {
        if (cancelled) return;
        activityGenerationRef.current += 1;
        setActivity((current) => {
          if (current.some((row) => row.id === item.id)) return current;
          return [item, ...current].slice(0, 100);
        });
      },
      onSummary: (nextSummary: CheckInActivitySummary) => {
        if (!cancelled) {
          activityGenerationRef.current += 1;
          setSummary(nextSummary);
        }
      },
      onReconnecting: ({
        attempt,
        retryInMs,
        error,
      }: {
        attempt: number;
        retryInMs: number;
        error?: Error;
      }) => {
        if (cancelled) return;
        setStreamStatus('reconnecting' as const);
        setStreamError(
          `${error?.message ?? 'Live connection closed'}. Retry ${attempt} in ${Math.ceil(retryInMs / 1000)}s.`,
        );
      },
      onError: (error: Error) => {
        if (cancelled) return;
        setStreamStatus('offline' as const);
        setStreamError(error.message);
      },
    };

    unsubscribe = subscribeToCheckInActivity(selectedEventId, selectedCheckInListId, handlers);

    void adminApi
      .listCheckInActivity(selectedEventId, selectedCheckInListId, {
        limit: 50,
      })
      .then((result) => {
        if (cancelled || !result.ok) return;
        const history = reverseActivityItems(result.data.items);
        setActivity((current) => mergeActivityItems(current, history));
        setSummary((current) => current ?? result.data.summary);
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [selectedEventId, selectedCheckInListId, tab, canReadActivity]);

  if (eventsLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (eventsError) {
    return (
      <div className="p-4">
        <ApiErrorState error={eventsError} onRetry={refetchEvents} />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Ticket}
          title="No events available"
          description="Ask an organizer to publish an event before staff can scan or sell."
        />
      </div>
    );
  }

  const availableTabs: Array<{
    id: CheckInConsoleTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    ...(canScan ? [{ id: 'scan' as const, label: 'Scan', icon: ScanLine }] : []),
    ...(canReadActivity ? [{ id: 'activity' as const, label: 'Live', icon: Activity }] : []),
    ...(canSell ? [{ id: 'sales' as const, label: 'Sales', icon: Banknote }] : []),
  ];

  const selectedCheckInList = checkInLists.find((list) => list.id === selectedCheckInListId);
  const canOpenDashboard = can('events.write') || can('settings.write');
  const sharedQuery = new URLSearchParams({
    tab,
    ...(selectedCheckInListId ? { listId: selectedCheckInListId } : {}),
  }).toString();
  const inviteReturnTo = selectedEventId
    ? `${routes.kioskEvent(selectedEventId)}?${sharedQuery}`
    : routes.kiosk;
  const kioskHref = selectedEventId
    ? `${routes.kioskEvent(selectedEventId)}?${sharedQuery}`
    : `${routes.kiosk}${sharedQuery ? `?${sharedQuery}` : ''}`;
  const inviteStaffHref = selectedEventId
    ? `${routes.settingsMembers}?${new URLSearchParams({
        invite: '1',
        eventId: selectedEventId,
        eventName: selectedEvent?.title ?? selectedEventId,
        returnTo: inviteReturnTo,
      }).toString()}`
    : `${routes.settingsMembers}?invite=1`;
  const Root = isKiosk ? 'main' : 'section';

  return (
    <Root
      className={cn(isKiosk ? 'min-h-svh bg-muted/25' : 'bg-transparent')}
      aria-labelledby="check-in-console-title"
    >
      <div
        className={cn(
          'mx-auto flex w-full flex-col gap-4',
          isKiosk ? 'max-w-5xl px-3 py-3 pb-10 sm:px-5 sm:py-5' : 'max-w-5xl pb-6',
        )}
      >
        <header className="flex items-start justify-between gap-3 rounded-2xl border bg-background p-4 shadow-xs sm:p-5">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <QrCode className="size-4" />
              {isKiosk ? 'Check-in kiosk' : 'Check-in'}
            </div>
            <h1
              id="check-in-console-title"
              className="truncate text-xl font-bold tracking-tight sm:text-2xl"
            >
              {selectedEvent?.title ?? 'Choose an event'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {selectedCheckInList?.name ??
                (tab === 'sales' ? 'Door sales' : 'Choose a check-in list to begin')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {can('settings.write') ? (
              <Button asChild variant="outline" size="sm">
                <Link href={inviteStaffHref} aria-label="Invite staff">
                  <UsersRound className="size-4" />
                  <span className="hidden sm:inline">Invite staff</span>
                </Link>
              </Button>
            ) : null}
            {!isKiosk ? (
              <Button asChild variant="outline" size="sm">
                <Link href={kioskHref} aria-label="Open kiosk mode">
                  <Maximize2 className="size-4" />
                  <span className="hidden sm:inline">Open kiosk mode</span>
                </Link>
              </Button>
            ) : null}
            {isKiosk && canOpenDashboard ? (
              <Button asChild variant="ghost" size="icon" aria-label="Open dashboard">
                <Link href={routes.dashboard}>
                  <LayoutDashboard className="size-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </header>

        <details className="group rounded-2xl border bg-background shadow-xs">
          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Settings2 className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Event setup</p>
                <p className="truncate text-xs text-muted-foreground">
                  {selectedEvent?.title ?? 'No event'}
                  {tab !== 'sales' ? ` · ${selectedCheckInList?.name ?? 'No check-in list'}` : ''}
                </p>
              </div>
            </div>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="grid gap-4 border-t p-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label id="check-in-event-label">Event</Label>
              {lockEvent ? (
                <div
                  className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm"
                  aria-labelledby="check-in-event-label"
                >
                  {selectedEvent?.title ?? selectedEventId ?? 'Event'}
                </div>
              ) : (
                <Select value={selectedEventId} onValueChange={setSelectedEventId}>
                  <SelectTrigger className="w-full" aria-labelledby="check-in-event-label">
                    <SelectValue placeholder="Select event" />
                  </SelectTrigger>
                  <SelectContent>
                    {events.map((event: AdminEventListItem) => (
                      <SelectItem key={event.id} value={event.id}>
                        <span className="flex items-center gap-2">
                          <AuthenticatedEventImage
                            source={event.thumbnail}
                            className="size-7 rounded"
                            fallbackClassName="size-7"
                          />
                          <span className="truncate">{event.title}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {tab !== 'sales' ? (
              <div className="space-y-2">
                <Label id="check-in-list-label">Check-in list</Label>
                <Select
                  value={selectedCheckInListId}
                  onValueChange={setSelectedCheckInListId}
                  disabled={!selectedEventId || checkInListsLoading}
                >
                  <SelectTrigger className="w-full" aria-labelledby="check-in-list-label">
                    <SelectValue
                      placeholder={
                        checkInListsLoading
                          ? 'Loading lists…'
                          : checkInListsError
                            ? 'Failed to load lists'
                            : 'Select list'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {checkInLists.map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex flex-wrap items-center gap-2">
                  {checkInListsError ? (
                    <Button variant="outline" size="sm" onClick={() => void refetchLists()}>
                      Retry lists
                    </Button>
                  ) : null}
                  {canScan && selectedEventId ? (
                    <CreateCheckInListDialog
                      eventId={selectedEventId}
                      onCreated={() => void refetchLists()}
                      triggerLabel="New check-in list"
                      triggerVariant="outline"
                      triggerSize="sm"
                    />
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                Sales uses the selected event. Check-in lists are only needed for Scan and Live.
              </div>
            )}
          </div>
        </details>

        {availableTabs.length === 0 ? (
          <EmptyState
            icon={QrCode}
            title="No check-in permissions"
            description="Ask an admin to grant check-in or box-office access for this brand."
          />
        ) : (
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as CheckInConsoleTab)}
            className="space-y-4"
          >
            <TabsList
              className="sticky top-2 z-20 grid h-auto w-full rounded-xl border bg-background/95 p-1 shadow-sm backdrop-blur"
              style={{
                gridTemplateColumns: `repeat(${availableTabs.length}, minmax(0, 1fr))`,
              }}
            >
              {availableTabs.map((item) => (
                <TabsTrigger key={item.id} value={item.id} className="min-h-11 gap-2 rounded-lg">
                  <item.icon className="size-4" />
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>

            {canScan ? (
              <TabsContent value="scan" className="space-y-3">
                {!selectedEventId || !selectedCheckInListId ? (
                  <EmptyState
                    icon={ScanLine}
                    title="Choose a check-in list"
                    description="Open Event setup and select the list this entrance should admit."
                  />
                ) : (
                  <>
                    {selectedEvent ? (
                      <div className="grid grid-cols-3 gap-2">
                        <SummaryTile label="Capacity" value={selectedEvent.capacity ?? null} />
                        <SummaryTile label="Tickets sold" value={selectedEvent.ticketsSold} />
                        <SummaryTile
                          label="Checked in"
                          value={
                            (checkInBaseline ?? selectedEvent.checkIns) + scanner.acceptedScanCount
                          }
                        />
                      </div>
                    ) : null}
                    <div className="grid gap-3 lg:grid-cols-2">
                      <ScannerPanel
                        eventId={selectedEventId}
                        checkInListId={selectedCheckInListId}
                        scanning={scanner.scanning}
                        lastResult={scanner.lastResult}
                        scanError={scanner.scanError}
                        onScan={scanner.scan}
                        onRetry={scanner.retryLastScan}
                      />
                      <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2 text-base">
                            <Search className="size-4" />
                            Manual lookup
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ManualLookup
                            eventId={selectedEventId}
                            checkInListId={selectedCheckInListId}
                            search={manualSearch}
                            onSearchChange={setManualSearch}
                          />
                        </CardContent>
                      </Card>
                    </div>
                  </>
                )}
                <div className="space-y-2">
                  <div
                    className="flex flex-wrap items-center justify-center gap-2 rounded-xl border bg-background px-4 py-3 text-center text-sm"
                    data-testid="scan-connectivity-status"
                  >
                    {typeof navigator !== 'undefined' && navigator.onLine === false ? (
                      <WifiOff className="size-4 text-amber-600" aria-hidden="true" />
                    ) : (
                      <Wifi className="size-4 text-emerald-600" aria-hidden="true" />
                    )}
                    <span className="font-semibold tabular-nums">{scanner.acceptedScanCount}</span>{' '}
                    <span className="text-muted-foreground">accepted on this device</span>
                    <span className="mx-2 text-muted-foreground" aria-hidden="true">
                      ·
                    </span>
                    <output className="text-muted-foreground" aria-live="polite">
                      {scanner.offlinePreparing
                        ? 'Preparing verified offline check-in'
                        : scanner.offlineReady
                          ? `Offline ready${
                              scanner.pendingOfflineCount > 0
                                ? ` · ${scanner.pendingOfflineCount} pending sync`
                                : ''
                            }`
                          : 'Online check-in only'}
                    </output>
                    {scanner.pendingOfflineCount > 0 ? (
                      <Badge variant="secondary" className="tabular-nums">
                        {scanner.pendingOfflineCount} queued
                      </Badge>
                    ) : null}
                    {scanner.pendingOfflineCount > 0 ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={scanner.offlineSyncing}
                        onClick={() => void scanner.syncPendingOffline()}
                      >
                        {scanner.offlineSyncing ? 'Syncing offline scans…' : 'Sync offline scans'}
                      </Button>
                    ) : null}
                  </div>
                  {scanner.offlineSyncError ||
                  scanner.scanError ||
                  scanner.lastResult?.status === 'duplicate' ||
                  scanner.lastResult?.status === 'invalid' ||
                  scanner.scanning ? (
                    <output
                      className="block rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                      aria-live="assertive"
                      data-testid="scan-incident-banner"
                    >
                      {scanner.scanning ? (
                        <p className="font-medium">
                          Scan in progress — wait before scanning again.
                        </p>
                      ) : null}
                      {scanner.offlineSyncError ? (
                        <p className="font-medium">
                          Sync failed: {scanner.offlineSyncError}. Queued scans are retained.
                        </p>
                      ) : null}
                      {scanner.scanError ? (
                        <p className="font-medium">Scan error: {scanner.scanError}</p>
                      ) : null}
                      {scanner.lastResult?.status === 'duplicate' ? (
                        <p className="font-medium">
                          Duplicate ticket — already checked in. Do not admit again.
                        </p>
                      ) : null}
                      {scanner.lastResult?.status === 'invalid' ? (
                        <p className="font-medium">
                          Invalid ticket — do not admit. Use manual lookup if needed.
                        </p>
                      ) : null}
                    </output>
                  ) : null}
                </div>
              </TabsContent>
            ) : null}

            {canReadActivity ? (
              <TabsContent value="activity" className="space-y-4">
                {!selectedEventId || !selectedCheckInListId ? (
                  <EmptyState
                    icon={Activity}
                    title="Choose a check-in list"
                    description="Open Event setup and select the list whose live admits you want to monitor."
                  />
                ) : (
                  <>
                    <Card className="overflow-hidden">
                      <CardContent className="flex items-start justify-between gap-3 p-4">
                        <div className="flex min-w-0 items-start gap-3">
                          <div
                            className={cn(
                              'flex size-10 shrink-0 items-center justify-center rounded-full',
                              streamStatus === 'live'
                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                            )}
                          >
                            {streamStatus === 'offline' ? (
                              <WifiOff className="size-5" />
                            ) : (
                              <Wifi className="size-5" />
                            )}
                          </div>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold">
                                {streamStatus === 'live'
                                  ? 'Live across devices'
                                  : streamStatus === 'reconnecting'
                                    ? 'Reconnecting…'
                                    : streamStatus === 'offline'
                                      ? 'Live updates offline'
                                      : 'Connecting…'}
                              </p>
                              <Badge variant={streamStatus === 'live' ? 'default' : 'secondary'}>
                                {streamStatus}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {streamError ??
                                'New scans from every active door device appear here.'}
                            </p>
                          </div>
                        </div>
                        <Button
                          size="icon"
                          variant="outline"
                          aria-label="Refresh activity"
                          onClick={() => {
                            if (!selectedEventId || !selectedCheckInListId) return;
                            const requestGeneration = activityGenerationRef.current;
                            void adminApi
                              .listCheckInActivity(selectedEventId, selectedCheckInListId, {
                                limit: 50,
                              })
                              .then((result) => {
                                if (!result.ok) return;
                                const history = reverseActivityItems(result.data.items);
                                setActivity((current) => mergeActivityItems(current, history));
                                if (activityGenerationRef.current === requestGeneration) {
                                  setSummary(result.data.summary);
                                }
                              });
                          }}
                        >
                          <RefreshCw className="size-4" />
                        </Button>
                      </CardContent>
                    </Card>

                    {summary ? (
                      <div className="grid grid-cols-3 gap-2">
                        <SummaryTile label="Checked in" value={summary.checkedIn} />
                        <SummaryTile label="Remaining" value={summary.remaining} />
                        <SummaryTile label="Accepted" value={summary.acceptedScans} />
                      </div>
                    ) : null}

                    {activity.length === 0 ? (
                      <EmptyState
                        icon={Activity}
                        title="No scans yet"
                        description="Accepted, duplicate, and invalid scans from every door device will appear here."
                      />
                    ) : (
                      <div className="overflow-hidden rounded-2xl border bg-background">
                        {activity.map((item, index) => (
                          <div
                            key={item.id}
                            className={cn(
                              'flex items-start justify-between gap-3 p-4',
                              index > 0 && 'border-t',
                            )}
                          >
                            <div className="min-w-0 space-y-1">
                              <p className="truncate font-medium">
                                {item.attendeeName ||
                                  item.attendeeEmail ||
                                  item.ticketId ||
                                  'Unknown ticket'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {new Date(item.scannedAt).toLocaleTimeString()} · {item.deviceId}
                                {item.offline ? ' · synced offline' : ''}
                              </p>
                            </div>
                            <Badge
                              variant={
                                item.outcome === 'accepted'
                                  ? 'default'
                                  : item.outcome === 'duplicate'
                                    ? 'secondary'
                                    : 'destructive'
                              }
                            >
                              {item.outcome}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </TabsContent>
            ) : null}

            {canSell ? (
              <TabsContent value="sales" className="space-y-3">
                {!selectedEventId || !selectedEvent ? (
                  <EmptyState
                    icon={Banknote}
                    title="Select an event"
                    description="Choose the event before selling tickets at the door."
                  />
                ) : ticketTypesLoading || occurrencesLoading ? (
                  <Skeleton className="h-64 w-full rounded-2xl" />
                ) : (
                  <BoxOfficeOrderPanel
                    eventId={selectedEventId}
                    event={selectedEvent}
                    ticketTypes={ticketTypesData ?? []}
                    occurrences={occurrencesData ?? []}
                  />
                )}
              </TabsContent>
            ) : null}
          </Tabs>
        )}
      </div>
    </Root>
  );
}

function SummaryTile({ label, value }: { label: string; value: number | null }) {
  return (
    <Card>
      <CardContent className="space-y-1 p-3 text-center">
        <p className={cn('text-2xl font-semibold tabular-nums')}>{value === null ? '—' : value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function reverseActivityItems(items: readonly CheckInActivityItem[]): CheckInActivityItem[] {
  const reversed: CheckInActivityItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    reversed.push(items[index]!);
  }
  return reversed;
}

function mergeActivityItems(
  liveItems: readonly CheckInActivityItem[],
  historyItems: readonly CheckInActivityItem[],
): CheckInActivityItem[] {
  const seen = new Set<string>();
  return [...liveItems, ...historyItems]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, 100);
}
