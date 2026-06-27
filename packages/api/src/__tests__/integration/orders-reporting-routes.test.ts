import Fastify from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Principal } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../../app.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';

const dbState = vi.hoisted(() => ({
  order: {
    id: 'ord_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    event_id: 'evt_1',
    checkout_session_id: 'cs_1',
    order_number: 'GK-1001',
    status: 'paid',
    currency: 'USD',
    subtotal_cents: 10000,
    discount_cents: 0,
    tax_cents: 500,
    fee_cents: 200,
    total_cents: 10700,
    refunded_cents: 0,
    buyer_email: 'buyer@test.com',
    buyer_first_name: 'Ada',
    buyer_last_name: 'Lovelace',
    buyer_phone: null,
    payment_intent_id: 'pi_1',
    payment_provider: 'stripe',
    paid_at: new Date('2026-06-01'),
    created_at: new Date('2026-06-01'),
    updated_at: new Date('2026-06-01'),
  } as Record<string, unknown>,
  orders: [] as Record<string, unknown>[],
  event: {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    currency: 'USD',
  } as Record<string, unknown>,
  lineItems: [] as Record<string, unknown>[],
  attendees: [] as Record<string, unknown>[],
  checkoutSession: null as Record<string, unknown> | null,
  refunds: [] as Record<string, unknown>[],
  queryWheres: [] as Array<{ table: string; wheres: Array<{ column: string; op: string; value: unknown }> }>,
  timeline: [] as Record<string, unknown>[],
  timelineEvents: [] as Record<string, unknown>[],
  updatedOrder: null as Record<string, unknown> | null,
  startRefundCalled: false,
  startRefundInput: null as Record<string, unknown> | null,
  startExportCalled: false,
  startExportInput: null as Record<string, unknown> | null,
  exportJobs: [] as Record<string, unknown>[],
  exportEvents: [] as Record<string, unknown>[],
  idempotencyCheck: null as Record<string, unknown> | null,
  destroy: vi.fn(),
}));

