import * as React from 'react';
import type {
  EventPageBlock,
  EventPageDocument,
  EventPageRenderContext,
} from '@tixkit/content-event-page';
import { EditableText } from './EditableText.js';
import { EditableBlockFrame } from './EditableBlockFrame.js';

export type EventPageEditorSurfaceProps = {
  document: EventPageDocument;
  sampleContext: EventPageRenderContext;
  selectedBlockId?: string;
  disabled?: boolean;
  onSelectBlock?: (blockId: string) => void;
  onChangeBlock?: (blockId: string, block: EventPageBlock) => void;
  onReorderBlocks?: (blocks: EventPageBlock[]) => void;
  onDeleteBlock?: (blockId: string) => void;
  onDuplicateBlock?: (blockId: string) => void;
  /**
   * Optional slot for rendering rich_text blocks with a WYSIWYG editor (e.g.
   * the admin's TipTap-based rich text editor). When omitted, rich_text blocks
   * render a plain contenteditable surface.
   */
  renderRichTextBlock?: (input: {
    block: Extract<EventPageBlock, { type: 'rich_text' }>;
    disabled: boolean;
    onChange: (block: EventPageBlock) => void;
  }) => React.ReactNode;
};

const BLOCK_LABELS: Record<EventPageBlock['type'], string> = {
  hero: 'Hero',
  event_details: 'Event details',
  tickets: 'Tickets',
  schedule: 'Schedule',
  venue_map: 'Venue',
  faq: 'FAQ',
  products: 'Products',
  sponsors: 'Sponsors',
  speakers: 'Speakers',
  button: 'Button',
  divider: 'Divider',
  social_links: 'Social links',
  custom_embed: 'Custom embed',
  rich_text: 'Rich text',
  event_header: 'Event header',
  resale_tickets: 'Resale tickets',
  brand_footer: 'Brand footer',
};

const BLOCK_SURFACE_CLASS: Record<EventPageBlock['type'], string> = {
  hero: 'tk-ep-hero',
  rich_text: 'tk-ep-rich-text',
  event_details: 'tk-ep-details',
  tickets: 'tk-ep-tickets',
  products: 'tk-ep-products',
  schedule: 'tk-ep-schedule',
  venue_map: 'tk-ep-venue',
  faq: 'tk-ep-faq',
  sponsors: 'tk-ep-sponsors',
  speakers: 'tk-ep-speakers',
  button: 'tk-ep-action',
  divider: 'tk-ep-divider',
  social_links: 'tk-ep-social',
  custom_embed: 'tk-ep-embed',
  event_header: 'tk-ep-header',
  resale_tickets: 'tk-ep-resale',
  brand_footer: 'tk-ep-footer',
};

/**
 * Shared editable event-page surface for the admin canvas edit mode. Renders the
 * same .tk-ep-* class contract and section structure as EventPageSurface, with
 * inline EditableText fields bound to the canonical (raw) EventPageBlock data.
 */
