import { EventSettingsView } from '@/features/events/event-settings-view';
import { PermissionGuard } from '@/components/permission-guard';

export default async function EventSettingsPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="events.write">
      <EventSettingsView eventId={eventId} />
    </PermissionGuard>
  );
}