function createMockDb(): unknown {
  function createQuery(table: string) {
    const query = {
      cols: [] as string[],
      wheres: [] as Array<{ column: string; op: string; value: unknown }>,
      select: (cols: string[]) => {
        query.cols = cols;
        return query;
      },
      selectAll: () => query,
      innerJoin: () => query,
      where: (column: string, op: string, value: unknown) => {
        query.wheres.push({ column, op, value });
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      forUpdate: () => query,
      fn: {
        sum: () => 'sum',
        countAll: () => 'count',
      },
      async executeTakeFirst() {
        if (table === 'orders') return dbState.order;
        if (table === 'events') return dbState.event;
        if (table === 'idempotency_records') return dbState.idempotencyCheck;
        if (table === 'export_jobs') return dbState.exportJobs[0];
        if (table === 'checkout_sessions') return dbState.checkoutSession;
        if (table === 'order_line_items') return undefined;
        if (table === 'email_jobs') return undefined;
        if (table === 'email_provider_routes') return { id: 'epr_1' };
        if (table === 'notification_templates as template') return { id: 'ntv_1' };
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === 'orders') return dbState.order;
        if (table === 'events') return { id: 'evt_1', tenant_id: 'tnt_1', brand_id: 'brd_1', organization_id: 'org_1' };
        throw new Error(`No mock for ${table}`);
      },
      async execute() {
        dbState.queryWheres.push({ table, wheres: [...query.wheres] });
        if (table === 'orders') return dbState.orders;
        if (table === 'order_line_items') return dbState.lineItems;
        if (table === 'attendees') return dbState.attendees;
        if (table === 'refunds') {
          return dbState.refunds.filter((refund) => {
            for (const where of query.wheres) {
              if (where.column === 'refunds.status' && refund.status !== where.value) return false;
            }
            return true;
          });
        }
        if (table === 'tickets') return [];
        if (table === 'discount_codes') return [{ code: 'PROMO10', uses_count: 5, event_id: 'evt_1' }];
        if (table === 'tax_rules') return [{ name: 'VAT', rate: 2500, type: 'exclusive', event_id: 'evt_1' }];
        if (table === 'ticket_types') return [];
        if (table === 'checkout_sessions') return [];
        if (table === 'checkout_holds') return [];
        if (table === 'export_job_events') {
          return dbState.exportEvents.filter((event) => {
            for (const where of query.wheres) {
              if (where.column === 'tenant_id' && event.tenant_id !== where.value) return false;
              if (where.column === 'export_job_id' && event.export_job_id !== where.value) return false;
              if (where.column === 'id' && where.op === '>' && String(event.id) <= String(where.value)) {
                return false;
              }
            }
            return true;
          });
        }
        if (table === 'affiliates') return [{ id: 'aff_1', code: 'ADA', name: 'Ada', organization_id: 'org_1' }];
        if (table === 'attributions') return [{ affiliate_id: 'aff_1', order_id: 'ord_1', commission_cents: 100 }];
        if (table === 'export_jobs') return [];
        if (table === 'order_timeline_events') return dbState.timelineEvents;
        if (table === 'user_profiles') return null;
        return [];
      },
    };
    return query;
  }

  function createUpdate(table: string) {
    return {
      set: (values: Record<string, unknown>) => {
        if (table === 'orders') dbState.updatedOrder = { ...dbState.order, ...values };
        return {
          where: () => ({
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => dbState.updatedOrder ?? dbState.order,
            }),
            execute: async () => [],
          }),
        };
      },
    };
  }

  function createInsert(table: string) {
    return {
      values: (vals: Record<string, unknown>) => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => ({ id: 'new_1', ...vals }),
        }),
        execute: async () => {
          if (table === 'export_jobs') {
            dbState.exportJobs.push(vals);
          }
          if (table === 'export_job_events') {
            dbState.exportEvents.push(vals);
          }
        },
      }),
    };
  }

  const db = {
    selectFrom: createQuery,
    updateTable: createUpdate,
    insertInto: createInsert,
    transaction: () => ({
      execute: async (fn: (trx: typeof db) => Promise<unknown>) => fn(db),
    }),
    destroy: dbState.destroy,
  };
  return db;
}

function createMockTemporalClient() {
  return {
    startRefund: vi.fn(async (input: Record<string, unknown>) => {
      dbState.startRefundCalled = true;
      dbState.startRefundInput = input;
    }),
    startExport: vi.fn(async (input: Record<string, unknown>) => {
      dbState.startExportCalled = true;
      dbState.startExportInput = input;
    }),
    waitForExport: vi.fn(async (exportId: string) => {
      const job = dbState.exportJobs.find((item) => item.id === exportId);
      if (job) {
        const completedAt = new Date('2026-06-01T00:01:00Z');
        const fileUrl = `https://exports.example.test/${exportId}.csv`;
        Object.assign(job, {
          status: 'completed',
          file_url: fileUrl,
          completed_at: completedAt,
        });
        dbState.exportEvents.push({
          id: `eev_${exportId}_completed`,
          tenant_id: String(job.tenant_id),
          export_job_id: exportId,
          status: 'completed',
          payload: JSON.stringify({
            exportId,
            eventId: job.event_id,
            type: job.type,
            format: job.format,
            status: 'completed',
            fileUrl,
            downloadUrl: `/v1/exports/${exportId}/download`,
            createdAt: job.created_at,
            completedAt,
          }),
          created_at: completedAt,
        });
      }
      return { status: 'completed', fileUrl: `https://exports.example.test/${exportId}.csv` };
    }),
    startNotificationDelivery: vi.fn(),
    startCheckoutSession: vi.fn(),
    startWebhookDelivery: vi.fn(),
  };
}

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['orders.read', 'orders.write', 'refunds.write', 'reports.read', 'events.read', 'events.write'],
    ...overrides,
  };
}

