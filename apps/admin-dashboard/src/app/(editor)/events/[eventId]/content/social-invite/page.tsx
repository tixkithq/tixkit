import { PermissionGuard } from '@/components/permission-guard';
import { ContentEditorView } from '@/features/content-editor/content-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <PermissionGuard required="messages.write">
      <ContentEditorView
        actionsUnavailableReason="Social invite is registered as a future channel and cannot publish or send tests yet."
        eventId={eventId}
        kind="social-invite"
      />
    </PermissionGuard>
  );
}
