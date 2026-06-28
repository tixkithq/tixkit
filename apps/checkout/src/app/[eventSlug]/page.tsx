import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import EventPageClient from '../e/[eventId]/event-page-client';
import { isSharedCheckoutHost, publicHostHeader } from '@/lib/hosts';

type PageProps = {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default async function CustomDomainEventPage({ params, searchParams }: PageProps) {
  const { eventSlug } = await params;
  const query = await searchParams;
  const host = publicHostHeader(await headers());

  if (isSharedCheckoutHost(host)) notFound();

  return (
    <EventPageClient
      eventSlug={eventSlug}
      customDomainHost={host}
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
