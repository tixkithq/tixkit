import { ContentEditorView } from '@/features/content-editor/content-editor-view';
import { createDefaultSmsTemplate, renderSmsTemplate } from '@tixkit/content-message';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const rendered = renderSmsTemplate(createDefaultSmsTemplate(), {
    event: {
      title: 'All Access Chicago',
      startsAt: '2026-07-17 19:00',
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${eventId}`,
    },
    recipient: {
      name: 'Ada Lovelace',
      phone: '+15550000001',
    },
  });

  return (
    <ContentEditorView
      actionsUnavailableReason="SMS compliance adapter preview is active; publish waits for persisted content wiring."
      eventId={eventId}
      kind="sms"
      preview={{
        label: 'SMS compliance preview',
        output: `${rendered.text}\n\nSegments: ${rendered.segments} (${rendered.encoding})\nEstimated cost: ${rendered.estimatedCostCents} cents`,
        format: 'text',
      }}
    />
  );
}
