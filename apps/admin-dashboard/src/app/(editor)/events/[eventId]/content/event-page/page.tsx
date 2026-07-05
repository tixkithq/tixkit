import { PermissionGuard } from '@/components/permission-guard';
import { EventPagePersistedEditorView } from '@/features/content-editor/event-page-persisted-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="events.write">
      <EventPagePersistedEditorView eventId={eventId} />
    </PermissionGuard>
  );
}
