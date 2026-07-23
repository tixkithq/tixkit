'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
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
import type { ResolvedBrand } from '@/lib/brand';
import { BrandThemeSurface } from '@/components/brand-theme-surface';
import { useResolvedBrand } from '@/lib/use-brand';
import { trackMarketingEvent } from '@/lib/marketing';
import {
  createDefaultEventPageDocument,
  materializeEventPageDocument,
} from '@tixkit/content-event-page';
import {
  EventPagePuckRender,
  isEventPagePuckData,
  ticketPriceLabel,
  type EventPageRuntime,
  type PublicEventPageTicket,
} from '@tixkit/content-event-page-react/puck';
import { RefreshNotifier } from '@/components/refresh-notifier';
import { resolveEventPageMedia } from '@/lib/event-media';
import { eventPageLocaleDirection, resolveEventPageLocale } from '@/lib/event-page-locale';

type Props = {
  eventId?: string;
  eventSlug?: string;
  customDomainHost?: string;
  locale?: string;
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
  locale,
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
  const [availabilityStatus, setAvailabilityStatus] = useState<
    'current' | 'stale' | 'unavailable' | 'loading' | 'refreshing'
  >(() => (initialBootstrap ? 'current' : 'loading'));
  const [availabilityMessage, setAvailabilityMessage] = useState<string | null>(null);
  const availabilityGenerationRef = useRef(0);
  const availabilityRef = useRef(availability);
  const availabilityRefreshRef = useRef<{
    eventId: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const requestedLocale = useMemo(() => resolveEventPageLocale(locale), [locale]);
  const resolvedLocale = useMemo(
    () => resolveEventPageLocale(contentPage?.document.locale ?? requestedLocale),
    [contentPage?.document.locale, requestedLocale],
  );

  useEffect(() => {
    const root = document.documentElement;
    const previousLang = root.lang;
    const previousDirection = root.dir;
    root.lang = resolvedLocale;
    root.dir = eventPageLocaleDirection(resolvedLocale);
    return () => {
      root.lang = previousLang;
      root.dir = previousDirection;
    };
  }, [resolvedLocale]);

  const brand: ResolvedBrand = useResolvedBrand(
    useMemo(
      () => ({
        brandId: brandId ?? event?.brandId,
        supportUrl,
        termsUrl,
        privacyUrl,
        refundUrl,
      }),
      [brandId, event, supportUrl, termsUrl, privacyUrl, refundUrl],
    ),
  );

  useEffect(() => {
    availabilityRef.current = availability;
  }, [availability]);

  useEffect(() => {
    return () => {
      availabilityGenerationRef.current += 1;
      const active = availabilityRefreshRef.current;
      active?.controller.abort();
      if (availabilityRefreshRef.current === active) {
        availabilityRefreshRef.current = null;
      }
    };
  }, [event?.id, eventId]);

  const refreshAvailability = useCallback((): Promise<void> => {
    const targetEventId = event?.id ?? eventId;
    if (!targetEventId) return Promise.resolve();
    const active = availabilityRefreshRef.current;
    if (active?.eventId === targetEventId) return active.promise;

    active?.controller.abort();
    const generation = ++availabilityGenerationRef.current;
    const controller = new AbortController();
    setAvailabilityStatus('refreshing');
    const promise = (async () => {
      try {
        const next = await publicApi.getAvailability(targetEventId, controller.signal);
        if (
          controller.signal.aborted ||
          generation !== availabilityGenerationRef.current ||
          availabilityRefreshRef.current?.controller !== controller
        )
          return;
        availabilityRef.current = next;
        setAvailability(next);
        setAvailabilityStatus('current');
        setAvailabilityMessage(null);
      } catch (err) {
        if (
          controller.signal.aborted ||
          generation !== availabilityGenerationRef.current ||
          availabilityRefreshRef.current?.controller !== controller
        )
          return;
        const hasTickets = availabilityRef.current.length > 0;
        setAvailabilityStatus(hasTickets ? 'stale' : 'unavailable');
        setAvailabilityMessage(
          hasTickets
            ? 'Ticket availability may be out of date. Event details are still shown.'
            : userFacingMessage(err),
        );
      } finally {
        if (availabilityRefreshRef.current?.controller === controller) {
          availabilityRefreshRef.current = null;
        }
      }
    })();
    availabilityRefreshRef.current = { eventId: targetEventId, controller, promise };
    return promise;
  }, [event?.id, eventId]);

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
      setAvailabilityStatus('current');
      setAvailabilityMessage(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      if (!eventId && (!eventSlug || !customDomainHost)) return;
      setLoading(true);
      setError(null);
      setResaleListingsError(null);
      setAvailabilityStatus('loading');
      try {
        let loadedEvent: PublicEvent;
        let loadedAvailability: AvailabilityItem[];
        let loadedContentPage: PublicContentPage | null;
        let loadedResaleListings: {
          items: CheckoutPublicResaleListing[];
          error: string | null;
        };
        let availabilityLoadFailed = false;
        let availabilityLoadError: string | null = null;

        try {
          const bootstrap = eventId
            ? await publicApi.getEventPageBootstrap(eventId, controller.signal, requestedLocale)
            : await publicApi.getEventPageBootstrapBySlug(
                eventSlug!,
                customDomainHost!,
                controller.signal,
                requestedLocale,
              );
          loadedEvent = bootstrap.event;
          loadedAvailability = bootstrap.availability;
          loadedContentPage = bootstrap.contentPage;
          loadedResaleListings = {
            items: bootstrap.resaleListings.items,
            error: null,
          };
        } catch (bootstrapError) {
          if (controller.signal.aborted) throw bootstrapError;
          loadedEvent = eventId
            ? await publicApi.getEvent(eventId, controller.signal)
            : await publicApi.getEventBySlug(eventSlug!, customDomainHost!, controller.signal);
          const loadContentPage =
            eventSlug && customDomainHost
              ? () =>
                  publicApi.getEventPageBySlug(
                    eventSlug,
                    customDomainHost,
                    controller.signal,
                    requestedLocale,
                  )
              : () => publicApi.getEventPage(loadedEvent.id, controller.signal, requestedLocale);
          const [availabilityResult, contentResult, resaleResult] = await Promise.all([
            publicApi.getAvailability(loadedEvent.id, controller.signal).then(
              (items) => ({ ok: true as const, items }),
              (err: unknown) => ({
                ok: false as const,
                error: userFacingMessage(err),
              }),
            ),
            loadContentPage().catch((err) => {
              // Broken published content should fall back to the default public page,
              // not hard-fail the entire event page.
              if (err instanceof CheckoutApiError) return null;
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
          if (availabilityResult.ok) {
            loadedAvailability = availabilityResult.items;
          } else {
            loadedAvailability = [];
            availabilityLoadFailed = true;
            availabilityLoadError = availabilityResult.error;
          }
          loadedContentPage = contentResult;
          loadedResaleListings = resaleResult;
        }

        if (cancelled) return;
        setEvent(loadedEvent);
        setContentPage(loadedContentPage);
        setAvailability(loadedAvailability);
        if (availabilityLoadFailed) {
          setAvailabilityStatus('unavailable');
          setAvailabilityMessage(
            availabilityLoadError ??
              'Ticket availability is unavailable right now. Event details are still shown.',
          );
        } else {
          setAvailabilityStatus('current');
          setAvailabilityMessage(null);
        }
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
  }, [customDomainHost, eventId, eventSlug, initialBootstrap, requestedLocale]);

  const visibleTickets = useMemo(
    () => availability.filter((t) => t.status === 'active' || t.status === 'sold_out'),
    [availability],
  );
  // Never present stale/unavailable inventory as currently purchasable.
  const hasActiveTickets =
    availabilityStatus === 'current' && visibleTickets.some((t) => t.status === 'active');
  const publishedPuckData = contentPage?.page.puckData;
  const hasPublishedPuckContent = isEventPagePuckData(publishedPuckData);

  const pageDocument = useMemo(() => {
    if (!event) return undefined;
    const pageMedia = resolveEventPageMedia(event);
    const input = {
      eventId: event.id,
      eventTitle: event.title,
      eventDescription: event.description ?? undefined,
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? undefined,
      timezone: event.timezone,
      venue: event.venue
        ? {
            name: event.venue.name,
            address: event.venue.addressLine1,
            city: event.venue.city,
            region: event.venue.region,
            country: event.venue.country,
          }
        : undefined,
      brandName: brand.fallback ? undefined : brand.name,
      coverImageUrl: pageMedia?.url ?? event.coverImageUrl,
      coverImageAlt: pageMedia?.altText ?? event.title,
      publicUrl: `/e/${event.id}`,
      locale: resolvedLocale,
    };
    if (hasPublishedPuckContent && publishedPuckData) {
      return materializeEventPageDocument(
        {
          schemaVersion: 2,
          editor: { provider: '@puckeditor/core', data: publishedPuckData },
          settings: {
            locale: resolvedLocale,
            discovery: { summary: event.description ?? event.title, tags: [] },
          },
        },
        input,
      );
    }
    return materializeEventPageDocument(createDefaultEventPageDocument(input), input);
  }, [
    brand.fallback,
    brand.name,
    event,
    hasPublishedPuckContent,
    publishedPuckData,
    resolvedLocale,
  ]);

  const goToCheckout = useCallback(
    (resaleListingId?: string) => {
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
      params.set('locale', resolvedLocale);
      router.push(`/checkout?${params.toString()}`);
    },
    [
      affiliateCode,
      brand.fallback,
      brand.id,
      event?.id,
      eventId,
      presetDiscountCode,
      privacyUrl,
      refundUrl,
      resolvedLocale,
      router,
      supportUrl,
      termsUrl,
      trackingId,
    ],
  );

  const runtime = useMemo<EventPageRuntime>(() => {
    const tickets: PublicEventPageTicket[] = visibleTickets.map((ticket) => {
      const soldOut = ticket.status === 'sold_out' || ticket.available <= 0;
      const inventoryUnreliable =
        availabilityStatus === 'stale' || availabilityStatus === 'unavailable';
      return {
        id: ticket.ticketTypeId ?? ticket.productId ?? ticket.name,
        name: ticket.name,
        description: ticket.description,
        priceLabel: ticketPriceLabel({
          kind: ticket.kind,
          priceCents: ticket.priceCents,
          currency: ticket.currency,
          minimumPriceCents: ticket.minimumPriceCents,
        }),
        status: inventoryUnreliable ? 'sold_out' : soldOut ? 'sold_out' : ticket.status,
        availabilityLabel: inventoryUnreliable
          ? availabilityStatus === 'stale'
            ? 'Availability may be out of date'
            : 'Availability unavailable'
          : !soldOut && ticket.available <= 10
            ? `${ticket.available} left`
            : undefined,
      };
    });
    const productIds = new Set(
      visibleTickets.filter((item) => Boolean(item.productId)).map((item) => item.productId!),
    );
    const products = tickets.filter((item) => productIds.has(item.id));
    const ticketItems = tickets.filter((item) => !productIds.has(item.id));

    const footerLinks = [
      brand.legalUrls.terms ? { label: 'Terms', href: brand.legalUrls.terms } : null,
      brand.legalUrls.privacy ? { label: 'Privacy', href: brand.legalUrls.privacy } : null,
      brand.legalUrls.refundPolicy
        ? { label: 'Refund policy', href: brand.legalUrls.refundPolicy }
        : null,
      brand.supportUrl ? { label: 'Support', href: brand.supportUrl } : null,
    ].filter((link): link is { label: string; href: string } => Boolean(link));

    return {
      brandName: brand.name,
      brandFooterLabel: brand.whiteLabel
        ? brand.name
        : brand.fallback
          ? 'Powered by Tixkit'
          : `${brand.name} · Powered by Tixkit`,
      footerLinks,
      tickets: ticketItems,
      products,
      resaleListings: resaleListings.map((listing) => ({
        id: listing.id,
        name: listing.ticketTypeName
          ? `Resale ticket - ${listing.ticketTypeName}`
          : 'Resale ticket',
        priceLabel: ticketPriceLabel({
          kind: 'paid',
          priceCents: listing.priceCents,
          currency: listing.currency,
        }),
        expiresLabel: listing.expiresAt
          ? `Listing expires ${new Date(listing.expiresAt).toLocaleString()}`
          : undefined,
      })),
      resaleError: resaleListingsError ?? undefined,
      showGetTicketsCta: hasActiveTickets,
      interactive: availabilityStatus === 'current',
      onGetTickets: () => {
        if (availabilityStatus !== 'current') return;
        goToCheckout();
      },
      onBuyResale: (listingId) => {
        if (availabilityStatus !== 'current') return;
        goToCheckout(listingId);
      },
    };
  }, [
    availabilityStatus,
    brand,
    goToCheckout,
    hasActiveTickets,
    resaleListings,
    resaleListingsError,
    visibleTickets,
  ]);

  useEffect(() => {
    if (!event) return;
    trackMarketingEvent(event.marketingIntegrations, 'view_item', {
      eventId: event.id,
      currency: visibleTickets[0]?.currency,
      items: [{ id: event.id, name: event.title, quantity: 1 }],
    });
  }, [event, visibleTickets]);

  if (loading) {
    return (
      <SurfaceShell brand={brand}>
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10 sm:px-6">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-12 w-full max-w-xl" />
          <Skeleton className="h-4 w-full max-w-md" />
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
    <>
      <RefreshNotifier eventId={eventId ?? event?.id} />
      <SurfaceShell brand={brand} testId="public-event-page-surface">
        <div data-testid={hasPublishedPuckContent ? 'published-event-page' : 'default-event-page'}>
          {availabilityMessage ? (
            <output
              className="mx-auto block w-full max-w-3xl px-4 pt-6 sm:px-6"
              aria-live="polite"
              aria-busy={availabilityStatus === 'refreshing'}
              data-testid="availability-status-banner"
            >
              <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
                <p>{availabilityMessage}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit shrink-0"
                  disabled={availabilityStatus === 'refreshing'}
                  onClick={() => void refreshAvailability()}
                >
                  {availabilityStatus === 'refreshing'
                    ? 'Refreshing availability…'
                    : 'Retry availability'}
                </Button>
              </div>
            </output>
          ) : null}
          {pageDocument ? (
            <EventPagePuckRender
              brandVariables={{
                background: brand.theme.background,
                foreground: brand.theme.foreground,
                accent: brand.theme.primary ?? brand.theme.accent,
                radius: brand.theme.radius,
              }}
              document={pageDocument}
              runtime={runtime}
              validate={false}
            />
          ) : null}
        </div>
      </SurfaceShell>
    </>
  );
}

function SurfaceShell({
  brand,
  children,
  testId,
}: {
  brand: ResolvedBrand;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <BrandThemeSurface
      as="main"
      brand={brand}
      className="min-h-svh bg-background text-foreground"
      testId={testId}
    >
      {children}
    </BrandThemeSurface>
  );
}