export function EventPageEditorSurface({
  document,
  sampleContext,
  selectedBlockId,
  disabled = false,
  onSelectBlock,
  onChangeBlock,
  onReorderBlocks,
  onDeleteBlock,
  onDuplicateBlock,
  renderRichTextBlock,
}: EventPageEditorSurfaceProps) {
  const change = (blockId: string, patch: EventPageBlock) => onChangeBlock?.(blockId, patch);

  const moveBlock = (blockId: string, direction: 'up' | 'down') => {
    if (!onReorderBlocks) return;
    const blocks = [...document.blocks];
    const index = blocks.findIndex((b) => b.id === blockId);
    if (index < 0) return;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= blocks.length) return;
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    onReorderBlocks(blocks);
  };

  const chromeTypes = new Set(['event_header', 'resale_tickets', 'brand_footer']);
  const hasContentBlocks = document.blocks.some((b) => !chromeTypes.has(b.type));

  return (
    <div
      className="tixkit-event-page"
      data-schema-version={document.schemaVersion}
      data-mode="edit"
      data-testid="tixkit-event-page-editor"
    >
      {!hasContentBlocks && (
        <div
          className="tk-ep-empty-state"
          data-testid="tk-ep-empty-state"
          contentEditable={false}
        >
          <p className="tk-ep-empty-state__title">Start building your event page</p>
          <p className="tk-ep-empty-state__hint">
            Use the insert menu to add a hero section, tickets, text, and more.
          </p>
        </div>
      )}
      {document.blocks.map((block, index) => {
        const selected = block.id === selectedBlockId;
        const label = BLOCK_LABELS[block.type];
        return (
          <EditableBlockFrame
            key={block.id}
            blockId={block.id}
            blockType={block.type}
            label={label}
            selected={selected}
            disabled={disabled}
            onSelect={onSelectBlock}
            onDelete={onDeleteBlock}
            onDuplicate={onDuplicateBlock}
            onMoveUp={(id) => moveBlock(id, 'up')}
            onMoveDown={(id) => moveBlock(id, 'down')}
            canMoveUp={index > 0}
            canMoveDown={index < document.blocks.length - 1}
          >
            <EditableBlockBody
              block={block}
              disabled={disabled}
              sampleContext={sampleContext}
              onChange={(next) => change(block.id, next)}
              renderRichTextBlock={renderRichTextBlock}
            />
          </EditableBlockFrame>
        );
      })}
    </div>
  );
}

export type EditableBlockBodyProps = {
  block: EventPageBlock;
  disabled: boolean;
  sampleContext: EventPageRenderContext;
  onChange: (block: EventPageBlock) => void;
  renderRichTextBlock?: EventPageEditorSurfaceProps['renderRichTextBlock'];
};

