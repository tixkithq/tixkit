import type { GenericCsvEntityType, GenericCsvSourceMetadata } from './types.js';

const templates: Readonly<Record<GenericCsvEntityType, readonly string[]>> = {
  event: [
    'external_id',
    'brand_external_id',
    'venue_external_id',
    'name',
    'starts_at',
    'ends_at',
    'timezone',
    'currency',
  ],
  'ticket-type': [
    'external_id',
    'event_external_id',
    'inventory_pool_external_id',
    'occurrence_external_id',
    'name',
    'price_minor',
    'currency',
    'quantity',
  ],
  attendee: [
    'external_id',
    'event_external_id',
    'ticket_type_external_id',
    'occurrence_external_id',
    'order_external_id',
    'email',
    'first_name',
    'last_name',
  ],
  'historical-order': [
    'external_id',
    'brand_external_id',
    'event_external_id',
    'attendee_external_id',
    'order_number',
    'buyer_email',
    'total_minor',
    'currency',
    'created_at',
  ],
  ticket: [
    'external_id',
    'event_external_id',
    'order_external_id',
    'ticket_type_external_id',
    'attendee_external_id',
    'code',
  ],
  discount: ['external_id', 'event_external_id', 'code', 'kind', 'amount_minor', 'percentage'],
  'check-in': ['external_id', 'ticket_external_id', 'checked_in_at', 'action'],
};

export const GENERIC_CSV_SOURCE_METADATA: GenericCsvSourceMetadata = {
  supportedVersions: ['rfc4180-v1'],
  featureMapping: {
    event: ['events and occurrences'],
    'ticket-type': ['ticket types', 'inventory quantity', 'fixed prices'],
    attendee: ['attendees and buyer contact provenance'],
    'historical-order': ['historical orders; payment state is not inferred'],
    ticket: ['issued ticket records'],
    discount: ['promo codes', 'fixed and percentage discounts'],
    'check-in': ['check-in and check-out history'],
  },
  knownLosses: [
    'Reserved seating geometry is not represented by the generic CSV format.',
    'Provider payment and refund state is not inferred from historical orders.',
    'Source automation, messaging, and webhook configuration is not imported.',
  ],
};

function quote(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function createGenericCsvTemplate(entityType: GenericCsvEntityType): string {
  return `${templates[entityType].map(quote).join(',')}\r\n`;
}

export function getGenericCsvTemplateHeaders(entityType: GenericCsvEntityType): readonly string[] {
  return templates[entityType];
}
