import type { EventbriteConfiguration } from './index.js';

/** Sanitized subset shaped like official Eventbrite API v3 resources. */
export const eventbriteApiV3Fixture: EventbriteConfiguration = {
  accountId: 'org_10001',
  sourceVersion: 'v3',
  importedAt: '2026-07-01T12:00:00.000Z',
  records: [
    {
      resource: 'event',
      id: 'ev_101',
      body: {
        name: { text: 'Sample Conference' },
        start: { utc: '2026-08-10T14:00:00Z' },
        end: { utc: '2026-08-10T21:00:00Z' },
        currency: 'USD',
        timezone: 'America/New_York',
        brand_id: 'org_10001',
      },
    },
    {
      resource: 'ticket_class',
      id: 'tc_201',
      body: {
        event_id: 'ev_101',
        inventory_pool_id: 'ev_101:capacity',
        name: 'General Admission',
        quantity_total: 100,
        price_minor: 2500,
        currency: 'USD',
      },
    },
    {
      resource: 'order',
      id: 'ord_301',
      body: {
        brand_id: 'org_10001',
        event_id: 'ev_101',
        attendee_id: 'att_401',
        order_number: 'ORD-301',
        buyer_email: 'redacted-buyer',
        total_minor: 2500,
        currency: 'USD',
        created: '2026-06-01T10:00:00Z',
        status: 'placed',
      },
    },
    {
      resource: 'attendee',
      id: 'att_401',
      body: {
        event_id: 'ev_101',
        order_id: 'ord_301',
        ticket_class_id: 'tc_201',
        profile: { email: 'redacted-attendee', first_name: 'Sample', last_name: 'Attendee' },
        status: 'attending',
      },
    },
    {
      resource: 'ticket',
      id: 'tkt_501',
      body: {
        event_id: 'ev_101',
        order_id: 'ord_301',
        attendee_id: 'att_401',
        ticket_class_id: 'tc_201',
        barcode: 'SANITIZED-501',
      },
    },
    {
      resource: 'checkin',
      id: 'chk_601',
      body: { ticket_id: 'tkt_501', created: '2026-08-10T13:55:00Z' },
    },
    {
      resource: 'payment',
      id: 'pay_701',
      body: {
        order_id: 'ord_301',
        amount: { value: 2500, currency: 'USD' },
        occurred_at: '2026-06-01T10:01:00Z',
        provider_reference: 'SANITIZED-PAYMENT-701',
      },
    },
  ],
};
