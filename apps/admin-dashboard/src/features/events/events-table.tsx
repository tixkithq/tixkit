'use client';

import * as React from 'react';
import { Plus, Ticket } from 'lucide-react';
import { type AdminEventListItem, adminApi } from '@/lib/api';
import { eventsTableSchema } from '@/lib/table-schemas';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { DataTable, useUrlTableState } from '@/components/data-table';
import { TimestampCell } from '@/components/data-table/cells';
import { useAdminTableData } from '@/hooks/use-admin-table-data';
import { usePermissions } from '@/context/permission-provider';
import { useBootstrap } from '@/context/bootstrap-provider';
import { getEventColumns } from './columns';
import { CreateEventDrawer } from './create-event-drawer';
import { formatDateTime } from '@/lib/format';

export function EventsTable() {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [editingEvent, setEditingEvent] = React.useState<AdminEventListItem | undefined>(undefined);
  const { can } = usePermissions();
  const { organizationId, brandId } = useBootstrap();
  const { query, updateQuery } = useUrlTableState(eventsTableSchema);

  const { data, loading, error, refetch } = useAdminTableData<AdminEventListItem>({
    schema: eventsTableSchema,
    query,
    fetcher: (tableQuery) =>
      adminApi.listEvents({
        ...tableQuery,
        organizationId: organizationId || undefined,
        brandId: brandId || undefined,
      }),
  });

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

  return (
    <>
      <DataTable
        schema={eventsTableSchema}
        columns={columns}
        data={data}
        query={query}
        onQueryChange={updateQuery}
        loading={loading}
        error={error ? { message: error.message } : undefined}
        onRetry={() => refetch()}
        getRowId={(row) => row.id}
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
            title="No events yet"
            description={
              canWriteEvents
                ? 'Create your first event to start selling tickets and tracking attendance.'
                : 'Events will appear here once your workspace starts publishing them.'
            }
            action={
              canWriteEvents ? (
                <Button onClick={handleCreate}>
                  <Plus className="size-4" />
                  Create event
                </Button>
              ) : undefined
            }
          />
        }
        renderRowSheet={(row) => (row ? <EventRowSheet event={row} /> : null)}
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

function EventRowSheet({ event }: { event: AdminEventListItem }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{event.title}</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-1 capitalize">{event.status}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Starts</dt>
          <dd className="mt-1">
            <TimestampCell value={event.startsAt} showTime />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Venue</dt>
          <dd className="mt-1">{event.venueName || '-'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">City</dt>
          <dd className="mt-1">{event.city || '-'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tickets Sold</dt>
          <dd className="mt-1">{event.ticketsSold ?? 0}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Gross Sales</dt>
          <dd className="mt-1">{formatDateTime(event.startsAt)}</dd>
        </div>
      </dl>
    </div>
  );
}
