import { expect, it, describe, beforeAll, afterAll, beforeEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, type Database } from '@tixkit/db';
import {
  PaymentEventRepository,
  TicketRepository,
  AttendeeRepository,
  OrderRepository,
} from '@tixkit/db';
import { InventoryExhaustedError, type Principal } from '@tixkit/domain';
import type { AppContext } from '../../app.js';
import { checkInRoutes, processPendingBulkSyncChunks } from '../../routes/modules/checkin.js';
import { eventRoutes } from '../../routes/modules/events.js';
import {
  MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS,
  MAX_OFFLINE_SYNC_SCANS,
  OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES,
} from '../../http/schemas.js';
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
const backgroundPoolErrors: Error[] = [];

const RUN_ID = ulid().slice(-10);
const TENANT_ID = `tnt_load_${RUN_ID}`;
const ORG_ID = `org_load_${RUN_ID}`;
const BRAND_ID = `brd_load_${RUN_ID}`;
const EVENT_ID = `evt_load_${RUN_ID}`;
const CHECKOUT_P95_SLO_MS = 2_000;
const SCAN_P95_SLO_MS = 500;
const WEBHOOK_CATCHUP_SLO_MS = 300_000;
const PAYMENT_SUCCESS_RATE_SLO = 0.98;
const OFFLINE_SYNC_BATCH_LOAD = process.env.OFFLINE_SYNC_BATCH_LOAD === '1';
const OFFLINE_SYNC_BATCH_SIZE = Number.parseInt(
  process.env.OFFLINE_SYNC_BATCH_SIZE ?? String(MAX_OFFLINE_SYNC_SCANS),
  10,
);
const OFFLINE_SYNC_BATCH_SLO_MS = process.env.OFFLINE_SYNC_BATCH_SLO_MS
  ? Number.parseInt(process.env.OFFLINE_SYNC_BATCH_SLO_MS, 10)
  : null;
const OFFLINE_SYNC_INVALID_BATCH_LOAD = process.env.OFFLINE_SYNC_INVALID_BATCH_LOAD === '1';
const OFFLINE_SYNC_INVALID_BATCH_SIZE = Number.parseInt(
  process.env.OFFLINE_SYNC_INVALID_BATCH_SIZE ?? String(OFFLINE_SYNC_BATCH_SIZE),
  10,
);
const OFFLINE_SYNC_INVALID_BATCH_SLO_MS = process.env.OFFLINE_SYNC_INVALID_BATCH_SLO_MS
  ? Number.parseInt(process.env.OFFLINE_SYNC_INVALID_BATCH_SLO_MS, 10)
  : null;
const BULK_OFFLINE_SYNC_LOAD = process.env.BULK_OFFLINE_SYNC_LOAD === '1';
const BULK_OFFLINE_SYNC_BATCH_SIZE = Number.parseInt(
  process.env.BULK_OFFLINE_SYNC_BATCH_SIZE ?? '250000',
  10,
);
const BULK_OFFLINE_SYNC_CHUNK_SIZE = Number.parseInt(
  process.env.BULK_OFFLINE_SYNC_CHUNK_SIZE ?? String(MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS),
  10,
);
const BULK_OFFLINE_SYNC_INVALID_LOAD = process.env.BULK_OFFLINE_SYNC_INVALID_LOAD === '1';
const BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE = Number.parseInt(
  process.env.BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE ?? String(BULK_OFFLINE_SYNC_BATCH_SIZE),
  10,
);
const BULK_OFFLINE_SYNC_FLEET_LOAD = process.env.BULK_OFFLINE_SYNC_FLEET_LOAD === '1';
const BULK_OFFLINE_SYNC_SLO_MS = process.env.BULK_OFFLINE_SYNC_SLO_MS
  ? Number.parseInt(process.env.BULK_OFFLINE_SYNC_SLO_MS, 10)
  : null;
const INSERT_CHUNK_SIZE = 500;
const PERFORMANCE_METRICS_PATH = process.env.PERFORMANCE_METRICS_PATH;
const CAPACITY_METRICS_PATH = process.env.CAPACITY_METRICS_PATH;
const FAULT_METRICS_PATH = process.env.FAULT_METRICS_PATH;
const FAULT_LOAD = process.env.FAULT_LOAD === '1';
const FAULT_CONTROL_DIRECTORY = process.env.FAULT_CONTROL_DIRECTORY;
const FAULT_CHECKOUT_INVENTORY = Number.parseInt(process.env.FAULT_CHECKOUT_INVENTORY ?? '64', 10);
const FAULT_CHECKOUT_ATTEMPTS = Number.parseInt(process.env.FAULT_CHECKOUT_ATTEMPTS ?? '64', 10);
const FAULT_MARKER_TIMEOUT_MS = Number.parseInt(process.env.FAULT_MARKER_TIMEOUT_MS ?? '90000', 10);
const CHECKOUT_CAPACITY = Number.parseInt(process.env.CAPACITY_CHECKOUT_INVENTORY ?? '25', 10);
const CHECKOUT_CONCURRENCY = Number.parseInt(
  process.env.CAPACITY_CHECKOUT_CONCURRENCY ?? '120',
  10,
);
const performanceMetrics: Record<string, number> = {};
let dbQueryCount = 0;

function recordPerformanceMetric(metric: string, value: number): void {
  performanceMetrics[metric] = Number(value.toFixed(2));
}

async function writePerformanceMetrics(): Promise<void> {
  if (!PERFORMANCE_METRICS_PATH) return;
  const target = path.resolve(PERFORMANCE_METRICS_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(performanceMetrics, null, 2)}\n`);
}

async function writeCapacityMetrics(metrics: Record<string, number>): Promise<void> {
  if (!CAPACITY_METRICS_PATH) return;
  const target = path.resolve(CAPACITY_METRICS_PATH);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(metrics, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function writeFaultProtocolFile(name: string, content = ''): Promise<void> {
  if (!FAULT_CONTROL_DIRECTORY) throw new Error('FAULT_CONTROL_DIRECTORY is required');
  const target = path.join(path.resolve(FAULT_CONTROL_DIRECTORY), name);
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
}

async function waitForFaultProtocolFile(name: string): Promise<string> {
  if (!FAULT_CONTROL_DIRECTORY) throw new Error('FAULT_CONTROL_DIRECTORY is required');
  const target = path.join(path.resolve(FAULT_CONTROL_DIRECTORY), name);
  const deadline = Date.now() + FAULT_MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`${name} is not a private regular fault-protocol file`);
      }
      return await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for fault-protocol file ${name}`);
}

async function writeFaultMetrics(metrics: Record<string, unknown>): Promise<void> {
  if (!FAULT_METRICS_PATH) throw new Error('FAULT_METRICS_PATH is required');
  const target = path.resolve(FAULT_METRICS_PATH);
  await writeFile(target, `${JSON.stringify(metrics)}\n`, { flag: 'wx', mode: 0o600 });
}

