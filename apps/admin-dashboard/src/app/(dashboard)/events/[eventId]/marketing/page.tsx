import { PermissionGuard } from '@/components/permission-guard';
import { EventMarketingView } from '@/features/events/event-marketing-view';

export default function Page({ params }: { params: Promise<{ eventId: string }> }) {
  return EventMarketingPageWrapper({ params });
}

async function EventMarketingPageWrapper({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="events.write">
      <EventMarketingView eventId={eventId} />
    </PermissionGuard>
  );
}
