'use client';

import * as React from 'react';
import { QrCode, Search } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { ApiErrorState } from '@/components/api-error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { cn } from '@/lib/utils';
import { useTicketScanner } from '../check-in/use-ticket-scanner';
import { ScannerPanel } from '../check-in/scanner-panel';
import { CreateCheckInListDialog } from '../check-in/create-check-in-list-dialog';

const EMPTY_CHECK_IN_LISTS: never[] = [];

export function EventCheckInView({ eventId }: { eventId: string }) {
  const [selectedCheckInListId, setSelectedCheckInListId] = React.useState<string>('');
  const [manualSearch, setManualSearch] = React.useState('');
  const checkInListLabelId = React.useId();
  const manualSearchId = React.useId();

  const {
    data: eventData,
    loading: eventLoading,
    error: eventError,
    refetch: refetchEvent,
  } = useAdminQuery(['getEvent', eventId], () => adminApi.getEvent(eventId));
  const {
    data: checkInListsData,
    loading: checkInListsLoading,
    error: checkInListsError,
    refetch: refetchLists,
  } = useAdminQuery(['listCheckInLists', eventId], () => adminApi.listCheckInLists(eventId));
  const attendeeQuery = manualSearch.trim();
  const { data: attendeesData, error: attendeesError } = useAdminQuery(
    ['listAttendees', eventId, selectedCheckInListId, attendeeQuery],
    () =>
      selectedCheckInListId
        ? adminApi.listAttendees({
            eventId,
            checkInListId: selectedCheckInListId,
            limit: attendeeQuery ? 25 : 10,
            search: attendeeQuery,
          })
        : Promise.resolve({
            ok: true as const,
            data: { items: [], total: 0, nextCursor: undefined, filterTotal: 0 },
          }),
  );

  const event = eventData;
  const attendees = attendeesData?.items ?? [];
  const checkInLists = checkInListsData ?? EMPTY_CHECK_IN_LISTS;

  const scanner = useTicketScanner({
    eventId,
    checkInListId: selectedCheckInListId,
    enabled: Boolean(selectedCheckInListId),
  });

  const scanBlockedReason = checkInListsLoading
    ? 'Loading check-in lists.'
    : checkInLists.length === 0
      ? 'Create a check-in list before scanning.'
      : !selectedCheckInListId
        ? 'Choose a check-in list before scanning.'
        : undefined;

  React.useEffect(() => {
    scanner.reset();
    setManualSearch('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Auto-select the only active check-in list when one is available.
  React.useEffect(() => {
    if (
      selectedCheckInListId &&
      checkInLists.length > 0 &&
      !checkInLists.some((list) => list.id === selectedCheckInListId)
    ) {
      setSelectedCheckInListId('');
    } else if (!selectedCheckInListId && checkInLists.length === 1) {
      setSelectedCheckInListId(checkInLists[0].id);
    }
  }, [checkInLists, selectedCheckInListId]);

  if (eventLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (eventError) {
    return <ApiErrorState error={eventError} onRetry={refetchEvent} />;
  }

  if (!event) {
    return (
      <EmptyState
        icon={QrCode}
        title="Event not found"
        description="The event you are looking for does not exist."
      />
    );
  }

  const displayedCheckIns = event.checkIns + scanner.acceptedScanCount;

  return (
    <div className="space-y-6">
      {event && (
        <Card>
          <CardHeader>
            <CardTitle>Check-in Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Capacity</p>
                <p className="text-2xl font-bold">{event.capacity ?? '—'}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Tickets Sold</p>
                <p className="text-2xl font-bold">{event.ticketsSold}</p>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Checked In</p>
                <p className="text-2xl font-bold">{displayedCheckIns}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
            <CreateCheckInListDialog eventId={eventId} onCreated={refetchLists} />
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
              eventId={eventId}
              onCreated={refetchLists}
              triggerLabel=""
              triggerVariant="outline"
              triggerSize="icon"
            />
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ScannerPanel
          key={`${eventId}:${selectedCheckInListId}`}
          eventId={eventId}
          checkInListId={selectedCheckInListId}
          scanBlockedReason={scanBlockedReason}
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
          <CardContent className="space-y-3">
            <Label htmlFor={manualSearchId} className="sr-only">
              Search attendees
            </Label>
            <Input
              id={manualSearchId}
              type="search"
              autoComplete="off"
              placeholder="Search by name, email, or ticket ID"
              value={manualSearch}
              onChange={(e) => setManualSearch(e.target.value)}
            />
            {attendeesError ? (
              <p className="py-4 text-center text-sm text-destructive">
                Failed to load attendees: {attendeesError.message}
              </p>
            ) : attendees.length === 0 ? (
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
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
