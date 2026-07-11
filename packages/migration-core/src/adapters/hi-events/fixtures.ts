import type { HiEventsConfiguration } from './index.js';

/** Sanitized native shapes from Hi.Events API resources. */
export const SANITIZED_HI_EVENTS_OFFICIAL_API_FIXTURE: HiEventsConfiguration = {
  sourceMode: 'official-api',
  accountId: 'sample-account',
  sourceVersion: '0.20.1',
  importedAt: '2026-07-01T12:00:00.000Z',
  pages: [
    {
      cursor: 'cursor-1',
      nextCursor: 'cursor-2',
      records: [
        { collection: 'accounts', body: { id: 'sample-account', name: 'Sample Organization' } },
        {
          collection: 'venues',
          body: { id: 'venue-1', name: 'Sample Venue', timezone: 'America/Chicago' },
        },
        {
          collection: 'events',
          body: {
            id: 'event-1',
            title: 'Sample Event',
            currency: 'USD',
            timezone: 'America/Chicago',
            start_date: '2026-10-01T15:00:00.000Z',
            end_date: '2026-10-01T23:00:00.000Z',
            venue_id: 'venue-1',
          },
        },
        {
          collection: 'capacity-assignments',
          body: { id: 'capacity-1', event_id: 'event-1', name: 'Event capacity', capacity: 80 },
        },
        {
          collection: 'products',
          body: {
            id: 'ticket-1',
            event_id: 'event-1',
            type: 'TICKET',
            title: 'General Admission',
            price: 3200,
            currency: 'USD',
            capacity_assignment_id: 'capacity-1',
          },
        },
        {
          collection: 'products',
          body: {
            id: 'addon-1',
            event_id: 'event-1',
            type: 'ADD_ON',
            title: 'Sample Add-on',
            price: 800,
            currency: 'USD',
          },
        },
        {
          collection: 'questions',
          body: {
            id: 'question-1',
            event_id: 'event-1',
            title: 'Dietary requirements',
            type: 'TEXT',
          },
        },
      ],
    },
    {
      cursor: 'cursor-2',
      records: [
        {
          collection: 'promo-codes',
          body: {
            id: 'promo-1',
            event_id: 'event-1',
            code: 'SAVE10',
            discount_type: 'percentage',
            discount: 10,
            currency: 'USD',
          },
        },
        {
          collection: 'promo-codes',
          body: {
            id: 'access-1',
            event_id: 'event-1',
            code: 'PRIVATE',
            access_only: true,
            product_id: 'ticket-1',
          },
        },
        {
          collection: 'orders',
          body: {
            id: 'order-100',
            order_short_id: 'ORDER-100',
            event_id: 'event-1',
            email: 'redacted-buyer',
            currency: 'USD',
            total: 3200,
            attendees: [
              {
                id: 'attendee-100',
                product_id: 'ticket-1',
                email: 'redacted-attendee',
                first_name: 'Sample',
                last_name: 'Attendee',
                public_id: 'SANITIZED-TICKET-100',
              },
            ],
          },
        },
        {
          collection: 'payments',
          body: {
            id: 'payment-100',
            order_id: 'order-100',
            amount: 3200,
            currency: 'USD',
            created_at: '2026-02-10T18:00:00.000Z',
            provider_reference: 'SANITIZED-PAYMENT-100',
          },
        },
        {
          collection: 'refunds',
          body: {
            id: 'refund-100',
            order_id: 'order-100',
            amount: 400,
            currency: 'USD',
            created_at: '2026-02-11T18:00:00.000Z',
            provider_reference: 'SANITIZED-REFUND-100',
          },
        },
        {
          collection: 'check-ins',
          body: {
            id: 'check-in-100',
            attendee_id: 'attendee-100',
            checked_in_at: '2026-02-12T18:00:00.000Z',
            status: 'ACCEPTED',
          },
        },
      ],
    },
  ],
};
