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
  renderRichTextBlock,
}: EventPageEditorSurfaceProps) {
  const change = (blockId: string, patch: EventPageBlock) => onChangeBlock?.(blockId, patch);

  return (
    <div
      className="tixkit-event-page"
      data-schema-version={document.schemaVersion}
      data-mode="edit"
      data-testid="tixkit-event-page-editor"
    >
      {document.blocks.map((block) => {
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
        <div className="tk-ep-hero" data-block-id={block.id}>
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
            <span className="tk-ep-button">
              <EditableText
                className="tk-ep-button__label"
                disabled={disabled}
                placeholder="Hero CTA label"
                ariaLabel="Hero CTA label"
                value={block.ctaLabel}
                onChange={(ctaLabel) => onChange({ ...block, ctaLabel })}
              />
            </span>
          )}
        </div>
      );
    case 'tickets':
      return (
        <div className="tk-ep-tickets" data-block-id={block.id}>
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
            <span className="tk-ep-button">
              <EditableText
                className="tk-ep-button__label"
                disabled={disabled}
                placeholder="Ticket CTA label"
                ariaLabel="Ticket CTA label"
                value={block.ctaLabel}
                onChange={(ctaLabel) => onChange({ ...block, ctaLabel })}
              />
            </span>
          )}
        </div>
      );
    case 'event_details':
      return (
        <div className="tk-ep-details" data-block-id={block.id}>
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
        </div>
      );
    case 'schedule':
      return (
        <div className="tk-ep-schedule" data-block-id={block.id}>
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
        </div>
      );
    case 'faq':
      return (
        <div className="tk-ep-faq" data-block-id={block.id}>
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
        </div>
      );
    case 'products':
      return (
        <div className="tk-ep-products" data-block-id={block.id}>
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
        </div>
      );
    case 'sponsors':
    case 'speakers':
      return (
        <div className={BLOCK_SURFACE_CLASS[block.type]} data-block-id={block.id}>
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
        </div>
      );
    case 'social_links':
      return (
        <div className="tk-ep-social" data-block-id={block.id}>
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
        </div>
      );
    case 'venue_map':
      return (
        <div className="tk-ep-venue" data-block-id={block.id}>
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
        </div>
      );
    case 'button':
      return (
        <div className="tk-ep-action" data-block-id={block.id}>
          <span className={`tk-ep-button tk-ep-button-${block.style ?? 'primary'}`}>
            <EditableText
              className="tk-ep-button__label"
              disabled={disabled}
              placeholder="Button label"
              ariaLabel="Button label"
              value={block.label}
              onChange={(label) => onChange({ ...block, label })}
            />
          </span>
        </div>
      );
    case 'divider':
      return <hr className="tk-ep-divider" data-block-id={block.id} />;
    case 'custom_embed':
      return (
        <div className="tk-ep-embed" data-block-id={block.id}>
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
        </div>
      );
    case 'rich_text':
      if (renderRichTextBlock) {
        return (
          <div className="tk-ep-rich-text" data-block-id={block.id}>
            {renderRichTextBlock({ block, disabled, onChange })}
          </div>
        );
      }
      return (
        <div className="tk-ep-rich-text" data-block-id={block.id}>
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
        </div>
      );
    case 'event_header':
      return (
        <div className="tk-ep-header" data-block-id={block.id}>
          <EditableText
            as="p"
            className="tk-ep-badge"
            disabled={disabled}
            placeholder="Badge label (defaults to brand name)"
            ariaLabel="Badge label"
            value={block.badgeLabel ?? ''}
            onChange={(badgeLabel) => onChange({ ...block, badgeLabel })}
          />
          <p className="tk-ep-header__title">
            {sampleContext.event?.title ?? 'Event title'}
          </p>
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
        </div>
      );
    case 'resale_tickets':
      return (
        <div className="tk-ep-resale" data-block-id={block.id}>
          <EditableText
            as="h2"
            className="tk-ep-resale__title"
            disabled={disabled}
            placeholder="Resale section title"
            ariaLabel="Resale tickets title"
            value={block.title}
            onChange={(title) => onChange({ ...block, title })}
          />
          <ul>
            {(sampleContext.resaleListings ?? []).map((listing) => (
              <li key={listing.id}>
                <strong>
                  {listing.ticketTypeName ? `Resale ticket - ${listing.ticketTypeName}` : 'Resale ticket'}
                </strong>
                {listing.priceLabel ? <span>{listing.priceLabel}</span> : null}
              </li>
            ))}
          </ul>
          <EditableText
            className="tk-ep-button__label"
            disabled={disabled}
            placeholder="Resale CTA label"
            ariaLabel="Resale CTA label"
            value={block.ctaLabel ?? ''}
            onChange={(ctaLabel) => onChange({ ...block, ctaLabel })}
          />
        </div>
      );
    case 'brand_footer': {
      const brand = sampleContext.brand;
      const links: { label: string; url: string }[] = [];
      if (brand?.supportUrl) links.push({ label: 'Support', url: brand.supportUrl });
      if (brand?.termsUrl) links.push({ label: 'Terms', url: brand.termsUrl });
      if (brand?.privacyUrl) links.push({ label: 'Privacy', url: brand.privacyUrl });
      if (brand?.refundUrl) links.push({ label: 'Refund', url: brand.refundUrl });
      return (
        <div className="tk-ep-footer" data-block-id={block.id}>
          {links.length > 0 ? (
            <ul className="tk-ep-footer__links">
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
        </div>
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
