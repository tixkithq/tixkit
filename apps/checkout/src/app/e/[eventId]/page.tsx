import EventPageClient from './event-page-client';
import EventPageEditOverlay from './event-page-edit-overlay';

type PageProps = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function EventPage({ params, searchParams }: PageProps) {
  const { eventId } = await params;
  const query = await searchParams;

  const editMode = firstParam(query.edit) === '1';
  const token = firstParam(query.token);

  if (editMode && token) {
    return (
      <EventPageEditOverlay
        eventId={eventId}
        token={token}
        brandId={firstParam(query.brand)}
      />
    );
  }

  return (
    <EventPageClient
      eventId={eventId}
      brandId={firstParam(query.brand)}
      supportUrl={firstParam(query.supportUrl)}
      termsUrl={firstParam(query.termsUrl)}
      privacyUrl={firstParam(query.privacyUrl)}
      refundUrl={firstParam(query.refundUrl)}
      presetDiscountCode={firstParam(query.discount)}
      trackingId={firstParam(query.tracking)}
      affiliateCode={firstParam(query.affiliateCode) || firstParam(query.affiliate)}
    />
  );
}
