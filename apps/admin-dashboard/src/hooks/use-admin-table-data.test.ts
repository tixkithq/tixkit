import { describe, expect, it } from 'vitest';
import { adminQueryStaleTime, adminTableStaleTime } from './use-admin-table-data';

describe('admin query stale times', () => {
  it('keeps live order and attendee surfaces fresh', () => {
    expect(adminQueryStaleTime(['listOrders', 'org_1'])).toBe(10_000);
    expect(adminQueryStaleTime(['listAttendees', 'evt_1', 'list_1', 'Ada'])).toBe(10_000);
    expect(adminQueryStaleTime(['getOrder', 'ord_1'])).toBe(10_000);
    expect(adminTableStaleTime('orders')).toBe(10_000);
    expect(adminTableStaleTime('attendees')).toBe(10_000);
  });

  it('aligns report queries with the short-lived API report cache', () => {
    expect(adminQueryStaleTime(['getSalesReport', 'sales', 'evt_1', '2026-06-01:'])).toBe(15_000);
    expect(adminQueryStaleTime(['getTaxReport', 'tax', 'evt_1', '2026-06-01:'])).toBe(15_000);
    expect(adminQueryStaleTime(['getAffiliateReport', 'affiliate', 'org_1'])).toBe(15_000);
  });

  it('uses longer stale times for mostly static metadata', () => {
    expect(adminQueryStaleTime(['getEvent', 'evt_1'])).toBe(300_000);
    expect(adminQueryStaleTime(['listTicketTypes', 'evt_1'])).toBe(300_000);
    expect(adminQueryStaleTime(['listCheckoutQuestions', 'evt_1'])).toBe(300_000);
    expect(adminTableStaleTime('events')).toBe(300_000);
  });

  it('falls back to the admin default for unclassified queries and tables', () => {
    expect(adminQueryStaleTime(['customQuery'])).toBe(30_000);
    expect(adminQueryStaleTime([Symbol('unknown')])).toBe(30_000);
    expect(adminTableStaleTime('audit_logs')).toBe(30_000);
  });
});
