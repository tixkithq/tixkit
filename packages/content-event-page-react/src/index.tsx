import type {
  ResolvedEventPage,
  ResolvedEventPageBlock,
} from '@tixkit/content-event-page';

export { EditableText } from './editor/EditableText.js';
export type { EditableTextProps } from './editor/EditableText.js';
export { EditableBlockFrame } from './editor/EditableBlockFrame.js';
export type { EditableBlockFrameProps } from './editor/EditableBlockFrame.js';
export { EventPageEditorSurface } from './editor/EventPageEditorSurface.js';
export type { EventPageEditorSurfaceProps } from './editor/EventPageEditorSurface.js';
export { EditableBlockBody } from './editor/EventPageEditorSurface.js';
export type { EditableBlockBodyProps } from './editor/EventPageEditorSurface.js';

export type EventPageSurfaceProps = {
  resolvedPage: ResolvedEventPage;
  mode?: 'preview' | 'public';
  className?: string;
  onTicketCtaClick?: (input: { blockId: string }) => void;
};

/**
 * Shared event page surface. Renders the same namespaced class names and DOM
 * structure as the server HTML renderer (packages/content-event-page) so the
 * admin canvas, admin preview drawer, and checkout hosted page stay visually
 * parity. Consumes a resolved page model produced by resolveEventPageDocument.
 */
export function EventPageSurface({
  resolvedPage,
  mode = 'public',
  className,
  onTicketCtaClick,
}: EventPageSurfaceProps) {
  if (!resolvedPage.validation.valid) return null;
  return (
    <div
      className={className ? `tixkit-event-page ${className}` : 'tixkit-event-page'}
      data-schema-version={resolvedPage.schemaVersion}
      data-mode={mode}
      data-testid="tixkit-event-page"
    >
      {resolvedPage.blocks.map((block) => (
        <EventPageBlockView
          key={block.id}
          block={block}
          onTicketCtaClick={onTicketCtaClick}
        />
      ))}
    </div>
  );
}

type BlockViewProps = {
  block: ResolvedEventPageBlock;
  onTicketCtaClick?: (input: { blockId: string }) => void;
};

