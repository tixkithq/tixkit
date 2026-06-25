import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../../app.js';
import { ClerkAuthService } from '../../auth/clerk.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';

/**
 * Cross-tenant denial tests (T04/T43).
 *
 * These tests verify that a principal from tenant A cannot read or mutate
 * resources belonging to tenant B, that API keys cannot exceed their assigned
 * scopes, that revoked/expired API keys are rejected, and that cross-organization
 * and cross-event access is denied for users without the required scope.
 *
 * The tests use a mocked Kysely DB that filters rows by the `where` clauses
 * emitted by the route handlers, so no real database is required.
 */

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createMockDb(tables: Tables = {}): unknown {
  function matchesWheres(row: Row, wheres: Array<{ column: string; op: string; value: unknown }>): boolean {
    for (const w of wheres) {
      const val = row[w.column];
      if (w.op === '=') {
        if (val !== w.value) return false;
      } else if (w.op === 'in') {
        if (!Array.isArray(w.value) || !w.value.includes(val)) return false;
      } else if (w.op === '>') {
        if (val == null || !(String(val) > String(w.value))) return false;
      } else if (w.op === 'is') {
        // `is null` semantics
        if (w.value === null) {
          if (val !== null && val !== undefined) return false;
        }
      }
      // Other operators (like, >=, <=) are not needed for these denial tests.
    }
    return true;
  }

  function createQuery(table: string) {
    const wheres: Array<{ column: string; op: string; value: unknown }> = [];
    const q = {
      select() {
        return q;
      },
      selectAll() {
        return q;
      },
      innerJoin() {
        return q;
      },
      where(column: string, op: string, value: unknown) {
        wheres.push({ column, op, value });
        return q;
      },
      orderBy() {
        return q;
      },
      limit() {
        return q;
      },
      forUpdate() {
        return q;
      },
      fn: {
        sum: () => 'sum',
        countAll: () => 'count',
      },
      async executeTakeFirst() {
        const rows = (tables[table] ?? []).filter((r) => matchesWheres(r, wheres));
        return rows[0];
      },
      async executeTakeFirstOrThrow() {
        const rows = (tables[table] ?? []).filter((r) => matchesWheres(r, wheres));
        if (!rows[0]) throw new Error(`No mock row for ${table}`);
        return rows[0];
      },
      async execute() {
        return (tables[table] ?? []).filter((r) => matchesWheres(r, wheres));
      },
    };
    return q;
  }

  function createUpdate(table: string) {
    return {
      set(values: Row) {
        const rows = tables[table] ?? [];
        if (rows[0]) Object.assign(rows[0], values);
        return {
          where() {
            return {
              returningAll() {
                return {
                  executeTakeFirstOrThrow: async () => rows[0] ?? { id: 'updated', ...values },
                };
              },
              execute: async () => [],
            };
          },
        };
      },
    };
  }

  function createInsert(table: string) {
    return {
      values(vals: Row) {
        const row = { id: 'new_1', ...vals };
        return {
          returningAll() {
            return {
              executeTakeFirstOrThrow: async () => {
                (tables[table] ??= []).push(row);
                return row;
              },
            };
          },
          execute: async () => {
            (tables[table] ??= []).push(row);
          },
        };
      },
    };
  }

  function createDelete(_table: string) {
    return {
      where() {
        return { execute: async () => {} };
      },
    };
  }

  return {
    selectFrom: createQuery,
    updateTable: createUpdate,
    insertInto: createInsert,
    deleteFrom: createDelete,
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn({}),
    }),
    destroy: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: [
      'events.read',
      'events.write',
      'orders.read',
      'orders.write',
      'refunds.write',
      'reports.read',
      'attendees.read',
      'attendees.write',
      'checkins.read',
      'checkins.write',
      'messages.write',
      'settings.write',
      'billing.write',
      'developers.write',
    ],
    ...overrides,
  };
}

