import type { PretixConfiguration } from './index.js';

/** Sanitized native shapes from documented pretix REST resources. */
export const SANITIZED_PRETIX_OFFICIAL_API_FIXTURE: PretixConfiguration = {
  sourceMode: 'official-api',
  organizerSlug: 'sample-organizer',
  sourceVersion: '2025.1',
  importedAt: '2026-07-01T12:00:00.000Z',
  unsupportedFeatures: ['seating: sample-event auditorium plan'],
  pages: [
    {
      cursor: 'page-1',
      nextCursor: 'page-2',
      records: [
        { resource: 'organizers', body: { slug: 'sample-organizer', name: 'Sample Organization' } },
        {
          resource: 'events',
          body: {
            slug: 'sample-event',
            name: 'Sample Conference',
            currency: 'EUR',
            timezone: 'Europe/Berlin',
            date_from: '2026-09-20T09:00:00.000Z',
            date_to: '2026-09-20T17:00:00.000Z',
            venue_id: 1,
            venue_name: 'Sample Hall',
            location: 'Sanitized venue address',
          },
        },
        {
          resource: 'quotas',
          body: { id: 10, event: 'sample-event', name: 'Admission capacity', size: 50 },
        },
        {
          resource: 'items',
          body: {
            id: 20,
            event: 'sample-event',
            name: 'Admission',
            admission: true,
            quota_id: 10,
            default_price: 2500,
            currency: 'EUR',
          },
        },
        {
          resource: 'items',
          body: {
            id: 21,
            event: 'sample-event',
            name: 'T-shirt',
            admission: false,
            default_price: 1500,
            currency: 'EUR',
          },
        },
        {
          resource: 'questions',
          body: {
            id: 30,
            event: 'sample-event',
            question: 'Accessibility requirements',
            type: 'S',
          },
        },
      ],
    },
    {
      cursor: 'page-2',
      records: [
        {
          resource: 'vouchers',
          body: {
            id: 40,
            event: 'sample-event',
            code: 'PROMO10',
            discount_mode: 'percentage',
            value: 10,
            currency: 'EUR',
          },
        },
        {
          resource: 'vouchers',
          body: { id: 41, event: 'sample-event', code: 'LOCKED', access_only: true, item_id: 20 },
        },
        {
          resource: 'orders',
          body: {
            code: 'A1',
            event: 'sample-event',
            email: 'redacted-buyer',
            currency: 'EUR',
            total_minor: 2500,
            positions: [
              {
                id: 100,
                item: 20,
                attendee_email: 'redacted-attendee',
                attendee_name: 'Sample Attendee',
                secret: 'SANITIZED-TICKET-1',
              },
            ],
          },
        },
        {
          resource: 'payments',
          body: {
            id: 50,
            order: 'A1',
            amount: 2500,
            currency: 'EUR',
            created: '2026-01-02T10:00:00.000Z',
            provider_reference: 'SANITIZED-PAYMENT-REFERENCE',
          },
        },
        {
          resource: 'refunds',
          body: {
            id: 51,
            order: 'A1',
            amount: 500,
            currency: 'EUR',
            created: '2026-01-03T10:00:00.000Z',
            provider_reference: 'SANITIZED-REFUND-REFERENCE',
          },
        },
        {
          resource: 'checkins',
          body: { id: 60, position_id: 100, datetime: '2026-01-04T10:00:00.000Z', type: 'entry' },
        },
      ],
    },
  ],
};
