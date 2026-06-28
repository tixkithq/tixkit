import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Filter = { column: string; operator: string; value: unknown };

const dbState = vi.hoisted(() => ({
  privacyRequests: [] as Row[],
  orders: [] as Row[],
  attendees: [] as Row[],
  tickets: [] as Row[],
  invoices: [] as Row[],
  auditLogs: [] as Row[],
  checkoutSessions: [] as Row[],
  updates: [] as Array<{ table: string; filters: Filter[]; values: Row }>,
  repositoryCalls: [] as Array<{ method: string; id: string }>,
  destroy: vi.fn(),
}));

function rowValue(row: Row, column: string): unknown {
  if (column.includes('.')) {
    const [, unqualified] = column.split('.');
    return row[column] ?? row[unqualified];
  }
  return row[column];
}

function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = rowValue(row, filter.column);
    if (filter.operator === 'in') {
      return Array.isArray(filter.value) && filter.value.includes(value);
    }
    return value === filter.value;
  });
}

function rowsFor(table: string): Row[] {
  if (table === 'privacy_requests') return dbState.privacyRequests;
  if (table === 'orders') return dbState.orders;
  if (table === 'attendees') return dbState.attendees;
  if (table === 'tickets') return dbState.tickets;
  if (table === 'invoices') return dbState.invoices;
  if (table === 'audit_logs') return dbState.auditLogs;
  if (table === 'checkout_sessions') return dbState.checkoutSessions;
  return [];
}

function queryRowsFor(table: string, joins: Set<string>): Row[] {
  if (table !== 'attendees' || !joins.has('orders')) return rowsFor(table);

  return dbState.attendees.map((attendee) => {
    const order = dbState.orders.find((candidate) => candidate.id === attendee.order_id);
    return {
      ...attendee,
      'orders.id': order?.id,
      'orders.tenant_id': order?.tenant_id,
      'orders.organization_id': order?.organization_id,
      'orders.brand_id': order?.brand_id,
      'orders.event_id': order?.event_id,
    };
  });
}

function createQuery(table: string) {
  const filters: Filter[] = [];
  const joins = new Set<string>();
  const query = {
    innerJoin(joinTable: string) {
      joins.add(joinTable);
      return query;
    },
    select() {
      return query;
    },
    selectAll() {
      return query;
    },
    where(column: string, operator: string, value: unknown) {
      filters.push({ column, operator, value });
      return query;
    },
    async execute() {
      return queryRowsFor(table, joins).filter((row) => matchesFilters(row, filters));
    },
    async executeTakeFirst() {
      return queryRowsFor(table, joins).find((row) => matchesFilters(row, filters));
    },
  };
  return query;
}

function createUpdate(table: string) {
  const filters: Filter[] = [];
  let values: Row = {};
  const update = {
    set(input: Row) {
      values = input;
      return update;
    },
    where(column: string, operator: string, value: unknown) {
      filters.push({ column, operator, value });
      return update;
    },
    async execute() {
      const rows = rowsFor(table).filter((row) => matchesFilters(row, filters));
      dbState.updates.push({ table, filters: [...filters], values });
      for (const row of rows) Object.assign(row, values);
      return rows.map(() => ({ numUpdatedRows: 1n }));
    },
  };
  return update;
}

