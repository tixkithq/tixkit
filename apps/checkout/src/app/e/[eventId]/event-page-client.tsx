'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarIcon,
  ClockIcon,
  MapPinIcon,
  TicketIcon,
  ArrowRightIcon,
  AlertCircleIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { EmptyState } from '@/components/empty-state';
import { BrandFooter } from '@/components/checkout/brand-footer';
import {
  publicApi,
  CheckoutApiError,
  type PublicEvent,
  type PublicContentPage,
  type AvailabilityItem,
  type CheckoutPublicResaleListing,
  type PublicEventPageBootstrap,
  userFacingMessage,
} from '@/lib/api';
import { brandThemeStyle, type ResolvedBrand } from '@/lib/brand';
import { useResolvedBrand } from '@/lib/use-brand';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { trackMarketingEvent } from '@/lib/marketing';
import { EventPagePuckRender, isEventPagePuckData } from '@tixkit/content-event-page-react/puck';
import { RefreshNotifier } from '@/components/refresh-notifier';

type Props = {
  eventId?: string;
  eventSlug?: string;
  customDomainHost?: string;
  brandId?: string;
  supportUrl?: string;
  termsUrl?: string;
  privacyUrl?: string;
  refundUrl?: string;
  presetDiscountCode?: string;
  trackingId?: string;
  affiliateCode?: string;
  initialBootstrap?: PublicEventPageBootstrap | null;
};