export function EventPageBlockView({ block, onTicketCtaClick }: BlockViewProps) {
  switch (block.type) {
    case 'hero':
      return (
        <section className="tk-ep-hero" data-block-id={block.id}>
          {block.eyebrow ? <p className="tk-ep-eyebrow">{block.eyebrow}</p> : null}
          <h1>{block.headline}</h1>
          {block.body ? <p>{block.body}</p> : null}
          {block.imageUrl ? (
            <img
              src={block.imageUrl}
              alt={block.imageAlt ?? ''}
              loading="lazy"
            />
          ) : null}
          {block.ctaLabel && block.ctaUrl ? (
            <a
              className="tk-ep-button"
              href={block.ctaUrl}
              onClick={
                onTicketCtaClick
                  ? (event) => {
                      event.preventDefault();
                      onTicketCtaClick({ blockId: block.id });
                    }
                  : undefined
              }
            >
              {block.ctaLabel}
            </a>
          ) : null}
        </section>
      );
    case 'rich_text':
      // The server resolver sanitizes rich-text HTML; render it verbatim to
      // match server output exactly.
      return (
        <section
          className="tk-ep-rich-text"
          data-block-id={block.id}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      );
    case 'event_details':
      return (
        <section className="tk-ep-details" data-block-id={block.id}>
          <h2>{block.title}</h2>
          <dl>
            {block.items.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case 'tickets':
      return (
        <section className="tk-ep-tickets" data-block-id={block.id}>
          <h2>{block.title}</h2>
          {block.body ? <p>{block.body}</p> : null}
          <ul>
            {block.tickets.map((ticket) => (
              <li key={ticket.id}>
                <strong>{ticket.name}</strong>
                {ticket.description ? <span>{ticket.description}</span> : null}
                {ticket.priceLabel ? <span>{ticket.priceLabel}</span> : null}
              </li>
            ))}
          </ul>
          {block.ctaLabel && block.checkoutUrl ? (
            <a
              className="tk-ep-button"
              href={block.checkoutUrl}
              onClick={
                onTicketCtaClick
                  ? (event) => {
                      event.preventDefault();
                      onTicketCtaClick({ blockId: block.id });
                    }
                  : undefined
              }
            >
              {block.ctaLabel}
            </a>
          ) : null}
        </section>
      );
    case 'products':
      return (
        <section className="tk-ep-products" data-block-id={block.id}>
          <h2>{block.title}</h2>
          {block.body ? <p>{block.body}</p> : null}
          <ul>
            {block.products.map((product) => (
              <li key={product.id}>
                <strong>{product.name}</strong>
                {product.description ? <span>{product.description}</span> : null}
                {product.priceLabel ? <span>{product.priceLabel}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      );
    case 'schedule':
      return (
        <section className="tk-ep-schedule" data-block-id={block.id}>
          <h2>{block.title}</h2>
          <ol>
            {block.items.map((item, index) => (
              <li key={`${item.title}-${index}`}>
                <strong>{item.title}</strong>
                <time>{item.startsAt}</time>
                {item.venueName ? <span>{item.venueName}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      );
    case 'venue_map':
      return (
        <section className="tk-ep-venue" data-block-id={block.id}>
          <h2>{block.title}</h2>
          <p>
            <strong>{block.venueName}</strong>
          </p>
          {block.address ? <p>{block.address}</p> : null}
          {block.mapUrl ? <a href={block.mapUrl}>Open map</a> : null}
        </section>
      );
    case 'faq':
      return (
        <section className="tk-ep-faq" data-block-id={block.id}>
          <h2>{block.title}</h2>
          {block.items.map((item, index) => (
            <details key={`${item.question}-${index}`}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </section>
      );
    case 'sponsors':
    case 'speakers':
      return (
        <section className={`tk-ep-${block.type}`} data-block-id={block.id}>
          <h2>{block.title}</h2>
          <ul>
            {block.items.map((item) => (
              <li key={item.name}>
                <strong>{item.name}</strong>
                {item.role ? <span>{item.role}</span> : null}
                {item.bio ? <p>{item.bio}</p> : null}
                {item.url ? <a href={item.url}>Open</a> : null}
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      );
    case 'button':
      return (
        <section className="tk-ep-action" data-block-id={block.id}>
          <a
            className={`tk-ep-button tk-ep-button-${block.style ?? 'primary'}`}
            href={block.url}
          >
            {block.label}
          </a>
        </section>
      );
    case 'divider':
      return <hr className="tk-ep-divider" data-block-id={block.id} />;
    case 'social_links':
      return (
        <section className="tk-ep-social" data-block-id={block.id}>
          {block.title ? <h2>{block.title}</h2> : null}
          <ul>
            {block.links.map((link) => (
              <li key={link.url}>
                <a href={link.url}>{link.label}</a>
              </li>
            ))}
          </ul>
        </section>
      );
    case 'custom_embed':
      // The server resolver sanitizes custom embed HTML and only emits it when
      // explicitly allowed; render verbatim to match server output.
      return block.html ? (
        <section
          className="tk-ep-embed"
          data-block-id={block.id}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ) : null;
    case 'event_header':
      return (
        <section className="tk-ep-header" data-block-id={block.id}>
          {block.showBadge && block.badgeLabel ? (
            <p className="tk-ep-badge">{block.badgeLabel}</p>
          ) : null}
          <p className="tk-ep-header__title">{block.title}</p>
          {block.showDescription && block.description ? (
            <p className="tk-ep-header__description">{block.description}</p>
          ) : null}
          {block.showDate || block.showVenue ? (
            <dl className="tk-ep-header__meta">
              {block.showDate && block.startsAt ? (
                <div>
                  <dt>Date</dt>
                  <dd>{block.startsAt}</dd>
                </div>
              ) : null}
              {block.showDate && block.timezone ? (
                <div>
                  <dt>Timezone</dt>
                  <dd>{block.timezone}</dd>
                </div>
              ) : null}
              {block.showVenue && block.venueName ? (
                <div>
                  <dt>Venue</dt>
                  <dd>{block.venueName}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </section>
      );
    case 'resale_tickets':
      return (
        <section className="tk-ep-resale" data-block-id={block.id}>
          <div className="tk-ep-resale__header">
            <h2>{block.title}</h2>
            {block.showVerifiedBadge ? (
              <span className="tk-ep-badge tk-ep-badge--verified">Verified listings</span>
            ) : null}
          </div>
          {block.listings.length > 0 ? (
            <ul>
              {block.listings.map((listing) => (
                <li key={listing.id}>
                  <strong>
                    {listing.ticketTypeName ? `Resale ticket - ${listing.ticketTypeName}` : 'Resale ticket'}
                  </strong>
                  <span>1 available</span>
                  {listing.priceLabel ? <span>{listing.priceLabel}</span> : null}
                  {listing.expiresAt ? <span>Expires {listing.expiresAt}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>{block.emptyStateText ?? 'No resale tickets available.'}</p>
          )}
          {block.ctaLabel && block.checkoutUrl ? (
            <a className="tk-ep-button" href={block.checkoutUrl}>
              {block.ctaLabel}
            </a>
          ) : null}
        </section>
      );
    case 'brand_footer':
      return block.links.length > 0 ? (
        <footer className="tk-ep-footer" data-block-id={block.id}>
          <ul className="tk-ep-footer__links">
            {block.links.map((link) => (
              <li key={link.url}>
                <a href={link.url}>{link.label}</a>
              </li>
            ))}
          </ul>
        </footer>
      ) : (
        <footer className="tk-ep-footer" data-block-id={block.id} />
      );
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}
