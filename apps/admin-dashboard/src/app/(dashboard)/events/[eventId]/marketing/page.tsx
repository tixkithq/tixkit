import { EventMarketingView } from '@/features/events/event-marketing-view';

export default function Page({ params }: { params: Promise<{ eventId: string }> }) {
  return EventMarketingPageWrapper({ params });
}

async function EventMarketingPageWrapper({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventMarketingView eventId={eventId} />;
}