vi.mock('@tixkit/db', () => {
  class PrivacyRequestRepository {
    async findById(id: string) {
      return dbState.privacyRequests.find((row) => row.id === id);
    }

    async markProcessing(id: string) {
      dbState.repositoryCalls.push({ method: 'markProcessing', id });
      const request = dbState.privacyRequests.find((row) => row.id === id);
      if (request) request.status = 'processing';
      return request;
    }

    async markCompleted(id: string, result: Row) {
      dbState.repositoryCalls.push({ method: 'markCompleted', id });
      const request = dbState.privacyRequests.find((row) => row.id === id);
      if (request) {
        request.status = 'completed';
        request.result = JSON.stringify(result);
        request.error = null;
        request.completed_at = new Date('2026-06-28T12:00:00.000Z');
      }
      return request;
    }

    async markFailed(id: string, error: string) {
      dbState.repositoryCalls.push({ method: 'markFailed', id });
      const request = dbState.privacyRequests.find((row) => row.id === id);
      if (request) {
        request.status = 'failed';
        request.error = error;
        request.completed_at = new Date('2026-06-28T12:00:00.000Z');
      }
      return request;
    }
  }

  return {
    createDb: () => ({
      selectFrom: createQuery,
      updateTable: createUpdate,
      destroy: dbState.destroy,
    }),
    PrivacyRequestRepository,
  };
});

const { processPrivacyRequestActivity } = await import('../activities/privacy.js');