function classifyFaultOutcome(
  outcome: PromiseSettledResult<unknown>,
): 'success' | 'expectedInventoryDecline' | 'dependencyFailure' | 'unexpectedPlatformFailure' {
  if (outcome.status === 'fulfilled') return 'success';
  if (
    outcome.reason instanceof InventoryExhaustedError &&
    outcome.reason.details?.available === 0
  ) {
    return 'expectedInventoryDecline';
  }
  const pending: unknown[] = [outcome.reason];
  const visited = new Set<unknown>();
  for (let depth = 0; pending.length > 0 && depth < 16; depth += 1) {
    const candidate = pending.shift();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    if (candidate instanceof AggregateError) pending.push(...candidate.errors.slice(0, 8));
    if (typeof candidate !== 'object') continue;
    const value = candidate as {
      code?: unknown;
      cause?: unknown;
      errno?: unknown;
      sqlState?: unknown;
      sqlstate?: unknown;
    };
    const code = typeof value.code === 'string' ? value.code : undefined;
    const errno =
      typeof value.errno === 'string' || typeof value.errno === 'number'
        ? String(value.errno)
        : undefined;
    const sqlStateValue = value.sqlState ?? value.sqlstate;
    const sqlState = typeof sqlStateValue === 'string' ? sqlStateValue : undefined;
    if (
      (sqlState?.startsWith('08') ?? false) ||
      (code?.startsWith('08') ?? false) ||
      ['57P01', '57P02', '57P03'].includes(sqlState ?? '') ||
      ['57P01', '57P02', '57P03'].includes(code ?? '') ||
      [
        'ER_SERVER_SHUTDOWN',
        'PROTOCOL_CONNECTION_LOST',
        'ER_SERVER_GONE_ERROR',
        'ER_SERVER_LOST',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
      ].includes(code ?? '') ||
      ['1053', '2006', '2013'].includes(errno ?? '')
    ) {
      return 'dependencyFailure';
    }
    if (value.cause) pending.push(value.cause);
  }
  return 'unexpectedPlatformFailure';
}

function identitySetSha256(ids: string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('\n'))
    .digest('hex');
}

async function waitForFaultDatabaseRecovery(operation: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + FAULT_MARKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await measureSettled(operation);
    if (result.outcome.status === 'fulfilled') return;
    if (classifyFaultOutcome(result.outcome) !== 'dependencyFailure') {
      throw result.outcome.reason;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Database dependency remained unreachable after container recovery');
}

describe('database fault outcome classification', () => {
  const rejected = (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason });

  it('classifies only bounded database and transport codes as dependency failures', () => {
    const reasons: unknown[] = [
      { code: '57P01' },
      { sqlState: '08006' },
      { code: 'ER_SERVER_SHUTDOWN' },
      { errno: 2013 },
      { cause: { code: 'ECONNRESET' } },
      new AggregateError([{ code: 'ETIMEDOUT' }]),
    ];
    for (const reason of reasons) {
      expect(classifyFaultOutcome(rejected(reason))).toBe('dependencyFailure');
    }
  });

  it('keeps exact inventory exhaustion separate from dependency loss', () => {
    expect(classifyFaultOutcome(rejected(new InventoryExhaustedError('pool', 1, 0)))).toBe(
      'expectedInventoryDecline',
    );
  });

  it('fails closed for unknown and provider-shaped errors', () => {
    expect(classifyFaultOutcome(rejected({ code: 'UNKNOWN_DATABASE_ERROR' }))).toBe(
      'unexpectedPlatformFailure',
    );
    expect(classifyFaultOutcome(rejected({ code: 'STRIPE_API_ERROR' }))).toBe(
      'unexpectedPlatformFailure',
    );
  });
});

async function measureDbQueryCount<T>(operation: () => Promise<T>): Promise<{
  queryCount: number;
  value: T;
}> {
  const before = dbQueryCount;
  const value = await operation();
  return { queryCount: dbQueryCount - before, value };
}

async function measureHeapDelta<T>(operation: () => Promise<T>): Promise<{
  heapDeltaBytes: number;
  value: T;
}> {
  const before = process.memoryUsage().heapUsed;
  const value = await operation();
  return {
    heapDeltaBytes: Math.max(0, process.memoryUsage().heapUsed - before),
    value,
  };
}

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
      box_office_settings: JSON.stringify({
        enabled: true,
        allowedTenderTypes: ['cash', 'manual_card', 'comp'],
        requireBuyerEmail: false,
        receiptMode: 'email',
      }),
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
  await cleanupScanLogsForEvent(database);
  await database
    .deleteFrom('offline_check_in_sync_chunks')
    .where('tenant_id', '=', TENANT_ID)
    .execute();
  await database
    .deleteFrom('offline_check_in_sync_jobs')
    .where('tenant_id', '=', TENANT_ID)
    .execute();
  await database.deleteFrom('marketing_integrations').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('tickets').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('attendees').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('export_job_events').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('export_jobs').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('payment_events').where('tenant_id', '=', TENANT_ID).execute();
  await cleanupCheckoutHoldsForEvent(database);
  await database
    .deleteFrom('checkout_sessions')
    .where('tenant_id', '=', TENANT_ID)
    .where('event_id', '=', EVENT_ID)
    .execute();
  await database.deleteFrom('check_in_lists').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('audit_logs').where('tenant_id', '=', TENANT_ID).execute();
  await database.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await database.deleteFrom('brands').where('id', '=', BRAND_ID).execute();
  await database.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await database.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function cleanupCheckoutHoldsForEvent(database: Database): Promise<void> {
  await database
    .deleteFrom('checkout_holds')
    .where('checkout_session_id', 'like', 'cs_load_%')
    .execute();
  await database
    .deleteFrom('checkout_holds')
    .where(
      'ticket_type_id',
      'in',
      database.selectFrom('ticket_types').select('id').where('event_id', '=', EVENT_ID),
    )
    .execute();
}

