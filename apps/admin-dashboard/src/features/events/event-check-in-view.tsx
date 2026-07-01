'use client';

import * as React from 'react';
import { QrCode, Search, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { type AdminCheckInList, type CheckInScanResult, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { useAdminData } from '@/hooks/use-admin-data';
import { cn } from '@/lib/utils';

const EMPTY_CHECK_IN_LISTS: AdminCheckInList[] = [];

export function EventCheckInView({ eventId }: { eventId: string }) {
  const [selectedCheckInListId, setSelectedCheckInListId] = React.useState<string>('');
  const [qrPayload, setQrPayload] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<CheckInScanResult | null>(null);
  const [manualSearch, setManualSearch] = React.useState('');
  const [acceptedScanCount, setAcceptedScanCount] = React.useState(0);
  const checkInListLabelId = React.useId();
  const ticketInputId = React.useId();
  const scanStatusId = React.useId();
  const manualSearchId = React.useId();

  const {
    data: eventData,
    loading: eventLoading,
    error: eventError,
    refetch: refetchEvent,
  } = useAdminData(() => adminApi.getEvent(eventId), [eventId]);
  const {
    data: checkInListsData,
    loading: checkInListsLoading,
    error: checkInListsError,
    refetch: refetchLists,
  } = useAdminData(() => adminApi.listCheckInLists(eventId), [eventId]);
  const attendeeQuery = manualSearch.trim();
  const { data: attendeesData, error: attendeesError } = useAdminData(
    () => adminApi.listAttendees({ eventId, limit: attendeeQuery ? 25 : 10, query: attendeeQuery }),
    [eventId, attendeeQuery],
  );

  const event = eventData;
  const attendees = attendeesData?.items ?? [];
  const checkInLists = checkInListsData ?? EMPTY_CHECK_IN_LISTS;
  const trimmedQrPayload = qrPayload.trim();
  const scanBlockedReason = checkInListsLoading
    ? 'Loading check-in lists.'
    : checkInLists.length === 0
      ? 'Create a check-in list before scanning.'
      : !selectedCheckInListId
        ? 'Choose a check-in list before scanning.'
        : undefined;
  const canScan = Boolean(trimmedQrPayload) && !scanBlockedReason && !scanning;

  React.useEffect(() => {
    setAcceptedScanCount(0);
    setQrPayload('');
    setLastResult(null);
    setManualSearch('');
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

  const handleScan = async () => {
    if (!selectedCheckInListId || !trimmedQrPayload || scanBlockedReason || scanning) return;
    setScanning(true);
    try {
      const result = await adminApi.scanTicket({
        eventId,
        checkInListId: selectedCheckInListId,
        qrPayload: trimmedQrPayload,
        scannedAt: new Date().toISOString(),
      });
      if (result.ok) {
        setLastResult(result.data);
        if (result.data.status === 'accepted') {
          setAcceptedScanCount((count) => count + 1);
        }
        setQrPayload('');
      } else {
        setLastResult({
          status: 'invalid',
          message: result.error.message,
          scannedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      setLastResult({
        status: 'invalid',
        message: error instanceof Error ? error.message : 'Unable to scan this ticket.',
        scannedAt: new Date().toISOString(),
      });
    } finally {
      setScanning(false);
    }
  };

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

  const displayedCheckIns = event.checkIns + acceptedScanCount;

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
          <p className="text-sm text-muted-foreground">
            No active check-in lists for this event. Create a check-in list before scanning.
          </p>
        ) : (
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
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="size-5" />
              Scan Ticket
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {scanBlockedReason && (
              <p id={scanStatusId} className="text-sm text-muted-foreground">
                {scanBlockedReason}
              </p>
            )}
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(submitEvent) => {
                submitEvent.preventDefault();
                void handleScan();
              }}
            >
              <Label htmlFor={ticketInputId} className="sr-only">
                Ticket QR or ID
              </Label>
              <Input
                id={ticketInputId}
                autoComplete="off"
                inputMode="text"
                aria-describedby={scanBlockedReason ? scanStatusId : undefined}
                disabled={Boolean(scanBlockedReason) || scanning}
                placeholder="Enter QR code or ticket ID"
                value={qrPayload}
                onChange={(e) => setQrPayload(e.target.value)}
              />
              <Button type="submit" disabled={!canScan} aria-busy={scanning}>
                {scanning ? 'Scanning...' : 'Scan'}
              </Button>
            </form>
            {lastResult && <ScanResult result={lastResult} />}
          </CardContent>
        </Card>

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

function ScanResult({ result }: { result: CheckInScanResult }) {
  const config = {
    accepted: {
      icon: CheckCircle2,
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    },
    duplicate: {
      icon: AlertCircle,
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    },
    invalid: {
      icon: XCircle,
      className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
    },
    revoked: {
      icon: XCircle,
      className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
    },
    wrong_event: {
      icon: AlertCircle,
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    },
    wrong_list: {
      icon: AlertCircle,
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    },
  };

  const { icon: Icon, className } = config[result.status];

  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className={cn('flex items-start gap-3 rounded-lg border p-4', className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <span className="space-y-1">
        <span className="block font-medium capitalize">{result.status.replace(/_/g, ' ')}</span>
        <span className="block text-sm">
          {result.status === 'accepted'
            ? result.attendee
              ? `${result.attendee.name} has been checked in.`
              : (result.message ?? 'Check-in successful')
            : result.message}
        </span>
        {result.attendee && result.status !== 'accepted' && (
          <span className="block text-xs text-muted-foreground">
            Attendee: {result.attendee.name} ({result.attendee.ticketTypeName})
          </span>
        )}
      </span>
    </output>
  );
}
