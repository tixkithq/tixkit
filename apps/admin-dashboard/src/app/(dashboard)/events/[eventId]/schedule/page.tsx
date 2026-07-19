import { PermissionGuard } from '@/components/permission-guard';
import { EventScheduleView } from '@/features/events/event-schedule-view';

export default function Page({ params }: { params: Promise<{ eventId: string }> }) {
  return EventSchedulePageWrapper({ params });
}

async function EventSchedulePageWrapper({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="events.write">
      <EventScheduleView eventId={eventId} />
    </PermissionGuard>
  );
}
