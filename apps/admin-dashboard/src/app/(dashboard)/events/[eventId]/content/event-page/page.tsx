import { ContentEditorView } from '@/features/content-editor/content-editor-view';
import {
  createDefaultEventPageDocument,
  renderEventPageDocument,
} from '@tixkit/content-event-page';

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const document = createDefaultEventPageDocument({
    eventId,
    eventTitle: '{{event.title}}',
    eventDescription: 'Hosted event-page draft generated from event metadata.',
    checkoutUrl: '{{event.checkoutUrl}}',
  });
  const rendered = renderEventPageDocument(document, {
    event: {
      title: 'All Access Chicago',
      startsAt: '2026-07-17T19:00:00.000Z',
      timezone: 'America/Chicago',
      venueName: 'The Salt Shed',
      checkoutUrl: `https://checkout.tixkit.com/checkout?eventId=${encodeURIComponent(eventId)}`,
    },
    brand: { name: 'Tixkit' },
    tickets: [
      {
        id: 'tt_preview_ga',
        name: 'General Admission',
        status: 'active',
        priceLabel: '$35.00',
      },
    ],
  });
  return (
    <ContentEditorView
      actionsUnavailableReason="TipTap event-page preview is active; publish waits for persisted page wiring."
      eventId={eventId}
      kind="event-page"
      preview={{
        label: 'TipTap event-page preview',
        output: rendered.text,
        format: 'html',
      }}
    />
  );
}
