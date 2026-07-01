import Fastify from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
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
    order_number: 'TK-1001',
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
  events: [] as Record<string, unknown>[],
  lineItems: [] as Record<string, unknown>[],
  attendees: [] as Record<string, unknown>[],
  tickets: [] as Record<string, unknown>[],
  checkoutSession: null as Record<string, unknown> | null,
  checkoutSessions: [] as Record<string, unknown>[],
  paymentCompensations: [] as Record<string, unknown>[],
  widgetImpressions: [] as Record<string, unknown>[],
  refunds: [] as Record<string, unknown>[],
  affiliates: [] as Record<string, unknown>[],
  attributions: [] as Record<string, unknown>[],
  queryWheres: [] as Array<{
    table: string;
    wheres: Array<{ column: string; op: string; value: unknown }>;
  }>,
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

function rowMatchesWheres(
  row: Record<string, unknown>,
  wheres: Array<{ column: string; op: string; value: unknown }>,
): boolean {
  return wheres.every((where) => {
    const column = where.column.includes('.') ? where.column.split('.').at(-1)! : where.column;
    const value = Object.prototype.hasOwnProperty.call(row, where.column)
      ? row[where.column]
      : row[column];
    if (where.op === '=') return value === where.value;
    if (where.op === 'in') return Array.isArray(where.value) && where.value.includes(value);
    if (where.op === 'is') return value === where.value;
    if (where.op === 'is not') return value !== where.value;
    if (where.op === '>=')
      return (
        new Date(value as string | Date).getTime() >=
        new Date(where.value as string | Date).getTime()
      );
    if (where.op === '<=')
      return (
        new Date(value as string | Date).getTime() <=
        new Date(where.value as string | Date).getTime()
      );
    return true;
  });
}

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
        dbState.queryWheres.push({ table, wheres: [...query.wheres] });
        if (table === 'tickets') {
          return {
            count: dbState.tickets.filter((ticket) => rowMatchesWheres(ticket, query.wheres))
              .length,
          };
        }
        if (table === 'attendees') {
          return {
            count: dbState.attendees.filter((attendee) => rowMatchesWheres(attendee, query.wheres))
              .length,
          };
        }
        if (table === 'orders') {
          if (query.wheres.some((where) => where.column === 'id' || where.column === 'orders.id')) {
            return (
              dbState.orders.find((order) => rowMatchesWheres(order, query.wheres)) ?? dbState.order
            );
          }
          return {
            count: dbState.orders.filter((order) => rowMatchesWheres(order, query.wheres)).length,
          };
        }
        if (table === 'events') return dbState.event;
        if (table === 'idempotency_records') return dbState.idempotencyCheck;
        if (table === 'export_jobs') return dbState.exportJobs[0];
        if (table === 'checkout_sessions') {
          if (
            query.wheres.some(
              (where) => where.column === 'id' || where.column === 'checkout_sessions.id',
            )
          ) {
            return dbState.checkoutSession;
          }
          return {
            count: dbState.checkoutSessions.filter((session) =>
              rowMatchesWheres(session, query.wheres),
            ).length,
          };
        }
        if (table === 'widget_impressions') {
          return {
            count: dbState.widgetImpressions.filter((impression) =>
              rowMatchesWheres(impression, query.wheres),
            ).length,
          };
        }
        if (table === 'order_line_items') return undefined;
        if (table === 'email_jobs') return undefined;
        if (table === 'email_provider_routes') return { id: 'epr_1' };
        if (table === 'notification_templates as template') return { id: 'ntv_1' };
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === 'orders') return dbState.order;
        if (table === 'events')
          return { id: 'evt_1', tenant_id: 'tnt_1', brand_id: 'brd_1', organization_id: 'org_1' };
        throw new Error(`No mock for ${table}`);
      },
      async execute() {
        dbState.queryWheres.push({ table, wheres: [...query.wheres] });
        if (table === 'orders')
          return dbState.orders.filter((order) => rowMatchesWheres(order, query.wheres));
        if (table === 'order_line_items') {
          return dbState.lineItems.filter((lineItem) => rowMatchesWheres(lineItem, query.wheres));
        }
        if (table === 'attendees')
          return dbState.attendees.filter((attendee) => rowMatchesWheres(attendee, query.wheres));
        if (table === 'refunds') {
          return dbState.refunds.filter((refund) => {
            for (const where of query.wheres) {
              if (where.column === 'refunds.status' && refund.status !== where.value) return false;
            }
            return true;
          });
        }
        if (table === 'tickets')
          return dbState.tickets.filter((ticket) => rowMatchesWheres(ticket, query.wheres));
        if (table === 'discount_codes')
          return [{ code: 'PROMO10', uses_count: 5, event_id: 'evt_1' }];
        if (table === 'tax_rules')
          return [{ name: 'VAT', rate: 2500, type: 'exclusive', event_id: 'evt_1' }];
        if (table === 'ticket_types') {
          return [
            { id: 'tt_1', event_id: 'evt_1', name: 'General Admission' },
            { id: 'tt_2', event_id: 'evt_1', name: 'VIP' },
          ].filter((ticketType) => rowMatchesWheres(ticketType, query.wheres));
        }
        if (table === 'checkout_sessions') return [];
        if (table === 'payment_compensations') {
          return dbState.paymentCompensations
            .map((compensation) => {
              const checkoutSession = dbState.checkoutSessions.find(
                (session) => session.id === compensation.checkout_session_id,
              );
              const event = dbState.events.find(
                (candidate) => candidate.id === checkoutSession?.event_id,
              );
              return {
                ...compensation,
                'payment_compensations.tenant_id': compensation.tenant_id,
                'payment_compensations.checkout_session_id': compensation.checkout_session_id,
                'payment_compensations.status': compensation.status,
                'payment_compensations.id': compensation.id,
                'checkout_sessions.tenant_id': checkoutSession?.tenant_id,
                'checkout_sessions.brand_id': checkoutSession?.brand_id,
                'checkout_sessions.event_id': checkoutSession?.event_id,
                'events.tenant_id': event?.tenant_id,
                'events.organization_id': event?.organization_id,
              };
            })
            .filter((compensation) => rowMatchesWheres(compensation, query.wheres));
        }
        if (table === 'checkout_holds') return [];
        if (table === 'export_job_events') {
          return dbState.exportEvents.filter((event) => {
            for (const where of query.wheres) {
              if (where.column === 'tenant_id' && event.tenant_id !== where.value) return false;
              if (where.column === 'export_job_id' && event.export_job_id !== where.value)
                return false;
              if (
                where.column === 'id' &&
                where.op === '>' &&
                String(event.id) <= String(where.value)
              ) {
                return false;
              }
            }
            return true;
          });
        }
        if (table === 'affiliates') {
          const affiliates =
            dbState.affiliates.length > 0
              ? dbState.affiliates
              : [
                  {
                    id: 'aff_1',
                    tenant_id: 'tnt_1',
                    code: 'ADA',
                    name: 'Ada',
                    organization_id: 'org_1',
                  },
                ];
          return affiliates.filter((affiliate) => rowMatchesWheres(affiliate, query.wheres));
        }
        if (table === 'attributions') {
          const attributions =
            dbState.attributions.length > 0
              ? dbState.attributions
              : [{ affiliate_id: 'aff_1', order_id: 'ord_1', commission_cents: 100 }];
          return attributions.filter((attribution) => rowMatchesWheres(attribution, query.wheres));
        }
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
    scopes: [
      'orders.read',
      'orders.write',
      'refunds.write',
      'reports.read',
      'events.read',
      'events.write',
    ],
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
      id: 'ord_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      checkout_session_id: 'cs_1',
      order_number: 'TK-1001',
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
    };
    dbState.orders = [dbState.order];
    dbState.startRefundCalled = false;
    dbState.startRefundInput = null;
    dbState.idempotencyCheck = null;
    dbState.updatedOrder = null;
    dbState.exportEvents = [];
    dbState.lineItems = [];
    dbState.tickets = [];
    dbState.attendees = [];
    dbState.refunds = [];
    dbState.timelineEvents = [];
    dbState.checkoutSession = null;
    dbState.checkoutSessions = [];
    dbState.events = [];
    dbState.paymentCompensations = [];
  });

  it('GET /orders/:orderId returns the full persisted detail contract', async () => {
    dbState.lineItems = [
      {
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
      },
    ];
    dbState.attendees = [
      {
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
      },
    ];
    dbState.refunds = [
      {
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
      },
    ];
    dbState.timelineEvents = [
      {
        id: 'ote_1',
        order_id: 'ord_1',
        type: 'order.created',
        description: 'Order created',
        metadata: '{}',
        actor_id: null,
        created_at: new Date('2026-06-01'),
      },
    ];
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

  it('GET /orders applies organizationId and eventId query filters', async () => {
    dbState.orders = [
      dbState.order,
      {
        ...dbState.order,
        id: 'ord_other_event',
        order_number: 'TK-1002',
        event_id: 'evt_2',
      },
      {
        ...dbState.order,
        id: 'ord_other_org',
        order_number: 'TK-1003',
        organization_id: 'org_2',
        event_id: 'evt_1',
      },
    ];
    const app = await setupApp(orderRoutes, makePrincipal({ organizationIds: ['org_1', 'org_2'] }));

    const res = await app.inject({
      method: 'GET',
      url: '/orders?organizationId=org_1&eventId=evt_1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((order: { id: string }) => order.id)).toEqual(['ord_1']);
    await app.close();
  });

  it('GET /payment-compensations hides rows outside the principal organization scope', async () => {
    dbState.paymentCompensations = [
      {
        id: 'pcmp_org_1',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_1',
        payment_intent_id: 'pi_1',
        provider: 'stripe',
        provider_intent_id: 'pi_provider_1',
        amount_cents: 2500,
        currency: 'USD',
        action: 'refund',
        status: 'manual_review',
        provider_compensation_id: null,
        attempts: 1,
        reason: 'Same organization review',
        last_error: 'Stripe secret key is not configured',
        metadata: '{}',
        created_at: new Date('2026-06-01T00:00:00Z'),
        updated_at: new Date('2026-06-01T00:00:00Z'),
      },
      {
        id: 'pcmp_org_2',
        tenant_id: 'tnt_1',
        checkout_session_id: 'cs_2',
        payment_intent_id: 'pi_2',
        provider: 'stripe',
        provider_intent_id: 'pi_provider_2',
        amount_cents: 9900,
        currency: 'USD',
        action: 'refund',
        status: 'manual_review',
        provider_compensation_id: null,
        attempts: 1,
        reason: 'Cross organization review',
        last_error: 'Provider declined automatic refund',
        metadata: '{}',
        created_at: new Date('2026-06-01T00:01:00Z'),
        updated_at: new Date('2026-06-01T00:01:00Z'),
      },
    ];
    dbState.checkoutSessions = [
      { id: 'cs_1', tenant_id: 'tnt_1', brand_id: 'brd_1', event_id: 'evt_1' },
      { id: 'cs_2', tenant_id: 'tnt_1', brand_id: 'brd_2', event_id: 'evt_2' },
    ];
    dbState.events = [
      { id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1' },
      { id: 'evt_2', tenant_id: 'tnt_1', organization_id: 'org_2', brand_id: 'brd_2' },
    ];
    const app = await setupApp(orderRoutes, makePrincipal({ organizationIds: ['org_1'] }));

    const res = await app.inject({
      method: 'GET',
      url: '/payment-compensations?status=manual_review',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(['pcmp_org_1']);
    expect(
      dbState.queryWheres.some(
        (entry) =>
          entry.table === 'payment_compensations' &&
          entry.wheres.some(
            (where) => where.column === 'events.organization_id' && where.op === 'in',
          ),
      ),
    ).toBe(true);
    await app.close();
  });

  it('GET /exports/:exportId returns scoped export job status', async () => {
    dbState.exportJobs = [
      {
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
      },
    ];
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
    dbState.exportJobs = [
      {
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
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/exports/exp_2' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.fileUrl).toBe('https://exports.example.test/exp_2.csv');
    expect(body.downloadUrl).toBe('/v1/exports/exp_2/download');
    await app.close();
  });

  it('GET /exports/:exportId suppresses unsafe completed file URLs', async () => {
    dbState.exportJobs = [
      {
        id: 'exp_unsafe',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        type: 'sales',
        format: 'csv',
        status: 'completed',
        file_url: 'javascript:alert(1)',
        requested_by: 'usr_1',
        filters: null,
        created_at: new Date('2026-06-01'),
        completed_at: new Date('2026-06-01T00:01:00Z'),
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/exports/exp_unsafe' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.fileUrl).toBeUndefined();
    expect(body.downloadUrl).toBeUndefined();

    const download = await app.inject({ method: 'GET', url: '/exports/exp_unsafe/download' });
    expect(download.statusCode).toBe(409);
    expect(download.headers.location).toBeUndefined();
    await app.close();
  });

  it('GET /exports/:exportId/events streams current and terminal export states', async () => {
    dbState.exportJobs = [
      {
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
      },
    ];
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
    dbState.exportJobs = [
      {
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
      },
    ];
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

  it('GET /exports/:exportId/events sends terminal state after stale cursors', async () => {
    dbState.exportJobs = [
      {
        id: 'exp_terminal_cursor',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        type: 'sales',
        format: 'csv',
        status: 'completed',
        file_url: 'https://exports.example.test/exp_terminal_cursor.csv',
        requested_by: 'usr_1',
        filters: null,
        created_at: new Date('2026-06-01'),
        completed_at: new Date('2026-06-01T00:01:00Z'),
      },
    ];
    dbState.exportEvents = [
      {
        id: 'eev_00000000000000000000000001',
        tenant_id: 'tnt_1',
        export_job_id: 'exp_terminal_cursor',
        status: 'completed',
        payload: JSON.stringify({
          exportId: 'exp_terminal_cursor',
          status: 'completed',
          downloadUrl: '/v1/exports/exp_terminal_cursor/download',
        }),
        created_at: new Date('2026-06-01T00:01:00Z'),
      },
      {
        id: 'eev_00000000000000000000000099',
        tenant_id: 'tnt_1',
        export_job_id: 'exp_other',
        status: 'completed',
        payload: JSON.stringify({ exportId: 'exp_other', status: 'completed' }),
        created_at: new Date('2026-06-01T00:01:00Z'),
      },
    ];

    const app = await setupApp(reportingRoutes, makePrincipal());
    const futureCursor = await app.inject({
      method: 'GET',
      url: '/exports/exp_terminal_cursor/events',
      headers: { 'last-event-id': 'zzzz_future_cursor' },
    });
    const wrongExportCursor = await app.inject({
      method: 'GET',
      url: '/exports/exp_terminal_cursor/events',
      headers: { 'last-event-id': 'eev_00000000000000000000000099' },
    });

    for (const res of [futureCursor, wrongExportCursor]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: export');
      expect(res.body).toContain('"status":"completed"');
      expect(res.body).toContain('"downloadUrl":"/v1/exports/exp_terminal_cursor/download"');
    }
    await app.close();
  });

  it('GET /exports/:exportId/download redirects only when completed', async () => {
    dbState.exportJobs = [
      {
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
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const completed = await app.inject({ method: 'GET', url: '/exports/exp_3/download' });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe('https://exports.example.test/exp_3.csv');

    dbState.exportJobs[0] = { ...dbState.exportJobs[0], status: 'processing', file_url: null };
    const pending = await app.inject({ method: 'GET', url: '/exports/exp_3/download' });
    expect(pending.statusCode).toBe(409);
    await app.close();
  });
});

describe('reporting routes', () => {
  beforeEach(() => {
    dbState.order = {
      id: 'ord_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      checkout_session_id: 'cs_1',
      order_number: 'TK-1001',
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
    };
    dbState.orders = [dbState.order];
    dbState.event = {
      id: 'evt_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      currency: 'USD',
    };
    dbState.lineItems = [
      {
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 2,
        subtotal_cents: 10000,
        discount_cents: 0,
        tax_cents: 500,
      },
    ];
    dbState.tickets = [];
    dbState.refunds = [];
    dbState.affiliates = [];
    dbState.attributions = [];
    dbState.widgetImpressions = [];
    dbState.checkoutSessions = [];
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
    dbState.lineItems = [
      {
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 4,
        subtotal_cents: 10000,
        discount_cents: 0,
        tax_cents: 500,
      },
      {
        order_id: 'ord_1',
        ticket_type_id: null,
        product_id: 'prd_1',
        quantity: 3,
        subtotal_cents: 4500,
        discount_cents: 0,
        tax_cents: 0,
      },
    ];
    dbState.tickets = [
      { id: 'tkt_1', tenant_id: 'tnt_1', event_id: 'evt_1', order_id: 'ord_1', status: 'valid' },
      {
        id: 'tkt_2',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_1',
        status: 'checked_in',
      },
      { id: 'tkt_3', tenant_id: 'tnt_1', event_id: 'evt_1', order_id: 'ord_1', status: 'void' },
      { id: 'tkt_4', tenant_id: 'tnt_1', event_id: 'evt_1', order_id: 'ord_1', status: 'refunded' },
      {
        id: 'tkt_other_event',
        tenant_id: 'tnt_1',
        event_id: 'evt_2',
        order_id: 'ord_2',
        status: 'valid',
      },
      {
        id: 'tkt_other_tenant',
        tenant_id: 'tnt_2',
        event_id: 'evt_1',
        order_id: 'ord_1',
        status: 'valid',
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eventId).toBe('evt_1');
    expect(body.grossSalesCents).toBe(10700);
    expect(body.grossSalesByChannelCents).toEqual({ online: 10700, boxOffice: 0 });
    expect(body.refundsCents).toBe(1000);
    expect(body.netRevenueCents).toBe(9700);
    expect(body.ticketsSold).toBe(2);
    expect(body.checkIns).toBe(1);
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'refunds',
        wheres: expect.arrayContaining([
          { column: 'refunds.status', op: '=', value: 'succeeded' },
          { column: 'orders.tenant_id', op: '=', value: 'tnt_1' },
        ]),
      }),
    );
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'tickets',
        wheres: expect.arrayContaining([
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'event_id', op: '=', value: 'evt_1' },
          { column: 'order_id', op: 'in', value: ['ord_1'] },
          { column: 'status', op: 'in', value: ['valid', 'checked_in'] },
        ]),
      }),
    );
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'tickets',
        wheres: expect.arrayContaining([
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'event_id', op: '=', value: 'evt_1' },
          { column: 'status', op: '=', value: 'checked_in' },
        ]),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/reports/sales groups gross sales by sales channel', async () => {
    dbState.orders = [
      { ...dbState.order, id: 'ord_online', sales_channel: 'online', total_cents: 10_700 },
      {
        ...dbState.order,
        id: 'ord_box_office',
        sales_channel: 'box_office',
        tender_type: 'cash',
        operator_id: 'usr_operator',
        total_cents: 3_500,
        fee_cents: 0,
        tax_cents: 0,
      },
      {
        ...dbState.order,
        id: 'ord_legacy_online',
        sales_channel: undefined,
        total_cents: 2_000,
        fee_cents: 0,
        tax_cents: 0,
      },
    ];

    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      grossSalesCents: 16_200,
      grossSalesByChannelCents: {
        online: 12_700,
        boxOffice: 3_500,
      },
    });
    await app.close();
  });

  it('GET /events/:eventId/reports/sales ignores same-event orders outside event scope', async () => {
    dbState.orders = [
      dbState.order,
      {
        ...dbState.order,
        id: 'ord_other_tenant',
        tenant_id: 'tnt_2',
        total_cents: 50000,
        tax_cents: 2500,
        fee_cents: 900,
      },
      {
        ...dbState.order,
        id: 'ord_wrong_org',
        organization_id: 'org_2',
        total_cents: 60000,
        tax_cents: 3000,
        fee_cents: 1000,
      },
      {
        ...dbState.order,
        id: 'ord_wrong_brand',
        brand_id: 'brd_2',
        total_cents: 70000,
        tax_cents: 3500,
        fee_cents: 1100,
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      grossSalesCents: 10700,
      taxCents: 500,
      feesCents: 200,
      ordersCount: 1,
      paidOrdersCount: 1,
    });
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'orders',
        wheres: expect.arrayContaining([
          { column: 'event_id', op: '=', value: 'evt_1' },
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'organization_id', op: '=', value: 'org_1' },
          { column: 'brand_id', op: '=', value: 'brd_1' },
        ]),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/reports/sales fallback ticket count ignores product line items', async () => {
    dbState.lineItems = [
      {
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 2,
        subtotal_cents: 10000,
        discount_cents: 0,
        tax_cents: 500,
      },
      {
        order_id: 'ord_1',
        ticket_type_id: null,
        product_id: 'prd_1',
        quantity: 4,
        subtotal_cents: 6000,
        discount_cents: 0,
        tax_cents: 0,
      },
    ];
    dbState.tickets = [];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketsSold).toBe(2);
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'order_line_items',
        wheres: expect.arrayContaining([
          { column: 'order_id', op: 'in', value: ['ord_1'] },
          { column: 'ticket_type_id', op: 'is not', value: null },
        ]),
      }),
    );
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

  it('GET /events/:eventId/reports/sales includes the full date-only to day', async () => {
    dbState.order.created_at = new Date('2026-06-01T18:30:00.000Z');
    dbState.orders = [dbState.order];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({
      method: 'GET',
      url: '/events/evt_1/reports/sales?from=2026-06-01&to=2026-06-01',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      grossSalesCents: 10700,
      netRevenueCents: 10700,
    });
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'orders',
        wheres: expect.arrayContaining([
          { column: 'created_at', op: '>=', value: new Date('2026-06-01T00:00:00.000Z') },
          { column: 'created_at', op: '<=', value: new Date('2026-06-01T23:59:59.999Z') },
        ]),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/reports/sales rejects malformed date filters', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal());

    const invalidFrom = await app.inject({
      method: 'GET',
      url: '/events/evt_1/reports/sales?from=not-a-date',
    });
    const invalidTo = await app.inject({
      method: 'GET',
      url: '/events/evt_1/reports/sales?to=2026-02-31',
    });

    expect(invalidFrom.statusCode).toBe(400);
    expect(invalidFrom.json().message).toBe('from must be a valid date');
    expect(invalidTo.statusCode).toBe(400);
    expect(invalidTo.json().message).toBe('to must be a valid date');
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

  it('GET /events/:eventId/reports/tax ignores same-event orders outside event scope', async () => {
    dbState.orders = [
      dbState.order,
      {
        ...dbState.order,
        id: 'ord_other_tenant',
        tenant_id: 'tnt_2',
        tax_cents: 2500,
      },
      {
        ...dbState.order,
        id: 'ord_wrong_org',
        organization_id: 'org_2',
        tax_cents: 3000,
      },
      {
        ...dbState.order,
        id: 'ord_wrong_brand',
        brand_id: 'brd_2',
        tax_cents: 3500,
      },
    ];
    dbState.lineItems = [
      {
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 2,
        subtotal_cents: 10000,
        discount_cents: 0,
        tax_cents: 500,
      },
      {
        order_id: 'ord_other_tenant',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 1,
        subtotal_cents: 50000,
        discount_cents: 0,
        tax_cents: 2500,
      },
      {
        order_id: 'ord_wrong_org',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 1,
        subtotal_cents: 60000,
        discount_cents: 0,
        tax_cents: 3000,
      },
      {
        order_id: 'ord_wrong_brand',
        ticket_type_id: 'tt_1',
        product_id: null,
        quantity: 1,
        subtotal_cents: 70000,
        discount_cents: 0,
        tax_cents: 3500,
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/tax' });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalTaxCollectedCents).toBe(500);
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'orders',
        wheres: expect.arrayContaining([
          { column: 'event_id', op: '=', value: 'evt_1' },
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'organization_id', op: '=', value: 'org_1' },
          { column: 'brand_id', op: '=', value: 'brd_1' },
        ]),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/reports/attendance returns attendance metrics', async () => {
    dbState.attendees = [
      { id: 'att_1', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'confirmed' },
      { id: 'att_2', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'checked_in' },
      { id: 'att_cancelled', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'cancelled' },
      { id: 'att_other_tenant', tenant_id: 'tnt_2', event_id: 'evt_1', status: 'checked_in' },
    ];
    dbState.tickets = [
      {
        id: 'tkt_1',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        status: 'valid',
      },
      {
        id: 'tkt_2',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        status: 'checked_in',
      },
      {
        id: 'tkt_other_tenant',
        tenant_id: 'tnt_2',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        status: 'checked_in',
      },
      {
        id: 'tkt_other_event',
        tenant_id: 'tnt_1',
        event_id: 'evt_2',
        ticket_type_id: 'tt_1',
        status: 'checked_in',
      },
      {
        id: 'tkt_void',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        status: 'void',
      },
    ];

    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/attendance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eventId).toBe('evt_1');
    expect(body.totalAttendees).toBe(2);
    expect(body.checkedIn).toBe(1);
    expect(body.notCheckedIn).toBe(1);
    expect(body.checkInRate).toBe(0.5);
    expect(body.breakdownByTicketType).toContainEqual({
      ticketTypeId: 'tt_1',
      ticketTypeName: 'General Admission',
      total: 2,
      checkedIn: 1,
    });
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'attendees',
        wheres: expect.arrayContaining([
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'event_id', op: '=', value: 'evt_1' },
          { column: 'status', op: 'in', value: ['confirmed', 'checked_in'] },
        ]),
      }),
    );
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'tickets',
        wheres: expect.arrayContaining([
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'event_id', op: '=', value: 'evt_1' },
          { column: 'status', op: '=', value: 'checked_in' },
        ]),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/reports/promo returns non-zero discount amount', async () => {
    dbState.order.discount_cents = 1000;
    dbState.order.refunded_cents = 1200;
    dbState.order.status = 'partially_refunded';
    dbState.order.cart = JSON.stringify({ discountCode: 'PROMO10' });
    dbState.orders = [dbState.order];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/promo' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.discountCodes[0].usesCount).toBe(5);
    expect(body.discountCodes[0].discountAmountCents).toBe(1000);
    expect(body.discountCodes[0].revenueAttributedCents).toBe(9500);
    await app.close();
  });

  it('GET /events/:eventId/reports/promo ignores same-event orders outside event scope', async () => {
    dbState.orders = [
      {
        ...dbState.order,
        discount_cents: 1000,
        refunded_cents: 1200,
        status: 'partially_refunded',
        cart: JSON.stringify({ discountCode: 'PROMO10' }),
      },
      {
        ...dbState.order,
        id: 'ord_other_tenant',
        tenant_id: 'tnt_2',
        checkout_session_id: 'cs_other_tenant',
        discount_cents: 5000,
        total_cents: 50000,
        refunded_cents: 0,
        cart: JSON.stringify({ discountCode: 'PROMO10' }),
      },
      {
        ...dbState.order,
        id: 'ord_wrong_org',
        organization_id: 'org_2',
        checkout_session_id: 'cs_wrong_org',
        discount_cents: 6000,
        total_cents: 60000,
        refunded_cents: 0,
        cart: JSON.stringify({ discountCode: 'PROMO10' }),
      },
      {
        ...dbState.order,
        id: 'ord_wrong_brand',
        brand_id: 'brd_2',
        checkout_session_id: 'cs_wrong_brand',
        discount_cents: 7000,
        total_cents: 70000,
        refunded_cents: 0,
        cart: JSON.stringify({ discountCode: 'PROMO10' }),
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/promo' });
    expect(res.statusCode).toBe(200);
    expect(res.json().discountCodes[0]).toMatchObject({
      discountAmountCents: 1000,
      revenueAttributedCents: 9500,
    });
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'orders',
        wheres: expect.arrayContaining([
          { column: 'orders.event_id', op: '=', value: 'evt_1' },
          { column: 'orders.tenant_id', op: '=', value: 'tnt_1' },
          { column: 'orders.organization_id', op: '=', value: 'org_1' },
          { column: 'orders.brand_id', op: '=', value: 'brd_1' },
          { column: 'checkout_sessions.tenant_id', op: '=', value: 'tnt_1' },
          { column: 'checkout_sessions.brand_id', op: '=', value: 'brd_1' },
        ]),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/reports/conversion returns conversion funnel', async () => {
    dbState.widgetImpressions = [
      {
        id: 'wim_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
      {
        id: 'wim_2',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
      {
        id: 'wim_other',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_other',
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/conversion' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.widgetViews).toBe(2);
    expect(body).toHaveProperty('checkoutCompleted');
    expect(body).toHaveProperty('conversionRate');
    await app.close();
  });

  it('GET /events/:eventId/reports/conversion ignores same-event rows outside event scope', async () => {
    dbState.checkoutSessions = [
      { id: 'cs_1', tenant_id: 'tnt_1', brand_id: 'brd_1', event_id: 'evt_1', status: 'open' },
      {
        id: 'cs_2',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        status: 'completed',
      },
      {
        id: 'cs_other_tenant',
        tenant_id: 'tnt_2',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        status: 'completed',
      },
      {
        id: 'cs_wrong_brand',
        tenant_id: 'tnt_1',
        brand_id: 'brd_2',
        event_id: 'evt_1',
        status: 'completed',
      },
    ];
    dbState.widgetImpressions = [
      {
        id: 'wim_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
      {
        id: 'wim_other_tenant',
        tenant_id: 'tnt_2',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
      {
        id: 'wim_wrong_org',
        tenant_id: 'tnt_1',
        organization_id: 'org_2',
        brand_id: 'brd_1',
        event_id: 'evt_1',
      },
      {
        id: 'wim_wrong_brand',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_2',
        event_id: 'evt_1',
      },
    ];
    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/conversion' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      widgetViews: 1,
      checkoutStarted: 2,
      checkoutCompleted: 1,
      conversionRate: 1,
    });
    await app.close();
  });

  it('GET /organizations/:organizationId/reports/affiliate returns revenue from order join', async () => {
    dbState.orders = [
      {
        ...dbState.order,
        id: 'ord_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        total_cents: 10000,
        refunded_cents: 1200,
      },
      {
        ...dbState.order,
        id: 'ord_over_refunded',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        total_cents: 5000,
        refunded_cents: 7000,
      },
      {
        ...dbState.order,
        id: 'ord_other_org',
        tenant_id: 'tnt_1',
        organization_id: 'org_2',
        total_cents: 9000,
        refunded_cents: 0,
      },
      {
        ...dbState.order,
        id: 'ord_other_tenant',
        tenant_id: 'tnt_2',
        organization_id: 'org_1',
        total_cents: 11000,
        refunded_cents: 0,
      },
    ];
    dbState.affiliates = [
      { id: 'aff_1', tenant_id: 'tnt_1', code: 'ADA', name: 'Ada', organization_id: 'org_1' },
    ];
    dbState.attributions = [
      { affiliate_id: 'aff_1', order_id: 'ord_1', commission_cents: 100 },
      { affiliate_id: 'aff_1', order_id: 'ord_over_refunded', commission_cents: 50 },
      { affiliate_id: 'aff_1', order_id: 'ord_other_org', commission_cents: 90 },
      { affiliate_id: 'aff_1', order_id: 'ord_other_tenant', commission_cents: 110 },
    ];

    const app = await setupApp(reportingRoutes, makePrincipal());
    const res = await app.inject({ method: 'GET', url: '/organizations/org_1/reports/affiliate' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.affiliates[0].code).toBe('ADA');
    expect(body.affiliates[0].referralsCount).toBe(2);
    expect(body.affiliates[0].revenueAttributedCents).toBe(8800);
    expect(body.affiliates[0].commissionCents).toBe(150);
    expect(dbState.queryWheres).toContainEqual(
      expect.objectContaining({
        table: 'orders',
        wheres: expect.arrayContaining([
          {
            column: 'id',
            op: 'in',
            value: ['ord_1', 'ord_over_refunded', 'ord_other_org', 'ord_other_tenant'],
          },
          { column: 'tenant_id', op: '=', value: 'tnt_1' },
          { column: 'organization_id', op: '=', value: 'org_1' },
        ]),
      }),
    );
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

  it('POST /exports rejects tenant-wide export creation for event-scoped API keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_1'],
      scopes: ['reports.read'],
    });
    const app = await setupApp(reportingRoutes, principal);
    const res = await app.inject({
      method: 'POST',
      url: '/exports',
      headers: { 'idempotency-key': 'export-key-event-scoped' },
      payload: { type: 'attendees', format: 'csv' },
    });

    expect(res.statusCode).toBe(400);
    expect(dbState.exportJobs).toHaveLength(0);
    expect(dbState.exportEvents).toHaveLength(0);
    expect(dbState.startExportCalled).toBe(false);
    await app.close();
  });

  it('POST /exports rejects tenant-wide export creation for brand-scoped API keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_1'],
      scopes: ['reports.read'],
    });
    const app = await setupApp(reportingRoutes, principal);
    const res = await app.inject({
      method: 'POST',
      url: '/exports',
      headers: { 'idempotency-key': 'export-key-brand-scoped' },
      payload: { type: 'sales', format: 'csv' },
    });

    expect(res.statusCode).toBe(400);
    expect(dbState.exportJobs).toHaveLength(0);
    expect(dbState.exportEvents).toHaveLength(0);
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

  it('POST /exports allows system principals to create tenant-wide export jobs', async () => {
    const app = await setupApp(reportingRoutes, makePrincipal({ type: 'system', id: 'sys_1' }));
    const res = await app.inject({
      method: 'POST',
      url: '/exports',
      headers: { 'idempotency-key': 'export-key-system-tenant-wide' },
      payload: { type: 'sales', format: 'csv' },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.exportId).toMatch(/^exp_/);
    expect(dbState.exportJobs).toHaveLength(1);
    expect(dbState.exportJobs[0]).toMatchObject({
      tenant_id: 'tnt_1',
      event_id: null,
      type: 'sales',
      format: 'csv',
      status: 'pending',
      requested_by: 'sys_1',
    });
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.startExportCalled).toBe(true);
    expect(dbState.startExportInput).toMatchObject({
      exportId: body.exportId,
      type: 'sales',
      format: 'csv',
      requestedBy: 'sys_1',
      tenantId: 'tnt_1',
    });
    await app.close();
  });
});
