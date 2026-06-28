'use client';

import * as React from 'react';
import { QrCode, Search, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { type AdminCheckInList, type CheckInScanResult, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

export function CheckInView() {
  const [selectedEventId, setSelectedEventId] = React.useState<string>('');
  const [selectedCheckInListId, setSelectedCheckInListId] = React.useState<string>('');
  const [qrPayload, setQrPayload] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<CheckInScanResult | null>(null);
  const [manualSearch, setManualSearch] = React.useState('');

  const {
    data: eventsData,
    loading: eventsLoading,
    error: eventsError,
    refetch: refetchEvents,
  } = useAdminData(() => adminApi.listEvents());

  const events = eventsData?.items ?? [];
  const selectedEvent = events.find((e) => e.id === selectedEventId);

  const {
    data: checkInListsData,
    loading: checkInListsLoading,
    error: checkInListsError,
    refetch: refetchLists,
  } = useAdminData(
    () =>
      selectedEventId
        ? adminApi.listCheckInLists(selectedEventId)
        : Promise.resolve({
            ok: true as const,
            data: EMPTY_CHECK_IN_LISTS,
          }),
    [selectedEventId],
  );

  const checkInLists = checkInListsData ?? EMPTY_CHECK_IN_LISTS;

  // Reset the selected check-in list whenever the event changes.
  React.useEffect(() => {
    setSelectedCheckInListId('');
  }, [selectedEventId]);

  // Auto-select the only active check-in list when one is available.
  React.useEffect(() => {
    if (!selectedCheckInListId && checkInLists.length === 1) {
      setSelectedCheckInListId(checkInLists[0].id);
    }
  }, [checkInLists, selectedCheckInListId]);

  const handleScan = async () => {
    if (!selectedEventId || !selectedCheckInListId || !qrPayload) return;
    setScanning(true);
    const result = await adminApi.scanTicket({
      eventId: selectedEventId,
      checkInListId: selectedCheckInListId,
      qrPayload,
      scannedAt: new Date().toISOString(),
    });
    setScanning(false);
    if (result.ok) {
      setLastResult(result.data);
      setQrPayload('');
    } else {
      setLastResult({
        status: 'invalid',
        message: result.error.message,
        scannedAt: new Date().toISOString(),
      });
    }
  };

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
        <span className="text-sm font-medium">Select Event</span>
        <Select value={selectedEventId} onValueChange={setSelectedEventId}>
          <SelectTrigger className="w-full max-w-xs" aria-label="Event">
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
          <span className="text-sm font-medium">Check-in List</span>
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
              <SelectTrigger className="w-full max-w-xs" aria-label="Check-in list">
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
      )}

      {selectedEventId && selectedCheckInListId && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <QrCode className="size-5" />
                Scan Ticket
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Enter QR code or ticket ID"
                  value={qrPayload}
                  onChange={(e) => setQrPayload(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleScan();
                  }}
                />
                <Button
                  onClick={handleScan}
                  disabled={scanning || !qrPayload || !selectedCheckInListId}
                >
                  {scanning ? 'Scanning...' : 'Scan'}
                </Button>
              </div>
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
            <CardContent className="space-y-4">
              <ManualLookup
                eventId={selectedEventId}
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
                <p className="text-2xl font-bold">{selectedEvent.checkIns}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
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
  };

  const { icon: Icon, className } = config[result.status];

  return (
    <div className={cn('flex items-start gap-3 rounded-lg border p-4', className)}>
      <Icon className="mt-0.5 size-5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium capitalize">{result.status.replace('_', ' ')}</p>
        <p className="text-sm">
          {result.status === 'accepted'
            ? result.attendee
              ? `${result.attendee.name} has been checked in.`
              : (result.message ?? 'Check-in successful')
            : result.message}
        </p>
        {result.attendee && result.status !== 'accepted' && (
          <p className="text-xs text-muted-foreground">
            Attendee: {result.attendee.name} ({result.attendee.ticketTypeName})
          </p>
        )}
      </div>
    </div>
  );
}

function ManualLookup({
  eventId,
  search,
  onSearchChange,
}: {
  eventId: string;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { data, loading, error } = useAdminData(
    () => adminApi.listAttendees({ eventId }),
    [eventId],
  );

  const attendees = data?.items ?? [];
  const filtered = search
    ? attendees.filter(
        (a) =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.email?.toLowerCase().includes(search.toLowerCase()) ||
          a.ticketId.includes(search),
      )
    : attendees.slice(0, 10);

  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return <ApiErrorState error={error} className="border-0 bg-transparent p-0" />;

  return (
    <div className="space-y-3">
      <Input
        placeholder="Search by name, email, or ticket ID"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No attendees found</p>
        ) : (
          filtered.map((attendee) => (
            <div
              key={attendee.id}
              className="flex items-center justify-between rounded-md border p-2 text-sm"
            >
              <div>
                <p className="font-medium">{attendee.name}</p>
                <p className="text-xs text-muted-foreground">{attendee.ticketTypeName}</p>
              </div>
              <span
                className={cn(
                  'text-xs',
                  attendee.checkInStatus === 'checked_in'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-muted-foreground',
                )}
              >
                {attendee.checkInStatus === 'checked_in' ? 'Checked in' : 'Pending'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
