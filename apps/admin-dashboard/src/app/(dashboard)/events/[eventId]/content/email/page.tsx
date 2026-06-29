import { ContentEditorView } from '@/features/content-editor/content-editor-view';
import { createDefaultEmailTemplate, renderEmailTemplate } from '@tixkit/content-email';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const rendered = await renderEmailTemplate(createDefaultEmailTemplate(), {
    event: {
      title: 'All Access Chicago',
      startsAt: '2026-07-17 19:00',
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${eventId}`,
    },
    brand: {
      name: 'Tixkit',
      supportUrl: 'https://help.example.test/preferences',
    },
    recipient: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    },
    ticket: {
      type: 'General Admission',
    },
    order: {
      total: '$35.00',
    },
  });

  return (
    <ContentEditorView
      actionsUnavailableReason="React Email adapter preview is active; publish waits for persisted content wiring."
      eventId={eventId}
      kind="email"
      preview={{
        label: 'React Email preview',
        output: `Subject: ${rendered.subject}\n\n${rendered.text}`,
        format: 'html',
      }}
    />
  );
}
