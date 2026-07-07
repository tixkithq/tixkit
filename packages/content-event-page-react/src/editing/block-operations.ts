import type { EventPageBlock, EventPageDocument } from '@tixkit/content-event-page';

export const BLOCK_LABELS: Record<EventPageBlock['type'], string> = {
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

/**
 * Reorders a block within the working document by swapping it with its
 * neighbor in the given direction. Returns the original document unchanged if
 * the block is not found or already at the boundary.
 */
export function moveBlockInDocument(
  document: EventPageDocument,
  blockId: string,
  direction: 'up' | 'down',
): EventPageDocument {
  const blocks = [...document.blocks];
  const index = blocks.findIndex((b) => b.id === blockId);
  if (index < 0) return document;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= blocks.length) return document;
  const moved = blocks[target];
  blocks[target] = blocks[index];
  blocks[index] = moved;
  return { ...document, blocks };
}
