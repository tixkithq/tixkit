'use client';

import * as React from 'react';
import { Download, Users } from 'lucide-react';
import { type AdminAttendeeListItem, type AdminExportJob, adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/data-table/data-table';
import { type DataTableFilter } from '@/components/data-table/toolbar';
import { useAdminData } from '@/hooks/use-admin-data';
import { usePermissions } from '@/context/permission-provider';
import { getAttendeeColumns } from './columns';
import { AttendeeFormDialog } from './attendee-form';
import { subscribeToExportJob } from '@/lib/export-jobs';
import { toast } from 'sonner';

const statusFilters: DataTableFilter = {
  columnId: 'status',
  title: 'Status',
  options: [
    { label: 'Active', value: 'active' },
    { label: 'Cancelled', value: 'cancelled' },
    { label: 'Refunded', value: 'refunded' },
    { label: 'Transferred', value: 'transferred' },
  ],
};

const checkInFilters: DataTableFilter = {
  columnId: 'checkInStatus',
  title: 'Check-in',
  options: [
    { label: 'Not Checked In', value: 'not_checked_in' },
    { label: 'Checked In', value: 'checked_in' },
    { label: 'Duplicate', value: 'duplicate' },
    { label: 'Revoked', value: 'revoked' },
  ],
};

export function AttendeesTable() {
  const [editingAttendee, setEditingAttendee] = React.useState<AdminAttendeeListItem | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [lastExport, setLastExport] = React.useState<AdminExportJob | null>(null);
  const exportSubscriptionRef = React.useRef<(() => void) | null>(null);
  const { data, loading, error, refetch } = useAdminData(() => adminApi.listAttendees({}));
  const { can } = usePermissions();

  const attendees = data?.items ?? [];

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

  if (loading) return <AttendeesTableSkeleton />;

  if (error && attendees.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Failed to load attendees"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  return (
    <>
      {lastExport && <ExportStatusNotice exportJob={lastExport} />}
      <DataTable
        columns={columns}
        data={attendees}
        getRowId={(row) => row.id}
        searchPlaceholder="Search attendees..."
        searchKey="name"
        filters={[statusFilters, checkInFilters]}
        toolbarActions={
          <Button
            size="sm"
            variant="outline"
            className="h-9"
            onClick={handleExport}
            disabled={attendees.length === 0 || !can('attendees.read') || exporting}
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

function ExportStatusNotice({ exportJob }: { exportJob: AdminExportJob }) {
  const href = exportJob.downloadUrl ?? exportJob.fileUrl;
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

function AttendeesTableSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-[250px]" />
      <div className="rounded-md border">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
