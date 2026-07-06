'use client';

import * as React from 'react';
import { Download, Users } from 'lucide-react';
import { type AdminAttendeeListItem, type AdminExportJob, adminApi } from '@/lib/api';
import { attendeesTableSchema } from '@/lib/table-schemas';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { DataTableV2, useUrlTableState } from '@/components/data-table';
import {
  TextCell,
  TimestampCell,
} from '@/components/data-table/cells';
import { useAdminTableData } from '@/hooks/use-admin-table-data';
import { usePermissions } from '@/context/permission-provider';
import { useBootstrap } from '@/context/bootstrap-provider';
import { getAttendeeColumns } from './columns';
import { AttendeeFormDialog } from './attendee-form';
import { subscribeToExportJob } from '@/lib/export-jobs';
import { toast } from 'sonner';
import { AttendeeStatusBadge, CheckInStatusBadge } from '@/features/events/event-status-badge';

export function AttendeesTable() {
  const [editingAttendee, setEditingAttendee] = React.useState<AdminAttendeeListItem | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [lastExport, setLastExport] = React.useState<AdminExportJob | null>(null);
  const exportSubscriptionRef = React.useRef<(() => void) | null>(null);
  const { organizationId, brandId } = useBootstrap();
  const { query, updateQuery } = useUrlTableState(attendeesTableSchema);
  const { can } = usePermissions();

  const { data, loading, error, refetch } = useAdminTableData<AdminAttendeeListItem>({
    schema: attendeesTableSchema,
    query,
    fetcher: (tableQuery) =>
      adminApi.listAttendees({
        ...tableQuery,
        organizationId: organizationId || undefined,
        brandId: brandId || undefined,
      }),
  });

  const columns = React.useMemo(
    () =>
      getAttendeeColumns((attendee) => {
        setEditingAttendee(attendee);
        setDialogOpen(true);
      }),
    [],
  );

  React.useEffect(() => {
    return () => {
      exportSubscriptionRef.current?.();
    };
  }, []);

  const handleExport = async () => {
    exportSubscriptionRef.current?.();
    setExporting(true);
    const result = await adminApi.createExport({
      type: 'attendees',
      format: 'csv',
    });
    if (!result.ok) {
      setExporting(false);
      toast.error(result.error.message);
      return;
    }

    setLastExport(result.data);
    toast.success(`Export queued (${result.data.exportId})`);
    exportSubscriptionRef.current = subscribeToExportJob(result.data.exportId, {
      onUpdate: setLastExport,
      onDone: (completed) => {
        setLastExport(completed);
        setExporting(false);
        if (completed.status === 'completed') {
          toast.success('Export ready to download');
        } else {
          toast.error('Export failed');
        }
      },
      onError: (streamError) => {
        setExporting(false);
        toast.error(streamError.message);
      },
    });
  };

  const attendees = data?.items ?? [];
  const canExport = can('attendees.read') && !exporting && attendees.length > 0;

  return (
    <>
      {lastExport && <ExportStatusNotice exportJob={lastExport} />}
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
        toolbarActions={
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={handleExport}
            disabled={!canExport}
          >
            <Download className="size-4" />
            {exporting ? 'Exporting...' : 'Export'}
          </Button>
        }
        emptyState={
          <EmptyState
            icon={Users}
            title="No attendees yet"
            description="Attendees are added automatically as orders are completed."
          />
        }
        renderRowSheet={(row) =>
          row ? <AttendeeRowSheetContent attendee={row} /> : null
        }
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

function AttendeeRowSheetContent({ attendee }: { attendee: AdminAttendeeListItem }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">{attendee.name}</h3>
        {attendee.email && (
          <p className="text-sm text-muted-foreground">{attendee.email}</p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Event</dt>
          <dd className="mt-1">
            <TextCell value={attendee.eventTitle} />
          </dd>
        </div>
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
        {attendee.checkedInAt && (
          <div>
            <dt className="text-muted-foreground">Checked In</dt>
            <dd className="mt-1">
              <TimestampCell value={attendee.checkedInAt} showTime />
            </dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">Order ID</dt>
          <dd className="mt-1">
            <TextCell value={attendee.orderId} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Ticket ID</dt>
          <dd className="mt-1">
            <TextCell value={attendee.ticketId} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

function ExportStatusNotice({ exportJob }: { exportJob: AdminExportJob }) {
  const href = exportJob.downloadUrl;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
      <span>
        Export {exportJob.exportId} is {exportJob.status}.
      </span>
      {exportJob.status === 'completed' && href && (
        <Button asChild size="sm" variant="outline">
          <a href={href} target="_blank" rel="noreferrer">
            <Download className="size-4" />
            Download
          </a>
        </Button>
      )}
    </div>
  );
}
