import { expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type Database } from '@tixkit/db';
import {
  PaymentEventRepository,
  TicketRepository,
  AttendeeRepository,
  OrderRepository,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../../app.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { InventoryService } from '../../services/inventory.js';
import { hashRequest, withIdempotency } from '../../services/idempotency.js';
import { ulid } from 'ulid';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

/**
 * T44 Load and concurrency harnesses (real database).
 *
 * These tests exercise high-concurrency paths against a real database to
 * verify oversell prevention, webhook burst dedupe, scanner burst duplicate
 * detection, idempotency replay, and large export generation. They require a
 * running database (`bun run infra:up`) and are skipped when no selected
 * integration database URL is set.
 *
 * All test data is scoped under a single tenant/org/brand/event created for
 * this run and torn down afterwards, so it does not interfere with other
 * integration tests.
 */

let db: Database;
let inventoryService: InventoryService;
let paymentEventRepo: PaymentEventRepository;
let ticketRepo: TicketRepository;
let attendeeRepo: AttendeeRepository;
let orderRepo: OrderRepository;
let app: FastifyInstance;
let previousDbDriver: string | undefined;

const RUN_ID = ulid().slice(-10);
const TENANT_ID = `tnt_load_${RUN_ID}`;
const ORG_ID = `org_load_${RUN_ID}`;
const BRAND_ID = `brd_load_${RUN_ID}`;
const EVENT_ID = `evt_load_${RUN_ID}`;
const CHECKOUT_P95_SLO_MS = 2_000;
const SCAN_P95_SLO_MS = 500;
const WEBHOOK_CATCHUP_SLO_MS = 300_000;
const PAYMENT_SUCCESS_RATE_SLO = 0.98;

async function seedTenantGraph(trx: Database): Promise<void> {
  await trx
    .insertInto('tenants')
    .values({
      id: TENANT_ID,
      name: 'Load Harness Tenant',
      status: 'active',
      plan: 'test',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await trx
    .insertInto('organizations')
    .values({
      id: ORG_ID,
      tenant_id: TENANT_ID,
      name: 'Load Harness Org',
      slug: `load-${RUN_ID}`,
      clerk_organization_id: null,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await trx
    .insertInto('brands')
    .values({
      id: BRAND_ID,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      name: 'Load Harness Brand',
      slug: `load-${RUN_ID}`,
      status: 'active',
      theme: JSON.stringify({}),
      legal_urls: JSON.stringify({}),
      white_label: false,
      payment_account_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await trx
    .insertInto('events')
    .values({
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      brand_id: BRAND_ID,
      slug: `load-${RUN_ID}`,
      title: 'Load Harness Event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date(Date.now() + 86400000),
      ends_at: null,
      visibility: 'public',
      seo: JSON.stringify({}),
      capacity: null,
      cover_image_url: null,
      external_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
}

async function cleanupAll(database: Database): Promise<void> {
  // Clean up load-harness data in reverse FK order.
  await database.deleteFrom('marketing_integrations').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('scan_logs').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('tickets').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('attendees').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('export_job_events').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('export_jobs').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('payment_events').where('tenant_id', '=', TENANT_ID).execute();
  await database
    .deleteFrom('checkout_holds')
    .where('checkout_session_id', 'like', 'cs_load_%')
    .execute();
  await database.deleteFrom('checkout_sessions').where('id', 'like', 'cs_load_%').execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await database.deleteFrom('brands').where('id', '=', BRAND_ID).execute();
  await database.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await database.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function createPool(database: Database, capacity: number, ttl = 300): Promise<string> {
  const poolId = `pool_load_${ulid().slice(-10)}`;
  await database
    .insertInto('inventory_pools')
    .values({
      id: poolId,
      event_id: EVENT_ID,
      name: `Load Pool ${poolId}`,
      total_capacity: capacity,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: ttl,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return poolId;
}

async function createTicketType(database: Database, poolId: string): Promise<string> {
  const ticketTypeId = `tt_load_${ulid().slice(-10)}`;
  await database
    .insertInto('ticket_types')
    .values({
      id: ticketTypeId,
      event_id: EVENT_ID,
      name: `Load Ticket ${ticketTypeId}`,
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 1000,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return ticketTypeId;
}

async function createCheckoutSession(database: Database, ticketTypeId: string): Promise<string> {
  const sessionId = `cs_load_${ulid().slice(-10)}`;
  await database
    .insertInto('checkout_sessions')
    .values({
      id: sessionId,
      tenant_id: TENANT_ID,
      event_id: EVENT_ID,
      brand_id: BRAND_ID,
      status: 'open',
      hold_id: `hld_${ulid()}`,
      currency: 'USD',
      cart: JSON.stringify({ items: [{ ticketTypeId, quantity: 1 }] }),
      buyer: JSON.stringify({ email: 'load@example.com' }),
      quote: JSON.stringify({
        totalCents: 1000,
        feeCents: 0,
        subtotalCents: 1000,
        discountCents: 0,
        taxCents: 0,
      }),
      expires_at: new Date(Date.now() + 300000),
      idempotency_key: `ik_load_${ulid()}`,
      success_url: null,
      cancel_url: null,
      order_id: null,
      client_token: ulid(),
      payment_intent_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return sessionId;
}

async function createOrder(): Promise<string> {
  // orders.checkout_session_id has a FK to checkout_sessions.id, so we must
  // create a real checkout session row before inserting the order.
  const sessionId = `cs_load_${ulid().slice(-10)}`;
  await db
    .insertInto('checkout_sessions')
    .values({
      id: sessionId,
      tenant_id: TENANT_ID,
      event_id: EVENT_ID,
      brand_id: BRAND_ID,
      status: 'open',
      hold_id: `hld_${ulid()}`,
      currency: 'USD',
      cart: JSON.stringify({ items: [] }),
      buyer: JSON.stringify({ email: 'load-buyer@example.com' }),
      quote: JSON.stringify({
        totalCents: 1000,
        feeCents: 0,
        subtotalCents: 1000,
        discountCents: 0,
        taxCents: 0,
      }),
      expires_at: new Date(Date.now() + 300000),
      idempotency_key: `ik_load_${ulid()}`,
      success_url: null,
      cancel_url: null,
      order_id: null,
      client_token: ulid(),
      payment_intent_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  const order = await orderRepo.create({
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    brandId: BRAND_ID,
    eventId: EVENT_ID,
    checkoutSessionId: sessionId,
    orderNumber: `TK-LOAD-${ulid()}`,
    status: 'paid',
    currency: 'USD',
    subtotalCents: 1000,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 1000,
    buyerEmail: 'load-buyer@example.com',
  });
  return order.id;
}

/**
 * CSV serialization mirroring the real export activity so the harness validates
 * the same data shape that production exports emit.
 */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(row[h])).join(','));
  }
  return lines.join('\n');
}

function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function measure<T>(operation: () => Promise<T>): Promise<{ durationMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await operation();
  return {
    durationMs: performance.now() - startedAt,
    value,
  };
}

async function measureSettled<T>(
  operation: () => Promise<T>,
): Promise<{ durationMs: number; outcome: PromiseSettledResult<T> }> {
  const startedAt = performance.now();
  try {
    return {
      durationMs: performance.now() - startedAt,
      outcome: { status: 'fulfilled', value: await operation() },
    };
  } catch (reason) {
    return {
      durationMs: performance.now() - startedAt,
      outcome: { status: 'rejected', reason },
    };
  }
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted: number[] = [];
  for (const value of values) {
    const index = sorted.findIndex((existing) => existing > value);
    if (index === -1) sorted.push(value);
    else sorted.splice(index, 0, value);
  }
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

function expectSloAtOrBelow(metric: string, actual: number, threshold: number): void {
  expect(
    actual,
    `${metric} expected <= ${threshold}ms, got ${actual.toFixed(2)}ms`,
  ).toBeLessThanOrEqual(threshold);
}

function makePrincipal(): Principal {
  return {
    type: 'user',
    id: `usr_load_${RUN_ID}`,
    tenantId: TENANT_ID,
    organizationIds: [ORG_ID],
    brandIds: [BRAND_ID],
    eventIds: [EVENT_ID],
    scopes: ['events.read', 'events.write'],
  };
}

async function setupEventRouteApp(database: Database): Promise<FastifyInstance> {
  const routeApp = Fastify();
  routeApp.decorate('context', {
    db: database,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  routeApp.addHook('onRequest', async (request) => {
    request.principal = makePrincipal();
  });
  await routeApp.register(eventRoutes);
  return routeApp;
}

describeWithIntegrationDatabase('Load and concurrency harnesses', () => {
  beforeAll(async () => {
    previousDbDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    inventoryService = new InventoryService(db);
    paymentEventRepo = new PaymentEventRepository(db);
    ticketRepo = new TicketRepository(db);
    attendeeRepo = new AttendeeRepository(db);
    orderRepo = new OrderRepository(db);
    await seedTenantGraph(db);
    app = await setupEventRouteApp(db);
  });

  afterAll(async () => {
    await app.close();
    await cleanupAll(db);
    await db.destroy();
    restoreDatabaseDriver(previousDbDriver);
  });

  beforeEach(async () => {
    // Reset per-test mutation targets scoped to this run. Order matters because
    // of FK constraints: tickets/attendees reference orders, orders reference
    // checkout_sessions.
    await db.deleteFrom('marketing_integrations').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('scan_logs').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('tickets').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('attendees').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('export_job_events').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('export_jobs').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('payment_events').where('tenant_id', '=', TENANT_ID).execute();
    await db
      .deleteFrom('checkout_holds')
      .where('checkout_session_id', 'like', 'cs_load_%')
      .execute();
    await db.deleteFrom('checkout_sessions').where('id', 'like', 'cs_load_%').execute();
    await db.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  });

  it('upserts one GA4 marketing integration when concurrent first-create requests target the same event/provider', async () => {
    const CONCURRENT_CLIENTS = 32;
    const payload = {
      config: {
        measurementId: `G-${RUN_ID}`,
        sendPageView: true,
      },
      consentRequired: false,
      status: 'active',
    };

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_CLIENTS }, () =>
        app.inject({
          method: 'PUT',
          url: `/events/${EVENT_ID}/marketing-integrations/ga4`,
          payload,
        }),
      ),
    );

    const statusCodes = responses.map((response) => response.statusCode);
    expect(
      statusCodes.every((statusCode) => statusCode < 500),
      statusCodes.join(','),
    ).toBe(true);
    expect(statusCodes).toEqual(Array(CONCURRENT_CLIENTS).fill(200));

    for (const response of responses) {
      const body = response.json();
      expect(body).toMatchObject({
        tenantId: TENANT_ID,
        organizationId: ORG_ID,
        brandId: BRAND_ID,
        eventId: EVENT_ID,
        provider: 'ga4',
        config: payload.config,
        consentRequired: payload.consentRequired,
        status: payload.status,
      });
    }

    const rows = await db
      .selectFrom('marketing_integrations')
      .select(['event_id', 'provider', 'config', 'consent_required', 'status'])
      .where('event_id', '=', EVENT_ID)
      .where('provider', '=', 'ga4')
      .execute();

    expect(rows).toHaveLength(1);
    const row = rows[0];
    const persistedConfig =
      typeof row.config === 'string' ? (JSON.parse(row.config) as unknown) : row.config;
    expect(persistedConfig).toEqual(payload.config);
    expect(Boolean(row.consent_required)).toBe(payload.consentRequired);
    expect(row.status).toBe(payload.status);
  });

  it('prevents oversell when 120 concurrent checkout reservations target a 25-capacity pool', async () => {
    const CAPACITY = 25;
    const CONCURRENT_CLIENTS = 120;

    const poolId = await createPool(db, CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId);

    const sessionIds: string[] = [];
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
      // eslint-disable-next-line no-await-in-loop -- load setup creates persisted sessions before the concurrent reservation burst.
      sessionIds.push(await createCheckoutSession(db, ticketTypeId));
    }

    const measuredResults = await Promise.all(
      sessionIds.map((sessionId) =>
        measureSettled(() =>
          inventoryService.reserveCart({
            items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
            checkoutSessionId: sessionId,
          }),
        ),
      ),
    );
    const results = measuredResults.map((entry) => entry.outcome);
    const checkoutP95 = percentile(
      measuredResults.map((entry) => entry.durationMs),
      0.95,
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    expect(succeeded).toBe(CAPACITY);
    expect(failed).toBe(CONCURRENT_CLIENTS - CAPACITY);
    expectSloAtOrBelow('checkout reservation p95', checkoutP95, CHECKOUT_P95_SLO_MS);

    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();

    const activeHolds = await db
      .selectFrom('checkout_holds')
      .select(db.fn.sum('quantity').as('total'))
      .where('inventory_pool_id', '=', poolId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    const held = Number(activeHolds?.total ?? 0);
    expect(Number(pool.sold_count)).toBe(0);
    expect(held).toBe(CAPACITY);
    expect(Number(pool.sold_count) + held).toBeLessThanOrEqual(CAPACITY);
  });

  it('webhook burst: concurrent deliveries for the same Stripe event dedupe to a single stored and processed row', async () => {
    const BURST = 50;
    const provider = 'stripe';
    const providerEventId = `evt_load_${ulid()}`;
    const eventType = 'payment_intent.succeeded';
    const rawPayload = { id: providerEventId, type: eventType };

    // Simulate the webhook route's store-then-process flow under a burst of
    // concurrent deliveries for the same provider event. The unique constraint
    // on (provider, provider_event_id) guarantees only one row is stored; the
    // winner marks it processed while every other delivery observes a duplicate.
    const deliver = async (): Promise<'created' | 'duplicate'> => {
      try {
        const stored = await paymentEventRepo.create({
          tenantId: TENANT_ID,
          provider,
          providerEventId,
          eventType,
          rawPayload,
          idempotencyKey: providerEventId,
        });
        await paymentEventRepo.markProcessed(stored.id);
        return 'created';
      } catch {
        const existing = await paymentEventRepo.findByProviderEventId(provider, providerEventId);
        if (!existing) throw new Error('webhook burst: race lost but no row found');
        return 'duplicate';
      }
    };

    const measured = await measure(() =>
      Promise.all(Array.from({ length: BURST }, () => deliver())),
    );
    const outcomes = measured.value;

    const created = outcomes.filter((o) => o === 'created').length;
    const duplicates = outcomes.filter((o) => o === 'duplicate').length;

    expect(created).toBe(1);
    expect(duplicates).toBe(BURST - 1);
    expectSloAtOrBelow('webhook burst catch-up', measured.durationMs, WEBHOOK_CATCHUP_SLO_MS);

    const rows = await db
      .selectFrom('payment_events')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_event_id', '=', providerEventId)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[0].tenant_id).toBe(TENANT_ID);
  });

  it('idempotency burst: concurrent requests with the same key run one side effect and replay the stored response', async () => {
    const BURST = 40;
    const key = `idem_load_${ulid()}`;
    const requestHash = hashRequest({ operation: 'load-harness-idempotency', key });
    let sideEffects = 0;

    const outcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        withIdempotency(
          db,
          {
            key,
            tenantId: TENANT_ID,
            requestHash,
          },
          async () => {
            sideEffects += 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { status: 202, body: { accepted: true, sideEffects } };
          },
        ),
      ),
    );

    expect(sideEffects).toBe(1);
    expect(outcomes).toHaveLength(BURST);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ status: 202, body: { accepted: true, sideEffects: 1 } });
    }

    const records = await db
      .selectFrom('idempotency_records')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('key', '=', key)
      .execute();

    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
  });

  it('scanner burst: concurrent scans for the same ticket yield exactly one accepted check-in', async () => {
    const BURST = 60;
    const deviceId = `dev_load_${ulid().slice(-8)}`;
    const qrHash = `qrh_load_${ulid()}`;
    const qrPayload = `payload_${ulid()}`;
    const poolId = await createPool(db, 1000);
    const ticketTypeId = await createTicketType(db, poolId);

    const orderId = await createOrder();
    const attendee = await attendeeRepo.create({
      tenantId: TENANT_ID,
      orderId,
      eventId: EVENT_ID,
      ticketTypeId,
      email: 'load-scanner@example.com',
      firstName: 'Scanner',
      lastName: 'Burst',
    });
    const ticket = await ticketRepo.create({
      tenantId: TENANT_ID,
      orderId,
      attendeeId: attendee.id,
      eventId: EVENT_ID,
      ticketTypeId,
      code: `code_${ulid()}`,
      qrPayload,
      qrHash,
    });

    const scannedAt = new Date();
    const measuredOutcomes = await Promise.all(
      Array.from({ length: BURST }, () =>
        measure(() => ticketRepo.checkInIfValid(ticket.id, deviceId, scannedAt)),
      ),
    );
    const outcomes = measuredOutcomes.map((entry) => entry.value);
    const scanP95 = percentile(
      measuredOutcomes.map((entry) => entry.durationMs),
      0.95,
    );

    const accepted = outcomes.filter(Boolean).length;
    const duplicates = outcomes.filter((v) => !v).length;

    expect(accepted).toBe(1);
    expect(duplicates).toBe(BURST - 1);
    expectSloAtOrBelow('scanner check-in p95', scanP95, SCAN_P95_SLO_MS);

    const refreshed = await ticketRepo.findById(ticket.id);
    expect(refreshed?.status).toBe('checked_in');
    expect(refreshed?.checked_in_by_device_id).toBe(deviceId);
  });

  it('payment success SLO: provider success events process above the production threshold', async () => {
    const ATTEMPTS = 100;
    const outcomes = await Promise.all(
      Array.from({ length: ATTEMPTS }, async (_, index) => {
        const providerEventId = `evt_payment_slo_${ulid()}`;
        const stored = await paymentEventRepo.create({
          tenantId: TENANT_ID,
          provider: 'stripe',
          providerEventId,
          eventType: 'payment_intent.succeeded',
          rawPayload: { id: providerEventId, index, type: 'payment_intent.succeeded' },
          idempotencyKey: providerEventId,
        });
        await paymentEventRepo.markProcessed(stored.id);
        return stored.id;
      }),
    );

    const processed = await db
      .selectFrom('payment_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', TENANT_ID)
      .where('provider', '=', 'stripe')
      .where('event_type', '=', 'payment_intent.succeeded')
      .where('processed_at', 'is not', null)
      .executeTakeFirstOrThrow();

    const successRate = Number(processed.count) / ATTEMPTS;
    expect(outcomes).toHaveLength(ATTEMPTS);
    expect(successRate).toBeGreaterThanOrEqual(PAYMENT_SUCCESS_RATE_SLO);
  });

  it('large export: 100+ attendees are exported correctly into CSV', async () => {
    const ATTENDEE_COUNT = 120;
    const ticketTypeId = await createTicketType(db, await createPool(db, ATTENDEE_COUNT));
    // attendees.order_id has a FK to orders.id; create one real order and link
    // every exported attendee to it.
    const orderId = await createOrder();

    const createdAttendees: { id: string; email: string; firstName: string; lastName: string }[] =
      [];
    for (let i = 0; i < ATTENDEE_COUNT; i++) {
      // eslint-disable-next-line no-await-in-loop -- export load setup persists deterministic attendee rows before measuring the scoped read.
      const row = await attendeeRepo.create({
        tenantId: TENANT_ID,
        orderId,
        eventId: EVENT_ID,
        ticketTypeId,
        email: `load-attendee-${i}@example.com`,
        firstName: `First${i}`,
        lastName: `Last${i}`,
      });
      createdAttendees.push({
        id: row.id,
        email: row.email,
        firstName: row.first_name as string,
        lastName: row.last_name as string,
      });
    }

    // Read attendees the same way the export activity does (tenant + event scoped).
    const rows = await db
      .selectFrom('attendees')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('event_id', '=', EVENT_ID)
      .execute();

    expect(rows).toHaveLength(ATTENDEE_COUNT);

    const exportRows = rows.map((a) => ({
      id: a.id,
      email: a.email,
      firstName: a.first_name,
      lastName: a.last_name,
      phone: a.phone,
      status: a.status,
      eventId: a.event_id,
      orderId: a.order_id,
      checkedInAt: a.checked_in_at,
      createdAt: a.created_at,
    }));

    const csv = toCsv(exportRows);
    const csvLines = csv.split('\n');

    // Header + one row per attendee.
    expect(csvLines).toHaveLength(ATTENDEE_COUNT + 1);
    expect(csvLines[0]).toBe(
      'id,email,firstName,lastName,phone,status,eventId,orderId,checkedInAt,createdAt',
    );

    // Spot-check first and last seeded attendee appear in the export.
    const firstAttendee = createdAttendees[0];
    const lastAttendee = createdAttendees[ATTENDEE_COUNT - 1];
    expect(csv).toContain(firstAttendee.email);
    expect(csv).toContain(lastAttendee.email);
    expect(csv).toContain(firstAttendee.firstName);
    expect(csv).toContain(lastAttendee.lastName);

    // Every seeded email must be present exactly once.
    for (const a of createdAttendees) {
      const occurrences = csv.split(a.email).length - 1;
      expect(occurrences).toBe(1);
    }
  });
});
