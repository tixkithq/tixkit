import { EventDetailView } from '@/features/events/event-detail-view';

export default function Page({ params }: { params: Promise<{ eventId: string }> }) {
  return EventDetailPageWrapper({ params });
}

async function EventDetailPageWrapper({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventDetailView eventId={eventId} />;
}
