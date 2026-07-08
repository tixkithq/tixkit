import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
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
import { waitlistRoutes } from '../../routes/modules/waitlist.js';
import { contentRoutes } from '../../routes/modules/content.js';
import { shortLinkRoutes } from '../../routes/modules/short-links.js';
import { privacyRoutes } from '../../routes/modules/privacy.js';
import { hashRequest } from '../../services/idempotency.js';

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

function matchesWheres(
  row: Row,
  wheres: Array<{ column: string; op: string; value: unknown }>,
): boolean {
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

function createDelete(table: string, tables: Tables) {
  const wheres: Array<{ column: string; op: string; value: unknown }> = [];
  return {
    where(column: string, op: string, value: unknown) {
      wheres.push({ column, op, value });
      return {
        execute: async () => {
          const rows = tables[table] ?? [];
          tables[table] = rows.filter((row) => !matchesWheres(row, wheres));
        },
      };
    },
  };
}

function createMockDb(tables: Tables = {}): unknown {
  function createQuery(table: string) {
    const wheres: Array<{ column: string; op: string; value: unknown }> = [];
    let countAlias: string | null = null;
    const q = {
      select(selection?: unknown) {
        if (typeof selection === 'function') {
          selection({
            fn: {
              countAll: () => ({
                as: (alias: string) => {
                  countAlias = alias;
                  return alias;
                },
              }),
            },
          });
        }
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
        if (countAlias)
          return {
            [countAlias]: (tables[table] ?? []).filter((r) => matchesWheres(r, wheres)).length,
          };
        return (tables[table] ?? []).find((row) => matchesWheres(row, wheres));
      },
      async executeTakeFirstOrThrow() {
        const row = (tables[table] ?? []).find((candidate) => matchesWheres(candidate, wheres));
        if (!row) throw new Error(`No mock row for ${table}`);
        return row;
      },
      async execute() {
        return (tables[table] ?? []).filter((r) => matchesWheres(r, wheres));
      },
    };
    return q;
  }

  function createUpdate(table: string) {
    const wheres: Array<{ column: string; op: string; value: unknown }> = [];
    return {
      set(values: Row) {
        const rows = tables[table] ?? [];
        const update = {
          where(column: string, op: string, value: unknown) {
            wheres.push({ column, op, value });
            return update;
          },
          returningAll() {
            return {
              executeTakeFirstOrThrow: async () => {
                const row = rows.find((candidate) => matchesWheres(candidate, wheres));
                if (!row) return { id: 'updated', ...values };
                Object.assign(row, values);
                return row;
              },
            };
          },
          execute: async () => {
            for (const row of rows) {
              if (matchesWheres(row, wheres)) Object.assign(row, values);
            }
            return [];
          },
        };
        return update;
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

  const db = {
    selectFrom: createQuery,
    updateTable: createUpdate,
    insertInto: createInsert,
    deleteFrom: (table: string) => createDelete(table, tables),
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(db),
    }),
    destroy: vi.fn(),
  };
  return db;
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
    key_prefix: 'tk_1234',
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

function organizationRow(overrides: Row = {}): Row {
  return {
    id: 'org_1',
    tenant_id: 'tnt_1',
    name: 'Org 1',
    slug: 'org-1',
    status: 'active',
    clerk_organization_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function paymentAccountRow(overrides: Row = {}): Row {
  return {
    id: 'pa_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    provider: 'stripe_connect',
    provider_account_id: 'acct_1',
    status: 'active',
    default_currency: 'USD',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function oauthApplicationRow(overrides: Row = {}): Row {
  return {
    id: 'oa_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    name: 'OAuth app',
    client_id: 'tk_oauth_1',
    client_secret_hash: 'hash',
    redirect_uris: JSON.stringify(['https://example.com/callback']),
    scopes: JSON.stringify(['events.read']),
    status: 'active',
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

function privacyRequestRow(overrides: Row = {}): Row {
  return {
    id: 'prv_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    request_type: 'export',
    subject_type: 'buyer',
    subject_id: null,
    subject_email: 'buyer@example.test',
    status: 'pending',
    requested_by: 'usr_1',
    result: null,
    error: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    completed_at: null,
    ...overrides,
  };
}

function auditLogRow(overrides: Row = {}): Row {
  return {
    id: 'audit_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    actor_type: 'user',
    actor_id: 'usr_1',
    action: 'privacy.export.requested',
    resource_type: 'PrivacyRequest',
    resource_id: 'prv_1',
    diff_summary: null,
    request_id: null,
    ip: null,
    user_agent: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function contentDocumentRow(overrides: Row = {}): Row {
  return {
    id: 'cdoc_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    event_id: 'evt_1',
    channel: 'event_page',
    key: 'event-page',
    name: 'Event page',
    locale: 'en',
    status: 'draft',
    current_draft_version_id: 'cver_1',
    published_version_id: null,
    archived_at: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function contentVersionRow(overrides: Row = {}): Row {
  return {
    id: 'cver_1',
    document_id: 'cdoc_1',
    version_number: 1,
    subject: 'Event update',
    preview_text: 'Preview',
    content_json: JSON.stringify({ blocks: [{ type: 'text', text: 'Hello' }] }),
    rendered_html: '<p>Hello</p>',
    rendered_text: 'Hello',
    variables: '[]',
    validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
    status: 'draft',
    created_by: 'usr_author',
    published_at: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function legacyEventPageContentJson(eventId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    channel: 'event_page',
    eventId,
    blocks: [
      {
        type: 'hero',
        id: `hero_${eventId}`,
        headline: 'Legacy event page',
        body: 'Legacy body',
      },
    ],
    editor: {
      provider: '@tiptap/core',
      document: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy body' }] }],
      },
    },
    settings: {
      locale: 'en',
      ticketCtaLabel: 'Get tickets',
      discovery: {
        summary: 'Legacy body',
        tags: [],
        seoTitle: 'Legacy event page',
        seoDescription: 'Legacy body',
      },
    },
  });
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
      startPrivacyRequest: vi.fn(),
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
// 0. Explicit permission gates on tenant settings list routes
// ===========================================================================

describe('tenant settings list permission gates', () => {
  it('GET /organizations rejects principals without settings.write', async () => {
    const app = await setupApp(tenantRoutes, makePrincipal({ scopes: ['events.read'] }), {
      organizations: [organizationRow()],
    });
    const res = await app.inject({ method: 'GET', url: '/organizations' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('settings.write');
    await app.close();
  });

  it('GET /brands rejects principals without settings.write', async () => {
    const app = await setupApp(tenantRoutes, makePrincipal({ scopes: ['events.read'] }), {
      brands: [brandRow()],
    });
    const res = await app.inject({ method: 'GET', url: '/brands' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('settings.write');
    await app.close();
  });

  it('GET /bootstrap-context returns scoped context for events.write without settings.write', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['events.write'] }),
      {
        organizations: [
          organizationRow({
            id: 'org_1',
            box_office_settings: JSON.stringify({
              enabled: false,
              allowedTenderTypes: ['cash'],
              requireBuyerEmail: true,
              receiptMode: 'print',
            }),
          }),
          organizationRow({ id: 'org_other' }),
        ],
        brands: [
          brandRow({
            id: 'brd_1',
            organization_id: 'org_1',
            theme: JSON.stringify({ primaryColor: '#123456' }),
            payment_account_id: 'pa_1',
          }),
          brandRow({ id: 'brd_other', organization_id: 'org_other' }),
        ],
        brand_domains: [
          {
            id: 'bdom_1',
            brand_id: 'brd_1',
            domain: 'tickets.example.test',
            is_primary: 1,
            is_verified: 1,
            ssl_status: 'active',
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    );
    const res = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      organizations: [
        expect.objectContaining({
          id: 'org_1',
          tenantId: 'tnt_1',
          name: 'Org 1',
          slug: 'org-1',
          status: 'active',
        }),
      ],
      brands: [
        expect.objectContaining({
          id: 'brd_1',
          tenantId: 'tnt_1',
          organizationId: 'org_1',
          name: 'Brand1',
          slug: 'brand1',
          status: 'active',
          theme: {},
          domains: [],
          whiteLabel: false,
        }),
      ],
    });
    expect(res.json().organizations[0]).not.toHaveProperty('boxOfficeSettings');
    expect(res.json().brands[0]).not.toHaveProperty('paymentAccountId');
    await app.close();
  });

  it('GET /bootstrap-context rejects principals without dashboard permissions', async () => {
    const app = await setupApp(tenantRoutes, makePrincipal({ scopes: [] }), {
      organizations: [organizationRow()],
      brands: [brandRow()],
    });
    const res = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('events.read');
    await app.close();
  });

  it('GET /organizations remains scoped for principals with settings.write', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['settings.write'] }),
      {
        organizations: [organizationRow({ id: 'org_1' }), organizationRow({ id: 'org_other' })],
      },
    );
    const res = await app.inject({ method: 'GET', url: '/organizations' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((org: { id: string }) => org.id)).toEqual(['org_1']);
    await app.close();
  });

  it('POST /organizations rejects brand-scoped principals', async () => {
    const tables: Tables = { organizations: [] };
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({
        type: 'api_key',
        id: 'ak_brand_scoped',
        organizationIds: ['org_1'],
        brandIds: ['brd_1'],
        scopes: ['settings.write'],
      }),
      tables,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/organizations',
      payload: {
        name: 'Scoped Org',
        slug: 'scoped-org',
        clerkOrganizationId: 'clerk_org_scoped',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('Scoped principals cannot create tenant organizations');
    expect(tables.organizations).toEqual([]);
    await app.close();
  });

  it('POST /organizations rejects event-scoped principals', async () => {
    const tables: Tables = { organizations: [] };
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({
        type: 'api_key',
        id: 'ak_event_scoped',
        organizationIds: ['org_1'],
        eventIds: ['evt_1'],
        scopes: ['settings.write'],
      }),
      tables,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/organizations',
      payload: {
        name: 'Event Scoped Org',
        slug: 'event-scoped-org',
        clerkOrganizationId: 'clerk_org_event_scoped',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('Scoped principals cannot create tenant organizations');
    expect(tables.organizations).toEqual([]);
    await app.close();
  });

  it('POST /organizations returns a serialized tenant-scoped organization contract', async () => {
    const tables: Tables = { organizations: [] };
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: [], scopes: ['settings.write'] }),
      tables,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/organizations',
      payload: {
        name: 'Serialized Org',
        slug: 'serialized-org',
        clerkOrganizationId: 'clerk_org_serialized',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(
      expect.objectContaining({
        tenantId: 'tnt_1',
        name: 'Serialized Org',
        slug: 'serialized-org',
        clerkOrganizationId: 'clerk_org_serialized',
        status: 'active',
      }),
    );
    expect(res.json()).not.toHaveProperty('tenant_id');
    expect(res.json()).not.toHaveProperty('clerk_organization_id');
    expect(tables.organizations).toHaveLength(1);
    expect(tables.organizations[0]).toMatchObject({
      tenant_id: 'tnt_1',
      name: 'Serialized Org',
      slug: 'serialized-org',
      clerk_organization_id: 'clerk_org_serialized',
    });
    await app.close();
  });

  it('POST /brands rejects brand-scoped principals', async () => {
    const tables: Tables = {
      organizations: [organizationRow({ id: 'org_1' })],
      brands: [],
    };
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({
        type: 'api_key',
        id: 'ak_brand_scoped',
        organizationIds: ['org_1'],
        brandIds: ['brd_1'],
        scopes: ['settings.write'],
      }),
      tables,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/brands',
      payload: {
        organizationId: 'org_1',
        name: 'Scoped Brand',
        slug: 'scoped-brand',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('Scoped principals cannot create brands');
    expect(tables.brands).toEqual([]);
    await app.close();
  });

  it('POST /brands rejects event-scoped principals', async () => {
    const tables: Tables = {
      organizations: [organizationRow({ id: 'org_1' })],
      brands: [],
    };
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({
        type: 'api_key',
        id: 'ak_event_scoped',
        organizationIds: ['org_1'],
        eventIds: ['evt_1'],
        scopes: ['settings.write'],
      }),
      tables,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/brands',
      payload: {
        organizationId: 'org_1',
        name: 'Event Scoped Brand',
        slug: 'event-scoped-brand',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('Scoped principals cannot create brands');
    expect(tables.brands).toEqual([]);
    await app.close();
  });

  it('GET /brands remains scoped for principals with settings.write', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['settings.write'] }),
      {
        brands: [
          brandRow({ id: 'brd_1', organization_id: 'org_1', white_label: 1 }),
          brandRow({ id: 'brd_other', organization_id: 'org_other' }),
        ],
        brand_domains: [
          {
            id: 'bdom_1',
            brand_id: 'brd_1',
            domain: 'tickets.example.test',
            is_primary: 1,
            is_verified: 0,
            ssl_status: 'pending',
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
          {
            id: 'bdom_other',
            brand_id: 'brd_other',
            domain: 'other.example.test',
            is_primary: true,
            is_verified: false,
            ssl_status: 'pending',
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    );
    const res = await app.inject({ method: 'GET', url: '/brands' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: 'brd_1',
        whiteLabel: true,
        domains: [
          expect.objectContaining({
            brandId: 'brd_1',
            domain: 'tickets.example.test',
            isPrimary: true,
            isVerified: false,
            sslStatus: 'pending',
          }),
        ],
      }),
    ]);
    await app.close();
  });

  it('GET /bootstrap-context includes settings details for settings.write principals', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['settings.write'] }),
      {
        organizations: [
          organizationRow({
            id: 'org_1',
            box_office_settings: JSON.stringify({
              enabled: false,
              allowedTenderTypes: ['cash'],
              requireBuyerEmail: true,
              receiptMode: 'print',
            }),
          }),
        ],
        brands: [
          brandRow({
            id: 'brd_1',
            organization_id: 'org_1',
            theme: JSON.stringify({ primaryColor: '#123456' }),
            white_label: 1,
          }),
        ],
        brand_domains: [
          {
            id: 'bdom_1',
            brand_id: 'brd_1',
            domain: 'tickets.example.test',
            is_primary: 1,
            is_verified: 0,
            ssl_status: 'pending',
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    );
    const res = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(res.statusCode).toBe(200);
    expect(res.json().organizations).toEqual([
      expect.objectContaining({
        id: 'org_1',
        boxOfficeSettings: {
          enabled: false,
          allowedTenderTypes: ['cash'],
          requireBuyerEmail: true,
          receiptMode: 'print',
        },
      }),
    ]);
    expect(res.json().brands).toEqual([
      expect.objectContaining({
        id: 'brd_1',
        theme: { primaryColor: '#123456' },
        whiteLabel: true,
        domains: [
          expect.objectContaining({
            brandId: 'brd_1',
            domain: 'tickets.example.test',
            isPrimary: true,
            isVerified: false,
            sslStatus: 'pending',
          }),
        ],
      }),
    ]);
    await app.close();
  });

  it('GET /brands/:brandId/email-sender-identities returns scoped sender identities', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['settings.write'] }),
      {
        brands: [brandRow({ id: 'brd_1', organization_id: 'org_1' })],
        brand_sender_identities: [
          {
            id: 'bsi_1',
            tenant_id: 'tnt_1',
            brand_id: 'brd_1',
            email: 'tickets@example.test',
            name: 'Tickets',
            reply_to_email: 'support@example.test',
            verified: 1,
            verified_at: new Date('2026-06-01T00:00:00.000Z'),
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
          {
            id: 'bsi_other_tenant',
            tenant_id: 'tnt_other',
            brand_id: 'brd_1',
            email: 'other-tenant@example.test',
            name: 'Other Tenant',
            reply_to_email: null,
            verified: 1,
            verified_at: new Date('2026-06-01T00:00:00.000Z'),
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/brands/brd_1/email-sender-identities',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: 'bsi_1',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        email: 'tickets@example.test',
        name: 'Tickets',
        replyToEmail: 'support@example.test',
        verified: true,
        verifiedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    expect(res.json().map((identity: { id: string }) => identity.id)).not.toContain(
      'bsi_other_tenant',
    );
    await app.close();
  });

  it('GET /brands/:brandId/email-sender-identities allows messages.write for in-scope brands', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['messages.write'] }),
      {
        brands: [brandRow({ id: 'brd_1', organization_id: 'org_1' })],
        brand_sender_identities: [
          {
            id: 'bsi_1',
            tenant_id: 'tnt_1',
            brand_id: 'brd_1',
            email: 'tickets@example.test',
            name: 'Tickets',
            reply_to_email: 'support@example.test',
            verified: 1,
            verified_at: new Date('2026-06-01T00:00:00.000Z'),
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/brands/brd_1/email-sender-identities',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: 'bsi_1',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        email: 'tickets@example.test',
        verified: true,
      }),
    ]);
    await app.close();
  });

  it('GET /brands/:brandId/email-sender-identities denies messages.write across brand scope', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({
        organizationIds: ['org_1'],
        brandIds: ['brd_1'],
        scopes: ['messages.write'],
      }),
      {
        brands: [
          brandRow({ id: 'brd_1', organization_id: 'org_1' }),
          brandRow({ id: 'brd_2', organization_id: 'org_1' }),
        ],
        brand_sender_identities: [
          {
            id: 'bsi_2',
            tenant_id: 'tnt_1',
            brand_id: 'brd_2',
            email: 'riverside@example.test',
            name: 'Riverside',
            reply_to_email: null,
            verified: 1,
            verified_at: new Date('2026-06-01T00:00:00.000Z'),
            created_at: new Date('2026-06-01T00:00:00.000Z'),
            updated_at: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
      },
    );

    const res = await app.inject({
      method: 'GET',
      url: '/brands/brd_2/email-sender-identities',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('Brand');
    await app.close();
  });

  it('POST /brands returns the serialized brand contract', async () => {
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['settings.write'] }),
      { organizations: [organizationRow({ id: 'org_1' })] },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/brands',
      payload: {
        organizationId: 'org_1',
        name: 'Serialized Brand',
        slug: 'serialized-brand',
        theme: { primaryColor: '#1d4ed8' },
        whiteLabel: true,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(
      expect.objectContaining({
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        name: 'Serialized Brand',
        slug: 'serialized-brand',
        theme: { primaryColor: '#1d4ed8' },
        whiteLabel: true,
      }),
    );
    expect(res.json()).not.toHaveProperty('tenant_id');
    expect(res.json()).not.toHaveProperty('organization_id');
    expect(res.json()).not.toHaveProperty('white_label');
    await app.close();
  });

  it('PATCH /brands/:brandId and POST /brands/:brandId/domains return serialized contracts', async () => {
    const tables: Tables = { brands: [brandRow({ id: 'brd_1', organization_id: 'org_1' })] };
    const app = await setupApp(
      tenantRoutes,
      makePrincipal({ organizationIds: ['org_1'], scopes: ['settings.write'] }),
      tables,
    );

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: {
        name: 'Updated Brand',
        theme: { primaryColor: '#0f766e' },
        supportUrl: 'https://help.example.test/brand',
        legalUrls: {
          privacy: 'https://example.test/privacy',
          terms: 'https://example.test/terms',
        },
        whiteLabel: true,
      },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual(
      expect.objectContaining({
        id: 'brd_1',
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        name: 'Updated Brand',
        theme: { primaryColor: '#0f766e' },
        supportUrl: 'https://help.example.test/brand',
        legalUrls: {
          privacy: 'https://example.test/privacy',
          terms: 'https://example.test/terms',
        },
        whiteLabel: true,
      }),
    );
    expect(tables.brands[0]).toMatchObject({
      support_url: 'https://help.example.test/brand',
    });
    expect(JSON.parse(String(tables.brands[0].legal_urls))).toEqual({
      privacy: 'https://example.test/privacy',
      terms: 'https://example.test/terms',
    });
    expect(patchRes.json()).not.toHaveProperty('tenant_id');
    expect(patchRes.json()).not.toHaveProperty('organization_id');
    expect(patchRes.json()).not.toHaveProperty('white_label');

    const domainRes = await app.inject({
      method: 'POST',
      url: '/brands/brd_1/domains',
      payload: { domain: 'tickets.example.test', isPrimary: true },
    });
    expect(domainRes.statusCode).toBe(201);
    expect(domainRes.json()).toEqual(
      expect.objectContaining({
        brandId: 'brd_1',
        domain: 'tickets.example.test',
        isPrimary: true,
        isVerified: false,
        sslStatus: 'pending',
      }),
    );
    expect(domainRes.json()).not.toHaveProperty('brand_id');
    expect(domainRes.json()).not.toHaveProperty('is_primary');
    expect(domainRes.json()).not.toHaveProperty('ssl_status');
    await app.close();
  });
});

describe('privacy idempotency recovery', () => {
  it('POST /privacy/data-exports reuses the pending request when workflow start fails before retry', async () => {
    const startPrivacyRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporal unavailable'))
      .mockResolvedValueOnce(undefined);
    const tables: Tables = {
      organizations: [organizationRow()],
      privacy_requests: [],
      idempotency_records: [],
      audit_logs: [],
    };
    const app = await setupApp(privacyRoutes, makePrincipal(), tables, {
      temporalClient: {
        startPrivacyRequest,
      },
    });
    const payload = {
      organizationId: 'org_1',
      subjectType: 'buyer',
      subjectEmail: 'BUYER@example.test',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/privacy/data-exports',
      headers: { 'idempotency-key': 'privacy-export-key' },
      payload,
    });
    expect(first.statusCode).toBe(500);
    expect(tables.privacy_requests).toHaveLength(1);
    const requestId = tables.privacy_requests[0]?.id;

    const retry = await app.inject({
      method: 'POST',
      url: '/privacy/data-exports',
      headers: { 'idempotency-key': 'privacy-export-key' },
      payload,
    });

    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({
      id: requestId,
      subjectEmail: 'buyer@example.test',
      status: 'pending',
    });
    expect(tables.privacy_requests).toHaveLength(1);
    expect(tables.idempotency_records).toHaveLength(1);
    expect(tables.idempotency_records[0]).toMatchObject({ status: 'completed' });
    expect(tables.audit_logs).toHaveLength(1);
    expect(tables.audit_logs[0]).toMatchObject({
      action: 'privacy.export.requested',
      resource_type: 'PrivacyRequest',
      resource_id: requestId,
      diff_summary: JSON.stringify({
        subjectType: 'buyer',
        subjectId: null,
        subjectEmail: 'buyer@example.test',
      }),
    });
    expect(startPrivacyRequest).toHaveBeenCalledTimes(2);
    expect(startPrivacyRequest).toHaveBeenNthCalledWith(1, { requestId });
    expect(startPrivacyRequest).toHaveBeenNthCalledWith(2, { requestId });
    await app.close();
  });
});

describe('privacy scoped principal boundaries', () => {
  it('POST /privacy/data-exports rejects brand-scoped principals that omit brandId', async () => {
    const startPrivacyRequest = vi.fn();
    const tables: Tables = {
      organizations: [organizationRow()],
      brands: [brandRow({ id: 'brd_A' })],
      privacy_requests: [],
      idempotency_records: [],
      audit_logs: [],
    };
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const app = await setupApp(privacyRoutes, principal, tables, {
      temporalClient: { startPrivacyRequest },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/privacy/data-exports',
      headers: { 'idempotency-key': 'privacy-brandless-export' },
      payload: {
        organizationId: 'org_1',
        subjectType: 'buyer',
        subjectEmail: 'buyer@example.test',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(tables.privacy_requests).toHaveLength(0);
    expect(tables.idempotency_records).toHaveLength(0);
    expect(startPrivacyRequest).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /privacy/erasures allows brand-scoped principals for an allowed brandId', async () => {
    const startPrivacyRequest = vi.fn();
    const tables: Tables = {
      organizations: [organizationRow()],
      brands: [brandRow({ id: 'brd_A' })],
      privacy_requests: [],
      idempotency_records: [],
      audit_logs: [],
    };
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const app = await setupApp(privacyRoutes, principal, tables, {
      temporalClient: { startPrivacyRequest },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/privacy/erasures',
      headers: { 'idempotency-key': 'privacy-brand-erasure' },
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_A',
        subjectType: 'buyer',
        subjectEmail: 'buyer@example.test',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ brandId: 'brd_A', subjectEmail: 'buyer@example.test' });
    expect(tables.privacy_requests).toHaveLength(1);
    expect(tables.privacy_requests[0]).toMatchObject({ brand_id: 'brd_A' });
    expect(startPrivacyRequest).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /privacy/requests defaults brand-scoped principals to their allowed brand rows', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const tables: Tables = {
      privacy_requests: [
        privacyRequestRow({ id: 'prv_A', brand_id: 'brd_A' }),
        privacyRequestRow({ id: 'prv_B', brand_id: 'brd_B' }),
        privacyRequestRow({ id: 'prv_org', brand_id: null }),
      ],
    };
    const app = await setupApp(privacyRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/privacy/requests' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(['prv_A']);
    await app.close();
  });

  it('GET /audit-logs defaults brand-scoped principals to their allowed brand rows', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const tables: Tables = {
      audit_logs: [
        auditLogRow({ id: 'audit_A', brand_id: 'brd_A' }),
        auditLogRow({ id: 'audit_B', brand_id: 'brd_B' }),
        auditLogRow({ id: 'audit_org', brand_id: null }),
      ],
    };
    const app = await setupApp(privacyRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/audit-logs' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(['audit_A']);
    await app.close();
  });

  it('GET /privacy/requests/:requestId hides org-wide rows from brand-scoped principals', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const tables: Tables = {
      privacy_requests: [privacyRequestRow({ id: 'prv_org', brand_id: null })],
    };
    const app = await setupApp(privacyRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/privacy/requests/prv_org' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /privacy/requests/:requestId returns serialized request details without storage columns', async () => {
    const tables: Tables = {
      privacy_requests: [
        privacyRequestRow({
          id: 'prv_serialized',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          subject_email: 'buyer@example.test',
          result: JSON.stringify({ exportedRecords: 12 }),
          error: null,
        }),
      ],
    };
    const app = await setupApp(privacyRoutes, makePrincipal(), tables);

    const res = await app.inject({ method: 'GET', url: '/privacy/requests/prv_serialized' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        id: 'prv_serialized',
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        subjectEmail: 'buyer@example.test',
        result: { exportedRecords: 12 },
      }),
    );
    expect(res.json()).not.toHaveProperty('tenant_id');
    expect(res.json()).not.toHaveProperty('organization_id');
    expect(res.json()).not.toHaveProperty('subject_email');
    await app.close();
  });
});

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

  it('GET /events/:eventId/marketing-integrations returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({
      method: 'GET',
      url: '/events/evt_1/marketing-integrations',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /events/:eventId/waitlist returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(waitlistRoutes, makePrincipal({ scopes: ['events.read'] }), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/waitlist' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /events/:eventId/waitlist/:entryId/offer returns 404 for event in another tenant', async () => {
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_other' })] };
    const app = await setupApp(
      waitlistRoutes,
      makePrincipal({ scopes: ['tickets.write'] }),
      tables,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/waitlist/wle_1/offer',
      payload: {},
    });
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

  it('POST /check-ins/scan returns 404 before revealing inactive list state in another tenant', async () => {
    const tables: Tables = {
      check_in_lists: [
        checkInListRow({ tenant_id: 'tnt_other', event_id: 'evt_other', status: 'inactive' }),
      ],
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
    expect(res.json().message).not.toContain('not active');
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

  // Payment account binding validation tests (T24 regression coverage)
  it('PATCH /brands/:brandId allows billing.write to bind a payment account', async () => {
    const tables: Tables = {
      brands: [brandRow()],
      payment_accounts: [
        {
          id: 'pa_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_1',
          status: 'active',
          default_currency: 'USD',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal({ scopes: ['billing.write'] }), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: { paymentAccountId: 'pa_1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'brd_1', paymentAccountId: 'pa_1' });
    expect(tables.brands[0].payment_account_id).toBe('pa_1');
    await app.close();
  });

  it('PATCH /brands/:brandId does not allow billing.write to edit general brand settings', async () => {
    const tables: Tables = { brands: [brandRow()] };
    const app = await setupApp(tenantRoutes, makePrincipal({ scopes: ['billing.write'] }), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: { name: 'Billing User Edit' },
    });

    expect(res.statusCode).toBe(403);
    expect(tables.brands[0].name).toBe('Brand1');
    await app.close();
  });

  it('PATCH /brands/:brandId rejects payment account from another tenant', async () => {
    const tables: Tables = {
      brands: [brandRow()],
      payment_accounts: [
        {
          id: 'pa_1',
          tenant_id: 'tnt_other',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_1',
          status: 'active',
          default_currency: 'USD',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: { paymentAccountId: 'pa_1' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /brands/:brandId rejects payment account from another organization', async () => {
    const tables: Tables = {
      brands: [brandRow({ organization_id: 'org_1' })],
      payment_accounts: [
        {
          id: 'pa_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_other',
          provider: 'stripe_connect',
          provider_account_id: 'acct_1',
          status: 'active',
          default_currency: 'USD',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: { paymentAccountId: 'pa_1' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH /brands/:brandId rejects non-existent payment account', async () => {
    const tables: Tables = {
      brands: [brandRow()],
      payment_accounts: [],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_1',
      payload: { paymentAccountId: 'pa_nonexistent' },
    });
    expect(res.statusCode).toBe(400);
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

  it('GET /api-keys does not return keys from other organizations in same tenant', async () => {
    const tables: Tables = {
      api_keys: [
        apiKeyRow({ id: 'ak_1', organization_id: 'org_1' }),
        apiKeyRow({ id: 'ak_2', organization_id: 'org_other' }),
      ],
    };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/api-keys' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const keyIds = body.items?.map((k: { id: string }) => k.id) ?? [];
    expect(keyIds).toContain('ak_1');
    expect(keyIds).not.toContain('ak_2');
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
      payload: { smsTemplateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /content-documents excludes documents from another tenant', async () => {
    const tables: Tables = {
      content_documents: [contentDocumentRow({ tenant_id: 'tnt_other' })],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/content-documents' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    await app.close();
  });

  it.each([
    ['GET /content-documents/:documentId', 'GET', '/content-documents/cdoc_1', undefined],
    [
      'POST /content-documents/:documentId/duplicate',
      'POST',
      '/content-documents/cdoc_1/duplicate',
      { key: 'copy' },
    ],
    [
      'GET /content-documents/:documentId/versions',
      'GET',
      '/content-documents/cdoc_1/versions',
      undefined,
    ],
    [
      'POST /content-documents/:documentId/versions',
      'POST',
      '/content-documents/cdoc_1/versions',
      {
        subject: 'Blocked',
        previewText: 'Blocked',
        contentJson: { blocks: [] },
        renderedHtml: '<p>Blocked</p>',
        renderedText: 'Blocked',
      },
    ],
    [
      'POST /content-documents/:documentId/preview',
      'POST',
      '/content-documents/cdoc_1/preview',
      {
        contentJson: { blocks: [] },
        renderedHtml: '<p>Blocked</p>',
        renderedText: 'Blocked',
      },
    ],
    [
      'POST /content-documents/:documentId/versions/:versionId/publish',
      'POST',
      '/content-documents/cdoc_1/versions/cver_1/publish',
      undefined,
    ],
    [
      'POST /content-documents/:documentId/archive',
      'POST',
      '/content-documents/cdoc_1/archive',
      undefined,
    ],
    [
      'POST /content-documents/:documentId/test-sends',
      'POST',
      '/content-documents/cdoc_1/test-sends',
      {
        versionId: 'cver_1',
        recipient: 'editor@example.com',
        context: {},
      },
    ],
  ] as const)(
    '%s returns 404 for a document in another tenant',
    async (_label, method, url, payload) => {
      const tables: Tables = {
        brands: [brandRow({ tenant_id: 'tnt_other' })],
        events: [eventRow({ tenant_id: 'tnt_other' })],
        content_documents: [contentDocumentRow({ tenant_id: 'tnt_other' })],
        content_document_versions: [contentVersionRow()],
        content_test_sends: [],
      };
      const app = await setupApp(contentRoutes, principal, tables);

      const res = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      });

      expect(res.statusCode).toBe(404);
      expect(tables.content_document_versions).toHaveLength(1);
      expect(tables.content_test_sends).toHaveLength(0);
      await app.close();
    },
  );
});

// ===========================================================================
// 2. Cross-organization denial (same tenant, different org)
// ===========================================================================

describe('cross-organization denial (same tenant)', () => {
  const principal = makePrincipal({ organizationIds: ['org_A'] });

  it('GET /events/:eventId returns 404 for event in another organization', async () => {
    const tables: Tables = {
      events: [eventRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /events/:eventId returns 404 for event in another organization', async () => {
    const tables: Tables = {
      events: [eventRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: { title: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PUT /events/:eventId/marketing-integrations/:provider returns 404 for event in another organization', async () => {
    const tables: Tables = {
      events: [eventRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-CROSSORG' },
        consentRequired: false,
        status: 'active',
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /orders/:orderId returns 404 for order in another organization', async () => {
    const tables: Tables = {
      orders: [orderRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(orderRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/orders/ord_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /orders/:orderId/refunds returns 404 for order in another organization', async () => {
    const tables: Tables = {
      orders: [orderRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(orderRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/orders/ord_1/refunds',
      headers: { 'idempotency-key': 'key-cross-org-refund' },
      payload: { reason: 'Customer request', amountCents: 5000 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /organizations/:organizationId returns 404 for another organization', async () => {
    const tables: Tables = {
      organizations: [organizationRow({ id: 'org_B', tenant_id: 'tnt_1' })],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/organizations/org_B',
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /organizations/:organizationId/payment-accounts returns 404 for another organization', async () => {
    const tables: Tables = {
      organizations: [organizationRow({ id: 'org_B', tenant_id: 'tnt_1' })],
      payment_accounts: [paymentAccountRow({ organization_id: 'org_B' })],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'GET',
      url: '/organizations/org_B/payment-accounts',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

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

  it('POST /check-ins/sync returns 404 before revealing inactive list state in another organization', async () => {
    const tables: Tables = {
      check_in_lists: [
        checkInListRow({ tenant_id: 'tnt_1', event_id: 'evt_B', status: 'inactive' }),
      ],
      events: [eventRow({ id: 'evt_B', tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/check-ins/sync',
      headers: { 'idempotency-key': 'key-cross-org-sync-inactive' },
      payload: {
        checkInListId: 'cil_1',
        scans: [{ qrHash: 'hash_1', scannedAt: '2026-06-01T00:00:00.000Z', offline: true }],
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).not.toContain('not active');
    await app.close();
  });

  it('POST /events/:eventId/messages does not replay same-tenant idempotency across organizations', async () => {
    const payload = { smsTemplateKey: 'attendee-message', audience: 'all', channel: 'sms' };
    const tables: Tables = {
      events: [eventRow({ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_B' })],
      idempotency_records: [
        {
          id: 'idm_msg_1',
          key: 'key-cross-org-message',
          tenant_id: 'tnt_1',
          request_hash: hashRequest({ eventId: 'evt_1', body: payload }),
          response_status: 202,
          response_body: JSON.stringify({ campaignId: 'cached', status: 'sent' }),
          status: 'completed',
        },
      ],
    };
    const app = await setupApp(messagingRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'idempotency-key': 'key-cross-org-message' },
      payload,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    await app.close();
  });

  it('DELETE /api-keys/:keyId returns 404 for key in another organization', async () => {
    const tables: Tables = {
      api_keys: [apiKeyRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'DELETE', url: '/api-keys/ak_1' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /scanner-devices/:deviceId/revoke returns 404 for device in another organization', async () => {
    const tables: Tables = {
      scanner_devices: [
        scannerDeviceRow({ tenant_id: 'tnt_1', organization_id: 'org_B', device_id: 'dev_B' }),
      ],
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

  it('GET /events?organizationId=otherOrg returns 404 for an org outside principal scope', async () => {
    const tables: Tables = {
      events: [
        eventRow({ id: 'evt_A', tenant_id: 'tnt_1', organization_id: 'org_A' }),
        eventRow({ id: 'evt_B', tenant_id: 'tnt_1', organization_id: 'org_B' }),
      ],
    };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events?organizationId=org_B' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /content-documents excludes documents from another organization', async () => {
    const tables: Tables = {
      content_documents: [contentDocumentRow({ tenant_id: 'tnt_1', organization_id: 'org_B' })],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/content-documents' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    await app.close();
  });

  it('POST /content-documents returns 404 for a target organization outside principal scope', async () => {
    const tables: Tables = {
      brands: [brandRow({ id: 'brd_B', organization_id: 'org_B' })],
      events: [eventRow({ id: 'evt_B', organization_id: 'org_B', brand_id: 'brd_B' })],
      content_documents: [],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents',
      payload: {
        organizationId: 'org_B',
        brandId: 'brd_B',
        eventId: 'evt_B',
        channel: 'event_page',
        key: 'event-page',
        name: 'Event page',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(tables.content_documents).toHaveLength(0);
    await app.close();
  });

  it('GET and write content document routes return 404 for another organization', async () => {
    const tables: Tables = {
      brands: [brandRow({ organization_id: 'org_B' })],
      events: [eventRow({ organization_id: 'org_B' })],
      content_documents: [contentDocumentRow({ organization_id: 'org_B' })],
      content_document_versions: [contentVersionRow()],
      content_test_sends: [],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const readRes = await app.inject({ method: 'GET', url: '/content-documents/cdoc_1' });
    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/duplicate',
      payload: { key: 'blocked-copy' },
    });
    const archiveRes = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/archive',
    });

    expect(readRes.statusCode).toBe(404);
    expect(duplicateRes.statusCode).toBe(404);
    expect(archiveRes.statusCode).toBe(404);
    expect(tables.content_documents).toHaveLength(1);
    await app.close();
  });
});

describe('empty organization principal fail-closed lists', () => {
  const principal = makePrincipal({ organizationIds: [] });

  it('GET /events returns no rows for a non-system principal with no organizations', async () => {
    const tables: Tables = { events: [eventRow({ organization_id: 'org_1' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    await app.close();
  });

  it('GET /orders returns no rows for a non-system principal with no organizations', async () => {
    const tables: Tables = { orders: [orderRow({ organization_id: 'org_1' })] };
    const app = await setupApp(orderRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/orders' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    await app.close();
  });

  it('GET /scanner-devices returns no rows for a non-system principal with no organizations', async () => {
    const tables: Tables = { scanner_devices: [scannerDeviceRow({ organization_id: 'org_1' })] };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/scanner-devices' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    await app.close();
  });

  it('GET /oauth-applications returns no rows for a non-system principal with no organizations', async () => {
    const tables: Tables = {
      oauth_applications: [oauthApplicationRow({ organization_id: 'org_1' })],
    };
    const app = await setupApp(developerRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/oauth-applications' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(0);
    await app.close();
  });
});

describe('developer credential resource scope containment', () => {
  it('GET /api-keys exposes only same-event keys and DELETE hides other-event or org-wide keys from event-scoped principals', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_parent',
      eventIds: ['evt_1'],
      brandIds: ['brd_1'],
      scopes: ['developers.write'],
    });
    const tables: Tables = {
      api_keys: [
        apiKeyRow({ id: 'ak_evt_1', event_ids: JSON.stringify(['evt_1']) }),
        apiKeyRow({ id: 'ak_evt_2', event_ids: JSON.stringify(['evt_2']) }),
        apiKeyRow({ id: 'ak_org', event_ids: null, brand_ids: null }),
        apiKeyRow({ id: 'ak_brand', event_ids: null, brand_ids: JSON.stringify(['brd_1']) }),
      ],
    };
    const app = await setupApp(developerRoutes, principal, tables);

    const listRes = await app.inject({ method: 'GET', url: '/api-keys' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((item: { id: string }) => item.id)).toEqual(['ak_evt_1']);

    const otherEventRes = await app.inject({ method: 'DELETE', url: '/api-keys/ak_evt_2' });
    expect(otherEventRes.statusCode).toBe(404);

    const orgWideRes = await app.inject({ method: 'DELETE', url: '/api-keys/ak_org' });
    expect(orgWideRes.statusCode).toBe(404);

    await app.close();
  });

  it('GET /scanner-devices and revoke hide other-brand event and org-wide devices from brand-scoped principals', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_parent',
      brandIds: ['brd_1'],
      scopes: ['developers.write'],
    });
    const tables: Tables = {
      events: [
        eventRow({ id: 'evt_1', brand_id: 'brd_1' }),
        eventRow({ id: 'evt_2', brand_id: 'brd_2' }),
      ],
      scanner_devices: [
        scannerDeviceRow({
          id: 'sd_1',
          device_id: 'dev_1',
          event_ids: JSON.stringify(['evt_1']),
        }),
        scannerDeviceRow({
          id: 'sd_2',
          device_id: 'dev_2',
          event_ids: JSON.stringify(['evt_2']),
        }),
        scannerDeviceRow({ id: 'sd_org', device_id: 'dev_org', event_ids: null }),
      ],
    };
    const app = await setupApp(developerRoutes, principal, tables);

    const listRes = await app.inject({ method: 'GET', url: '/scanner-devices' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((item: { deviceId: string }) => item.deviceId)).toEqual([
      'dev_1',
    ]);

    const otherBrandRes = await app.inject({
      method: 'POST',
      url: '/scanner-devices/dev_2/revoke',
    });
    expect(otherBrandRes.statusCode).toBe(404);

    const orgWideRes = await app.inject({
      method: 'POST',
      url: '/scanner-devices/dev_org/revoke',
    });
    expect(orgWideRes.statusCode).toBe(404);

    await app.close();
  });
});

// ===========================================================================
// 3. Brand / event scope denial (scoped API keys)
// ===========================================================================

describe('brand and event scope denial', () => {
  it('POST /short-links rejects out-of-scope brand attribution for brand-scoped keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['messages.write'],
    });
    const tables: Tables = {
      brands: [
        brandRow({ id: 'brd_A', organization_id: 'org_1' }),
        brandRow({ id: 'brd_B', organization_id: 'org_1' }),
      ],
      short_links: [],
    };
    const app = await setupApp(shortLinkRoutes, principal, tables);

    const denied = await app.inject({
      method: 'POST',
      url: '/short-links',
      payload: {
        destinationUrl: 'https://example.com/tickets',
        slug: 'brand-b-link',
        brandId: 'brd_B',
      },
    });
    expect(denied.statusCode).toBe(404);
    expect(tables.short_links).toHaveLength(0);

    const allowed = await app.inject({
      method: 'POST',
      url: '/short-links',
      payload: {
        destinationUrl: 'https://example.com/tickets',
        slug: 'brand-a-link',
        brandId: 'brd_A',
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      slug: 'brand-a-link',
      destinationUrl: 'https://example.com/tickets',
    });
    expect(tables.short_links).toHaveLength(1);
    expect(tables.short_links[0]).toMatchObject({
      tenant_id: 'tnt_1',
      brand_id: 'brd_A',
      slug: 'brand-a-link',
    });

    await app.close();
  });

  it('GET /short-links hides other-brand and brandless links from brand-scoped keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['messages.write'],
    });
    const tables: Tables = {
      short_links: [
        {
          id: 'slk_A',
          tenant_id: 'tnt_1',
          brand_id: 'brd_A',
          slug: 'brand-a',
          destination_url: 'https://example.com/a',
          utm_params: null,
          clicks: 2,
          expires_at: null,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          id: 'slk_B',
          tenant_id: 'tnt_1',
          brand_id: 'brd_B',
          slug: 'brand-b',
          destination_url: 'https://example.com/b',
          utm_params: null,
          clicks: 5,
          expires_at: null,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
        {
          id: 'slk_tenant',
          tenant_id: 'tnt_1',
          brand_id: null,
          slug: 'tenant-wide',
          destination_url: 'https://example.com/tenant',
          utm_params: null,
          clicks: 1,
          expires_at: null,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    };
    const app = await setupApp(shortLinkRoutes, principal, tables);

    const listRes = await app.inject({ method: 'GET', url: '/short-links' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().links.map((link: { id: string }) => link.id)).toEqual(['slk_A']);

    const otherBrandClicks = await app.inject({
      method: 'GET',
      url: '/short-links/slk_B/clicks',
    });
    expect(otherBrandClicks.statusCode).toBe(404);

    const brandlessClicks = await app.inject({
      method: 'GET',
      url: '/short-links/slk_tenant/clicks',
    });
    expect(brandlessClicks.statusCode).toBe(404);

    await app.close();
  });

  it('PATCH /brands/:brandId returns 404 for brand-scoped key accessing another same-org brand', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const tables: Tables = {
      brands: [
        brandRow({ id: 'brd_A', organization_id: 'org_1' }),
        brandRow({ id: 'brd_B', organization_id: 'org_1' }),
      ],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_B',
      payload: { name: 'Hijacked' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /brands/:brandId/domains returns 404 for brand-scoped key accessing another same-org brand', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const tables: Tables = {
      brands: [
        brandRow({ id: 'brd_A', organization_id: 'org_1' }),
        brandRow({ id: 'brd_B', organization_id: 'org_1' }),
      ],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({
      method: 'POST',
      url: '/brands/brd_B/domains',
      payload: { domain: 'brand-b.example.com', isPrimary: true },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /brands returns only organization brands inside populated brand scope', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['settings.write'],
    });
    const tables: Tables = {
      brands: [
        brandRow({ id: 'brd_A', organization_id: 'org_1' }),
        brandRow({ id: 'brd_B', organization_id: 'org_1' }),
        brandRow({ id: 'brd_C', organization_id: 'org_other' }),
      ],
    };
    const app = await setupApp(tenantRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/brands' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((brand: { id: string }) => brand.id)).toEqual(['brd_A']);
    await app.close();
  });

  it('rejects event-scoped principals from tenant brand and bootstrap surfaces', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['events.read', 'messages.write', 'settings.write'],
    });
    const tables: Tables = {
      organizations: [organizationRow({ id: 'org_1' })],
      brands: [brandRow({ id: 'brd_A', organization_id: 'org_1' })],
    };
    const app = await setupApp(tenantRoutes, principal, tables);

    const bootstrap = await app.inject({ method: 'GET', url: '/bootstrap-context' });
    expect(bootstrap.statusCode).toBe(403);
    expect(bootstrap.json().message).toContain('Event-scoped principals cannot access');

    const brands = await app.inject({ method: 'GET', url: '/brands' });
    expect(brands.statusCode).toBe(403);

    const patch = await app.inject({
      method: 'PATCH',
      url: '/brands/brd_A',
      payload: { name: 'Event Scoped Edit' },
    });
    expect(patch.statusCode).toBe(403);
    expect(tables.brands[0]?.name).toBe('Brand1');

    const domain = await app.inject({
      method: 'POST',
      url: '/brands/brd_A/domains',
      payload: { domain: 'event-scoped.example.com', isPrimary: true },
    });
    expect(domain.statusCode).toBe(403);

    const senders = await app.inject({
      method: 'GET',
      url: '/brands/brd_A/email-sender-identities',
    });
    expect(senders.statusCode).toBe(403);

    await app.close();
  });

  it('rejects event-scoped principals from tenant-wide short-link surfaces', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['messages.write'],
    });
    const tables: Tables = {
      short_links: [
        {
          id: 'slk_tenant',
          tenant_id: 'tnt_1',
          brand_id: null,
          slug: 'tenant-wide',
          destination_url: 'https://example.com/tenant',
          utm_params: null,
          clicks: 1,
          expires_at: null,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    };
    const app = await setupApp(shortLinkRoutes, principal, tables);

    const list = await app.inject({ method: 'GET', url: '/short-links' });
    expect(list.statusCode).toBe(403);

    const clicks = await app.inject({ method: 'GET', url: '/short-links/slk_tenant/clicks' });
    expect(clicks.statusCode).toBe(403);

    const create = await app.inject({
      method: 'POST',
      url: '/short-links',
      payload: {
        destinationUrl: 'https://example.com/tickets',
        slug: 'event-scoped-link',
      },
    });
    expect(create.statusCode).toBe(403);
    expect(tables.short_links).toHaveLength(1);

    await app.close();
  });

  it('GET /attendees only returns permitted event attendees for event-scoped keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['attendees.read'],
    });
    const tables: Tables = {
      events: [
        eventRow({ id: 'evt_A', organization_id: 'org_1' }),
        eventRow({ id: 'evt_B', organization_id: 'org_1' }),
      ],
      attendees: [
        attendeeRow({
          id: 'att_A',
          event_id: 'evt_A',
          'attendees.tenant_id': 'tnt_1',
          'attendees.event_id': 'evt_A',
          'events.organization_id': 'org_1',
        }),
        attendeeRow({
          id: 'att_B',
          event_id: 'evt_B',
          'attendees.tenant_id': 'tnt_1',
          'attendees.event_id': 'evt_B',
          'events.organization_id': 'org_1',
        }),
      ],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/attendees' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((attendee: { id: string }) => attendee.id)).toEqual(['att_A']);
    await app.close();
  });

  it('GET /attendees only returns permitted brand attendees for brand-scoped keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['attendees.read'],
    });
    const tables: Tables = {
      events: [
        eventRow({ id: 'evt_A', organization_id: 'org_1', brand_id: 'brd_A' }),
        eventRow({ id: 'evt_B', organization_id: 'org_1', brand_id: 'brd_B' }),
      ],
      attendees: [
        attendeeRow({
          id: 'att_A',
          event_id: 'evt_A',
          'attendees.tenant_id': 'tnt_1',
          'events.organization_id': 'org_1',
          'events.brand_id': 'brd_A',
        }),
        attendeeRow({
          id: 'att_B',
          event_id: 'evt_B',
          'attendees.tenant_id': 'tnt_1',
          'events.organization_id': 'org_1',
          'events.brand_id': 'brd_B',
        }),
      ],
    };
    const app = await setupApp(checkInRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/attendees' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((attendee: { id: string }) => attendee.id)).toEqual(['att_A']);
    await app.close();
  });

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

  it('GET /events/:eventId/waitlist returns 404 for brand-scoped key accessing other brand event', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_1', brand_id: 'brd_B' })] };
    const app = await setupApp(waitlistRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/waitlist' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /events/:eventId/marketing-integrations returns 404 for brand-scoped key accessing other brand event', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = { events: [eventRow({ tenant_id: 'tnt_1', brand_id: 'brd_B' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({
      method: 'GET',
      url: '/events/evt_1/marketing-integrations',
    });
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

  it('PATCH /events/:eventId/waitlist/settings returns 404 for event-scoped key accessing other event', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_scoped',
      eventIds: ['evt_A'],
      scopes: ['tickets.write'],
    });
    const tables: Tables = { events: [eventRow({ id: 'evt_B', tenant_id: 'tnt_1' })] };
    const app = await setupApp(waitlistRoutes, principal, tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt_B/waitlist/settings',
      payload: { autoOfferEnabled: false, offerTtlMinutes: 45 },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PUT /events/:eventId/marketing-integrations/:provider returns 404 for event-scoped key accessing other event', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_scoped',
      eventIds: ['evt_A'],
      scopes: ['events.write'],
    });
    const tables: Tables = { events: [eventRow({ id: 'evt_B', tenant_id: 'tnt_1' })] };
    const app = await setupApp(eventRoutes, principal, tables);
    const res = await app.inject({
      method: 'PUT',
      url: '/events/evt_B/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-EVENTSCOPE' },
        consentRequired: false,
        status: 'active',
      },
    });
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

  it('GET /exports/:exportId returns 404 for same-tenant null-event export to event-scoped API key', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['reports.read'],
    });
    const tables: Tables = { export_jobs: [exportJobRow({ event_id: null })] };
    const app = await setupApp(reportingRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/exports/exp_1' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /exports/:exportId/download returns 404 for same-tenant null-event export to brand-scoped API key', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['reports.read'],
    });
    const tables: Tables = { export_jobs: [exportJobRow({ event_id: null })] };
    const app = await setupApp(reportingRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/exports/exp_1/download' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /exports/:exportId/events returns 404 for same-tenant null-event export to event-scoped API key', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['reports.read'],
    });
    const tables: Tables = { export_jobs: [exportJobRow({ event_id: null })] };
    const app = await setupApp(reportingRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/exports/exp_1/events' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /exports/:exportId/download allows system principals to access null-event exports', async () => {
    const principal = makePrincipal({ type: 'system', id: 'sys_1' });
    const tables: Tables = { export_jobs: [exportJobRow({ event_id: null })] };
    const app = await setupApp(reportingRoutes, principal, tables);
    const res = await app.inject({ method: 'GET', url: '/exports/exp_1/download' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).not.toBe('https://exports.example.test/exp_1.csv');
    expect(res.headers.location).toContain('/exports/exp_1.csv');
    expect(res.headers.location).toContain('X-Amz-Signature=');
    await app.close();
  });

  it('GET /content-documents exposes only permitted brand documents for brand-scoped keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = {
      content_documents: [
        contentDocumentRow({ id: 'cdoc_A', brand_id: 'brd_A' }),
        contentDocumentRow({ id: 'cdoc_B', brand_id: 'brd_B' }),
      ],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/content-documents?channel=event_page' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(['cdoc_A']);
    await app.close();
  });

  it('GET /content-documents/:documentId returns 404 for brand-scoped keys accessing another brand document', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = {
      brands: [brandRow({ id: 'brd_B' })],
      events: [eventRow({ brand_id: 'brd_B' })],
      content_documents: [contentDocumentRow({ brand_id: 'brd_B' })],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/content-documents/cdoc_1' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /content-documents returns 404 for brand-scoped keys creating under another brand', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.write'],
    });
    const tables: Tables = {
      brands: [brandRow({ id: 'brd_B' })],
      events: [eventRow({ id: 'evt_B', brand_id: 'brd_B' })],
      content_documents: [],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_B',
        eventId: 'evt_B',
        channel: 'event_page',
        key: 'event-page',
        name: 'Event page',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(tables.content_documents).toHaveLength(0);
    await app.close();
  });

  it('GET /content-documents exposes only permitted event documents for event-scoped keys', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['events.read'],
    });
    const tables: Tables = {
      content_documents: [
        contentDocumentRow({ id: 'cdoc_A', event_id: 'evt_A' }),
        contentDocumentRow({ id: 'cdoc_B', event_id: 'evt_B' }),
        contentDocumentRow({ id: 'cdoc_brand', event_id: null }),
      ],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({ method: 'GET', url: '/content-documents?channel=event_page' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string }) => item.id)).toEqual(['cdoc_A']);
    await app.close();
  });

  it('POST /content-documents/:documentId/versions returns 404 for event-scoped keys accessing another event document', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['events.write'],
    });
    const tables: Tables = {
      brands: [brandRow()],
      events: [eventRow({ id: 'evt_B' })],
      content_documents: [contentDocumentRow({ event_id: 'evt_B' })],
      content_document_versions: [],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/versions',
      payload: {
        subject: 'Blocked',
        previewText: 'Blocked',
        contentJson: { blocks: [] },
        renderedHtml: '<p>Blocked</p>',
        renderedText: 'Blocked',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(tables.content_document_versions).toHaveLength(0);
    await app.close();
  });

  it('POST /content-documents/migrate-event-page-puck rejects read-only event-page principals', async () => {
    const originalContent = legacyEventPageContentJson('evt_1');
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_read_only',
      scopes: ['events.read'],
    });
    const tables: Tables = {
      content_documents: [contentDocumentRow()],
      content_document_versions: [contentVersionRow({ content_json: originalContent })],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents/migrate-event-page-puck',
    });

    expect(res.statusCode).toBe(403);
    expect(tables.content_document_versions?.[0]?.content_json).toBe(originalContent);
    await app.close();
  });

  it('POST /content-documents/migrate-event-page-puck only migrates permitted brand documents', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_brand_scoped',
      brandIds: ['brd_A'],
      scopes: ['events.write'],
    });
    const tables: Tables = {
      content_documents: [
        contentDocumentRow({ id: 'cdoc_A', brand_id: 'brd_A', event_id: 'evt_A' }),
        contentDocumentRow({ id: 'cdoc_B', brand_id: 'brd_B', event_id: 'evt_B' }),
      ],
      content_document_versions: [
        contentVersionRow({
          id: 'cver_A',
          document_id: 'cdoc_A',
          content_json: legacyEventPageContentJson('evt_A'),
        }),
        contentVersionRow({
          id: 'cver_B',
          document_id: 'cdoc_B',
          content_json: legacyEventPageContentJson('evt_B'),
        }),
      ],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents/migrate-event-page-puck',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      documentsScanned: 1,
      versionsChecked: 1,
      versionsMigrated: 1,
      migrated: [{ documentId: 'cdoc_A', versionId: 'cver_A', versionNumber: 1 }],
    });
    const migrated = JSON.parse(String(tables.content_document_versions?.[0]?.content_json)) as {
      schemaVersion: number;
      editor: { provider: string; data: { content: Array<{ type: string }> } };
    };
    const untouched = JSON.parse(String(tables.content_document_versions?.[1]?.content_json)) as {
      schemaVersion: number;
    };
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.editor.provider).toBe('@puckeditor/core');
    expect(migrated.editor.data.content.map((component) => component.type)).toContain('Hero');
    expect(untouched.schemaVersion).toBe(1);
    await app.close();
  });

  it('POST /content-documents/migrate-event-page-puck only migrates permitted event documents', async () => {
    const principal = makePrincipal({
      type: 'api_key',
      id: 'ak_event_scoped',
      eventIds: ['evt_A'],
      scopes: ['events.write'],
    });
    const tables: Tables = {
      content_documents: [
        contentDocumentRow({ id: 'cdoc_A', event_id: 'evt_A' }),
        contentDocumentRow({ id: 'cdoc_B', event_id: 'evt_B' }),
        contentDocumentRow({ id: 'cdoc_brand', event_id: null }),
      ],
      content_document_versions: [
        contentVersionRow({
          id: 'cver_A',
          document_id: 'cdoc_A',
          content_json: legacyEventPageContentJson('evt_A'),
        }),
        contentVersionRow({
          id: 'cver_B',
          document_id: 'cdoc_B',
          content_json: legacyEventPageContentJson('evt_B'),
        }),
        contentVersionRow({
          id: 'cver_brand',
          document_id: 'cdoc_brand',
          content_json: legacyEventPageContentJson('evt_brand'),
        }),
      ],
    };
    const app = await setupApp(contentRoutes, principal, tables);

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents/migrate-event-page-puck',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      documentsScanned: 1,
      versionsChecked: 1,
      versionsMigrated: 1,
      migrated: [{ documentId: 'cdoc_A', versionId: 'cver_A', versionNumber: 1 }],
    });
    const schemaVersions = (tables.content_document_versions ?? []).map(
      (version) =>
        (JSON.parse(String(version.content_json)) as { schemaVersion: number }).schemaVersion,
    );
    expect(schemaVersions).toEqual([2, 1, 1]);
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

  it('PUT /events/:eventId/marketing-integrations/:provider returns 403 without events.write', async () => {
    const principal = makePrincipal({ scopes: ['events.read'] });
    const app = await setupApp(eventRoutes, principal, {
      events: [eventRow({ tenant_id: 'tnt_1' })],
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-NOWRITE' },
        consentRequired: false,
        status: 'active',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('GET /events/:eventId/waitlist returns 403 without events.read', async () => {
    const principal = makePrincipal({ scopes: ['tickets.write'] });
    const app = await setupApp(waitlistRoutes, principal, {
      events: [eventRow({ tenant_id: 'tnt_1' })],
    });
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/waitlist' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('PATCH /events/:eventId/waitlist/settings returns 403 without tickets.write', async () => {
    const principal = makePrincipal({ scopes: ['events.read'] });
    const app = await setupApp(waitlistRoutes, principal, {
      events: [eventRow({ tenant_id: 'tnt_1' })],
    });
    const res = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1/waitlist/settings',
      payload: { autoOfferEnabled: true, offerTtlMinutes: 60 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('POST /content-documents returns 403 for event-page content without events.write', async () => {
    const principal = makePrincipal({ scopes: ['events.read'] });
    const app = await setupApp(contentRoutes, principal, {
      brands: [brandRow()],
      events: [eventRow()],
      content_documents: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        eventId: 'evt_1',
        channel: 'event_page',
        key: 'event-page',
        name: 'Event page',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('GET /content-documents/:documentId returns 403 for email content without messages.write', async () => {
    const principal = makePrincipal({ scopes: ['events.read'] });
    const app = await setupApp(contentRoutes, principal, {
      brands: [brandRow()],
      events: [eventRow()],
      content_documents: [contentDocumentRow({ channel: 'email', key: 'order-confirmed' })],
    });

    const res = await app.inject({ method: 'GET', url: '/content-documents/cdoc_1' });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('POST /content-documents/:documentId/archive returns 403 for event-page content without events.write', async () => {
    const principal = makePrincipal({ scopes: ['events.read'] });
    const app = await setupApp(contentRoutes, principal, {
      brands: [brandRow()],
      events: [eventRow()],
      content_documents: [contentDocumentRow()],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/archive',
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
    const rawKey = 'tk_testkeyvalid';
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
    const rawKey = 'tk_testkeyrevoked';
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
    const rawKey = 'tk_testkeyexpired';
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
    const rawKey = 'tk_testkeyunknown';
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

// ===========================================================================
// 3. organizationId/brandId query-param scope guards on list routes
// ===========================================================================

describe('organizationId/brandId query-param scope guards', () => {
  it('GET /attendees?organizationId=org_B returns 404 for an org outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'] });
    const app = await setupApp(checkInRoutes, principal, { attendees: [], events: [] });
    const res = await app.inject({ method: 'GET', url: '/attendees?organizationId=org_B' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /attendees?brandId=brd_other returns 404 for a brand outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'], brandIds: ['brd_1'] });
    const app = await setupApp(checkInRoutes, principal, { attendees: [], events: [] });
    const res = await app.inject({ method: 'GET', url: '/attendees?brandId=brd_other' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /api-keys?organizationId=org_B returns 404 for an org outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'] });
    const app = await setupApp(developerRoutes, principal, { api_keys: [] });
    const res = await app.inject({ method: 'GET', url: '/api-keys?organizationId=org_B' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /webhook-endpoints?organizationId=org_B returns 404 for an org outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'] });
    const app = await setupApp(webhookRoutes, principal, { webhook_endpoints: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/webhook-endpoints?organizationId=org_B',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /payment-compensations?organizationId=org_B returns 404 for an org outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'] });
    const app = await setupApp(orderRoutes, principal, {});
    const res = await app.inject({
      method: 'GET',
      url: '/payment-compensations?organizationId=org_B',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /payment-compensations?brandId=brd_other returns 404 for a brand outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'], brandIds: ['brd_1'] });
    const app = await setupApp(orderRoutes, principal, {});
    const res = await app.inject({
      method: 'GET',
      url: '/payment-compensations?brandId=brd_other',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /content-documents?organizationId=org_B returns 404 for an org outside principal scope', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A'] });
    const app = await setupApp(contentRoutes, principal, { content_documents: [] });
    const res = await app.inject({
      method: 'GET',
      url: '/content-documents?organizationId=org_B',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /api-keys?organizationId=org_A narrows to org_A keys for a multi-org principal', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A', 'org_B'] });
    const app = await setupApp(developerRoutes, principal, {
      api_keys: [
        apiKeyRow({ id: 'ak_A', organization_id: 'org_A' }),
        apiKeyRow({ id: 'ak_B', organization_id: 'org_B' }),
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api-keys?organizationId=org_A' });
    expect(res.statusCode).toBe(200);
    const keyIds = res.json().items?.map((k: { id: string }) => k.id) ?? [];
    expect(keyIds).toEqual(['ak_A']);
    await app.close();
  });

  it('GET /webhook-endpoints?organizationId=org_A narrows to org_A endpoints for a multi-org principal', async () => {
    const principal = makePrincipal({ organizationIds: ['org_A', 'org_B'] });
    const app = await setupApp(webhookRoutes, principal, {
      webhook_endpoints: [
        webhookEndpointRow({ id: 'wh_A', organization_id: 'org_A' }),
        webhookEndpointRow({ id: 'wh_B', organization_id: 'org_B' }),
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/webhook-endpoints?organizationId=org_A',
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items?.map((w: { id: string }) => w.id) ?? [];
    expect(ids).toEqual(['wh_A']);
    await app.close();
  });
});
