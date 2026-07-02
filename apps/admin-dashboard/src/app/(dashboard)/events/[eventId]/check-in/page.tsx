import { PermissionGuard } from '@/components/permission-guard';
import { EventCheckInView } from '@/features/events/event-check-in-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="checkins.write">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Check-in</h1>
            <p className="text-sm text-muted-foreground">
              Scan tickets and admit attendees for this event
            </p>
          </div>
        </div>
        <EventCheckInView eventId={eventId} />
      </div>
    </PermissionGuard>
  );
}
