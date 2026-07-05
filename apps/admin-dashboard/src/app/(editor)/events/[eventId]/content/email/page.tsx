import { PermissionGuard } from '@/components/permission-guard';
import { EmailPersistedEditorView } from '@/features/content-editor/email-persisted-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="messages.write">
      <EmailPersistedEditorView eventId={eventId} />
    </PermissionGuard>
  );
}