export default function EventPageClient({
  eventId,
  eventSlug,
  customDomainHost,
  brandId,
  supportUrl,
  termsUrl,
  privacyUrl,
  refundUrl,
  presetDiscountCode,
  trackingId,
  affiliateCode,
  initialBootstrap,
}: Props) {
  const router = useRouter();
  const [event, setEvent] = useState<PublicEvent | null>(() => initialBootstrap?.event ?? null);
  const [contentPage, setContentPage] = useState<PublicContentPage | null>(
    () => initialBootstrap?.contentPage ?? null,
  );
  const [availability, setAvailability] = useState<AvailabilityItem[]>(
    () => initialBootstrap?.availability ?? [],
  );
  const [resaleListings, setResaleListings] = useState<CheckoutPublicResaleListing[]>(
    () => initialBootstrap?.resaleListings.items ?? [],
  );
  const [resaleListingsError, setResaleListingsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !initialBootstrap);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const brand: ResolvedBrand = useResolvedBrand(
    useMemo(
      () => ({
        brandId: brandId ?? event?.brandId,
        brandName: event ? undefined : undefined,
        supportUrl,
        termsUrl,
        privacyUrl,
        refundUrl,
      }),
      [brandId, event, supportUrl, termsUrl, privacyUrl, refundUrl],
    ),
  );

  useEffect(() => {
    if (initialBootstrap) {
      setEvent(initialBootstrap.event);
      setContentPage(initialBootstrap.contentPage);
      setAvailability(initialBootstrap.availability);
      setResaleListings(initialBootstrap.resaleListings.items);
      setResaleListingsError(null);
      setLoading(false);
      setError(null);
      setNotFound(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      if (!eventId && (!eventSlug || !customDomainHost)) return;
      setLoading(true);
      setError(null);
      setResaleListingsError(null);
      try {
        let loadedEvent: PublicEvent;
        let loadedAvailability: AvailabilityItem[];
        let loadedContentPage: PublicContentPage | null;
        let loadedResaleListings: {
          items: CheckoutPublicResaleListing[];
          error: string | null;
        };

        try {
          const bootstrap = eventId
            ? await publicApi.getEventPageBootstrap(eventId, controller.signal)
            : await publicApi.getEventPageBootstrapBySlug(
                eventSlug!,
                customDomainHost!,
                controller.signal,
              );
          loadedEvent = bootstrap.event;
          loadedAvailability = bootstrap.availability;
          loadedContentPage = bootstrap.contentPage;
          loadedResaleListings = { items: bootstrap.resaleListings.items, error: null };
        } catch (bootstrapError) {
          if (controller.signal.aborted) throw bootstrapError;
          loadedEvent = eventId
            ? await publicApi.getEvent(eventId, controller.signal)
            : await publicApi.getEventBySlug(eventSlug!, customDomainHost!, controller.signal);
          const loadContentPage =
            eventSlug && customDomainHost
              ? () => publicApi.getEventPageBySlug(eventSlug, customDomainHost, controller.signal)
              : () => publicApi.getEventPage(loadedEvent.id, controller.signal);
          [loadedAvailability, loadedContentPage, loadedResaleListings] = await Promise.all([
            publicApi.getAvailability(loadedEvent.id, controller.signal),
            loadContentPage().catch((err) => {
              if (err instanceof CheckoutApiError && err.status === 404) return null;
              throw err;
            }),
            publicApi
              .getResaleListings(loadedEvent.id, controller.signal)
              .then((response) => ({ items: response.items, error: null }))
              .catch((err) => {
                if (controller.signal.aborted) throw err;
                if (err instanceof CheckoutApiError && err.status === 404) {
                  return { items: [], error: null };
                }
                return { items: [], error: userFacingMessage(err) };
              }),
          ]);
        }

        if (cancelled) return;
        setEvent(loadedEvent);
        setContentPage(loadedContentPage);
        setAvailability(loadedAvailability);
        setResaleListings(loadedResaleListings.items);
        setResaleListingsError(loadedResaleListings.error);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setNotFound(err instanceof CheckoutApiError && err.status === 404);
        setError(userFacingMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [customDomainHost, eventId, eventSlug, initialBootstrap]);

  const visibleTickets = useMemo(
    () => availability.filter((t) => t.status === 'active' || t.status === 'sold_out'),
    [availability],
  );
  const hasActiveTickets = visibleTickets.some((t) => t.status === 'active');
  const startsAt = event ? formatDateTime(event.startsAt, event.timezone) : null;
  const venueName = event?.venue?.name;
  const puckData = contentPage?.page.puckData;
  const eventTitle = event?.title ?? 'Event';

  useEffect(() => {
    if (!event) return;
    trackMarketingEvent(event.marketingIntegrations, 'view_item', {
      eventId: event.id,
      currency: visibleTickets[0]?.currency,
      items: [{ id: event.id, name: event.title, quantity: 1 }],
    });
  }, [event, visibleTickets]);

  function goToCheckout(resaleListingId?: string) {
    const checkoutEventId = event?.id ?? eventId;
    if (!checkoutEventId) return;
    const params = new URLSearchParams();
    params.set('eventId', checkoutEventId);
    if (resaleListingId) params.set('resaleListing', resaleListingId);
    if (brand.id && !brand.fallback) params.set('brand', brand.id);
    if (supportUrl) params.set('supportUrl', supportUrl);
    if (termsUrl) params.set('termsUrl', termsUrl);
    if (privacyUrl) params.set('privacyUrl', privacyUrl);
    if (refundUrl) params.set('refundUrl', refundUrl);
    if (presetDiscountCode) params.set('discount', presetDiscountCode);
    if (trackingId) params.set('tracking', trackingId);
    if (affiliateCode) params.set('affiliateCode', affiliateCode);
    router.push(`/checkout?${params.toString()}`);
  }

  if (loading) {
    return (
      <SurfaceShell brand={brand}>
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10 sm:px-6">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-12 w-full max-w-xl" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Separator />
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
          <Skeleton className="h-11 w-full max-w-xs" />
        </div>
      </SurfaceShell>
    );
  }

  if (error) {
    return (
      <SurfaceShell brand={brand}>
        <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
          <EmptyState
            icon={AlertCircleIcon}
            title={notFound ? 'Event not found' : 'Could not load event'}
            description={
              notFound ? 'This event may have been removed, or the link is incorrect.' : error
            }
            action={
              <Button variant="outline" onClick={() => window.location.reload()}>
                Try again
              </Button>
            }
          />
        </div>
      </SurfaceShell>
    );
  }

  return (
    <SurfaceShell brand={brand}>
      <RefreshNotifier eventId={eventId ?? event?.id} />
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-10 sm:px-6">
        <header className="space-y-4">
          <Badge variant="secondary" className="gap-1.5">
            <TicketIcon className="size-3.5" />
            {brand.name}
          </Badge>
          <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            {eventTitle}
          </h1>
          {event?.description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              {event.description}
            </p>
          ) : null}

          <dl className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
            <div className="flex items-center gap-2">
              <CalendarIcon className="size-4 text-muted-foreground" />
              <dd>{startsAt ?? 'Date to be announced'}</dd>
            </div>
            {event?.timezone ? (
              <div className="flex items-center gap-2">
                <ClockIcon className="size-4 text-muted-foreground" />
                <dd>{event.timezone}</dd>
              </div>
            ) : null}
            {venueName ? (
              <div className="flex items-center gap-2">
                <MapPinIcon className="size-4 text-muted-foreground" />
                <dd>{venueName}</dd>
              </div>
            ) : null}
          </dl>
        </header>

        {isEventPagePuckData(puckData) ? (
          <div data-testid="published-event-page">
            <EventPagePuckRender data={puckData} />
          </div>
        ) : null}

        <Separator />

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Tickets</h2>

          {visibleTickets.length === 0 ? (
            <EmptyState
              icon={TicketIcon}
              title="No tickets available"
              description="Ticket sales have not opened for this event yet. Check back soon."
            />
          ) : (
            <ul className="space-y-3">
              {visibleTickets.map((ticket) => {
                const soldOut = ticket.status === 'sold_out' || ticket.available <= 0;
                return (
                  <li key={ticket.ticketTypeId}>
                    <Card className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <CardContent className="flex w-full flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{ticket.name}</span>
                          {soldOut ? (
                            <Badge variant="secondary">Sold out</Badge>
                          ) : ticket.available <= 10 ? (
                            <Badge variant="outline">{ticket.available} left</Badge>
                          ) : null}
                        </div>
                        {ticket.description ? (
                          <p className="text-sm text-muted-foreground">{ticket.description}</p>
                        ) : null}
                      </CardContent>
                      <div className="w-full px-6 text-left sm:w-auto sm:text-right">
                        <div className="font-semibold">
                          {ticket.kind === 'free'
                            ? 'Free'
                            : ticket.kind === 'donation'
                              ? `From ${formatCurrency(ticket.minimumPriceCents ?? 0, ticket.currency)}`
                              : formatCurrency(ticket.priceCents, ticket.currency)}
                        </div>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {resaleListingsError ? (
          <Alert>
            <AlertCircleIcon className="size-4" />
            <AlertTitle>Resale tickets are temporarily unavailable</AlertTitle>
            <AlertDescription>{resaleListingsError}</AlertDescription>
          </Alert>
        ) : null}

        {resaleListings.length > 0 ? (
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Resale tickets</h2>
              <Badge variant="outline">Verified listings</Badge>
            </div>
            <ul className="space-y-3">
              {resaleListings.map((listing) => (
                <li key={listing.id}>
                  <Card className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <CardContent className="flex w-full flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {listing.ticketTypeName
                            ? `Resale ticket - ${listing.ticketTypeName}`
                            : 'Resale ticket'}
                        </span>
                        <Badge variant="secondary">1 available</Badge>
                      </div>
                      {listing.expiresAt ? (
                        <p className="text-sm text-muted-foreground">
                          Listing expires {new Date(listing.expiresAt).toLocaleString()}
                        </p>
                      ) : null}
                    </CardContent>
                    <div className="flex w-full flex-col items-start gap-2 px-6 text-left sm:w-auto sm:items-end sm:text-right">
                      <div className="font-semibold">
                        {formatCurrency(listing.priceCents, listing.currency)}
                      </div>
                      <Button
                        size="sm"
                        onClick={() => goToCheckout(listing.id)}
                        className="gap-1.5"
                      >
                        Buy resale
                        <ArrowRightIcon className="size-4" />
                      </Button>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hasActiveTickets ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Secure checkout powered by Tixkit</p>
            <Button size="lg" onClick={() => goToCheckout()} className="gap-1.5">
              Get tickets
              <ArrowRightIcon className="size-4" />
            </Button>
          </div>
        ) : null}

        <BrandFooter brand={brand} />
      </div>
    </SurfaceShell>
  );
}

function SurfaceShell({ brand, children }: { brand: ResolvedBrand; children: React.ReactNode }) {
  return (
    <main className="min-h-svh bg-background text-foreground" style={brandThemeStyle(brand)}>
      {children}
    </main>
  );
}
