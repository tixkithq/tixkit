import EventPageClient from './event-page-client';
import { publicApi, type PublicEventPageBootstrap } from '@/lib/api';

type PageProps = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const revalidate = 60;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function loadInitialBootstrap(
  eventId: string,
  locale: string,
): Promise<PublicEventPageBootstrap | null> {
  try {
    return await publicApi.getEventPageBootstrap(eventId, undefined, locale || undefined);
  } catch {
    return null;
  }
}

export default async function EventPage({ params, searchParams }: PageProps) {
  const { eventId } = await params;
  const query = await searchParams;

  const editMode = firstParam(query.edit) === '1';
  const token = firstParam(query.token);
  const locale = firstParam(query.locale);

  if (editMode && token) {
    const EventPageEditOverlay = (await import('./event-page-edit-overlay')).default;
    return (
      <EventPageEditOverlay eventId={eventId} token={token} brandId={firstParam(query.brand)} />
    );
  }

  const initialBootstrap = await loadInitialBootstrap(eventId, locale);

  return (
    <EventPageClient
      eventId={eventId}
      initialBootstrap={initialBootstrap}
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
