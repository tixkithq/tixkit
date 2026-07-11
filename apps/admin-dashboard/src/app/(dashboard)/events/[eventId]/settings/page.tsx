import { EventSettingsView } from '@/features/events/event-settings-view';

export default async function EventSettingsPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return <EventSettingsView eventId={eventId} />;
}
