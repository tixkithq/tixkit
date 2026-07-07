import type {
  EventPageBlock,
  ResolvedEventPage,
  ResolvedEventPageBlock,
} from '@tixkit/content-event-page';
import { SurfaceEditingContext, useSurfaceEditing } from './editing/context.js';
import { SurfaceText } from './editing/SurfaceText.js';
import type { SurfaceEditing } from './editing/context.js';

export { SurfaceText } from './editing/SurfaceText.js';
export type { SurfaceTextProps } from './editing/SurfaceText.js';
export {
  SurfaceEditingContext,
  useEditableBlock,
  useSurfaceEditing,
} from './editing/context.js';
export type { SurfaceEditing, EditableBlockHandle } from './editing/context.js';
export { EditorOverlayLayer } from './editing/EditorOverlayLayer.js';
export type { EditorOverlayLayerProps } from './editing/EditorOverlayLayer.js';
export { useBlockRects, computeOverlayPlacement } from './editing/use-block-rects.js';
export type { OverlayPlacement } from './editing/use-block-rects.js';
export { BLOCK_LABELS, moveBlockInDocument } from './editing/block-operations.js';

export type EventPageSurfaceProps = {
  resolvedPage: ResolvedEventPage;
  mode?: 'preview' | 'public' | 'edit';
  className?: string;
  onTicketCtaClick?: (input: { blockId: string }) => void;
  /** Present iff mode === 'edit'. */
  editing?: SurfaceEditing;
};

const CHROME_BLOCK_TYPES = new Set<EventPageBlock['type']>([
  'event_header',
  'resale_tickets',
  'brand_footer',
]);

/**
 * Shared event page surface. Renders the same namespaced class names and DOM
 * structure as the server HTML renderer (packages/content-event-page) so the
 * admin canvas, admin preview drawer, and checkout hosted page stay visually
 * parity. Consumes a resolved page model produced by resolveEventPageDocument.
 *
 * In edit mode (editing provided) the surface threads a SurfaceEditingContext
 * so EventPageBlockView can bind inline editable text nodes to the raw working
 * document, and renders invalid drafts (editors must see blockers) instead of
 * returning null.
 */
export function EventPageSurface({
  resolvedPage,
  mode = 'public',
  className,
  onTicketCtaClick,
  editing,
}: EventPageSurfaceProps) {
  const isEditing = mode === 'edit' && Boolean(editing);
  // Public/preview hide invalid pages; edit renders drafts so blockers are visible.
  if (!isEditing && !resolvedPage.validation.valid) return null;

  const hasContentBlocks = resolvedPage.blocks.some(
    (block) => !CHROME_BLOCK_TYPES.has(block.type),
  );

  const surface = (
    <div
      className={className ? `tixkit-event-page ${className}` : 'tixkit-event-page'}
      data-schema-version={resolvedPage.schemaVersion}
      data-mode={mode}
      data-testid="tixkit-event-page"
    >
      {isEditing && !hasContentBlocks ? (
        <div className="tk-ep-empty-state" data-testid="tk-ep-empty-state">
          <p className="tk-ep-empty-state__title">Start building your event page</p>
          <p className="tk-ep-empty-state__hint">
            Use the insert menu to add a hero section, tickets, text, and more.
          </p>
        </div>
      ) : null}
      {resolvedPage.blocks.map((block) => (
        <EventPageBlockView
          key={block.id}
          block={block}
          mode={mode}
          onTicketCtaClick={onTicketCtaClick}
        />
      ))}
    </div>
  );

  if (!isEditing || !editing) return surface;
  return <SurfaceEditingContext.Provider value={editing}>{surface}</SurfaceEditingContext.Provider>;
}

type BlockViewProps = {
  block: ResolvedEventPageBlock;
  mode?: 'preview' | 'public' | 'edit';
  onTicketCtaClick?: (input: { blockId: string }) => void;
};

