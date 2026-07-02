import { PermissionGuard } from '@/components/permission-guard';
import { EventAttendeesView } from '@/features/events/event-attendees-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="attendees.read">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Attendees</h1>
            <p className="text-sm text-muted-foreground">Event attendees and check-in status</p>
          </div>
        </div>
        <EventAttendeesView eventId={eventId} />
      </div>
    </PermissionGuard>
  );
}
