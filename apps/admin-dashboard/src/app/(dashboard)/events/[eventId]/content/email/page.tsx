import { EmailPersistedEditorView } from '@/features/content-editor/email-persisted-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <EmailPersistedEditorView eventId={eventId} />;
}
