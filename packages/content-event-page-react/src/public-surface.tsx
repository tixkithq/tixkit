import type { CSSProperties, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import {
  AlertCircleIcon,
  ArrowRightIcon,
  CalendarIcon,
  ClockIcon,
  ExternalLinkIcon,
  MapPinIcon,
  TicketIcon,
} from 'lucide-react';
import type {
  EventPageBrandFooterProps,
  EventPageBrandVariables,
  EventPageCheckoutCtaProps,
  EventPageEventHeaderProps,
  EventPageMediaRole,
  EventPageProductAddOnsProps,
  EventPageResaleTicketsProps,
  EventPageTicketsProps,
} from '@tixkit/content-event-page';
import {
  eventPageBrandVariablesToCssProperties,
  formatTimezoneLabel,
} from '@tixkit/content-event-page';

export type PublicEventPageTicket = {
  id: string;
  name: string;
  description?: string;
  priceLabel: string;
  status: 'active' | 'sold_out' | string;
  availabilityLabel?: string;
};

export type PublicEventPageProduct = PublicEventPageTicket;

export type PublicEventPageResaleListing = {
  id: string;
  name: string;
  priceLabel: string;
  expiresLabel?: string;
};

export type PublicEventPageFooterLink = {
  label: string;
  href: string;
};

export type EventPageRuntime = {
  brandName: string;
  brandFooterLabel: string;
  footerLinks?: PublicEventPageFooterLink[];
  tickets: PublicEventPageTicket[];
  products?: PublicEventPageProduct[];
  eventMedia?: Partial<
    Record<
      EventPageMediaRole,
      {
        url: string;
        altText: string;
      }
    >
  >;
  resaleListings?: PublicEventPageResaleListing[];
  resaleError?: string;
  showGetTicketsCta?: boolean;
  interactive?: boolean;
  onGetTickets?: () => void;
  onBuyResale?: (listingId: string) => void;
};

/** @deprecated Prefer EventPageRuntime with chrome blocks in the Puck document. */
export type PublicEventPageChrome = EventPageRuntime & {
  title: string;
  description?: string;
  startsAtLabel?: string;
  timezone?: string;
  venueName?: string;
};

export type PublicEventPageSurfaceProps = {
  children?: ReactNode;
  chrome: PublicEventPageChrome;
  brandVariables?: EventPageBrandVariables;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  as?: 'div' | 'main';
};

function joinClassNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

const EventPageRuntimeContext = createContext<EventPageRuntime | null>(null);

export function EventPageRuntimeProvider({
  value,
  children,
}: {
  value: EventPageRuntime;
  children: ReactNode;
}) {
  return (
    <EventPageRuntimeContext.Provider value={value}>{children}</EventPageRuntimeContext.Provider>
  );
}

export function useEventPageRuntime(): EventPageRuntime {
  return (
    useContext(EventPageRuntimeContext) ?? {
      brandName: 'Event',
      brandFooterLabel: 'Powered by Tixkit',
      tickets: [],
      resaleListings: [],
      interactive: false,
    }
  );
}

const badgeBaseClass =
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium';
const badgeSecondaryClass = `${badgeBaseClass} border-transparent bg-secondary text-secondary-foreground`;
const badgeOutlineClass = `${badgeBaseClass} text-foreground`;

const buttonBaseClass =
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4";
const buttonDefaultClass = `${buttonBaseClass} bg-primary text-primary-foreground shadow-xs hover:bg-primary/90`;
const buttonSmClass = `${buttonDefaultClass} h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5`;
const buttonLgClass = `${buttonDefaultClass} h-11 rounded-md px-6 text-base has-[>svg]:px-4`;

const cardClass =
  'flex flex-col gap-4 rounded-xl border bg-card py-4 text-card-foreground shadow-sm sm:flex-row sm:items-center sm:justify-between';

type WithBlockId<T> = T & { id?: string };

/** Puck contentEditable fields can pass React nodes at edit-time; only strings are trim-safe. */
function textProp(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function styleFromLengths(values: Record<string, string | undefined>): CSSProperties {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ) as CSSProperties;
}

/** Page h1 chrome block — primary outline/heading-audit root. */
export function EventHeaderBlock({
  id,
  brandLabel,
  title,
  description,
  startsAtLabel,
  timezone,
  venueName,
  showDate = true,
  showTimezone = true,
  showVenue = true,
}: WithBlockId<EventPageEventHeaderProps>) {
  const runtime = useEventPageRuntime();
  const resolvedBrand =
    typeof brandLabel === 'string' || brandLabel == null
      ? textProp(brandLabel) || runtime.brandName
      : (brandLabel as ReactNode);
  const resolvedTitle =
    typeof title === 'string' || title == null ? textProp(title, 'Event') : title;
  const resolvedDescription =
    typeof description === 'string' || description == null ? textProp(description) : description;
  const resolvedStartsAt =
    typeof startsAtLabel === 'string' || startsAtLabel == null
      ? textProp(startsAtLabel, 'Date to be announced')
      : startsAtLabel;
  const rawTimezone = typeof timezone === 'string' || timezone == null ? textProp(timezone) : '';
  const resolvedTimezone =
    (typeof rawTimezone === 'string' && rawTimezone
      ? (formatTimezoneLabel(rawTimezone) ?? rawTimezone)
      : '') || 'Timezone to be announced';
  const resolvedVenue =
    typeof venueName === 'string' || venueName == null
      ? textProp(venueName, 'Venue to be announced')
      : venueName;

  return (
    <header className="space-y-5" data-block-id={id} data-block-type="EventHeader">
      <span
        className={`${badgeSecondaryClass} gap-1.5`}
        data-event-page-outline-target={`${id}:badge`}
        data-slot="badge"
      >
        <TicketIcon className="size-3.5" />
        {resolvedBrand}
      </span>
      <h1
        className="text-3xl font-bold tracking-tight text-balance sm:text-5xl"
        data-event-page-outline-target={`${id}:title`}
      >
        {resolvedTitle}
      </h1>
      {resolvedDescription ? (
        <p
          className="text-muted-foreground max-w-3xl text-sm leading-relaxed sm:text-base"
          data-event-page-outline-target={`${id}:description`}
        >
          {resolvedDescription}
        </p>
      ) : null}

      {showDate || showTimezone || showVenue ? (
        <dl
          className="text-foreground flex flex-wrap gap-x-6 gap-y-3 text-sm"
          data-event-page-outline-target={`${id}:details`}
        >
          {showDate ? (
            <div className="flex min-w-0 items-center gap-2">
              <CalendarIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <div>
                <dt className="sr-only">Date</dt>
                <dd>{resolvedStartsAt}</dd>
              </div>
            </div>
          ) : null}
          {showTimezone ? (
            <div className="flex min-w-0 items-center gap-2">
              <ClockIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <div>
                <dt className="sr-only">Timezone</dt>
                <dd>{resolvedTimezone}</dd>
              </div>
            </div>
          ) : null}
          {showVenue ? (
            <div className="flex min-w-0 items-center gap-2">
              <MapPinIcon className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <div>
                <dt className="sr-only">Location</dt>
                <dd>{resolvedVenue}</dd>
              </div>
            </div>
          ) : null}
        </dl>
      ) : null}
    </header>
  );
}

/** Tickets chrome — section h2 for outline/heading audit. */
export function TicketsBlock({
  id,
  title = 'Tickets',
  emptyTitle = 'No tickets available',
  emptyDescription = 'Ticket sales have not opened for this event yet. Check back soon.',
  previewState = 'live',
  alignment = 'left',
  spacing = 'normal',
  titleFontSize,
  titleColor,
  sectionGap,
  itemGap,
  itemPadding,
  itemRadius,
  itemBackgroundColor,
  itemBorderColor,
  itemTextColor,
  itemDescriptionColor,
  priceTextColor,
  emptyBackgroundColor,
  emptyBorderColor,
  blockType = 'Tickets',
}: WithBlockId<EventPageTicketsProps> & {
  blockType?: 'Tickets' | 'ProductAddOns';
}) {
  const runtime = useEventPageRuntime();
  const interactive = runtime.interactive !== false;
  const usePreviewState = interactive ? 'live' : previewState;
  const tickets =
    usePreviewState === 'empty'
      ? []
      : usePreviewState === 'populated' && runtime.tickets.length === 0
        ? [
            {
              id: 'preview-ticket',
              name: 'General Admission',
              description: 'Example ticket shown only in the editor canvas.',
              priceLabel: 'Free',
              status: 'active',
              availabilityLabel: '10 left',
            },
          ]
        : runtime.tickets;

  const sectionStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    ...styleFromLengths({ gap: sectionGap || '16px' }),
    textAlign: alignment,
  };
  const listStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    listStyle: 'none',
    margin: 0,
    padding: 0,
    ...styleFromLengths({
      gap: itemGap || (spacing === 'compact' ? '8px' : spacing === 'loose' ? '20px' : '12px'),
    }),
  };

  return (
    <section
      className={`tk-ep-section-spacing-${spacing}`}
      id={blockType === 'Tickets' ? 'tickets' : 'product-add-ons'}
      aria-label={title}
      data-block-id={id}
      data-block-type={blockType}
      style={sectionStyle}
    >
      <h2
        className="text-lg font-semibold"
        data-event-page-outline-target={`${id}:title`}
        style={{
          ...styleFromLengths({ fontSize: titleFontSize }),
          ...(titleColor ? { color: titleColor } : {}),
        }}
      >
        {title}
      </h2>

      {tickets.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center"
          data-event-page-outline-target={`${id}:ticketList`}
          style={{
            ...styleFromLengths({
              borderRadius: itemRadius,
              padding: itemPadding,
            }),
            ...(emptyBackgroundColor ? { backgroundColor: emptyBackgroundColor } : {}),
            ...(emptyBorderColor ? { borderColor: emptyBorderColor } : {}),
          }}
        >
          <div className="bg-muted flex size-10 items-center justify-center rounded-full">
            <TicketIcon className="text-muted-foreground size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">{emptyTitle}</p>
            <p className="text-muted-foreground text-sm">{emptyDescription}</p>
          </div>
        </div>
      ) : (
        <ul data-event-page-outline-target={`${id}:ticketList`} style={listStyle}>
          {tickets.map((ticket) => {
            const soldOut = ticket.status === 'sold_out';
            return (
              <li key={ticket.id}>
                <div
                  className={cardClass}
                  data-slot="card"
                  style={{
                    ...styleFromLengths({
                      borderRadius: itemRadius,
                      padding: itemPadding,
                    }),
                    ...(itemBackgroundColor ? { backgroundColor: itemBackgroundColor } : {}),
                    ...(itemBorderColor ? { borderColor: itemBorderColor } : {}),
                    ...(itemTextColor ? { color: itemTextColor } : {}),
                  }}
                >
                  <div className="flex w-full flex-1 flex-col gap-1 px-6" data-slot="card-content">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{ticket.name}</span>
                      {soldOut ? (
                        <span className={badgeSecondaryClass} data-slot="badge">
                          Sold out
                        </span>
                      ) : ticket.availabilityLabel ? (
                        <span className={badgeOutlineClass} data-slot="badge">
                          {ticket.availabilityLabel}
                        </span>
                      ) : null}
                    </div>
                    {ticket.description ? (
                      <p
                        className="text-muted-foreground text-sm"
                        style={itemDescriptionColor ? { color: itemDescriptionColor } : undefined}
                      >
                        {ticket.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="w-full px-6 text-left sm:w-auto sm:text-right">
                    <div
                      className="font-semibold"
                      style={priceTextColor ? { color: priceTextColor } : undefined}
                    >
                      {ticket.priceLabel}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ProductAddOnsBlock(props: WithBlockId<EventPageProductAddOnsProps>) {
  const runtime = useEventPageRuntime();
  return (
    <EventPageRuntimeProvider value={{ ...runtime, tickets: runtime.products ?? [] }}>
      <TicketsBlock {...props} blockType="ProductAddOns" />
    </EventPageRuntimeProvider>
  );
}

/** Resale chrome — section h2 when listings exist. */
export function ResaleTicketsBlock({
  id,
  title = 'Resale tickets',
  badgeLabel = 'Verified listings',
  previewState = 'live',
}: WithBlockId<EventPageResaleTicketsProps>) {
  const runtime = useEventPageRuntime();
  const interactive = runtime.interactive !== false;
  const usePreviewState = interactive ? 'live' : previewState;
  const runtimeListings = runtime.resaleListings ?? [];
  const listings =
    usePreviewState === 'empty'
      ? []
      : usePreviewState === 'populated' && runtimeListings.length === 0
        ? [
            {
              id: 'preview-resale-listing',
              name: 'Resale ticket - General Admission',
              priceLabel: '$45.00',
              expiresLabel: 'Example listing shown only in the editor canvas.',
            },
          ]
        : runtimeListings;
  const resaleError = runtime.resaleError;

  if (!resaleError && listings.length === 0 && usePreviewState !== 'empty') {
    if (interactive) return null;
    return (
      <span className="sr-only" data-block-id={id} data-block-type="ResaleTickets">
        {title}
      </span>
    );
  }
  if (!resaleError && listings.length === 0 && usePreviewState === 'empty') {
    return (
      <section
        className="space-y-2"
        aria-label={title}
        data-block-id={id}
        data-block-type="ResaleTickets"
      >
        <h2 className="text-lg font-semibold" data-event-page-outline-target={`${id}:title`}>
          {title}
        </h2>
        <p
          className="text-muted-foreground text-sm"
          data-event-page-outline-target={`${id}:resaleList`}
        >
          No resale listings available yet.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4" data-block-id={id} data-block-type="ResaleTickets">
      {resaleError ? (
        <output
          className="bg-card text-card-foreground relative grid w-full items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm grid-cols-[0_1fr] has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current"
          data-slot="alert"
        >
          <AlertCircleIcon className="size-4" />
          <div className="col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight">
            Resale tickets are temporarily unavailable
          </div>
          <div className="text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed">
            {resaleError}
          </div>
        </output>
      ) : null}

      {listings.length > 0 ? (
        <section className="space-y-4" aria-label={title}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold" data-event-page-outline-target={`${id}:title`}>
              {title}
            </h2>
            <span className={badgeOutlineClass} data-slot="badge">
              {badgeLabel}
            </span>
          </div>
          <ul className="space-y-3" data-event-page-outline-target={`${id}:resaleList`}>
            {listings.map((listing) => (
              <li key={listing.id}>
                <div className={cardClass} data-slot="card">
                  <div className="flex w-full flex-1 flex-col gap-1 px-6" data-slot="card-content">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{listing.name}</span>
                      <span className={badgeSecondaryClass} data-slot="badge">
                        1 available
                      </span>
                    </div>
                    {listing.expiresLabel ? (
                      <p className="text-muted-foreground text-sm">{listing.expiresLabel}</p>
                    ) : null}
                  </div>
                  <div className="flex w-full flex-col items-start gap-2 px-6 text-left sm:w-auto sm:items-end sm:text-right">
                    <div className="font-semibold">{listing.priceLabel}</div>
                    {interactive ? (
                      <button
                        className={`${buttonSmClass} gap-1.5`}
                        onClick={() => runtime.onBuyResale?.(listing.id)}
                        type="button"
                      >
                        Buy resale
                        <ArrowRightIcon className="size-4" />
                      </button>
                    ) : (
                      <span className={`${buttonSmClass} pointer-events-none gap-1.5 opacity-90`}>
                        Buy resale
                        <ArrowRightIcon className="size-4" />
                      </span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function CheckoutCtaBlock({
  id,
  label = 'Get tickets',
  supportingText = 'Secure checkout powered by Tixkit',
}: WithBlockId<EventPageCheckoutCtaProps>) {
  const runtime = useEventPageRuntime();
  const show =
    runtime.showGetTicketsCta ?? runtime.tickets.some((ticket) => ticket.status === 'active');
  // Keep CTA visible in non-interactive editor preview so the full chrome composition remains editable.
  if (!show && runtime.interactive !== false) return null;
  const interactive = runtime.interactive !== false;

  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      data-block-id={id}
      data-block-type="CheckoutCta"
    >
      <p
        className="text-muted-foreground text-sm"
        data-event-page-outline-target={`${id}:supportingText`}
      >
        {supportingText}
      </p>
      {interactive ? (
        <button
          className={`${buttonLgClass} gap-1.5`}
          data-event-page-outline-target={`${id}:label`}
          onClick={() => runtime.onGetTickets?.()}
          type="button"
        >
          {label}
          <ArrowRightIcon className="size-4" />
        </button>
      ) : (
        <span
          className={`${buttonLgClass} pointer-events-none gap-1.5 opacity-90`}
          data-event-page-outline-target={`${id}:label`}
        >
          {label}
          <ArrowRightIcon className="size-4" />
        </span>
      )}
    </div>
  );
}

export function BrandFooterBlock({ id, label }: WithBlockId<EventPageBrandFooterProps>) {
  const runtime = useEventPageRuntime();
  const footerLabel =
    typeof label === 'string' || label == null
      ? textProp(label) || runtime.brandFooterLabel
      : (label as ReactNode);
  const footerLinks = runtime.footerLinks ?? [];

  return (
    <footer className="space-y-4 pt-4" data-block-id={id} data-block-type="BrandFooter">
      <hr className="bg-border h-px w-full shrink-0 border-0" data-slot="separator" />
      <div className="text-muted-foreground flex flex-col items-start justify-between gap-3 text-xs sm:flex-row sm:items-center">
        <p data-event-page-outline-target={`${id}:label`}>{footerLabel}</p>
        {footerLinks.length > 0 ? (
          <nav className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Brand links">
            {footerLinks.map((link) => (
              <a
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                href={link.href}
                key={`${link.label}:${link.href}`}
                rel="noreferrer"
                target="_blank"
              >
                {link.label}
                <ExternalLinkIcon className="size-3" />
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}

/**
 * @deprecated Prefer rendering the full Puck document with chrome blocks.
 * Kept for transitional callers that still pass chrome props.
 */
export function PublicEventPageSurface({
  children,
  chrome,
  brandVariables,
  className,
  style,
  testId = 'public-event-page-surface',
  as = 'div',
}: PublicEventPageSurfaceProps) {
  const Root = as;
  const brandStyle = {
    ...eventPageBrandVariablesToCssProperties(brandVariables),
    ...style,
  } as CSSProperties;

  const runtime: EventPageRuntime = {
    brandName: chrome.brandName,
    brandFooterLabel: chrome.brandFooterLabel,
    footerLinks: chrome.footerLinks,
    tickets: chrome.tickets,
    resaleListings: chrome.resaleListings,
    resaleError: chrome.resaleError,
    showGetTicketsCta: chrome.showGetTicketsCta,
    interactive: chrome.interactive,
    onGetTickets: chrome.onGetTickets,
    onBuyResale: chrome.onBuyResale,
  };

  return (
    <Root
      className={joinClassNames(
        as === 'main' ? 'min-h-svh' : 'min-h-full',
        'bg-background text-foreground',
        className,
      )}
      data-testid={testId}
      style={brandStyle}
    >
      <EventPageRuntimeProvider value={runtime}>
        <div className="mx-auto w-full max-w-6xl space-y-8 px-4 py-10 sm:px-8 lg:px-10">
          <EventHeaderBlock
            brandLabel={chrome.brandName}
            title={chrome.title}
            description={chrome.description}
            startsAtLabel={chrome.startsAtLabel}
            timezone={chrome.timezone}
            venueName={chrome.venueName}
          />
          {children ? <div data-testid="preview-surface">{children}</div> : null}
          <hr className="bg-border h-px w-full shrink-0 border-0" />
          <TicketsBlock />
          <ResaleTicketsBlock />
          <CheckoutCtaBlock />
          <BrandFooterBlock />
        </div>
      </EventPageRuntimeProvider>
    </Root>
  );
}

export function formatEventPageMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function ticketPriceLabel(input: {
  kind?: string;
  priceCents: number;
  currency: string;
  minimumPriceCents?: number | null;
}): string {
  if (input.kind === 'free') return 'Free';
  if (input.kind === 'donation') {
    return `From ${formatEventPageMoney(input.minimumPriceCents ?? 0, input.currency)}`;
  }
  return formatEventPageMoney(input.priceCents, input.currency);
}
