'use client';

import * as React from 'react';
import { Plus, Ticket } from 'lucide-react';
import { type AdminEventListItem, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/data-table/data-table';
import { type DataTableFilter } from '@/components/data-table/toolbar';
import { usePermissions } from '@/context/permission-provider';
import { useAdminData } from '@/hooks/use-admin-data';
import { useDebouncedValue } from '@/hooks/use-debounced-search';
import { getEventColumns } from './columns';
import { CreateEventDrawer } from './create-event-drawer';

const statusFilters: DataTableFilter = {
  columnId: 'status',
  title: 'Status',
  options: [
    { label: 'Draft', value: 'draft' },
    { label: 'Published', value: 'published' },
    { label: 'Paused', value: 'paused' },
    { label: 'Archived', value: 'archived' },
  ],
};

export function EventsTable() {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editingEvent, setEditingEvent] = React.useState<AdminEventListItem | undefined>(undefined);
  const [searchInput, setSearchInput] = React.useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const { can } = usePermissions();
  const { data, loading, error, refetch } = useAdminData(
    () => adminApi.listEvents(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : undefined),
    [debouncedSearch],
  );

  const events = data?.items ?? [];
  const canWriteEvents = can('events.write');

  const columns = React.useMemo(
    () =>
      getEventColumns(
        (event) => {
          setEditingEvent(event);
          setDrawerOpen(true);
        },
        () => refetch(),
        canWriteEvents,
      ),
    [canWriteEvents, refetch],
  );

  const handleCreate = () => {
    if (!canWriteEvents) return;
    setEditingEvent(undefined);
    setDrawerOpen(true);
  };

  if (loading && events.length === 0) {
    return <EventsTableSkeleton />;
  }

  if (error && events.length === 0) {
    return (
      <EmptyState
        icon={Ticket}
        title="Failed to load events"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  return (
    <>
      <DataTable
        columns={columns}
        data={events}
        getRowId={(row) => row.id}
        searchPlaceholder="Search events..."
        onServerSearch={setSearchInput}
        serverSearchValue={searchInput}
        serverSearchLoading={loading}
        filters={[statusFilters]}
        toolbarActions={
          canWriteEvents ? (
            <Button size="sm" className="h-9" onClick={handleCreate}>
              <Plus className="size-4" />
              Create event
            </Button>
          ) : undefined
        }
        emptyState={
          <EmptyState
            icon={Ticket}
            title={searchInput ? 'No matching events' : 'No events yet'}
            description={
              searchInput
                ? 'Try a different search term.'
                : canWriteEvents
                  ? 'Create your first event to start selling tickets and tracking attendance.'
                  : 'Events will appear here once your workspace starts publishing them.'
            }
            action={
              canWriteEvents && !searchInput ? (
                <Button onClick={handleCreate}>
                  <Plus className="size-4" />
                  Create event
                </Button>
              ) : undefined
            }
          />
        }
      />
      {canWriteEvents && (
        <CreateEventDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          event={editingEvent}
          onSuccess={refetch}
        />
      )}
    </>
  );
}

function EventsTableSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-[250px]" />
        <Skeleton className="h-9 w-[120px]" />
      </div>
      <div className="rounded-md border">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