describe('processPrivacyRequestActivity', () => {
  beforeEach(() => {
    dbState.destroy.mockClear();
    dbState.updates = [];
    dbState.repositoryCalls = [];
    dbState.privacyRequests = [
      {
        id: 'prv_erase_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        request_type: 'erasure',
        subject_type: 'buyer',
        subject_id: null,
        subject_email: 'buyer@test.com',
        status: 'pending',
        result: null,
        error: null,
        completed_at: null,
      },
      {
        id: 'prv_export_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        request_type: 'export',
        subject_type: 'buyer',
        subject_id: null,
        subject_email: 'buyer@test.com',
        status: 'pending',
        result: null,
        error: null,
        completed_at: null,
      },
      {
        id: 'prv_completed_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        request_type: 'erasure',
        subject_type: 'buyer',
        subject_id: null,
        subject_email: 'buyer@test.com',
        status: 'completed',
        result: JSON.stringify({ sentinel: 'kept' }),
        error: null,
        completed_at: new Date('2026-06-27T12:00:00.000Z'),
      },
    ];
    dbState.orders = [
      {
        id: 'ord_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        status: 'paid',
        currency: 'USD',
        total_cents: 12500,
        refunded_cents: 2500,
        buyer_email: 'buyer@test.com',
        buyer_first_name: 'Ada',
        buyer_last_name: 'Lovelace',
        buyer_phone: '+15550000001',
        paid_at: new Date('2026-06-01T10:00:00.000Z'),
        refunded_at: null,
        created_at: new Date('2026-06-01T09:00:00.000Z'),
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
      {
        id: 'ord_other_tenant',
        tenant_id: 'tnt_other',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        status: 'paid',
        currency: 'USD',
        total_cents: 9900,
        refunded_cents: 0,
        buyer_email: 'buyer@test.com',
        buyer_first_name: 'Other',
        buyer_last_name: 'Tenant',
        buyer_phone: '+15550000009',
      },
      {
        id: 'ord_wrong_join',
        tenant_id: 'tnt_1',
        organization_id: 'org_other',
        brand_id: 'brd_other',
        event_id: 'evt_other',
        status: 'paid',
        currency: 'USD',
        total_cents: 8800,
        refunded_cents: 0,
        buyer_email: 'buyer@test.com',
        buyer_first_name: 'Wrong',
        buyer_last_name: 'Join',
        buyer_phone: '+15550000008',
      },
    ];
    dbState.attendees = [
      {
        id: 'att_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        order_id: 'ord_1',
        event_id: 'evt_1',
        event_occurrence_id: null,
        ticket_type_id: 'tt_1',
        ticket_id: 'tkt_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'buyer@test.com',
        phone: '+15550000001',
        status: 'registered',
        custom_answers: JSON.stringify({ company: '<script>alert(1)</script>' }),
        checked_in_at: null,
        created_at: new Date('2026-06-01T09:00:00.000Z'),
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
      {
        id: 'att_no_ticket',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        order_id: 'ord_1',
        event_id: 'evt_1',
        event_occurrence_id: null,
        ticket_type_id: 'tt_1',
        ticket_id: null,
        first_name: 'Grace',
        last_name: 'Hopper',
        email: 'buyer@test.com',
        phone: '+15550000002',
        status: 'registered',
        custom_answers: JSON.stringify({ dietary: 'vegan' }),
        checked_in_at: null,
        created_at: new Date('2026-06-01T09:00:00.000Z'),
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
      {
        id: 'att_wrong_join',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        order_id: 'ord_wrong_join',
        event_id: 'evt_other',
        event_occurrence_id: null,
        ticket_type_id: 'tt_other',
        ticket_id: 'tkt_wrong_join',
        first_name: 'Wrong',
        last_name: 'Join',
        email: 'buyer@test.com',
        phone: '+15550000008',
        status: 'registered',
        custom_answers: JSON.stringify({ shouldStay: true }),
        checked_in_at: null,
        created_at: new Date('2026-06-01T09:00:00.000Z'),
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
    ];
    dbState.tickets = [
      {
        id: 'tkt_1',
        tenant_id: 'tnt_1',
        order_id: 'ord_1',
        attendee_id: 'att_1',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        status: 'issued',
        transferred_to_email: 'buyer@test.com',
        transferred_at: null,
        checked_in_at: null,
        created_at: new Date('2026-06-01T09:00:00.000Z'),
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
    ];
    dbState.invoices = [
      {
        id: 'inv_1',
        tenant_id: 'tnt_1',
        order_id: 'ord_1',
        total_cents: 12500,
        tax_cents: 900,
        buyer_email: 'buyer@test.com',
        buyer_name: 'Ada Lovelace',
        buyer_tax_id: 'US-123',
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
    ];
    dbState.auditLogs = [
      {
        id: 'aud_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        action: 'privacy.erasure.requested',
        resource_type: 'privacy_request',
        resource_id: 'prv_erase_1',
        diff_summary: JSON.stringify({ subjectEmail: 'buyer@test.com' }),
      },
    ];
    dbState.checkoutSessions = [
      {
        id: 'cs_1',
        tenant_id: 'tnt_1',
        order_id: 'ord_1',
        buyer: JSON.stringify({
          email: 'buyer@test.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '+15550000001',
        }),
        updated_at: new Date('2026-06-01T09:00:00.000Z'),
      },
    ];
  });

  it('redacts direct buyer and attendee PII while retaining commerce and audit records', async () => {
    const result = await processPrivacyRequestActivity({ requestId: 'prv_erase_1' });

    expect(result).toMatchObject({
      ok: true,
      value: { requestId: 'prv_erase_1', status: 'completed' },
    });

    expect(dbState.orders).toHaveLength(3);
    expect(dbState.orders[0]).toMatchObject({
      id: 'ord_1',
      status: 'paid',
      currency: 'USD',
      total_cents: 12500,
      refunded_cents: 2500,
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
    });
    expect(String(dbState.orders[0].buyer_email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    expect(dbState.orders[1]).toMatchObject({
      id: 'ord_other_tenant',
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Other',
    });
    expect(dbState.orders[2]).toMatchObject({
      id: 'ord_wrong_join',
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Wrong',
    });

    expect(dbState.invoices).toHaveLength(1);
    expect(dbState.invoices[0]).toMatchObject({
      id: 'inv_1',
      total_cents: 12500,
      tax_cents: 900,
      buyer_name: null,
      buyer_tax_id: null,
    });
    expect(String(dbState.invoices[0].buyer_email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );

    expect(dbState.attendees).toHaveLength(3);
    expect(dbState.attendees[0]).toMatchObject({
      id: 'att_1',
      first_name: null,
      last_name: null,
      phone: null,
      custom_answers: null,
      status: 'registered',
    });
    expect(String(dbState.attendees[0].email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    expect(dbState.attendees[1]).toMatchObject({
      id: 'att_no_ticket',
      first_name: null,
      last_name: null,
      phone: null,
      custom_answers: null,
      status: 'registered',
    });
    expect(String(dbState.attendees[1].email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    expect(dbState.attendees[2]).toMatchObject({
      id: 'att_wrong_join',
      first_name: 'Wrong',
      last_name: 'Join',
      email: 'buyer@test.com',
      phone: '+15550000008',
      custom_answers: JSON.stringify({ shouldStay: true }),
    });

    expect(dbState.tickets).toHaveLength(1);
    expect(dbState.tickets[0]).toMatchObject({
      id: 'tkt_1',
      status: 'issued',
      transferred_to_email: null,
    });
    expect(dbState.auditLogs).toHaveLength(1);
    const auditSummary = JSON.parse(String(dbState.auditLogs[0].diff_summary));
    expect(auditSummary.subjectEmail).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    expect(dbState.checkoutSessions).toHaveLength(1);
    const checkoutBuyer = JSON.parse(String(dbState.checkoutSessions[0].buyer));
    expect(checkoutBuyer).toMatchObject({
      email: expect.stringMatching(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/),
      firstName: null,
      lastName: null,
      phone: null,
    });

    const request = dbState.privacyRequests.find((row) => row.id === 'prv_erase_1');
    expect(request).toMatchObject({ status: 'completed', error: null });
    expect(String(request?.subject_email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    expect(JSON.parse(String(request?.result))).toMatchObject({
      ordersRedacted: 1,
      attendeesRedacted: 2,
      ticketsTouched: 1,
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns completed requests without rewriting retained data during workflow replay', async () => {
    const originalResult = String(
      dbState.privacyRequests.find((row) => row.id === 'prv_completed_1')?.result,
    );

    const result = await processPrivacyRequestActivity({ requestId: 'prv_completed_1' });

    expect(result).toMatchObject({
      ok: true,
      value: { requestId: 'prv_completed_1', status: 'completed' },
    });
    expect(dbState.repositoryCalls).toEqual([]);
    expect(dbState.updates).toEqual([]);
    expect(dbState.privacyRequests.find((row) => row.id === 'prv_completed_1')).toMatchObject({
      status: 'completed',
      result: originalResult,
      completed_at: new Date('2026-06-27T12:00:00.000Z'),
    });
    expect(dbState.orders[0]).toMatchObject({
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Ada',
    });
    expect(dbState.attendees[0]).toMatchObject({
      email: 'buyer@test.com',
      first_name: 'Ada',
      custom_answers: JSON.stringify({ company: '<script>alert(1)</script>' }),
    });
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });

  it('exports the retention policy with the retained commerce snapshot', async () => {
    const result = await processPrivacyRequestActivity({ requestId: 'prv_export_1' });

    expect(result).toMatchObject({
      ok: true,
      value: { requestId: 'prv_export_1', status: 'completed' },
    });

    const request = dbState.privacyRequests.find((row) => row.id === 'prv_export_1');
    const exportPayload = JSON.parse(String(request?.result));
    expect(exportPayload.retentionPolicy).toContain(
      'Financial ledgers, audit logs, invoices, tax snapshots, and fraud-prevention records are retained',
    );
    expect(exportPayload.orders).toEqual([
      expect.objectContaining({
        id: 'ord_1',
        status: 'paid',
        currency: 'USD',
        totalCents: 12500,
        refundedCents: 2500,
        buyerEmail: 'buyer@test.com',
      }),
    ]);
    expect(exportPayload.attendees).toEqual([
      expect.objectContaining({
        id: 'att_1',
        email: 'buyer@test.com',
        customAnswers: { company: '<script>alert(1)</script>' },
      }),
      expect.objectContaining({
        id: 'att_no_ticket',
        email: 'buyer@test.com',
        customAnswers: { dietary: 'vegan' },
      }),
    ]);
    expect(exportPayload.tickets).toEqual([
      expect.objectContaining({ id: 'tkt_1', status: 'issued' }),
    ]);
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
  });
});
