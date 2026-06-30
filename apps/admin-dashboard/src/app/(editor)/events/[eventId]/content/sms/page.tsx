import { SmsPersistedEditorView } from '@/features/content-editor/sms-persisted-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <SmsPersistedEditorView eventId={eventId} />;
}