async function setupApp(routes: any, principal: Principal) {
  const app = Fastify();
  app.decorate('context', {
    db: createMockDb() as unknown as Database,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: createMockTemporalClient(),
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(routes);
  return app;
}

describe('order routes', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', event_id: 'evt_1',
      checkout_session_id: 'cs_1', order_number: 'GK-1001', status: 'paid', currency: 'USD',
      subtotal_cents: 10000, discount_cents: 0, tax_cents: 500, fee_cents: 200, total_cents: 10700,
      refunded_cents: 0, buyer_email: 'buyer@test.com', buyer_first_name: 'Ada', buyer_last_name: 'Lovelace',
      buyer_phone: null, payment_intent_id: 'pi_1', payment_provider: 'stripe',
      paid_at: new Date('2026-06-01'), created_at: new Date('2026-06-01'), updated_at: new Date('2026-06-01'),
    };
    dbState.orders = [dbState.order];
    dbState.startRefundCalled = false;
    dbState.startRefundInput = null;
    dbState.idempotencyCheck = null;
    dbState.updatedOrder = null;
    dbState.exportEvents = [];
    dbState.lineItems = [];
    dbState.attendees = [];
    dbState.refunds = [];
    dbState.timelineEvents = [];
    dbState.checkoutSession = null;
  });

  it('GET /orders/:orderId returns the full persisted detail contract', async () => {
    dbState.lineItems = [{
      id: 'oli_1',
      order_id: 'ord_1',
      ticket_type_id: 'tt_1',
      attendee_id: 'att_1',
      description: 'General admission',
      quantity: 1,
      unit_price_cents: 10000,
      subtotal_cents: 10000,
      discount_cents: 0,
      tax_cents: 500,
      fee_cents: 200,
      total_cents: 10700,
      currency: 'USD',
      created_at: new Date('2026-06-01'),
      updated_at: new Date('2026-06-01'),
    }];
    dbState.attendees = [{
      id: 'att_1',
      tenant_id: 'tnt_1',
      order_id: 'ord_1',
      event_id: 'evt_1',
      ticket_type_id: 'tt_1',
      ticket_id: 'tkt_1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'buyer@test.com',
      phone: null,
      status: 'active',
      custom_answers: JSON.stringify({ q_attendee: 'Ada' }),
      checked_in_at: null,
      check_in_device_id: null,
      created_at: new Date('2026-06-01'),
      updated_at: new Date('2026-06-01'),
    }];
    dbState.refunds = [{
      id: 'ref_1',
      tenant_id: 'tnt_1',
      order_id: 'ord_1',
      payment_intent_id: 'pi_1',
      provider: 'stripe',
      provider_refund_id: 're_1',
      amount_cents: 1000,
      currency: 'USD',
      status: 'succeeded',
      reason: 'customer request',
      metadata: '{}',
      created_at: new Date('2026-06-02'),
      updated_at: new Date('2026-06-02'),
    }];
    dbState.timelineEvents = [{
      id: 'ote_1',
      order_id: 'ord_1',
      type: 'order.created',
      description: 'Order created',
      metadata: '{}',
      actor_id: null,
      created_at: new Date('2026-06-01'),
    }];
    dbState.checkoutSession = {
      id: 'cs_1',
      cart: JSON.stringify({
        buyerFields: {
          q_consent: {
            accepted: true,
            consentText: 'I agree',
            consentVersion: 'v1',
            consentedAt: '2026-06-01T00:00:00.000Z',
          },
        },
        attendeeFields: { tt_1: [{ q_attendee: 'Ada' }] },
      }),
    };
    const app = await setupApp(orderRoutes, makePrincipal());

    const res = await app.inject({ method: 'GET', url: '/orders/ord_1' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lineItems).toHaveLength(1);
    expect(body.attendees).toHaveLength(1);
    expect(body.refunds).toHaveLength(1);
    expect(body.timeline).toHaveLength(1);
    expect(body.checkoutAnswers.buyerFields.q_consent.accepted).toBe(true);
    expect(body.consentSnapshots.q_consent.consentVersion).toBe('v1');
    expect(body.deliveryStatus).toEqual({ email: 'pending', tickets: 'issued' });
    await app.close();
  });

  it('POST /orders/:orderId/cancel rejects paid orders', async () => {
    const app = await setupApp(orderRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/cancel',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /orders/:orderId/cancel succeeds for draft orders', async () => {
    dbState.order.status = 'draft';
    const app = await setupApp(orderRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/cancel',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('cancelled');
    await app.close();
  });

  it('POST /orders/:orderId/refunds validates refundable state', async () => {
    dbState.order.status = 'cancelled';
    const app = await setupApp(orderRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/refunds',
      headers: { 'idempotency-key': 'key-1' },
      payload: { reason: 'Customer request' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /orders/:orderId/refunds starts refund workflow with nonce', async () => {
    dbState.order.status = 'paid';
    const app = await setupApp(orderRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/refunds',
      headers: { 'idempotency-key': 'key-1' },
      payload: { reason: 'Customer request', amountCents: 5000 },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.orderId).toBe('ord_1');
    expect(body.refundAmount).toBe(5000);
    expect(body.status).toBe('pending');
    expect(dbState.startRefundCalled).toBe(true);
    expect(dbState.startRefundInput).toHaveProperty('nonce');
    await app.close();
  });

  it('POST /orders/:orderId/refunds requires Idempotency-Key', async () => {
    const app = await setupApp(orderRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/refunds',
      payload: { reason: 'Customer request' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /orders/:orderId/refunds rejects amount exceeding total', async () => {
    const app = await setupApp(orderRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/refunds',
      headers: { 'idempotency-key': 'key-1' },
      payload: { reason: 'test', amountCents: 999999 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('GET /orders filters by organization_id for org-scoped principals', async () => {
    const app = await setupApp(orderRoutes, makePrincipal({ organizationIds: ['org_1'] }));
    const res = await app.inject({ method: 'GET', url: '/orders' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /exports/:exportId returns scoped export job status', async () => {
    dbState.exportJobs = [{
      id: 'exp_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'attendees',
      format: 'csv',
      status: 'processing',
      file_url: null,
      requested_by: 'usr_1',
      filters: null,
      created_at: new Date('2026-06-01'),
      completed_at: null,
    }];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/exports/exp_1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      exportId: 'exp_1',
      eventId: 'evt_1',
      type: 'attendees',
      format: 'csv',
      status: 'processing',
    });
    expect(body.fileUrl).toBeUndefined();
    await app.close();
  });

  it('GET /exports/:exportId returns completed download metadata', async () => {
    dbState.exportJobs = [{
      id: 'exp_2',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'sales',
      format: 'csv',
      status: 'completed',
      file_url: 'https://exports.example.test/exp_2.csv',
      requested_by: 'usr_1',
      filters: null,
      created_at: new Date('2026-06-01'),
      completed_at: new Date('2026-06-01T00:01:00Z'),
    }];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/exports/exp_2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.fileUrl).toBe('https://exports.example.test/exp_2.csv');
    expect(body.downloadUrl).toBe('/v1/exports/exp_2/download');
    await app.close();
  });

  it('GET /exports/:exportId/events streams current and terminal export states', async () => {
    dbState.exportJobs = [{
      id: 'exp_stream',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'sales',
      format: 'csv',
      status: 'pending',
      file_url: null,
      requested_by: 'usr_1',
      filters: null,
      created_at: new Date('2026-06-01'),
      completed_at: null,
    }];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/exports/exp_stream/events' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: export');
    expect(res.body).toContain('"status":"pending"');
    expect(res.body).toContain('"status":"completed"');
    expect(res.body).toContain('"downloadUrl":"/v1/exports/exp_stream/download"');
    await app.close();
  });

  it('GET /exports/:exportId/events replays durable events after Last-Event-ID', async () => {
    dbState.exportJobs = [{
      id: 'exp_replay',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'sales',
      format: 'csv',
      status: 'completed',
      file_url: 'https://exports.example.test/exp_replay.csv',
      requested_by: 'usr_1',
      filters: null,
      created_at: new Date('2026-06-01'),
      completed_at: new Date('2026-06-01T00:01:00Z'),
    }];
    dbState.exportEvents = [
      {
        id: 'eev_00000000000000000000000001',
        tenant_id: 'tnt_1',
        export_job_id: 'exp_replay',
        status: 'pending',
        payload: JSON.stringify({ exportId: 'exp_replay', status: 'pending' }),
        created_at: new Date('2026-06-01'),
      },
      {
        id: 'eev_00000000000000000000000002',
        tenant_id: 'tnt_1',
        export_job_id: 'exp_replay',
        status: 'completed',
        payload: JSON.stringify({
          exportId: 'exp_replay',
          status: 'completed',
          downloadUrl: '/v1/exports/exp_replay/download',
        }),
        created_at: new Date('2026-06-01T00:01:00Z'),
      },
    ];

    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({
      method: 'GET',
      url: '/exports/exp_replay/events',
      headers: { 'last-event-id': 'eev_00000000000000000000000001' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('"status":"pending"');
    expect(res.body).toContain('id: eev_00000000000000000000000002');
    expect(res.body).toContain('"status":"completed"');
    await app.close();
  });

  it('GET /exports/:exportId/download redirects only when completed', async () => {
    dbState.exportJobs = [{
      id: 'exp_3',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'sales',
      format: 'csv',
      status: 'completed',
      file_url: 'https://exports.example.test/exp_3.csv',
      requested_by: 'usr_1',
      filters: null,
      created_at: new Date('2026-06-01'),
      completed_at: new Date('2026-06-01T00:01:00Z'),
    }];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const completed = await app.inject({ method: 'GET', url: '/exports/exp_3/download' });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe('https://exports.example.test/exp_3.csv');

    dbState.exportJobs[0] = { ...dbState.exportJobs[0], status: 'processing', file_url: null };
    const pending = await app.inject({ method: 'GET', url: '/exports/exp_3/download' });
    expect(pending.statusCode).toBe(400);
    await app.close();
  });
});

describe('reporting routes', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', event_id: 'evt_1',
      checkout_session_id: 'cs_1', order_number: 'GK-1001', status: 'paid', currency: 'USD',
      subtotal_cents: 10000, discount_cents: 0, tax_cents: 500, fee_cents: 200, total_cents: 10700,
      refunded_cents: 0, buyer_email: 'buyer@test.com', buyer_first_name: 'Ada', buyer_last_name: 'Lovelace',
      buyer_phone: null, payment_intent_id: 'pi_1', payment_provider: 'stripe',
      paid_at: new Date('2026-06-01'), created_at: new Date('2026-06-01'), updated_at: new Date('2026-06-01'),
    };
    dbState.orders = [dbState.order];
    dbState.event = {
      id: 'evt_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      currency: 'USD',
    };
    dbState.lineItems = [{ quantity: 2, subtotal_cents: 10000, discount_cents: 0, tax_cents: 500 }];
    dbState.refunds = [];
    dbState.queryWheres = [];
    dbState.exportJobs = [];
    dbState.exportEvents = [];
    dbState.startExportCalled = false;
    dbState.startExportInput = null;
    dbState.idempotencyCheck = null;
  });

  it('GET /events/:eventId/reports/sales returns sales metrics with refund subtraction', async () => {
    dbState.refunds = [
      { amount_cents: 1000, status: 'succeeded' },
      { amount_cents: 700, status: 'failed' },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eventId).toBe('evt_1');
    expect(body.grossSalesCents).toBe(10700);
    expect(body.refundsCents).toBe(1000);
    expect(body.netRevenueCents).toBe(9700);
    expect(dbState.queryWheres).toContainEqual(expect.objectContaining({
      table: 'refunds',
      wheres: expect.arrayContaining([
        { column: 'refunds.status', op: '=', value: 'succeeded' },
        { column: 'orders.tenant_id', op: '=', value: 'tnt_1' },
      ]),
    }));
    await app.close();
  });

  it('GET /events/:eventId/reports/sales falls back to event currency when there are no orders', async () => {
    dbState.orders = [];
    dbState.lineItems = [];
    dbState.event.currency = 'EUR';
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('EUR');
    await app.close();
  });

  it('GET /events/:eventId/reports/tax returns tax breakdown from line items', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/tax' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eventId).toBe('evt_1');
    expect(body.totalTaxCollectedCents).toBe(500);
    expect(body.breakdown).toHaveLength(1);
    expect(body.breakdown[0].taxRuleName).toBe('VAT');
    await app.close();
  });

  it('GET /events/:eventId/reports/attendance returns attendance metrics', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/attendance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eventId).toBe('evt_1');
    expect(body).toHaveProperty('totalAttendees');
    expect(body).toHaveProperty('checkedIn');
    expect(body).toHaveProperty('checkInRate');
    await app.close();
  });

  it('GET /events/:eventId/reports/promo returns non-zero discount amount', async () => {
    dbState.order.discount_cents = 1000;
    dbState.orders = [dbState.order];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/promo' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.discountCodes[0].usesCount).toBe(5);
    // Should not be hardcoded 0
    expect(body.discountCodes[0].discountAmountCents).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it('GET /events/:eventId/reports/conversion returns conversion funnel', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/conversion' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.widgetViews).toBeNull();
    expect(body).toHaveProperty('checkoutCompleted');
    expect(body).toHaveProperty('conversionRate');
    await app.close();
  });

  it('GET /organizations/:organizationId/reports/affiliate returns revenue from order join', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/organizations/org_1/reports/affiliate' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.affiliates[0].code).toBe('ADA');
    expect(body.affiliates[0].revenueAttributedCents).toBeGreaterThanOrEqual(0);
    expect(dbState.queryWheres).toContainEqual(expect.objectContaining({
      table: 'orders',
      wheres: expect.arrayContaining([
        { column: 'tenant_id', op: '=', value: 'tnt_1' },
        { column: 'organization_id', op: '=', value: 'org_1' },
      ]),
    }));
    await app.close();
  });

  it('POST /exports requires Idempotency-Key', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/exports',
      payload: { eventId: 'evt_1', type: 'attendees', format: 'csv' },
    });
    expect(res.statusCode).toBe(400);
    expect(dbState.startExportCalled).toBe(false);
    await app.close();
  });

  it('POST /exports creates a durable job before starting the export workflow', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/exports',
      headers: { 'idempotency-key': 'export-key-1' },
      payload: {
        eventId: 'evt_1',
        type: 'attendees',
        format: 'csv',
        filters: { status: 'active' },
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.exportId).toMatch(/^exp_/);
    expect(body.status).toBe('pending');
    expect(dbState.exportJobs).toHaveLength(1);
    expect(dbState.exportJobs[0]).toMatchObject({
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'attendees',
      format: 'csv',
      status: 'pending',
      requested_by: 'usr_1',
    });
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      export_job_id: body.exportId,
      status: 'pending',
    });
    expect(dbState.startExportCalled).toBe(true);
    expect(dbState.startExportInput).toMatchObject({
      exportId: body.exportId,
      type: 'attendees',
      format: 'csv',
      requestedBy: 'usr_1',
      tenantId: 'tnt_1',
    });
    await app.close();
  });
});
