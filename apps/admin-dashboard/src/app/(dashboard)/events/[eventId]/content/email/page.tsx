import { ContentEditorView } from '@/features/content-editor/content-editor-view';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <ContentEditorView eventId={eventId} kind="email" />;
}
