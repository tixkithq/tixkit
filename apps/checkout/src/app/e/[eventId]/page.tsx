import EventPageClient from './event-page-client'

type PageProps = {
  params: Promise<{ eventId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : value ?? ''
}

export default async function EventPage({ params, searchParams }: PageProps) {
  const { eventId } = await params
  const query = await searchParams

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
  )
}
