import type { TicketTailorConfiguration } from './index.js';

/** Sanitized subset shaped like official Ticket Tailor API v1 resources. */
export const ticketTailorApiV1Fixture: TicketTailorConfiguration = {
  accountId: 'box-office-1001',
  sourceVersion: 'v1',
  importedAt: '2026-07-01T12:00:00.000Z',
  records: [
    {
      resource: 'event',
      id: 'ev_110',
      body: {
        name: 'Sample Festival',
        start: '2026-09-01T16:00:00Z',
        end: '2026-09-02T03:00:00Z',
        currency: 'USD',
        timezone: 'America/Chicago',
        brand_id: 'box-office-1001',
      },
    },
    {
      resource: 'ticket_type',
      id: 'tt_210',
      body: {
        event_id: 'ev_110',
        inventory_pool_id: 'ev_110:capacity',
        name: 'Day Pass',
        quantity: 250,
        price_minor: 3400,
        currency: 'USD',
      },
    },
    {
      resource: 'order',
      id: 'ord_310',
      body: {
        brand_id: 'box-office-1001',
        event_id: 'ev_110',
        attendee_id: 'it_410:attendee',
        attendee_email: 'redacted-attendee',
        order_number: 'ORD-310',
        buyer_email: 'redacted-buyer',
        total_minor: 3400,
        currency: 'USD',
        created_at: '2026-06-10T09:00:00Z',
        status: 'completed',
      },
    },
    {
      resource: 'issued_ticket',
      id: 'it_410',
      body: {
        event_id: 'ev_110',
        order_id: 'ord_310',
        attendee_id: 'it_410:attendee',
        attendee_email: 'redacted-attendee',
        ticket_type_id: 'tt_210',
        barcode: 'SANITIZED-410',
      },
    },
    {
      resource: 'check_in',
      id: 'ci_510',
      body: { issued_ticket_id: 'it_410', checked_in_at: '2026-09-01T15:58:00Z' },
    },
    {
      resource: 'payment',
      id: 'txn_610',
      body: {
        order_id: 'ord_310',
        total: 3400,
        currency: 'USD',
        transaction_id: 'SANITIZED-TXN-610',
        created_at: '2026-06-10T09:01:00Z',
      },
    },
  ],
};