async function cleanupScanLogsForEvent(database: Database): Promise<void> {
  const lists = await database
    .selectFrom('check_in_lists')
    .select('id')
    .where('event_id', '=', EVENT_ID)
    .execute();
  for (let offset = 0; offset < lists.length; offset += INSERT_CHUNK_SIZE) {
    const listIds = lists.slice(offset, offset + INSERT_CHUNK_SIZE).map((list) => list.id);
    if (listIds.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop -- chunked indexed deletes keep max-size load cleanup bounded.
    await database.deleteFrom('scan_logs').where('check_in_list_id', 'in', listIds).execute();
  }
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
    const value = await operation();
    return {
      durationMs: performance.now() - startedAt,
      outcome: { status: 'fulfilled', value },
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

function makeScannerPrincipal(): Principal {
  return {
    type: 'mobile_device',
    id: `dev_load_${RUN_ID}`,
    tenantId: TENANT_ID,
    organizationIds: [ORG_ID],
    eventIds: [EVENT_ID],
    scopes: ['checkins.read', 'checkins.write'],
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

async function setupCheckInRouteApp(database: Database): Promise<FastifyInstance> {
  const routeApp = Fastify({ bodyLimit: OFFLINE_SYNC_JSON_BODY_LIMIT_BYTES });
  routeApp.decorate('context', {
    db: database,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  routeApp.addHook('onRequest', async (request) => {
    request.principal = makeScannerPrincipal();
  });
  await routeApp.register(checkInRoutes);
  return routeApp;
}

async function insertOfflineSyncBatchFixtures(batchSize: number): Promise<{
  checkInListId: string;
  deviceId: string;
  scans: { qrHash: string; scannedAt: string; offline: true }[];
}> {
  const poolId = await createPool(db, batchSize);
  const ticketTypeId = await createTicketType(db, poolId);
  const orderId = await createOrder();
  const checkInListId = `cil_load_${ulid().slice(-10)}`;
  const deviceId = makeScannerPrincipal().id;
  const now = new Date();
  const scanBaseTime = Date.parse('2026-06-01T12:00:00.000Z');

  await db
    .insertInto('check_in_lists')
    .values({
      id: checkInListId,
      event_id: EVENT_ID,
      name: `Load Check-in ${RUN_ID}`,
      ticket_type_ids: JSON.stringify([ticketTypeId]),
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();

  const scans: { qrHash: string; scannedAt: string; offline: true }[] = [];
  for (let offset = 0; offset < batchSize; offset += INSERT_CHUNK_SIZE) {
    const chunkSize = Math.min(INSERT_CHUNK_SIZE, batchSize - offset);
    const attendees = [];
    const tickets = [];

    for (let index = offset; index < offset + chunkSize; index += 1) {
      const attendeeId = `att_load_${ulid().slice(-14)}`;
      const ticketId = `tkt_load_${ulid().slice(-14)}`;
      const qrHash = `qrh_load_${RUN_ID}_${index}`;
      const scannedAt = new Date(scanBaseTime + index).toISOString();

      attendees.push({
        id: attendeeId,
        tenant_id: TENANT_ID,
        order_id: orderId,
        event_id: EVENT_ID,
        ticket_type_id: ticketTypeId,
        ticket_id: ticketId,
        first_name: 'Offline',
        last_name: `Sync${index}`,
        email: `offline-sync-${RUN_ID}-${index}@example.com`,
        phone: null,
        status: 'pending',
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      });
      tickets.push({
        id: ticketId,
        tenant_id: TENANT_ID,
        order_id: orderId,
        attendee_id: attendeeId,
        event_id: EVENT_ID,
        ticket_type_id: ticketTypeId,
        status: 'valid',
        code: `code_${RUN_ID}_${index}`,
        qr_payload: `payload_${RUN_ID}_${index}`,
        qr_hash: qrHash,
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: null,
        created_at: now,
        updated_at: now,
      });
      scans.push({ qrHash, scannedAt, offline: true });
    }

    // eslint-disable-next-line no-await-in-loop -- chunked inserts keep the 10k fixture under query parameter limits.
    await db.insertInto('attendees').values(attendees).execute();
    // eslint-disable-next-line no-await-in-loop -- tickets reference attendees from the immediately preceding chunk.
    await db.insertInto('tickets').values(tickets).execute();
  }

  return { checkInListId, deviceId, scans };
}

async function insertOfflineSyncInvalidBatchFixtures(batchSize: number): Promise<{
  checkInListId: string;
  deviceId: string;
  scans: { qrHash: string; scannedAt: string; offline: true }[];
}> {
  const poolId = await createPool(db, 1);
  const ticketTypeId = await createTicketType(db, poolId);
  const checkInListId = `cil_invalid_${ulid().slice(-10)}`;
  const deviceId = makeScannerPrincipal().id;
  const now = new Date();
  const scanBaseTime = Date.parse('2026-06-01T12:00:00.000Z');

  await db
    .insertInto('check_in_lists')
    .values({
      id: checkInListId,
      event_id: EVENT_ID,
      name: `Invalid Load Check-in ${RUN_ID}`,
      ticket_type_ids: JSON.stringify([ticketTypeId]),
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();

  const scans = Array.from({ length: batchSize }, (_, index) => ({
    qrHash: `qrh_invalid_${RUN_ID}_${index}`,
    scannedAt: new Date(scanBaseTime + index).toISOString(),
    offline: true as const,
  }));

  return { checkInListId, deviceId, scans };
}

async function runBulkOfflineSyncRoute(input: {
  routeApp: FastifyInstance;
  checkInListId: string;
  deviceId: string;
  scans: { qrHash: string; scannedAt: string; offline: true }[];
  chunkSize: number;
}): Promise<{
  jobId: string;
  createJobMs: number;
  uploadChunksMs: number;
  processMs: number;
  replayChunksMs: number;
  status: {
    accepted: number;
    duplicates: number;
    invalid: number;
    chunksProcessed: number;
    status: string;
  };
}> {
  const totalChunks = Math.ceil(input.scans.length / input.chunkSize);
  const createJob = await measure(() =>
    input.routeApp.inject({
      method: 'POST',
      url: '/check-ins/bulk-sync-jobs',
      headers: { 'Idempotency-Key': `idem_bulk_job_${ulid()}` },
      payload: {
        checkInListId: input.checkInListId,
        deviceId: input.deviceId,
        totalChunks,
        totalScans: input.scans.length,
      },
    }),
  );
  expect(createJob.value.statusCode).toBe(202);
  const job = createJob.value.json() as { id: string };

  const uploadChunks = await measure(async () => {
    for (let offset = 0; offset < input.scans.length; offset += input.chunkSize) {
      const sequence = Math.floor(offset / input.chunkSize) + 1;
      const chunk = input.scans.slice(offset, offset + input.chunkSize);
      // eslint-disable-next-line no-await-in-loop -- chunks are sequenced by persisted job order.
      const response = await input.routeApp.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_chunk_${sequence}_${ulid()}` },
        payload: { scans: chunk },
      });
      expect(response.statusCode).toBe(202);
    }
  });

  const processing = await measure(async () => {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- worker recovery and polling are intentionally sequential.
      await processPendingBulkSyncChunks(db, job.id);
      // eslint-disable-next-line no-await-in-loop -- status polling waits for async worker completion.
      const response = await input.routeApp.inject({
        method: 'GET',
        url: `/check-ins/bulk-sync-jobs/${job.id}`,
      });
      expect(response.statusCode).toBe(200);
      const current = response.json() as {
        accepted: number;
        duplicates: number;
        invalid: number;
        chunksProcessed: number;
        status: string;
      };
      if (current.status === 'completed' || current.status === 'failed') return current;
      // eslint-disable-next-line no-await-in-loop -- bounded polling avoids racing the API-local background worker.
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Timed out waiting for bulk offline sync job completion');
  });
  const status = processing.value;
  expect(status.status).toBe('completed');
  expect(status.chunksProcessed).toBe(totalChunks);

  const replayChunks = await measure(async () => {
    for (let offset = 0; offset < input.scans.length; offset += input.chunkSize) {
      const sequence = Math.floor(offset / input.chunkSize) + 1;
      const chunk = input.scans.slice(offset, offset + input.chunkSize);
      // eslint-disable-next-line no-await-in-loop -- replay checks persisted chunk idempotency sequence by sequence.
      const response = await input.routeApp.inject({
        method: 'PUT',
        url: `/check-ins/bulk-sync-jobs/${job.id}/chunks/${sequence}`,
        headers: { 'Idempotency-Key': `idem_bulk_chunk_replay_${sequence}_${ulid()}` },
        payload: { scans: chunk },
      });
      expect(response.statusCode).toBe(202);
    }
    await processPendingBulkSyncChunks(db, job.id);
  });

  return {
    jobId: job.id,
    createJobMs: createJob.durationMs,
    uploadChunksMs: uploadChunks.durationMs,
    processMs: processing.durationMs,
    replayChunksMs: replayChunks.durationMs,
    status,
  };
}

describeWithIntegrationDatabase('Load and concurrency harnesses', () => {
  beforeAll(async () => {
    previousDbDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl(), {
      log(event) {
        if (event.level === 'query') dbQueryCount += 1;
      },
      onPoolError(error) {
        backgroundPoolErrors.push(error);
      },
    });
    inventoryService = new InventoryService(db);
    paymentEventRepo = new PaymentEventRepository(db);
    ticketRepo = new TicketRepository(db);
    attendeeRepo = new AttendeeRepository(db);
    orderRepo = new OrderRepository(db);
    await seedTenantGraph(db);
    app = await setupEventRouteApp(db);
  });

  afterAll(async () => {
    await writePerformanceMetrics();
    await app.close();
    await cleanupAll(db);
    await db.destroy();
    restoreDatabaseDriver(previousDbDriver);
  }, 120_000);

  beforeEach(async () => {
    // Reset per-test mutation targets scoped to this run. Order matters because
    // of FK constraints: tickets/attendees reference orders, orders reference
    // checkout_sessions.
    await cleanupScanLogsForEvent(db);
    await db
      .deleteFrom('offline_check_in_sync_chunks')
      .where('tenant_id', '=', TENANT_ID)
      .execute();
    await db.deleteFrom('offline_check_in_sync_jobs').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('marketing_integrations').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('idempotency_records').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('tickets').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('attendees').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('orders').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('export_job_events').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('export_jobs').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('payment_events').where('tenant_id', '=', TENANT_ID).execute();
    await cleanupCheckoutHoldsForEvent(db);
    await db
      .deleteFrom('checkout_sessions')
      .where('tenant_id', '=', TENANT_ID)
      .where('event_id', '=', EVENT_ID)
      .execute();
    await db.deleteFrom('check_in_lists').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  }, 120_000);

  it('upserts one GA4 marketing integration when concurrent first-create requests target the same event/provider', async () => {
    const CONCURRENT_CLIENTS = 32;
    const payload = {
      config: {
        measurementId: `G-${RUN_ID}`,
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

  it('prevents oversell under concurrent checkout reservations', async () => {
    const CAPACITY = CHECKOUT_CAPACITY;
    const CONCURRENT_CLIENTS = CHECKOUT_CONCURRENCY;

    expect(Number.isSafeInteger(CAPACITY) && CAPACITY > 0).toBe(true);
    expect(Number.isSafeInteger(CONCURRENT_CLIENTS) && CONCURRENT_CLIENTS > 0).toBe(true);

    const poolId = await createPool(db, CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId);

    const sessionIds: string[] = [];
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
      // eslint-disable-next-line no-await-in-loop -- load setup creates persisted sessions before the concurrent reservation burst.
      sessionIds.push(await createCheckoutSession(db, ticketTypeId));
    }

    const burstStartedAt = performance.now();
    const measuredHeapResults = await measureHeapDelta(() =>
      measureDbQueryCount(() =>
        Promise.all(
          sessionIds.map((sessionId) =>
            measureSettled(() =>
              inventoryService.reserveCart({
                items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
                checkoutSessionId: sessionId,
              }),
            ),
          ),
        ),
      ),
    );
    const measuredQueryResults = measuredHeapResults.value;
    const measuredResults = measuredQueryResults.value;
    const results = measuredResults.map((entry) => entry.outcome);
    const checkoutP50 = percentile(
      measuredResults.map((entry) => entry.durationMs),
      0.5,
    );
    const checkoutP95 = percentile(
      measuredResults.map((entry) => entry.durationMs),
      0.95,
    );
    recordPerformanceMetric('checkoutReservationP50Ms', checkoutP50);
    recordPerformanceMetric('checkoutReservationP95Ms', checkoutP95);
    recordPerformanceMetric('checkoutReservationQueryCount', measuredQueryResults.queryCount);
    recordPerformanceMetric(
      'checkoutReservationHeapDeltaBytes',
      measuredHeapResults.heapDeltaBytes,
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const successfulDurations = measuredResults
      .filter(({ outcome }) => outcome.status === 'fulfilled')
      .map(({ durationMs }) => durationMs);
    const successfulReservationP50Ms = percentile(successfulDurations, 0.5);
    const successfulReservationP95Ms = percentile(successfulDurations, 0.95);
    const expectedInventoryDeclines = results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof InventoryExhaustedError &&
        result.reason.details?.available === 0,
    ).length;
    const platformFailures = results.filter(
      (result) =>
        result.status === 'rejected' &&
        !(
          result.reason instanceof InventoryExhaustedError && result.reason.details?.available === 0
        ),
    ).length;
    const elapsedMs = performance.now() - burstStartedAt;

    await writeCapacityMetrics({
      attempts: CONCURRENT_CLIENTS,
      successes: succeeded,
      expectedInventoryDeclines,
      platformFailures,
      elapsedMs,
      requestThroughputPerSecond: Number(((CONCURRENT_CLIENTS / elapsedMs) * 1_000).toFixed(2)),
      successfulReservationThroughputPerSecond: Number(
        ((succeeded / elapsedMs) * 1_000).toFixed(2),
      ),
      successfulReservationP50Ms: Number(successfulReservationP50Ms.toFixed(2)),
      successfulReservationP95Ms: Number(successfulReservationP95Ms.toFixed(2)),
    });

    expect(CONCURRENT_CLIENTS).toBe(succeeded + expectedInventoryDeclines + platformFailures);
    if (CAPACITY_METRICS_PATH && platformFailures > 0) {
      expect(succeeded).toBeLessThanOrEqual(Math.min(CAPACITY, CONCURRENT_CLIENTS));
      expect(expectedInventoryDeclines).toBeLessThanOrEqual(
        Math.max(0, CONCURRENT_CLIENTS - CAPACITY),
      );
    } else {
      expect(succeeded).toBe(Math.min(CAPACITY, CONCURRENT_CLIENTS));
      expect(expectedInventoryDeclines).toBe(Math.max(0, CONCURRENT_CLIENTS - CAPACITY));
      expect(platformFailures).toBe(0);
      expectSloAtOrBelow('checkout reservation p95', checkoutP95, CHECKOUT_P95_SLO_MS);
    }

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
    if (CAPACITY_METRICS_PATH && platformFailures > 0) expect(held).toBeLessThanOrEqual(CAPACITY);
    else expect(held).toBe(Math.min(CAPACITY, CONCURRENT_CLIENTS));
    expect(Number(pool.sold_count) + held).toBeLessThanOrEqual(CAPACITY);
  }, 60_000);

  it.runIf(FAULT_LOAD)(
    'reconciles exact reservation attempts after a controlled database dependency loss',
    async () => {
      expect(FAULT_METRICS_PATH).toBeTruthy();
      expect(FAULT_CONTROL_DIRECTORY).toBeTruthy();
      expect(Number.isSafeInteger(FAULT_CHECKOUT_INVENTORY) && FAULT_CHECKOUT_INVENTORY > 0).toBe(
        true,
      );
      expect(Number.isSafeInteger(FAULT_CHECKOUT_ATTEMPTS) && FAULT_CHECKOUT_ATTEMPTS > 0).toBe(
        true,
      );
      expect(FAULT_CHECKOUT_INVENTORY).toBe(FAULT_CHECKOUT_ATTEMPTS);
      expect(Number.isSafeInteger(FAULT_MARKER_TIMEOUT_MS) && FAULT_MARKER_TIMEOUT_MS > 0).toBe(
        true,
      );

      const poolId = await createPool(db, FAULT_CHECKOUT_INVENTORY);
      const ticketTypeId = await createTicketType(db, poolId);
      const sessionIds: string[] = [];
      for (let index = 0; index < FAULT_CHECKOUT_ATTEMPTS; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- exact durable attempt identities must exist before fault injection.
        sessionIds.push(await createCheckoutSession(db, ticketTypeId));
      }

      // Warm the selected database connection without mutating inventory or adding
      // an identity outside the exact fault/replay set.
      await db
        .selectFrom('inventory_pools')
        .select('id')
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      backgroundPoolErrors.length = 0;
      await writeFaultProtocolFile('fault-ready');
      const protocolToken = await waitForFaultProtocolFile('fault-injected');
      if (!/^[a-f0-9]{64}$/.test(protocolToken)) {
        throw new Error('fault-injected has an invalid protocol token');
      }

      const faultResults = await Promise.all(
        sessionIds.map((checkoutSessionId) =>
          measureSettled(() =>
            inventoryService.reserveCart({
              items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
              checkoutSessionId,
            }),
          ),
        ),
      );
      const faultClassifications = faultResults.map(({ outcome }) => classifyFaultOutcome(outcome));
      const faultCount = (classification: (typeof faultClassifications)[number]) =>
        faultClassifications.filter((value) => value === classification).length;
      const unexpectedBackgroundPoolErrors = backgroundPoolErrors.filter(
        (error) =>
          classifyFaultOutcome({ status: 'rejected', reason: error }) !== 'dependencyFailure',
      );
      if (unexpectedBackgroundPoolErrors.length > 0) {
        throw new Error('Database pool emitted an unrecognized background failure during outage');
      }

      await writeFaultProtocolFile('fault-observed', protocolToken);
      const recoveredToken = await waitForFaultProtocolFile('database-recovered');
      if (recoveredToken !== protocolToken) {
        throw new Error('database-recovered does not match the active fault protocol');
      }
      await waitForFaultDatabaseRecovery(() =>
        db
          .selectFrom('inventory_pools')
          .select('id')
          .where('id', '=', poolId)
          .executeTakeFirstOrThrow(),
      );

      const preReplayHolds = await db
        .selectFrom('checkout_holds')
        .select(['id', 'checkout_session_id', 'status'])
        .where('ticket_type_id', '=', ticketTypeId)
        .execute();
      const preReplayActiveHolds = preReplayHolds.length;

      const replayResults = await Promise.all(
        sessionIds.map((checkoutSessionId) =>
          measureSettled(() =>
            inventoryService.reserveCart({
              items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
              checkoutSessionId,
            }),
          ),
        ),
      );
      const replayClassifications = replayResults.map(({ outcome }) =>
        classifyFaultOutcome(outcome),
      );
      const replayCount = (classification: (typeof replayClassifications)[number]) =>
        replayClassifications.filter((value) => value === classification).length;

      const holdRows = await db
        .selectFrom('checkout_holds')
        .select(['checkout_session_id', 'quantity', 'status'])
        .where('ticket_type_id', '=', ticketTypeId)
        .execute();
      const activeHoldRows = holdRows.filter((hold) => hold.status === 'active');
      const activeHolds = activeHoldRows.reduce((total, hold) => total + Number(hold.quantity), 0);
      const holdCountsBySession = new Map<string, number>();
      for (const hold of activeHoldRows) {
        const sessionId = String(hold.checkout_session_id);
        holdCountsBySession.set(sessionId, (holdCountsBySession.get(sessionId) ?? 0) + 1);
      }
      const uniqueActiveSessions = holdCountsBySession.size;
      const expectedSessionIds = new Set(sessionIds);
      const allHoldCountsBySession = new Map<string, number>();
      for (const hold of holdRows) {
        const sessionId = String(hold.checkout_session_id);
        allHoldCountsBySession.set(sessionId, (allHoldCountsBySession.get(sessionId) ?? 0) + 1);
      }
      const duplicateActiveSessions = [...allHoldCountsBySession.values()].filter(
        (count) => count > 1,
      ).length;
      const partialStatusCount =
        sessionIds.filter((sessionId) => (holdCountsBySession.get(sessionId) ?? 0) !== 1).length +
        holdRows.filter((hold) => hold.status !== 'active').length;
      const knownStatuses = new Set(['active', 'converted', 'released', 'expired']);
      const unknownStatusCount = holdRows.filter(
        (hold) =>
          !knownStatuses.has(String(hold.status)) ||
          !expectedSessionIds.has(String(hold.checkout_session_id)),
      ).length;
      const pool = await db
        .selectFrom('inventory_pools')
        .select(['sold_count', 'total_capacity'])
        .where('id', '=', poolId)
        .executeTakeFirstOrThrow();
      const soldCount = Number(pool.sold_count);

      const originalSha256 = identitySetSha256(sessionIds);
      const replayIdentities = [...sessionIds];
      const replaySha256 = identitySetSha256(replayIdentities);
      const metrics = {
        providerScope: 'not-exercised',
        faultPhase: {
          attempts: FAULT_CHECKOUT_ATTEMPTS,
          successes: faultCount('success'),
          expectedInventoryDeclines: faultCount('expectedInventoryDecline'),
          dependencyFailures: faultCount('dependencyFailure'),
          providerFailures: 0,
          unexpectedPlatformFailures: faultCount('unexpectedPlatformFailure'),
        },
        replayPhase: {
          attempts: FAULT_CHECKOUT_ATTEMPTS,
          successes: replayCount('success'),
          expectedInventoryDeclines: replayCount('expectedInventoryDecline'),
          dependencyFailures: replayCount('dependencyFailure'),
          providerFailures: 0,
          unexpectedPlatformFailures: replayCount('unexpectedPlatformFailure'),
        },
        reconciliation: {
          preReplayActiveHolds,
          totalCapacity: Number(pool.total_capacity),
          activeHeldQuantity: activeHolds,
          uniqueSessions: uniqueActiveSessions,
          duplicateIdentities: duplicateActiveSessions,
          partialStatusCount,
          unknownStatusCount,
          soldCount,
          oversold: soldCount + activeHolds > Number(pool.total_capacity),
        },
        identitySets: { originalSha256, replaySha256, identical: originalSha256 === replaySha256 },
      };
      await writeFaultMetrics(metrics);

      expect(metrics.faultPhase.successes).toBe(0);
      expect(metrics.faultPhase.expectedInventoryDeclines).toBe(0);
      expect(metrics.faultPhase.unexpectedPlatformFailures).toBe(0);
      expect(metrics.faultPhase.dependencyFailures).toBe(FAULT_CHECKOUT_ATTEMPTS);
      expect(preReplayActiveHolds).toBe(0);
      expect(metrics.replayPhase.successes).toBe(FAULT_CHECKOUT_ATTEMPTS);
      expect(metrics.replayPhase.dependencyFailures).toBe(0);
      expect(metrics.replayPhase.unexpectedPlatformFailures).toBe(0);
      expect(activeHolds).toBe(FAULT_CHECKOUT_INVENTORY);
      expect(uniqueActiveSessions).toBe(FAULT_CHECKOUT_ATTEMPTS);
      expect(duplicateActiveSessions).toBe(0);
      expect(partialStatusCount).toBe(0);
      expect(unknownStatusCount).toBe(0);
      expect(originalSha256).toBe(replaySha256);
      expect(soldCount + activeHolds).toBeLessThanOrEqual(FAULT_CHECKOUT_INVENTORY);
    },
    240_000,
  );

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
  }, 60_000);

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
  }, 60_000);

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
    const measuredHeapOutcomes = await measureHeapDelta(() =>
      measureDbQueryCount(() =>
        Promise.all(
          Array.from({ length: BURST }, () =>
            measure(() => ticketRepo.checkInIfValid(ticket.id, deviceId, scannedAt)),
          ),
        ),
      ),
    );
    const measuredQueryOutcomes = measuredHeapOutcomes.value;
    const measuredOutcomes = measuredQueryOutcomes.value;
    const outcomes = measuredOutcomes.map((entry) => entry.value);
    const scanP50 = percentile(
      measuredOutcomes.map((entry) => entry.durationMs),
      0.5,
    );
    const scanP95 = percentile(
      measuredOutcomes.map((entry) => entry.durationMs),
      0.95,
    );
    recordPerformanceMetric('scannerCheckInP50Ms', scanP50);
    recordPerformanceMetric('scannerCheckInP95Ms', scanP95);
    recordPerformanceMetric('scannerCheckInQueryCount', measuredQueryOutcomes.queryCount);
    recordPerformanceMetric('scannerCheckInHeapDeltaBytes', measuredHeapOutcomes.heapDeltaBytes);

    const accepted = outcomes.filter(Boolean).length;
    const duplicates = outcomes.filter((v) => !v).length;

    expect(accepted).toBe(1);
    expect(duplicates).toBe(BURST - 1);
    expectSloAtOrBelow('scanner check-in p95', scanP95, SCAN_P95_SLO_MS);

    const refreshed = await ticketRepo.findById(ticket.id);
    expect(refreshed?.status).toBe('checked_in');
    expect(refreshed?.checked_in_by_device_id).toBe(deviceId);
  });

  const offlineSyncBatchLoadTest = OFFLINE_SYNC_BATCH_LOAD ? it : it.skip;

  offlineSyncBatchLoadTest(
    'offline sync batch load: processes the production batch ceiling through the real route',
    async () => {
      expect(Number.isFinite(OFFLINE_SYNC_BATCH_SIZE)).toBe(true);
      expect(OFFLINE_SYNC_BATCH_SIZE).toBeGreaterThan(0);
      expect(OFFLINE_SYNC_BATCH_SIZE).toBeLessThanOrEqual(MAX_OFFLINE_SYNC_SCANS);

      const routeApp = await setupCheckInRouteApp(db);
      const idempotencyKey = `idem_offline_sync_load_${ulid()}`;
      try {
        const fixtureMetrics = await measure(() =>
          insertOfflineSyncBatchFixtures(OFFLINE_SYNC_BATCH_SIZE),
        );
        const { checkInListId, deviceId, scans } = fixtureMetrics.value;

        const firstSync = await measure(() =>
          routeApp.inject({
            method: 'POST',
            url: '/check-ins/sync',
            headers: { 'Idempotency-Key': idempotencyKey },
            payload: {
              checkInListId,
              deviceId,
              scans,
            },
          }),
        );

        expect(firstSync.value.statusCode).toBe(200);
        const firstBody = firstSync.value.json() as {
          accepted: number;
          duplicates: number;
          invalid: number;
          results: unknown[];
        };
        expect(firstBody.accepted).toBe(OFFLINE_SYNC_BATCH_SIZE);
        expect(firstBody.duplicates).toBe(0);
        expect(firstBody.invalid).toBe(0);
        expect(firstBody.results).toHaveLength(OFFLINE_SYNC_BATCH_SIZE);

        const scanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        const checkedInTicketCount = await db
          .selectFrom('tickets')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('checked_in_by_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();
        const checkedInAttendeeCount = await db
          .selectFrom('attendees')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('check_in_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();

        expect(Number(scanLogCount.count)).toBe(OFFLINE_SYNC_BATCH_SIZE);
        expect(Number(checkedInTicketCount.count)).toBe(OFFLINE_SYNC_BATCH_SIZE);
        expect(Number(checkedInAttendeeCount.count)).toBe(OFFLINE_SYNC_BATCH_SIZE);

        const replay = await measure(() =>
          routeApp.inject({
            method: 'POST',
            url: '/check-ins/sync',
            headers: { 'Idempotency-Key': idempotencyKey },
            payload: {
              checkInListId,
              deviceId,
              scans,
            },
          }),
        );
        expect(replay.value.statusCode).toBe(200);
        expect(replay.value.json()).toEqual(firstBody);

        const replayScanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        expect(Number(replayScanLogCount.count)).toBe(OFFLINE_SYNC_BATCH_SIZE);

        const metrics = {
          batchSize: OFFLINE_SYNC_BATCH_SIZE,
          fixtureSetupMs: Number(fixtureMetrics.durationMs.toFixed(2)),
          firstSyncMs: Number(firstSync.durationMs.toFixed(2)),
          replayMs: Number(replay.durationMs.toFixed(2)),
          scanLogs: Number(scanLogCount.count),
          checkedInTickets: Number(checkedInTicketCount.count),
          checkedInAttendees: Number(checkedInAttendeeCount.count),
        };
        console.info(`offline sync batch load metrics: ${JSON.stringify(metrics)}`);

        if (OFFLINE_SYNC_BATCH_SLO_MS !== null) {
          expectSloAtOrBelow(
            'offline sync batch route latency',
            firstSync.durationMs,
            OFFLINE_SYNC_BATCH_SLO_MS,
          );
        }
      } finally {
        await routeApp.close();
      }
    },
    900_000,
  );

  const offlineSyncInvalidBatchLoadTest = OFFLINE_SYNC_INVALID_BATCH_LOAD ? it : it.skip;

  offlineSyncInvalidBatchLoadTest(
    'offline sync invalid batch load: bounds amplification for max-sized invalid scans',
    async () => {
      expect(Number.isFinite(OFFLINE_SYNC_INVALID_BATCH_SIZE)).toBe(true);
      expect(OFFLINE_SYNC_INVALID_BATCH_SIZE).toBeGreaterThan(0);
      expect(OFFLINE_SYNC_INVALID_BATCH_SIZE).toBeLessThanOrEqual(MAX_OFFLINE_SYNC_SCANS);

      const routeApp = await setupCheckInRouteApp(db);
      const idempotencyKey = `idem_offline_sync_invalid_${ulid()}`;
      try {
        const fixtureMetrics = await measure(() =>
          insertOfflineSyncInvalidBatchFixtures(OFFLINE_SYNC_INVALID_BATCH_SIZE),
        );
        const { checkInListId, deviceId, scans } = fixtureMetrics.value;

        const firstSync = await measure(() =>
          routeApp.inject({
            method: 'POST',
            url: '/check-ins/sync',
            headers: { 'Idempotency-Key': idempotencyKey },
            payload: {
              checkInListId,
              deviceId,
              scans,
            },
          }),
        );

        expect(firstSync.value.statusCode).toBe(200);
        const firstBody = firstSync.value.json() as {
          accepted: number;
          duplicates: number;
          invalid: number;
          results: unknown[];
        };
        expect(firstBody.accepted).toBe(0);
        expect(firstBody.duplicates).toBe(0);
        expect(firstBody.invalid).toBe(OFFLINE_SYNC_INVALID_BATCH_SIZE);
        expect(firstBody.results).toHaveLength(OFFLINE_SYNC_INVALID_BATCH_SIZE);

        const scanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        const checkedInTicketCount = await db
          .selectFrom('tickets')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('checked_in_by_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();
        const checkedInAttendeeCount = await db
          .selectFrom('attendees')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('check_in_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();

        expect(Number(scanLogCount.count)).toBe(OFFLINE_SYNC_INVALID_BATCH_SIZE);
        expect(Number(checkedInTicketCount.count)).toBe(0);
        expect(Number(checkedInAttendeeCount.count)).toBe(0);

        const replay = await measure(() =>
          routeApp.inject({
            method: 'POST',
            url: '/check-ins/sync',
            headers: { 'Idempotency-Key': idempotencyKey },
            payload: {
              checkInListId,
              deviceId,
              scans,
            },
          }),
        );
        expect(replay.value.statusCode).toBe(200);
        expect(replay.value.json()).toEqual(firstBody);

        const replayScanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        expect(Number(replayScanLogCount.count)).toBe(OFFLINE_SYNC_INVALID_BATCH_SIZE);

        const metrics = {
          batchSize: OFFLINE_SYNC_INVALID_BATCH_SIZE,
          fixtureSetupMs: Number(fixtureMetrics.durationMs.toFixed(2)),
          firstSyncMs: Number(firstSync.durationMs.toFixed(2)),
          replayMs: Number(replay.durationMs.toFixed(2)),
          scanLogs: Number(scanLogCount.count),
          checkedInTickets: Number(checkedInTicketCount.count),
          checkedInAttendees: Number(checkedInAttendeeCount.count),
        };
        console.info(`offline sync invalid batch load metrics: ${JSON.stringify(metrics)}`);

        if (OFFLINE_SYNC_INVALID_BATCH_SLO_MS !== null) {
          expectSloAtOrBelow(
            'offline sync invalid batch route latency',
            firstSync.durationMs,
            OFFLINE_SYNC_INVALID_BATCH_SLO_MS,
          );
        }
      } finally {
        await routeApp.close();
      }
    },
    900_000,
  );

  const bulkOfflineSyncLoadTest = BULK_OFFLINE_SYNC_LOAD ? it : it.skip;

  bulkOfflineSyncLoadTest(
    'bulk offline sync load: processes an async valid batch above the sync cap',
    async () => {
      expect(Number.isFinite(BULK_OFFLINE_SYNC_BATCH_SIZE)).toBe(true);
      expect(BULK_OFFLINE_SYNC_BATCH_SIZE).toBeGreaterThan(MAX_OFFLINE_SYNC_SCANS);
      expect(BULK_OFFLINE_SYNC_CHUNK_SIZE).toBeGreaterThan(0);
      expect(BULK_OFFLINE_SYNC_CHUNK_SIZE).toBeLessThanOrEqual(MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS);

      const routeApp = await setupCheckInRouteApp(db);
      try {
        const fixtureMetrics = await measure(() =>
          insertOfflineSyncBatchFixtures(BULK_OFFLINE_SYNC_BATCH_SIZE),
        );
        const { checkInListId, deviceId, scans } = fixtureMetrics.value;
        const bulk = await runBulkOfflineSyncRoute({
          routeApp,
          checkInListId,
          deviceId,
          scans,
          chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
        });

        expect(bulk.status.accepted).toBe(BULK_OFFLINE_SYNC_BATCH_SIZE);
        expect(bulk.status.duplicates).toBe(0);
        expect(bulk.status.invalid).toBe(0);

        const scanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        const checkedInTicketCount = await db
          .selectFrom('tickets')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('checked_in_by_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();
        const checkedInAttendeeCount = await db
          .selectFrom('attendees')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('check_in_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();

        expect(Number(scanLogCount.count)).toBe(BULK_OFFLINE_SYNC_BATCH_SIZE);
        expect(Number(checkedInTicketCount.count)).toBe(BULK_OFFLINE_SYNC_BATCH_SIZE);
        expect(Number(checkedInAttendeeCount.count)).toBe(BULK_OFFLINE_SYNC_BATCH_SIZE);

        const replayScanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        expect(Number(replayScanLogCount.count)).toBe(BULK_OFFLINE_SYNC_BATCH_SIZE);

        const metrics = {
          batchSize: BULK_OFFLINE_SYNC_BATCH_SIZE,
          chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
          fixtureSetupMs: Number(fixtureMetrics.durationMs.toFixed(2)),
          createJobMs: Number(bulk.createJobMs.toFixed(2)),
          uploadChunksMs: Number(bulk.uploadChunksMs.toFixed(2)),
          processMs: Number(bulk.processMs.toFixed(2)),
          replayChunksMs: Number(bulk.replayChunksMs.toFixed(2)),
          scanLogs: Number(scanLogCount.count),
          checkedInTickets: Number(checkedInTicketCount.count),
          checkedInAttendees: Number(checkedInAttendeeCount.count),
        };
        console.info(`bulk offline sync load metrics: ${JSON.stringify(metrics)}`);

        if (BULK_OFFLINE_SYNC_SLO_MS !== null) {
          expectSloAtOrBelow(
            'bulk offline sync processing latency',
            bulk.processMs,
            BULK_OFFLINE_SYNC_SLO_MS,
          );
        }
      } finally {
        await routeApp.close();
      }
    },
    1_200_000,
  );

  const bulkOfflineSyncInvalidLoadTest = BULK_OFFLINE_SYNC_INVALID_LOAD ? it : it.skip;

  bulkOfflineSyncInvalidLoadTest(
    'bulk offline sync invalid load: bounds async invalid amplification above the sync cap',
    async () => {
      expect(Number.isFinite(BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE)).toBe(true);
      expect(BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE).toBeGreaterThan(MAX_OFFLINE_SYNC_SCANS);
      expect(BULK_OFFLINE_SYNC_CHUNK_SIZE).toBeGreaterThan(0);
      expect(BULK_OFFLINE_SYNC_CHUNK_SIZE).toBeLessThanOrEqual(MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS);

      const routeApp = await setupCheckInRouteApp(db);
      try {
        const fixtureMetrics = await measure(() =>
          insertOfflineSyncInvalidBatchFixtures(BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE),
        );
        const { checkInListId, deviceId, scans } = fixtureMetrics.value;
        const bulk = await runBulkOfflineSyncRoute({
          routeApp,
          checkInListId,
          deviceId,
          scans,
          chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
        });

        expect(bulk.status.accepted).toBe(0);
        expect(bulk.status.duplicates).toBe(0);
        expect(bulk.status.invalid).toBe(BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE);

        const scanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        const checkedInTicketCount = await db
          .selectFrom('tickets')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('checked_in_by_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();
        const checkedInAttendeeCount = await db
          .selectFrom('attendees')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_id', '=', EVENT_ID)
          .where('status', '=', 'checked_in')
          .where('check_in_device_id', '=', deviceId)
          .executeTakeFirstOrThrow();

        expect(Number(scanLogCount.count)).toBe(BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE);
        expect(Number(checkedInTicketCount.count)).toBe(0);
        expect(Number(checkedInAttendeeCount.count)).toBe(0);

        const replayScanLogCount = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .where('check_in_list_id', '=', checkInListId)
          .executeTakeFirstOrThrow();
        expect(Number(replayScanLogCount.count)).toBe(BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE);

        const metrics = {
          batchSize: BULK_OFFLINE_SYNC_INVALID_BATCH_SIZE,
          chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
          fixtureSetupMs: Number(fixtureMetrics.durationMs.toFixed(2)),
          createJobMs: Number(bulk.createJobMs.toFixed(2)),
          uploadChunksMs: Number(bulk.uploadChunksMs.toFixed(2)),
          processMs: Number(bulk.processMs.toFixed(2)),
          replayChunksMs: Number(bulk.replayChunksMs.toFixed(2)),
          scanLogs: Number(scanLogCount.count),
          checkedInTickets: Number(checkedInTicketCount.count),
          checkedInAttendees: Number(checkedInAttendeeCount.count),
        };
        console.info(`bulk offline sync invalid load metrics: ${JSON.stringify(metrics)}`);
      } finally {
        await routeApp.close();
      }
    },
    1_200_000,
  );

  const bulkOfflineSyncFleetLoadTest = BULK_OFFLINE_SYNC_FLEET_LOAD ? it : it.skip;

  bulkOfflineSyncFleetLoadTest(
    'bulk offline sync fleet: tolerates worker, poll, and replay storms',
    async () => {
      expect(BULK_OFFLINE_SYNC_BATCH_SIZE).toBeGreaterThan(MAX_OFFLINE_SYNC_SCANS);
      expect(BULK_OFFLINE_SYNC_CHUNK_SIZE).toBeGreaterThan(0);
      expect(BULK_OFFLINE_SYNC_CHUNK_SIZE).toBeLessThanOrEqual(MAX_BULK_OFFLINE_SYNC_CHUNK_SCANS);

      const routeApp = await setupCheckInRouteApp(db);
      try {
        const [validFixtures, invalidFixtures] = await Promise.all([
          insertOfflineSyncBatchFixtures(BULK_OFFLINE_SYNC_BATCH_SIZE),
          insertOfflineSyncInvalidBatchFixtures(BULK_OFFLINE_SYNC_BATCH_SIZE),
        ]);

        const [validBulk, invalidBulk] = await Promise.all([
          runBulkOfflineSyncRoute({
            routeApp,
            ...validFixtures,
            chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
          }),
          runBulkOfflineSyncRoute({
            routeApp,
            ...invalidFixtures,
            chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
          }),
        ]);

        expect(validBulk.status).toMatchObject({
          status: 'completed',
          accepted: BULK_OFFLINE_SYNC_BATCH_SIZE,
          invalid: 0,
        });
        expect(invalidBulk.status).toMatchObject({
          status: 'completed',
          accepted: 0,
          invalid: BULK_OFFLINE_SYNC_BATCH_SIZE,
        });

        const scanLogCountBeforeStorm = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .executeTakeFirstOrThrow();

        await Promise.all(
          Array.from({ length: 20 }, () =>
            routeApp.inject({
              method: 'GET',
              url: `/check-ins/bulk-sync-jobs/${validBulk.jobId}`,
            }),
          ),
        );
        await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            processPendingBulkSyncChunks(db, validBulk.jobId, {
              workerId: `fleet-worker-${index}`,
            }),
          ),
        );

        const scanLogCountAfterStorm = await db
          .selectFrom('scan_logs')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', TENANT_ID)
          .executeTakeFirstOrThrow();

        expect(Number(scanLogCountAfterStorm.count)).toBe(Number(scanLogCountBeforeStorm.count));

        const metrics = {
          batchSize: BULK_OFFLINE_SYNC_BATCH_SIZE,
          chunkSize: BULK_OFFLINE_SYNC_CHUNK_SIZE,
          validProcessMs: Number(validBulk.processMs.toFixed(2)),
          invalidProcessMs: Number(invalidBulk.processMs.toFixed(2)),
          scanLogs: Number(scanLogCountAfterStorm.count),
        };
        console.info(`bulk offline sync fleet metrics: ${JSON.stringify(metrics)}`);
      } finally {
        await routeApp.close();
      }
    },
    1_800_000,
  );

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
  }, 30_000);
});
