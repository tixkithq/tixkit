import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import EventPageClient from '../e/[eventId]/event-page-client';
import { isSharedCheckoutHost, publicHostHeader } from '@/lib/hosts';
import type { PublicEventPageBootstrap } from '@/lib/api';
import { getServerEventPageBootstrapBySlug } from '@/lib/api-server';
import { parseCheckoutRuntimeConfig } from '@/lib/runtime-config-server';
import { eventPageMetadataFromBootstrap } from '@/lib/event-page-metadata';
import type { Metadata } from 'next';

type PageProps = {
  params: Promise<{ eventSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function loadInitialBootstrap(
  eventSlug: string,
  host: string,
  locale: string,
): Promise<PublicEventPageBootstrap | null> {
  try {
    return await getServerEventPageBootstrapBySlug(eventSlug, host, locale || undefined);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { eventSlug } = await params;
  const query = await searchParams;
  const runtimeConfig = parseCheckoutRuntimeConfig();
  const host = publicHostHeader(await headers(), runtimeConfig.checkoutUrl);

  if (isSharedCheckoutHost(host, runtimeConfig.checkoutUrl)) return {};
  const bootstrap = await loadInitialBootstrap(eventSlug, host, firstParam(query.locale));
  return bootstrap ? eventPageMetadataFromBootstrap(bootstrap) : {};
}

export default async function CustomDomainEventPage({ params, searchParams }: PageProps) {
  const { eventSlug } = await params;
  const query = await searchParams;
  const runtimeConfig = parseCheckoutRuntimeConfig();
  const host = publicHostHeader(await headers(), runtimeConfig.checkoutUrl);

  if (isSharedCheckoutHost(host, runtimeConfig.checkoutUrl)) notFound();
  const locale = firstParam(query.locale);
  const initialBootstrap = await loadInitialBootstrap(eventSlug, host, locale);

  return (
    <EventPageClient
      eventSlug={eventSlug}
      customDomainHost={host}
      initialBootstrap={initialBootstrap}
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