export function EventPageBlockView({ block, onTicketCtaClick }: BlockViewProps) {
  const editing = useSurfaceEditing();
  switch (block.type) {
    case 'hero': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawHero = raw?.type === 'hero' ? raw : undefined;
      return (
        <section className="tk-ep-hero" data-block-id={block.id}>
          {block.eyebrow ? (
            <SurfaceText
              as="p"
              className="tk-ep-eyebrow"
              blockId={block.id}
              field="eyebrow"
              value={rawHero?.eyebrow ?? block.eyebrow ?? ''}
              onCommit={(eyebrow) => rawHero && editing?.onChangeBlock(block.id, { ...rawHero, eyebrow })}
              placeholder="Eyebrow text"
              ariaLabel="Eyebrow text"
            />
          ) : null}
          <SurfaceText
            as="h1"
            blockId={block.id}
            field="headline"
            value={rawHero?.headline ?? block.headline}
            onCommit={(headline) => rawHero && editing?.onChangeBlock(block.id, { ...rawHero, headline })}
            placeholder="Page headline"
            ariaLabel="Page headline"
          />
          {block.body ? (
            <SurfaceText
              as="p"
              blockId={block.id}
              field="body"
              multiline
              value={rawHero?.body ?? block.body ?? ''}
              onCommit={(body) => rawHero && editing?.onChangeBlock(block.id, { ...rawHero, body })}
              placeholder="Page summary"
              ariaLabel="Page summary"
            />
          ) : null}
          {block.imageUrl ? (
            <img
              src={block.imageUrl}
              alt={block.imageAlt ?? ''}
              loading="lazy"
            />
          ) : null}
          {block.ctaLabel && block.ctaUrl ? (
            <SurfaceText
              as="a"
              className="tk-ep-button"
              blockId={block.id}
              field="ctaLabel"
              href={block.ctaUrl}
              onClick={
                editing
                  ? (event) => { event.preventDefault(); }
                  : onTicketCtaClick
                    ? (event) => { event.preventDefault(); onTicketCtaClick({ blockId: block.id }); }
                    : undefined
              }
              value={rawHero?.ctaLabel ?? block.ctaLabel ?? ''}
              onCommit={(ctaLabel) => rawHero && editing?.onChangeBlock(block.id, { ...rawHero, ctaLabel })}
              placeholder="Hero CTA label"
              ariaLabel="Hero CTA label"
            />
          ) : null}
        </section>
      );
    }
    case 'rich_text': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawRich = raw?.type === 'rich_text' ? raw : undefined;
      if (editing && rawRich && editing.renderRichTextBlock) {
        return (
          <section className="tk-ep-rich-text" data-block-id={block.id}>
            {editing.renderRichTextBlock({
              block: rawRich,
              disabled: editing.disabled,
              onChange: (next) => editing.onChangeBlock(block.id, next),
            })}
          </section>
        );
      }
      // The server resolver sanitizes rich-text HTML; render it verbatim to
      // match server output exactly (also the edit fallback when no WYSIWYG slot).
      return (
        <section
          className="tk-ep-rich-text"
          data-block-id={block.id}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      );
    }
    case 'event_details': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawDetails = raw?.type === 'event_details' ? raw : undefined;
      return (
        <section className="tk-ep-details" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawDetails?.title ?? block.title}
            onCommit={(title) => rawDetails && editing?.onChangeBlock(block.id, { ...rawDetails, title })}
            placeholder="Section title"
            ariaLabel="Event details title"
          />
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
    }
    case 'tickets': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawTickets = raw?.type === 'tickets' ? raw : undefined;
      return (
        <section className="tk-ep-tickets" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawTickets?.title ?? block.title}
            onCommit={(title) => rawTickets && editing?.onChangeBlock(block.id, { ...rawTickets, title })}
            placeholder="Tickets title"
            ariaLabel="Tickets title"
          />
          {block.body ? (
            <SurfaceText
              as="p"
              blockId={block.id}
              field="body"
              multiline
              value={rawTickets?.body ?? block.body ?? ''}
              onCommit={(body) => rawTickets && editing?.onChangeBlock(block.id, { ...rawTickets, body })}
              placeholder="Tickets body"
              ariaLabel="Tickets body"
            />
          ) : null}
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
            <SurfaceText
              as="a"
              className="tk-ep-button"
              blockId={block.id}
              field="ctaLabel"
              href={block.checkoutUrl}
              onClick={
                editing
                  ? (event) => { event.preventDefault(); }
                  : onTicketCtaClick
                    ? (event) => { event.preventDefault(); onTicketCtaClick({ blockId: block.id }); }
                    : undefined
              }
              value={rawTickets?.ctaLabel ?? block.ctaLabel ?? ''}
              onCommit={(ctaLabel) => rawTickets && editing?.onChangeBlock(block.id, { ...rawTickets, ctaLabel })}
              placeholder="Ticket CTA label"
              ariaLabel="Ticket CTA label"
            />
          ) : null}
        </section>
      );
    }
    case 'products': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawProducts = raw?.type === 'products' ? raw : undefined;
      return (
        <section className="tk-ep-products" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawProducts?.title ?? block.title}
            onCommit={(title) => rawProducts && editing?.onChangeBlock(block.id, { ...rawProducts, title })}
            placeholder="Section title"
            ariaLabel="Products title"
          />
          {block.body ? (
            <SurfaceText
              as="p"
              blockId={block.id}
              field="body"
              multiline
              value={rawProducts?.body ?? block.body ?? ''}
              onCommit={(body) => rawProducts && editing?.onChangeBlock(block.id, { ...rawProducts, body })}
              placeholder="Products body"
              ariaLabel="Products body"
            />
          ) : null}
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
    }
    case 'schedule': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawSchedule = raw?.type === 'schedule' ? raw : undefined;
      return (
        <section className="tk-ep-schedule" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawSchedule?.title ?? block.title}
            onCommit={(title) => rawSchedule && editing?.onChangeBlock(block.id, { ...rawSchedule, title })}
            placeholder="Section title"
            ariaLabel="Schedule title"
          />
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
    }
    case 'venue_map': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawVenue = raw?.type === 'venue_map' ? raw : undefined;
      return (
        <section className="tk-ep-venue" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawVenue?.title ?? block.title}
            onCommit={(title) => rawVenue && editing?.onChangeBlock(block.id, { ...rawVenue, title })}
            placeholder="Venue title"
            ariaLabel="Venue title"
          />
          <p>
            <SurfaceText
              as="strong"
              blockId={block.id}
              field="venueName"
              value={rawVenue?.venueName ?? block.venueName}
              onCommit={(venueName) => rawVenue && editing?.onChangeBlock(block.id, { ...rawVenue, venueName })}
              placeholder="Venue name"
              ariaLabel="Venue name"
            />
          </p>
          {block.address ? (
            <SurfaceText
              as="p"
              blockId={block.id}
              field="address"
              multiline
              value={rawVenue?.address ?? block.address ?? ''}
              onCommit={(address) => rawVenue && editing?.onChangeBlock(block.id, { ...rawVenue, address })}
              placeholder="Venue address"
              ariaLabel="Venue address"
            />
          ) : null}
          {block.mapUrl ? <a href={block.mapUrl}>Open map</a> : null}
        </section>
      );
    }
    case 'faq': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawFaq = raw?.type === 'faq' ? raw : undefined;
      return (
        <section className="tk-ep-faq" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawFaq?.title ?? block.title}
            onCommit={(title) => rawFaq && editing?.onChangeBlock(block.id, { ...rawFaq, title })}
            placeholder="Section title"
            ariaLabel="FAQ title"
          />
          {block.items.map((item, index) => (
            <details key={`${item.question}-${index}`}>
              <summary>
                <SurfaceText
                  as="span"
                  blockId={block.id}
                  field={`items.${index}.question`}
                  value={rawFaq?.items[index]?.question ?? item.question}
                  onCommit={(question) =>
                    rawFaq &&
                    editing?.onChangeBlock(block.id, {
                      ...rawFaq,
                      items: rawFaq.items.map((it, i) => (i === index ? { ...it, question } : it)),
                    })
                  }
                  placeholder="Question"
                  ariaLabel="FAQ question"
                />
              </summary>
              <p>
                <SurfaceText
                  as="span"
                  blockId={block.id}
                  field={`items.${index}.answer`}
                  multiline
                  value={rawFaq?.items[index]?.answer ?? item.answer}
                  onCommit={(answer) =>
                    rawFaq &&
                    editing?.onChangeBlock(block.id, {
                      ...rawFaq,
                      items: rawFaq.items.map((it, i) => (i === index ? { ...it, answer } : it)),
                    })
                  }
                  placeholder="Answer"
                  ariaLabel="FAQ answer"
                />
              </p>
            </details>
          ))}
        </section>
      );
    }
    case 'sponsors': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawSponsors = raw?.type === 'sponsors' ? raw : undefined;
      return (
        <section className="tk-ep-sponsors" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawSponsors?.title ?? block.title}
            onCommit={(title) => rawSponsors && editing?.onChangeBlock(block.id, { ...rawSponsors, title })}
            placeholder="Section title"
            ariaLabel="Sponsors title"
          />
          <ul>
            {block.items.map((item, index) => (
              <li key={item.name}>
                <SurfaceText
                  as="strong"
                  blockId={block.id}
                  field={`items.${index}.name`}
                  value={rawSponsors?.items[index]?.name ?? item.name}
                  onCommit={(name) =>
                    rawSponsors &&
                    editing?.onChangeBlock(block.id, {
                      ...rawSponsors,
                      items: rawSponsors.items.map((it, i) => (i === index ? { ...it, name } : it)),
                    })
                  }
                  placeholder="Name"
                  ariaLabel="Sponsor name"
                />
                {item.url ? <a href={item.url}>Open</a> : null}
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case 'speakers': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawSpeakers = raw?.type === 'speakers' ? raw : undefined;
      return (
        <section className="tk-ep-speakers" data-block-id={block.id}>
          <SurfaceText
            as="h2"
            blockId={block.id}
            field="title"
            value={rawSpeakers?.title ?? block.title}
            onCommit={(title) => rawSpeakers && editing?.onChangeBlock(block.id, { ...rawSpeakers, title })}
            placeholder="Section title"
            ariaLabel="Speakers title"
          />
          <ul>
            {block.items.map((item, index) => (
              <li key={item.name}>
                <SurfaceText
                  as="strong"
                  blockId={block.id}
                  field={`items.${index}.name`}
                  value={rawSpeakers?.items[index]?.name ?? item.name}
                  onCommit={(name) =>
                    rawSpeakers &&
                    editing?.onChangeBlock(block.id, {
                      ...rawSpeakers,
                      items: rawSpeakers.items.map((it, i) => (i === index ? { ...it, name } : it)),
                    })
                  }
                  placeholder="Name"
                  ariaLabel="Speaker name"
                />
                {item.role ? (
                  <SurfaceText
                    as="span"
                    blockId={block.id}
                    field={`items.${index}.role`}
                    value={rawSpeakers?.items[index]?.role ?? item.role ?? ''}
                    onCommit={(role) =>
                      rawSpeakers &&
                      editing?.onChangeBlock(block.id, {
                        ...rawSpeakers,
                        items: rawSpeakers.items.map((it, i) => (i === index ? { ...it, role } : it)),
                      })
                    }
                    placeholder="Role"
                    ariaLabel="Speaker role"
                  />
                ) : null}
                {item.bio ? (
                  <SurfaceText
                    as="p"
                    blockId={block.id}
                    field={`items.${index}.bio`}
                    multiline
                    value={rawSpeakers?.items[index]?.bio ?? item.bio ?? ''}
                    onCommit={(bio) =>
                      rawSpeakers &&
                      editing?.onChangeBlock(block.id, {
                        ...rawSpeakers,
                        items: rawSpeakers.items.map((it, i) => (i === index ? { ...it, bio } : it)),
                      })
                    }
                    placeholder="Bio"
                    ariaLabel="Speaker bio"
                  />
                ) : null}
                {item.url ? <a href={item.url}>Open</a> : null}
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case 'button': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawButton = raw?.type === 'button' ? raw : undefined;
      return (
        <section className="tk-ep-action" data-block-id={block.id}>
          <SurfaceText
            as="a"
            className={`tk-ep-button tk-ep-button-${block.style ?? 'primary'}`}
            blockId={block.id}
            field="label"
            href={block.url}
            onClick={editing ? (event) => { event.preventDefault(); } : undefined}
            value={rawButton?.label ?? block.label}
            onCommit={(label) => rawButton && editing?.onChangeBlock(block.id, { ...rawButton, label })}
            placeholder="Button label"
            ariaLabel="Button label"
          />
        </section>
      );
    }
    case 'divider':
      return <hr className="tk-ep-divider" data-block-id={block.id} />;
    case 'social_links': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawSocial = raw?.type === 'social_links' ? raw : undefined;
      return (
        <section className="tk-ep-social" data-block-id={block.id}>
          {block.title ? (
            <SurfaceText
              as="h2"
              blockId={block.id}
              field="title"
              value={rawSocial?.title ?? block.title ?? ''}
              onCommit={(title) => rawSocial && editing?.onChangeBlock(block.id, { ...rawSocial, title })}
              placeholder="Section title"
              ariaLabel="Social links title"
            />
          ) : null}
          <ul>
            {block.links.map((link, index) => (
              <li key={link.url}>
                <SurfaceText
                  as="a"
                  blockId={block.id}
                  field={`links.${index}.label`}
                  href={link.url}
                  onClick={editing ? (event) => { event.preventDefault(); } : undefined}
                  value={rawSocial?.links[index]?.label ?? link.label}
                  onCommit={(label) =>
                    rawSocial &&
                    editing?.onChangeBlock(block.id, {
                      ...rawSocial,
                      links: rawSocial.links.map((l, i) => (i === index ? { ...l, label } : l)),
                    })
                  }
                  placeholder="Link label"
                  ariaLabel="Link label"
                />
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case 'custom_embed':
      // The server resolver sanitizes custom embed HTML and only emits it when
      // explicitly allowed; render verbatim to match server output (edited via inspector).
      return block.html ? (
        <section
          className="tk-ep-embed"
          data-block-id={block.id}
          dangerouslySetInnerHTML={{ __html: block.html }}
        />
      ) : null;
    case 'event_header': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawHeader = raw?.type === 'event_header' ? raw : undefined;
      return (
        <section className="tk-ep-header" data-block-id={block.id}>
          {block.showBadge && block.badgeLabel ? (
            <SurfaceText
              as="p"
              className="tk-ep-badge"
              blockId={block.id}
              field="badgeLabel"
              value={rawHeader?.badgeLabel ?? block.badgeLabel ?? ''}
              onCommit={(badgeLabel) => rawHeader && editing?.onChangeBlock(block.id, { ...rawHeader, badgeLabel })}
              placeholder="Badge label (defaults to brand name)"
              ariaLabel="Badge label"
            />
          ) : null}
          <p className="tk-ep-header__title">{block.title}</p>
          {block.showDescription && block.description ? (
            <SurfaceText
              as="p"
              className="tk-ep-header__description"
              blockId={block.id}
              field="descriptionOverride"
              multiline
              value={rawHeader?.descriptionOverride ?? block.description ?? ''}
              onCommit={(descriptionOverride) => rawHeader && editing?.onChangeBlock(block.id, { ...rawHeader, descriptionOverride })}
              placeholder="Description override (defaults to event description)"
              ariaLabel="Description override"
            />
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
    }
    case 'resale_tickets': {
      const raw = editing?.document.blocks.find((b) => b.id === block.id);
      const rawResale = raw?.type === 'resale_tickets' ? raw : undefined;
      return (
        <section className="tk-ep-resale" data-block-id={block.id}>
          <div className="tk-ep-resale__header">
            <SurfaceText
              as="h2"
              blockId={block.id}
              field="title"
              value={rawResale?.title ?? block.title}
              onCommit={(title) => rawResale && editing?.onChangeBlock(block.id, { ...rawResale, title })}
              placeholder="Resale section title"
              ariaLabel="Resale tickets title"
            />
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
            <SurfaceText
              as="p"
              blockId={block.id}
              field="emptyStateText"
              multiline
              value={rawResale?.emptyStateText ?? block.emptyStateText ?? ''}
              onCommit={(emptyStateText) => rawResale && editing?.onChangeBlock(block.id, { ...rawResale, emptyStateText })}
              placeholder="Empty state text"
              ariaLabel="Resale empty state"
            />
          )}
          {block.ctaLabel && block.checkoutUrl ? (
            <SurfaceText
              as="a"
              className="tk-ep-button"
              blockId={block.id}
              field="ctaLabel"
              href={block.checkoutUrl}
              onClick={editing ? (event) => { event.preventDefault(); } : undefined}
              value={rawResale?.ctaLabel ?? block.ctaLabel ?? ''}
              onCommit={(ctaLabel) => rawResale && editing?.onChangeBlock(block.id, { ...rawResale, ctaLabel })}
              placeholder="Resale CTA label"
              ariaLabel="Resale CTA label"
            />
          ) : null}
        </section>
      );
    }
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
