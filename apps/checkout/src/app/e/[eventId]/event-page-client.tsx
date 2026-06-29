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
import { EmptyState } from '@/components/empty-state';
import { BrandFooter } from '@/components/checkout/brand-footer';
import {
  publicApi,
  CheckoutApiError,
  type PublicEvent,
  type PublicContentPage,
  type AvailabilityItem,
  userFacingMessage,
} from '@/lib/api';
import { brandThemeStyle, type ResolvedBrand } from '@/lib/brand';
import { useResolvedBrand } from '@/lib/use-brand';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { trackMarketingEvent } from '@/lib/marketing';

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
}: Props) {
  const router = useRouter();
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [contentPage, setContentPage] = useState<PublicContentPage | null>(null);
  const [availability, setAvailability] = useState<AvailabilityItem[]>([]);
  const [loading, setLoading] = useState(true);
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
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      if (!eventId && (!eventSlug || !customDomainHost)) return;
      setLoading(true);
      setError(null);
      try {
        const loadedEvent = eventId
          ? await publicApi.getEvent(eventId, controller.signal)
          : await publicApi.getEventBySlug(eventSlug!, customDomainHost!, controller.signal);
        const loadContentPage =
          eventSlug && customDomainHost
            ? () => publicApi.getEventPageBySlug(eventSlug, customDomainHost, controller.signal)
            : () => publicApi.getEventPage(loadedEvent.id, controller.signal);
        const [loadedAvailability, loadedContentPage] = await Promise.all([
          publicApi.getAvailability(loadedEvent.id, controller.signal),
          loadContentPage().catch((err) => {
            if (err instanceof CheckoutApiError && err.status === 404) return null;
            throw err;
          }),
        ]);
        if (cancelled) return;
        setEvent(loadedEvent);
        setContentPage(loadedContentPage);
        setAvailability(loadedAvailability);
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
  }, [customDomainHost, eventId, eventSlug]);

  const visibleTickets = useMemo(
    () => availability.filter((t) => t.status === 'active' || t.status === 'sold_out'),
    [availability],
  );
  const hasActiveTickets = visibleTickets.some((t) => t.status === 'active');
  const startsAt = event ? formatDateTime(event.startsAt, event.timezone) : null;
  const venueName = event?.venue?.name;

  useEffect(() => {
    if (!event) return;
    trackMarketingEvent(event.marketingIntegrations, 'view_item', {
      eventId: event.id,
      currency: visibleTickets[0]?.currency,
      items: [{ id: event.id, name: event.title, quantity: 1 }],
    });
  }, [event, visibleTickets]);

  function goToCheckout() {
    const checkoutEventId = event?.id ?? eventId;
    if (!checkoutEventId) return;
    const params = new URLSearchParams();
    params.set('eventId', checkoutEventId);
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
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-10 sm:px-6">
        <header className="space-y-4">
          <Badge variant="secondary" className="gap-1.5">
            <TicketIcon className="size-3.5" />
            {brand.name}
          </Badge>
          <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            {event?.title ?? 'Event'}
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

        {contentPage ? (
          <article
            className="prose prose-neutral max-w-none dark:prose-invert"
            data-testid="published-event-page"
            dangerouslySetInnerHTML={{
              __html: sanitizePublishedEventPageHtml(contentPage.page.html),
            }}
          />
        ) : null}

        <Separator />

        <section className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Tickets</h2>
            {hasActiveTickets ? (
              <Button size="sm" onClick={goToCheckout} className="gap-1.5">
                Get tickets
                <ArrowRightIcon className="size-4" />
              </Button>
            ) : null}
          </div>

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
                    <Card className="flex flex-row items-center justify-between gap-4 py-4">
                      <CardContent className="flex flex-1 flex-col gap-1">
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
                      <div className="px-6 text-right">
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

        {hasActiveTickets ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Secure checkout powered by Tixkit</p>
            <Button size="lg" onClick={goToCheckout} className="gap-1.5">
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

function sanitizePublishedEventPageHtml(html: string): string {
  return html
    .replace(
      /<iframe\b(?=[^>]*\ssrcdoc\b)[\s\S]*?<\/iframe>/gi,
      '',
    )
    .replace(
      /<(script|object|embed|form|svg|math|base|link|meta|style|template)\b[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(
      /<(script|object|embed|form|svg|math|base|link|meta|style|template)\b[^>]*\/?>/gi,
      '',
    )
    .replace(
      /\s+on[a-z][\w:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]+))?/gi,
      '',
    )
    .replace(
      /\s+(srcdoc|style)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]*)/gi,
      '',
    )
    .replace(
      /\s+(href|src|data|action|formaction|xlink:href)\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s"'`=<>]*)/gi,
      (attribute: string, _name: string, rawValue: string) =>
        hasUnsafeHtmlUrlScheme(rawValue) ? '' : attribute,
    );
}

function hasUnsafeHtmlUrlScheme(rawValue: string): boolean {
  const value = stripAttributeQuotes(rawValue)
    .replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));?/gi, (_entity, hex, decimal, named) => {
      if (hex) return htmlCodePointEntity(hex, 16);
      if (decimal) return htmlCodePointEntity(decimal, 10);
      return namedHtmlEntity(named);
    })
    .split('')
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .toLowerCase();
  return /^(?:javascript|data|file):/.test(value);
}

function stripAttributeQuotes(rawValue: string): string {
  const first = rawValue[0];
  const last = rawValue[rawValue.length - 1];
  return (first === '"' || first === "'" || first === '`') && first === last
    ? rawValue.slice(1, -1)
    : rawValue;
}

function htmlCodePointEntity(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return '';
  }
  return String.fromCodePoint(codePoint);
}

function namedHtmlEntity(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === 'colon') return ':';
  if (normalized === 'tab') return '\t';
  if (normalized === 'newline') return '\n';
  if (normalized === 'amp') return '&';
  if (normalized === 'lt') return '<';
  if (normalized === 'gt') return '>';
  if (normalized === 'quot') return '"';
  if (normalized === 'apos') return "'";
  return `&${name};`;
}

function SurfaceShell({ brand, children }: { brand: ResolvedBrand; children: React.ReactNode }) {
  return (
    <main className="min-h-svh bg-background text-foreground" style={brandThemeStyle(brand)}>
      {children}
    </main>
  );
}
