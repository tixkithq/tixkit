'use client';

import * as React from 'react';
import { Users } from 'lucide-react';
import { type AdminAttendeeListItem, adminApi } from '@/lib/api';
import { attendeesTableSchema } from '@/lib/table-schemas';
import { EmptyState } from '@/components/empty-state';
import { DataTableV2, useMemoryTableState } from '@/components/data-table';
import { TextCell, TimestampCell } from '@/components/data-table/cells';
import { useAdminTableData } from '@/hooks/use-admin-table-data';
import { getAttendeeColumns } from '@/features/attendees/columns';
import { AttendeeFormDialog } from '@/features/attendees/attendee-form';
import { AttendeeStatusBadge, CheckInStatusBadge } from '@/features/events/event-status-badge';

export function EventAttendeesView({ eventId }: { eventId: string }) {
  const [editingAttendee, setEditingAttendee] = React.useState<AdminAttendeeListItem | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const { query, updateQuery } = useMemoryTableState({ includeFacets: true });

  const { data, loading, error, refetch } = useAdminTableData<AdminAttendeeListItem>({
    schema: attendeesTableSchema,
    query,
    fetcher: (tableQuery) => adminApi.listAttendees({ ...tableQuery, eventId }),
  });

  const columns = React.useMemo(
    () =>
      getAttendeeColumns((attendee) => {
        setEditingAttendee(attendee);
        setDialogOpen(true);
      }),
    [],
  );

  return (
    <>
      <DataTableV2
        schema={attendeesTableSchema}
        columns={columns}
        data={data}
        query={query}
        onQueryChange={updateQuery}
        loading={loading}
        error={error ? { message: error.message } : undefined}
        onRetry={() => refetch()}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState
            icon={Users}
            title="No attendees yet"
            description="Attendees will appear here as orders are completed."
          />
        }
        renderRowSheet={(row) => (row ? <AttendeeRowSheet attendee={row} /> : null)}
      />
      <AttendeeFormDialog
        attendee={editingAttendee}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={refetch}
      />
    </>
  );
}

function AttendeeRowSheet({ attendee }: { attendee: AdminAttendeeListItem }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">{attendee.name}</h3>
        {attendee.email && <p className="text-sm text-muted-foreground">{attendee.email}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Ticket Type</dt>
          <dd className="mt-1">
            <TextCell value={attendee.ticketTypeName} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-1">
            <AttendeeStatusBadge status={attendee.status} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Check-in</dt>
          <dd className="mt-1">
            <CheckInStatusBadge status={attendee.checkInStatus} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Registered</dt>
          <dd className="mt-1">
            <TimestampCell value={attendee.createdAt} showTime />
          </dd>
        </div>
      </dl>
    </div>
  );
}
