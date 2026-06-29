import { ContentEditorView } from '@/features/content-editor/content-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return (
    <ContentEditorView
      actionsUnavailableReason="iMessage is registered as a future channel and cannot publish or send tests yet."
      eventId={eventId}
      kind="imessage"
    />
  );
}
