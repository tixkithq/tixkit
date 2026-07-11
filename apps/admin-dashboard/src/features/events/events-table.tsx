'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
import { formatCurrency } from '@/lib/format';
import { routes } from '@/lib/routes';

export function EventsTable() {
  const router = useRouter();
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
          router.push(routes.eventSettings(event.id));
        },
        () => refetch(),
        canWriteEvents,
      ),
    [canWriteEvents, refetch, router],
  );

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
            <Button asChild size="sm" className="h-9">
              <Link href={routes.newEvent}>
                <Plus className="size-4" />
                Create event
              </Link>
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
                <Button asChild>
                  <Link href={routes.newEvent}>
                    <Plus className="size-4" />
                    Create event
                  </Link>
                </Button>
              ) : undefined
            }
          />
        }
        renderRowSheet={(row) => (row ? <EventRowSheet event={row} /> : null)}
      />
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
          <dd className="mt-1">{formatCurrency(event.grossSalesCents, event.currency)}</dd>
        </div>
      </dl>
    </div>
  );
}
