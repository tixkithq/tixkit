'use client';

import * as React from 'react';
import { QrCode, Search } from 'lucide-react';
import { type AdminCheckInList, adminApi } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { ApiErrorState } from '@/components/api-error-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { useAllEvents } from '@/hooks/use-all-events';
import { useBootstrap } from '@/context/bootstrap-provider';
import { cn } from '@/lib/utils';
import { useTicketScanner } from './use-ticket-scanner';
import { ScannerPanel } from './scanner-panel';
import { CreateCheckInListDialog } from './create-check-in-list-dialog';

const EMPTY_CHECK_IN_LISTS: AdminCheckInList[] = [];

export function CheckInView() {
  const [selectedEventId, setSelectedEventId] = React.useState<string>('');
  const [selectedCheckInListId, setSelectedCheckInListId] = React.useState<string>('');
  const [manualSearch, setManualSearch] = React.useState('');
  const eventSelectLabelId = React.useId();
  const checkInListLabelId = React.useId();
  const { organizationId, brandId } = useBootstrap();

  const {
    events,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useAllEvents({ organizationId, brandId });

  // Reset the selected event/check-in list when the workspace/brand scope changes
  // so the selector does not retain an event that is no longer in the narrowed list.
  React.useEffect(() => {
    setSelectedEventId('');
    setSelectedCheckInListId('');
  }, [organizationId, brandId]);

  const selectedEvent = events.find((e) => e.id === selectedEventId);

  const {
    data: checkInListsData,
    loading: checkInListsLoading,
    error: checkInListsError,
    refetch: refetchLists,
  } = useAdminQuery(
    ['listCheckInLists', selectedEventId],
    () =>
      selectedEventId
        ? adminApi.listCheckInLists(selectedEventId)
        : Promise.resolve({
            ok: true as const,
            data: EMPTY_CHECK_IN_LISTS,
          }),
  );

  const checkInLists = checkInListsData ?? EMPTY_CHECK_IN_LISTS;

  const scanner = useTicketScanner({
    eventId: selectedEventId,
    checkInListId: selectedCheckInListId,
    enabled: Boolean(selectedEventId && selectedCheckInListId),
  });

  // Reset the selected check-in list and scanner state whenever the event changes.
  React.useEffect(() => {
    setSelectedCheckInListId('');
    setManualSearch('');
    scanner.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEventId]);

  React.useEffect(() => {
    if (!selectedEventId && events.length === 1) {
      setSelectedEventId(events[0].id);
    }
  }, [events, selectedEventId]);

  // Auto-select the only active check-in list when one is available.
  React.useEffect(() => {
    if (!selectedCheckInListId && checkInLists.length === 1) {
      setSelectedCheckInListId(checkInLists[0].id);
    }
  }, [checkInLists, selectedCheckInListId]);

  if (eventsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full max-w-xs" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (eventsError) {
    return <ApiErrorState error={eventsError} onRetry={refetchEvents} />;
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={QrCode}
        title="No events to check in"
        description="Create an event first, then return here to scan tickets."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Label id={eventSelectLabelId}>Select Event</Label>
        <Select value={selectedEventId} onValueChange={setSelectedEventId}>
          <SelectTrigger className="w-full max-w-xs" aria-labelledby={eventSelectLabelId}>
            <SelectValue placeholder="Choose an event" />
          </SelectTrigger>
          <SelectContent>
            {events.map((event) => (
              <SelectItem key={event.id} value={event.id}>
                {event.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedEventId && (
        <div className="flex flex-col gap-2">
          <Label id={checkInListLabelId}>Check-in List</Label>
          {checkInListsLoading ? (
            <Skeleton className="h-10 w-full max-w-xs" />
          ) : checkInListsError ? (
            <ApiErrorState
              error={checkInListsError}
              onRetry={refetchLists}
              className="border-0 bg-transparent p-0"
            />
          ) : checkInLists.length === 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                No active check-in lists for this event. Create a check-in list before scanning.
              </p>
              <CreateCheckInListDialog eventId={selectedEventId} onCreated={refetchLists} />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Select value={selectedCheckInListId} onValueChange={setSelectedCheckInListId}>
                <SelectTrigger className="w-full max-w-xs" aria-labelledby={checkInListLabelId}>
                  <SelectValue placeholder="Choose a check-in list" />
                </SelectTrigger>
                <SelectContent>
                  {checkInLists.map((list) => (
                    <SelectItem key={list.id} value={list.id}>
                      {list.name}
                    </SelectItem>
                ))}
                </SelectContent>
              </Select>
              <CreateCheckInListDialog
                eventId={selectedEventId}
                onCreated={refetchLists}
                triggerLabel=""
                triggerVariant="outline"
                triggerSize="icon"
              />
            </div>
          )}
        </div>
      )}

      {selectedEventId && selectedCheckInListId && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* key forces the panel to reset its internal input/mode when the
          event or check-in list changes. */}
          <ScannerPanel
            key={`${selectedEventId}:${selectedCheckInListId}`}
            eventId={selectedEventId}
            checkInListId={selectedCheckInListId}
            scanning={scanner.scanning}
            lastResult={scanner.lastResult}
            onScan={scanner.scan}
          />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="size-5" />
                Manual Lookup
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ManualLookup
                eventId={selectedEventId}
                checkInListId={selectedCheckInListId}
                search={manualSearch}
                onSearchChange={setManualSearch}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {selectedEvent && (
        <Card>
          <CardHeader>
            <CardTitle>Check-in Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Capacity</p>
                <p className="text-2xl font-bold">{selectedEvent.capacity ?? '—'}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Tickets Sold</p>
                <p className="text-2xl font-bold">{selectedEvent.ticketsSold}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Checked In</p>
                <p className="text-2xl font-bold">
                  {selectedEvent.checkIns + scanner.acceptedScanCount}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ManualLookup({
  eventId,
  checkInListId,
  search,
  onSearchChange,
}: {
  eventId: string;
  checkInListId: string;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const manualSearchId = React.useId();
  const attendeeQuery = search.trim();
  const { data, loading, error } = useAdminQuery(
    ['listAttendees', eventId, checkInListId, attendeeQuery],
    () =>
      adminApi.listAttendees({
        eventId,
        checkInListId,
        limit: attendeeQuery ? 25 : 10,
        search: attendeeQuery,
      }),
  );

  const attendees = data?.items ?? [];

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <ApiErrorState error={error} className="border-0 bg-transparent p-0" />;

  return (
    <div className="space-y-3">
      <Label htmlFor={manualSearchId} className="sr-only">
        Search attendees
      </Label>
      <Input
        id={manualSearchId}
        type="search"
        autoComplete="off"
        placeholder="Search by name, email, or ticket ID"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      {attendees.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No attendees found</p>
      ) : (
        <ul
          aria-label={attendeeQuery ? 'Matching attendees' : 'Recent attendees'}
          className="max-h-64 space-y-1 overflow-y-auto"
        >
          {attendees.map((attendee) => (
            <li
              key={attendee.id}
              className="flex flex-col gap-1 rounded-md border p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium break-words">{attendee.name}</p>
                <p className="text-xs text-muted-foreground">{attendee.ticketTypeName}</p>
              </div>
              <span
                className={cn(
                  'text-xs sm:shrink-0',
                  attendee.checkInStatus === 'checked_in'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-muted-foreground',
                )}
              >
                {attendee.checkInStatus === 'checked_in' ? 'Checked in' : 'Pending'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
