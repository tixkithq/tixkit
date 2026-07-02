import { PermissionGuard } from '@/components/permission-guard';
import { EventReportsView } from '@/features/events/event-reports-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="reports.read">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
            <p className="text-sm text-muted-foreground">
              Sales, tax, and attendance analytics for this event
            </p>
          </div>
        </div>
        <EventReportsView eventId={eventId} />
      </div>
    </PermissionGuard>
  );
}
