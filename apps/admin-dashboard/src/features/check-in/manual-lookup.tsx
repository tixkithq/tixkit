'use client';

import * as React from 'react';
import { adminApi } from '@/lib/api';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiErrorState } from '@/components/api-error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const SEARCH_DEBOUNCE_MS = 250;

export function ManualLookup({
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
  const [debouncedSearch, setDebouncedSearch] = React.useState(search);

  React.useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [search]);

  const attendeeQuery = debouncedSearch.trim();
  const { data, loading, error, refetch } = useAdminQuery(
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
  const showInitialLoading = loading && !data && !error;
  const isSearchPending = search.trim() !== debouncedSearch.trim();

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
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {error ? (
        <ApiErrorState
          error={error}
          onRetry={() => void refetch()}
          className="border-0 bg-transparent p-0"
        />
      ) : showInitialLoading || isSearchPending ? (
        <>
          <output className="sr-only">Loading attendees</output>
          <Skeleton aria-hidden="true" className="h-24 w-full" />
        </>
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
    </div>
  );
}