function eventRow(overrides: Row = {}): Row {
  return {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    slug: 'evt',
    title: 'Event',
    status: 'published',
    timezone: 'UTC',
    starts_at: new Date('2026-06-01'),
    ends_at: null,
    visibility: 'public',
    seo: '{}',
    capacity: null,
    description: null,
    venue: null,
    cover_image_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function orderRow(overrides: Row = {}): Row {
  return {
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
    ...overrides,
  };
}

function attendeeRow(overrides: Row = {}): Row {
  return {
    id: 'att_1',
    tenant_id: 'tnt_1',
    order_id: 'ord_1',
    event_id: 'evt_1',
    ticket_type_id: 'tt_1',
    ticket_id: 'tkt_1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@test.com',
    phone: null,
    status: 'confirmed',
    custom_answers: null,
    checked_in_at: null,
    check_in_device_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function ticketRow(overrides: Row = {}): Row {
  return {
    id: 'tkt_1',
    tenant_id: 'tnt_1',
    event_id: 'evt_1',
    ticket_type_id: 'tt_1',
    attendee_id: 'att_1',
    qr_hash: 'hash_1',
    status: 'valid',
    transferred_to_email: null,
    transferred_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function checkInListRow(overrides: Row = {}): Row {
  return {
    id: 'cil_1',
    tenant_id: 'tnt_1',
    event_id: 'evt_1',
    name: 'Main list',
    status: 'active',
    ticket_type_ids: '[]',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function brandRow(overrides: Row = {}): Row {
  return {
    id: 'brd_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    name: 'Brand1',
    slug: 'brand1',
    status: 'active',
    theme: '{}',
    white_label: false,
    legal_urls: '{}',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function webhookEndpointRow(overrides: Row = {}): Row {
  return {
    id: 'wh_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    url: 'https://example.com/webhooks',
    secret: 'secret',
    events: JSON.stringify(['order.paid']),
    status: 'active',
    description: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function webhookEventRow(overrides: Row = {}): Row {
  return {
    id: 'we_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    type: 'order.paid',
    payload: JSON.stringify({ orderId: 'ord_1' }),
    status: 'pending',
    created_at: new Date(),
    ...overrides,
  };
}

function apiKeyRow(overrides: Row = {}): Row {
  return {
    id: 'ak_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    name: 'Server key',
    key_prefix: 'gk_1234',
    hashed_key: 'hash',
    scopes: JSON.stringify(['events.read']),
    brand_ids: null,
    event_ids: null,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function scannerDeviceRow(overrides: Row = {}): Row {
  return {
    id: 'sd_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    name: 'Scanner',
    device_id: 'dev_1',
    hashed_secret: 'hash',
    event_ids: null,
    status: 'active',
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function exportJobRow(overrides: Row = {}): Row {
  return {
    id: 'exp_1',
    tenant_id: 'tnt_1',
    event_id: 'evt_1',
    type: 'sales',
    format: 'csv',
    status: 'completed',
    file_url: 'https://exports.example.test/exp_1.csv',
    requested_by: 'usr_1',
    filters: null,
    created_at: new Date('2026-06-01'),
    completed_at: new Date('2026-06-01'),
    ...overrides,
  };
}

async function setupApp(
  routes: unknown,
  principal: Principal,
  tables: Tables = {},
  contextOverrides: Record<string, unknown> = {},
) {
  const app = Fastify();
  const context = {
    db: createMockDb(tables) as unknown as Database,
    pricingEngine: {
      calculate: () => ({
        currency: 'USD',
        totalCents: 0,
        subtotalCents: 0,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        lineItems: [],
      }),
    },
    inventoryService: { reserveCart: () => ({ primaryHoldId: 'hld_1', expiresAt: new Date() }) },
    qrService: {
      hashPayload: () => 'hash_1',
      getQrPayload: () => ({ valid: true, ticketId: 'tkt_1' }),
    },
    authService: {},
    temporalClient: {
      startRefund: vi.fn(),
      startExport: vi.fn(),
      startNotificationDelivery: vi.fn(),
      startSmsDelivery: vi.fn(),
      startCheckoutSession: vi.fn(),
      startWebhookDelivery: vi.fn(),
      getCheckoutState: vi.fn(),
    },
    ...contextOverrides,
  };
  app.decorate('context', context as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  // @ts-expect-error: register accepts a FastifyPluginAsync; tests pass route modules.
  await app.register(routes);
  return app;
}

// ===========================================================================
// 1. Cross-tenant denial (principal in tnt_1 cannot touch tnt_other resources)
// ===========================================================================

describe('cross-tenant denial', () => {
  const principal = makePrincipal();

  it('GET /events/:eventId returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /events/:eventId returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: { title: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /events/:eventId/publish returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'POST', url: '/events/evt_1/publish' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /orders/:orderId returns 404 for order in another tenant', async () => {
    const tables: Tables = { orders: [orderRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(orderRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/orders/ord_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /orders/:orderId/refunds returns 404 for order in another tenant', async () => {
    const tables: Tables = { orders: [orderRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(orderRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/refunds',
      headers: { 'idempotency-key': 'key-x-tenant' },
      payload: { reason: 'Customer request', amountCents: 5000 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /attendees/:attendeeId returns 404 for attendee in another tenant', async () => {
    const tables: Tables = {
      attendees: [attendeeRow({ tenant_id: 'tnt_other', event_id: 'evt_other' })],
      events: [eventRow({ id: 'evt_other', tenant_id: 'tnt_other' })],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/attendees/att_1',
      payload: { firstName: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /tickets/:ticketId/transfer returns 404 for ticket in another tenant', async () => {
    const tables: Tables = {
      tickets: [ticketRow({ tenant_id: 'tnt_other', event_id: 'evt_other' })],
      events: [eventRow({ id: 'evt_other', tenant_id: 'tnt_other' })],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/tickets/tkt_1/transfer',
      headers: { 'idempotency-key': 'key-x-transfer' },
      payload: { toEmail: 'new@test.com' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /check-ins/scan returns 404 for active list in another tenant', async () => {
    const tables: Tables = {
      check_in_lists: [checkInListRow({ tenant_id: 'tnt_other', event_id: 'evt_other' })],
      events: [eventRow({ id: 'evt_other', tenant_id: 'tnt_other' })],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/check-ins/scan',
      payload: {
        checkInListId: 'cil_1',
        qrPayload: 'payload',
        scannedAt: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /events/:eventId/check-in-lists/:listId/manifest returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({
      method: 'GET',
      url: '/events/evt_1/check-in-lists/cil_1/manifest',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /brands/:brandId returns 404 for brand in another tenant', async () => {
    const tables: Tables = { brands: [brandRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /webhook-endpoints/:endpointId returns 404 for endpoint in another tenant', async () => {
    const tables: Tables = { webhook_endpoints: [webhookEndpointRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(webhookRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/webhook-endpoints/wh_1',
      payload: { url: 'https://evil.example.com/hook' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /webhook-events/:eventId/replay returns 404 for event in another tenant', async () => {
    const tables: Tables = { webhook_events: [webhookEventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(webhookRoutes, principal, tables);
    const res = await app.inject({ method: 'POST', url: '/webhook-events/we_1/replay' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE /api-keys/:keyId returns 404 for key in another tenant', async () => {
    const tables: Tables = { api_keys: [apiKeyRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'DELETE', url: '/api-keys/ak_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /scanner-devices/:deviceId/revoke returns 404 for device in another tenant', async () => {
    const tables: Tables = {
      scanner_devices: [scannerDeviceRow({ tenant_id: 'tnt_other', device_id: 'dev_other' })],
    };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'POST', url: '/scanner-devices/dev_other/revoke' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /exports/:exportId/download returns 404 for export in another tenant', async () => {
    const tables: Tables = { export_jobs: [exportJobRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(reportingRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/exports/exp_1/download' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /events/:eventId/reports/sales returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(reportingRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/reports/sales' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /events/:eventId/messages returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(messagingRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'idempotency-key': 'key-x-msg' },
      payload: { templateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ===========================================================================
// 2. Cross-organization denial (same tenant, different org)
// ===========================================================================

describe('cross-organization denial (same tenant)', () => {
  const principal = makePrincipal({ organizationIds: ['org_A'] });

  it('PATCH /webhook-endpoints/:endpointId returns 404 for endpoint in another organization', async () => {
    const tables: Tables = {
      webhook_endpoints: [webhookEndpointRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(webhookRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/webhook-endpoints/wh_1',
      payload: { url: 'https://evil.example.com/hook' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE /api-keys/:keyId returns 404 for key in another organization', async () => {
    const tables: Tables = { api_keys: [apiKeyRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })] };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'DELETE', url: '/api-keys/ak_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /scanner-devices/:deviceId/revoke returns 404 for device in another organization', async () => {
    const tables: Tables = {
      scanner_devices: [scannerDeviceRow({ tenant_id: 'tnt_1', organization_id: 'org_B', device_id: 'dev_B' })],
    };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'POST', url: '/scanner-devices/dev_B/revoke' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /webhook-events/:eventId/replay returns 404 for event in another organization', async () => {
    const tables: Tables = {
      webhook_events: [webhookEventRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(webhookRoutes, principal, tables);
    const res = await app.inject({ method: 'POST', url: '/webhook-events/we_1/replay' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /webhook-endpoints only returns endpoints in the principal organization', async () => {
    const tables: Tables = {
      webhook_endpoints: [
        webhookEndpointRow({ id: 'wh_A', tenant_id: 'tnt_1', organization_id: 'org_A' }),
        webhookEndpointRow({ id: 'wh_B', tenant_id: 'tnt_1', organization_id: 'org_B' }),
      ],
    };
    const app = await setupApp(webhookRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/webhook-endpoints' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('wh_A');
    await app.close();
  });

  it('GET /events?organizationId=otherOrg returns no rows for an org outside principal scope', async () => {
    const tables: Tables = {
      events: [
        eventRow({ id: 'evt_A', tenant_id: 'tnt_1', organization_id: 'org_A' }),
        eventRow({ id: 'evt_B', tenant_id: 'tnt_1', organization_id: 'org_B' }),
      ],
    };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events?organizationId=org_B' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(0);
    await app.close();
  });
});

// ===========================================================================
// 3. Brand / event scope denial (scoped API keys)
// ===========================================================================

describe('brand and event scope denial', () => {
  it('GET /events/:eventId returns 404 for brand-scoped key accessing other brand event', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_1', brand_id: 'brd_B' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /events/:eventId returns 404 for event-scoped key accessing other event', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_scoped',
      eventIds: ['evt_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = { events: [eventRow({ id: 'evt_B', tenant_id: 'tnt_1' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_B' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /check-ins/scan returns 404 for event-scoped scanner on other event', async () => {
    const principal = makePrincipal({
      type: 'mobile_device',
      id: 'sd_scoped',
      eventIds: ['evt_A'],
      scopes: ['checkins.read', 'checkins.write'],
    });
    const tables: Tables = {
      check_in_lists: [checkInListRow({ tenant_id: 'tnt_1', event_id: 'evt_B' })],
      events: [eventRow({ id: 'evt_B', tenant_id: 'tnt_1' })],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/check-ins/scan',
      payload: {
        checkInListId: 'cil_1',
        qrPayload: 'payload',
        scannedAt: '2026-06-01T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ===========================================================================
// 4. API key scope enforcement
// ===========================================================================

describe('API key scope enforcement', () => {
  it('POST /events returns 403 for principal without events.write', async () => {
    const principal = makePrincipal({ scopes: ['events.read'] });
    const app = await setupApp(eventRoutes, principal, {});
    const res = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('POST /api-keys returns 403 when requesting scopes the principal does not hold', async () => {
    const principal = makePrincipal({
      scopes: ['developers.write', 'events.read'],
      organizationIds: ['org_1'],
    });
    const app = await setupApp(developerRoutes, principal, {});
    const res = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: {
        organizationId: 'org_1',
        name: 'Escalated key',
        scopes: ['events.read', 'refunds.write'],
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('authenticates a valid API key and maps tenant/scopes', async () => {
    const rawKey = 'gk_testkeyvalid';
    const hashedKey = createHash('sha256').update(rawKey).digest('hex');
    const tables: Tables = {
      api_keys: [
        apiKeyRow({
          id: 'ak_valid',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          hashed_key: hashedKey,
          scopes: JSON.stringify(['events.read']),
          revoked_at: null,
          expires_at: null,
        }),
      ],
    };
    const db = createMockDb(tables) as unknown as Database;
    const service = new ClerkAuthService('test-secret', db);
    const fakeRequest = {
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as import('fastify').FastifyRequest;
    const result = await service.authenticateApiKey(fakeRequest);
    expect(result.principal.type).toBe('api_key');
    expect(result.principal.tenantId).toBe('tnt_1');
    expect(result.principal.scopes).toContain('events.read');
  });

  it('rejects a revoked API key with 401 Unauthorized', async () => {
    const rawKey = 'gk_testkeyrevoked';
    const hashedKey = createHash('sha256').update(rawKey).digest('hex');
    const tables: Tables = {
      api_keys: [
        apiKeyRow({
          id: 'ak_revoked',
          hashed_key: hashedKey,
          revoked_at: new Date('2026-06-01'),
        }),
      ],
    };
    const db = createMockDb(tables) as unknown as Database;
    const service = new ClerkAuthService('test-secret', db);
    const fakeRequest = {
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as import('fastify').FastifyRequest;
    await expect(service.authenticateApiKey(fakeRequest)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });

  it('rejects an expired API key with 401 Unauthorized', async () => {
    const rawKey = 'gk_testkeyexpired';
    const hashedKey = createHash('sha256').update(rawKey).digest('hex');
    const tables: Tables = {
      api_keys: [
        apiKeyRow({
          id: 'ak_expired',
          hashed_key: hashedKey,
          revoked_at: null,
          expires_at: new Date('2020-01-01'),
        }),
      ],
    };
    const db = createMockDb(tables) as unknown as Database;
    const service = new ClerkAuthService('test-secret', db);
    const fakeRequest = {
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as import('fastify').FastifyRequest;
    await expect(service.authenticateApiKey(fakeRequest)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });

  it('rejects an API key with an unknown hash (no row)', async () => {
    const rawKey = 'gk_testkeyunknown';
    const tables: Tables = { api_keys: [] };
    const db = createMockDb(tables) as unknown as Database;
    const service = new ClerkAuthService('test-secret', db);
    const fakeRequest = {
      headers: { authorization: `Bearer ${rawKey}` },
    } as unknown as import('fastify').FastifyRequest;
    await expect(service.authenticateApiKey(fakeRequest)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });
});

// ===========================================================================
// 5. Scanner device revocation denial (revoked device auth)
// ===========================================================================

describe('scanner device auth denial', () => {
  it('rejects a revoked scanner device with 403 Forbidden', async () => {
    const rawSecret = 'device-secret-123';
    const hashedSecret = createHash('sha256').update(rawSecret).digest('hex');
    const tables: Tables = {
      scanner_devices: [
        scannerDeviceRow({
          id: 'sd_revoked',
          device_id: 'dev_revoked',
          hashed_secret: hashedSecret,
          status: 'revoked',
        }),
      ],
    };
    const db = createMockDb(tables) as unknown as Database;
    const service = new ClerkAuthService('test-secret', db);
    const fakeRequest = {
      headers: {
        'x-device-id': 'dev_revoked',
        'x-device-secret': rawSecret,
      },
    } as unknown as import('fastify').FastifyRequest;
    await expect(service.authenticateScannerDevice(fakeRequest)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });
});
