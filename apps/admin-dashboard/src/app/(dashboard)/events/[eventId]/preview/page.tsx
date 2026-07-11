import { EventPreviewView } from '@/features/events/event-preview-view';

export default async function EventPreviewPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventPreviewView eventId={eventId} />;
}