export function EditableBlockBody({
  block,
  disabled,
  sampleContext,
  onChange,
  renderRichTextBlock,
}: EditableBlockBodyProps) {
  switch (block.type) {
    case 'hero':
      return (
        <section className="tk-ep-hero" data-block-id={block.id}>
          {block.eyebrow !== undefined && (
            <EditableText
              as="p"
              className="tk-ep-eyebrow"
              disabled={disabled}
              placeholder="Eyebrow text"
              ariaLabel="Eyebrow text"
              value={block.eyebrow}
              onChange={(eyebrow) => onChange({ ...block, eyebrow })}
            />
          )}
          <EditableText
            as="h1"
            className="tk-ep-hero__headline"
            disabled={disabled}
            placeholder="Page headline"
            ariaLabel="Page headline"
            value={block.headline}
            onChange={(headline) => onChange({ ...block, headline })}
          />
          {block.body !== undefined && (
            <EditableText
              as="p"
              multiline
              className="tk-ep-hero__body"
              disabled={disabled}
              placeholder="Page summary"
              ariaLabel="Page summary"
              value={block.body}
              onChange={(body) => onChange({ ...block, body })}
            />
          )}
          {block.imageUrl ? (
            <img
              src={block.imageUrl}
              alt={block.imageAlt ?? ''}
              loading="lazy"
            />
          ) : null}
          {block.ctaLabel !== undefined && (
            <a
              className="tk-ep-button"
              href={block.ctaUrl ?? '#'}
              contentEditable={false}
              onClick={(e) => e.preventDefault()}
            >
              <EditableText
                className="tk-ep-button__label"
                disabled={disabled}
                placeholder="Hero CTA label"
                ariaLabel="Hero CTA label"
                value={block.ctaLabel}
                onChange={(ctaLabel) => onChange({ ...block, ctaLabel })}
              />
            </a>
          )}
        </section>
      );
    case 'tickets':
      return (
        <section className="tk-ep-tickets" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-tickets__title"
            disabled={disabled}
            placeholder="Tickets title"
            ariaLabel="Tickets title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
          />
          {block.body !== undefined && (
            <EditableText
              as="p"
              multiline
              className="tk-ep-tickets__body"
              disabled={disabled}
              value={block.body}
              onChange={(body) => onChange({ ...block, body })}
            />
          )}
          <ul>
            {(sampleContext.tickets ?? [])
              .filter((t) => t.status !== 'hidden')
              .map((ticket) => (
                <li key={ticket.id}>
                  <strong>{ticket.name}</strong>
                  {ticket.description ? <span>{ticket.description}</span> : null}
                  {ticket.priceLabel ? <span>{ticket.priceLabel}</span> : null}
                </li>
              ))}
          </ul>
          {block.ctaLabel !== undefined && (
            // eslint-disable-next-line jsx-a11y/anchor-is-valid -- editor placeholder anchor for DOM parity with public surface
            <a
              className="tk-ep-button"
              href="#"
              contentEditable={false}
              onClick={(e) => e.preventDefault()}
            >
              <EditableText
                className="tk-ep-button__label"
                disabled={disabled}
                placeholder="Ticket CTA label"
                ariaLabel="Ticket CTA label"
                value={block.ctaLabel}
                onChange={(ctaLabel) => onChange({ ...block, ctaLabel })}
              />
            </a>
          )}
        </section>
      );
    case 'event_details':
      return (
        <section className="tk-ep-details" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-section__title"
            disabled={disabled}
            placeholder="Section title"
            ariaLabel="Event details title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
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
    case 'schedule':
      return (
        <section className="tk-ep-schedule" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-section__title"
            disabled={disabled}
            placeholder="Section title"
            ariaLabel="Schedule title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
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
    case 'faq':
      return (
        <section className="tk-ep-faq" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-section__title"
            disabled={disabled}
            placeholder="Section title"
            ariaLabel="FAQ title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
          />
          {block.items.map((item, index) => (
            <details key={`${item.question}-${index}`}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </section>
      );
    case 'products':
      return (
        <section className="tk-ep-products" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-section__title"
            disabled={disabled}
            placeholder="Section title"
            ariaLabel="Products title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
          />
          {block.body !== undefined && (
            <EditableText
              as="p"
              multiline
              className="tk-ep-products__body"
              disabled={disabled}
              value={block.body}
              onChange={(body) => onChange({ ...block, body })}
            />
          )}
          <ul>
            {(sampleContext.products ?? [])
              .filter((p) => block.productIds.includes(p.id))
              .map((product) => (
                <li key={product.id}>
                  <strong>{product.name}</strong>
                  {product.description ? <span>{product.description}</span> : null}
                  {product.priceLabel ? <span>{product.priceLabel}</span> : null}
                </li>
              ))}
          </ul>
        </section>
      );
    case 'sponsors':
    case 'speakers':
      return (
        <section className={BLOCK_SURFACE_CLASS[block.type]} data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-section__title"
            disabled={disabled}
            placeholder="Section title"
            ariaLabel={BLOCK_LABELS[block.type]}
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
          />
          <ul>
            {block.items.map((rawItem) => {
              const item = rawItem as {
                name: string;
                role?: string;
                bio?: string;
                url?: string;
                imageUrl?: string;
                imageAlt?: string;
              };
              return (
                <li key={item.name}>
                  <strong>{item.name}</strong>
                  {item.role ? <span>{item.role}</span> : null}
                  {item.bio ? <p>{item.bio}</p> : null}
                  {item.url ? <a href={item.url}>Open</a> : null}
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.imageAlt ?? item.name} loading="lazy" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      );
    case 'social_links':
      return (
        <section className="tk-ep-social" data-block-id={block.id}>
          {block.title !== undefined && (
            <EditableText
              as="h2"
              className="tk-ep-section__title"
              disabled={disabled}
              placeholder="Section title"
              ariaLabel="Social links title"
              value={block.title}
              onChange={(title) => onChange({ ...block, title })}
            />
          )}
          <ul>
            {block.links.map((link) => (
              <li key={link.url}>
                <a href={link.url}>{link.label}</a>
              </li>
            ))}
          </ul>
        </section>
      );
    case 'venue_map':
      return (
        <section className="tk-ep-venue" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-venue__title"
            disabled={disabled}
            placeholder="Venue title"
            ariaLabel="Venue title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
          />
          <EditableText
            as="p"
            className="tk-ep-venue__name"
            disabled={disabled}
            placeholder="Venue name"
            ariaLabel="Venue name"
            value={block.venueName}
            onChange={(venueName) => onChange({ ...block, venueName })}
          />
          {block.address !== undefined && (
            <EditableText
              as="p"
              className="tk-ep-venue__address"
              disabled={disabled}
              placeholder="Venue address"
              ariaLabel="Venue address"
              value={block.address}
              onChange={(address) => onChange({ ...block, address })}
            />
          )}
          {block.mapUrl ? <a href={block.mapUrl}>Open map</a> : null}
        </section>
      );
    case 'button':
      return (
        <section className="tk-ep-action" data-block-id={block.id}>
          <a
            className={`tk-ep-button tk-ep-button-${block.style ?? 'primary'}`}
            href={block.url}
            contentEditable={false}
            onClick={(e) => e.preventDefault()}
          >
            <EditableText
              className="tk-ep-button__label"
              disabled={disabled}
              placeholder="Button label"
              ariaLabel="Button label"
              value={block.label}
              onChange={(label) => onChange({ ...block, label })}
            />
          </a>
        </section>
      );
    case 'divider':
      return <hr className="tk-ep-divider" data-block-id={block.id} />;
    case 'custom_embed':
      return (
        <section className="tk-ep-embed" data-block-id={block.id}>
          {block.allowUnsafeEmbed && block.html ? (
            <div
              className="tk-ep-embed__preview"
              contentEditable={false}
              dangerouslySetInnerHTML={{ __html: block.html }}
            />
          ) : null}
          <EditableText
            as="p"
            multiline
            className="tk-ep-embed__source"
            disabled={disabled}
            placeholder="Embed HTML or URL"
            ariaLabel="Custom embed HTML"
            value={block.html}
            onChange={(html) => onChange({ ...block, html })}
          />
        </section>
      );
    case 'rich_text':
      if (renderRichTextBlock) {
        return (
          <section className="tk-ep-rich-text" data-block-id={block.id}>
            {renderRichTextBlock({ block, disabled, onChange })}
          </section>
        );
      }
      return (
        <section className="tk-ep-rich-text" data-block-id={block.id}>
          <EditableText
            as="div"
            multiline
            className="tk-ep-rich-text__content"
            disabled={disabled}
            placeholder="Add event page copy here."
            ariaLabel="Rich text content"
            value={tipTapText(block.content)}
            onChange={(text) =>
              onChange({ ...block, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } })
            }
          />
        </section>
      );
    case 'event_header': {
      const showBadge = block.showBadge ?? true;
      const showDescription = block.showDescription ?? true;
      const showDate = block.showDate ?? true;
      const showVenue = block.showVenue ?? true;
      const event = sampleContext.event;
      return (
        <section className="tk-ep-header" data-block-id={block.id}>
          {showBadge && (
            <EditableText
              as="p"
              className="tk-ep-badge"
              disabled={disabled}
              placeholder="Badge label (defaults to brand name)"
              ariaLabel="Badge label"
              value={block.badgeLabel ?? ''}
              onChange={(badgeLabel) => onChange({ ...block, badgeLabel })}
            />
          )}
          <p className="tk-ep-header__title">
            {event?.title ?? 'Event title'}
          </p>
          {showDescription && (
            <EditableText
              as="p"
              multiline
              className="tk-ep-header__description"
              disabled={disabled}
              placeholder="Description override (defaults to event description)"
              ariaLabel="Description override"
              value={block.descriptionOverride ?? ''}
              onChange={(descriptionOverride) => onChange({ ...block, descriptionOverride })}
            />
          )}
          {(showDate || showVenue) && (
            <dl className="tk-ep-header__meta" contentEditable={false}>
              {showDate && event?.startsAt ? (
                <div>
                  <dt>Date</dt>
                  <dd>{event.startsAt}</dd>
                </div>
              ) : null}
              {showDate && event?.timezone ? (
                <div>
                  <dt>Timezone</dt>
                  <dd>{event.timezone}</dd>
                </div>
              ) : null}
              {showVenue && event?.venueName ? (
                <div>
                  <dt>Venue</dt>
                  <dd>{event.venueName}</dd>
                </div>
              ) : null}
            </dl>
          )}
        </section>
      );
    }
    case 'resale_tickets': {
      const showVerifiedBadge = block.showVerifiedBadge ?? true;
      const listings = sampleContext.resaleListings ?? [];
      return (
        <section className="tk-ep-resale" data-block-id={block.id}>
          <div className="tk-ep-resale__header" contentEditable={false}>
            <EditableText
              as="h2"
              className="tk-ep-resale__title"
              disabled={disabled}
              placeholder="Resale section title"
              ariaLabel="Resale tickets title"
              value={block.title}
              onChange={(title) => onChange({ ...block, title })}
            />
            {showVerifiedBadge ? (
              <span className="tk-ep-badge tk-ep-badge--verified">Verified listings</span>
            ) : null}
          </div>
          {listings.length > 0 ? (
            <ul contentEditable={false}>
              {listings.map((listing) => (
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
            <EditableText
              as="p"
              className="tk-ep-resale__empty"
              disabled={disabled}
              placeholder="Empty state text"
              ariaLabel="Resale empty state"
              value={block.emptyStateText ?? ''}
              onChange={(emptyStateText) => onChange({ ...block, emptyStateText })}
            />
          )}
          {block.ctaLabel !== undefined && (
            // eslint-disable-next-line jsx-a11y/anchor-is-valid -- editor placeholder anchor for DOM parity with public surface
            <a
              className="tk-ep-button"
              href="#"
              contentEditable={false}
              onClick={(e) => e.preventDefault()}
            >
              <EditableText
                className="tk-ep-button__label"
                disabled={disabled}
                placeholder="Resale CTA label"
                ariaLabel="Resale CTA label"
                value={block.ctaLabel ?? ''}
                onChange={(ctaLabel) => onChange({ ...block, ctaLabel })}
              />
            </a>
          )}
        </section>
      );
    }
    case 'brand_footer': {
      const brand = sampleContext.brand;
      const showSupport = block.showSupport ?? true;
      const showTerms = block.showTerms ?? true;
      const showPrivacy = block.showPrivacy ?? true;
      const showRefund = block.showRefund ?? true;
      const links: { label: string; url: string }[] = [];
      if (showSupport && brand?.supportUrl) links.push({ label: 'Support', url: brand.supportUrl });
      if (showTerms && brand?.termsUrl) links.push({ label: 'Terms', url: brand.termsUrl });
      if (showPrivacy && brand?.privacyUrl) links.push({ label: 'Privacy', url: brand.privacyUrl });
      if (showRefund && brand?.refundUrl) links.push({ label: 'Refund', url: brand.refundUrl });
      return (
        <footer className="tk-ep-footer" data-block-id={block.id}>
          {links.length > 0 ? (
            <ul className="tk-ep-footer__links" contentEditable={false}>
              {links.map((link) => (
                <li key={link.url}>
                  <a href={link.url}>{link.label}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="tk-ep-footer__empty text-sm text-black/40">
              Configure brand support and legal URLs to populate the footer.
            </p>
          )}
        </footer>
      );
    }
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function tipTapText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (node && typeof node === 'object') {
    const n = node as { text?: string; content?: unknown[] };
    if (typeof n.text === 'string') return n.text;
    if (Array.isArray(n.content)) return n.content.map(tipTapText).join('');
  }
  return '';
}
