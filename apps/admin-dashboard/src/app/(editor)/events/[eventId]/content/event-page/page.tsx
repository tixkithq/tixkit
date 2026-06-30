import { EventPagePersistedEditorView } from '@/features/content-editor/event-page-persisted-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EventPagePersistedEditorView eventId={eventId} />;
}
