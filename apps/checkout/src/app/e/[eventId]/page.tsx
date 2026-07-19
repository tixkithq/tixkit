import EventPageClient from './event-page-client';
import type { PublicEventPageBootstrap } from '@/lib/api';
import { getServerEventPageBootstrap } from '@/lib/api-server';
import { eventPageMetadataFromBootstrap } from '@/lib/event-page-metadata';
import type { Metadata } from 'next';
import { eventPageLocaleDirection, resolveEventPageLocale } from '@/lib/event-page-locale';

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
    return await getServerEventPageBootstrap(eventId, locale || undefined);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { eventId } = await params;
  const query = await searchParams;
  const bootstrap = await loadInitialBootstrap(
    eventId,
    resolveEventPageLocale(firstParam(query.locale)),
  );
  if (!bootstrap) return {};
  return eventPageMetadataFromBootstrap(bootstrap);
}

export default async function EventPage({ params, searchParams }: PageProps) {
  const { eventId } = await params;
  const query = await searchParams;

  const requestedLocale = resolveEventPageLocale(firstParam(query.locale));

  const initialBootstrap = await loadInitialBootstrap(eventId, requestedLocale);
  const locale = resolveEventPageLocale(
    initialBootstrap?.contentPage?.document.locale ?? requestedLocale,
  );

  return (
    <div lang={locale} dir={eventPageLocaleDirection(locale)}>
      <EventPageClient
        eventId={eventId}
        locale={locale}
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
    </div>
  );
}
