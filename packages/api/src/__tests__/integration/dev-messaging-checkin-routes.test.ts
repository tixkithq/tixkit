import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../../app.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import { authRoutes } from '../../routes/modules/auth.js';
import { publicRoutes } from '../../routes/modules/public.js';
import { PricingEngine } from '../../services/pricing.js';

function createMockDb(tables: Record<string, unknown> = {}): unknown {
  const getRows = (table: string): Record<string, unknown>[] => {
    if (table in tables) return tables[table] as Record<string, unknown>[];
    return [];
  };
  const getRow = (table: string): Record<string, unknown> | undefined => {
    const rows = getRows(table);
    return rows[0];
  };

  function createQuery(table: string) {
    const query = {
      select: () => query,
      selectAll: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      forUpdate: () => query,
      fn: { sum: () => 'sum', countAll: () => 'count' },
      async executeTakeFirst() {
        if (table === 'idempotency_records') return undefined;
        return getRow(table);
      },
      async executeTakeFirstOrThrow() {
        const row = getRow(table);
        if (!row) throw new Error(`No mock for ${table}`);
        return row;
      },
      async execute() {
        return getRows(table);
      },
    };
    return query;
  }

  function createUpdate(table: string) {
    return {
      set: (values: Record<string, unknown>) => {
        const rows = getRows(table);
        if (rows[0]) Object.assign(rows[0], values);
        return {
          where: () => ({
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => rows[0] ?? { id: 'updated', ...values },
            }),
            execute: async () => [],
          }),
        };
      },
    };
  }

  function createInsert(table: string) {
    return {
      values: (vals: Record<string, unknown>) => {
        const row = { id: String(vals.id ?? 'new_1'), ...vals };
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              getRows(table).push(row);
              return row;
            },
          }),
          execute: async () => {
            getRows(table).push(row);
          },
        };
      },
    };
  }

  function createDelete(_table: string) {
    return {
      where: () => ({ execute: async () => {} }),
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

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['developers.write', 'events.read', 'events.write', 'messages.write', 'attendees.read', 'attendees.write', 'checkins.read', 'checkins.write', 'settings.write', 'billing.write', 'reports.read'],
    ...overrides,
  };
}

async function setupApp(
  routes: any,
  principal: Principal,
  tables: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
  options: { rateLimit?: boolean } = {},
) {
  const app = Fastify();
  if (options.rateLimit) {
    await app.register(rateLimit, {
      max: 1000,
      timeWindow: '1 minute',
    });
  }
  const context = {
    db: createMockDb(tables) as unknown as Database,
    pricingEngine: { calculate: () => ({ currency: 'USD', totalCents: 0, subtotalCents: 0, discountCents: 0, taxCents: 0, feeCents: 0, lineItems: [] }) },
    inventoryService: { reserveCart: () => ({ primaryHoldId: 'hld_1', expiresAt: new Date() }) },
    qrService: { hashPayload: () => 'hash_1', getQrPayload: () => ({ valid: true, ticketId: 'tkt_1' }) },
    authService: {},
    temporalClient: {
      startRefund: vi.fn(),
      startExport: vi.fn(),
      startNotificationDelivery: vi.fn(),
      startSmsDelivery: vi.fn(),
      startCheckoutSession: vi.fn(async () => ({ workflowId: 'wf_1', result: async () => ({ status: 'completed', orderId: 'ord_1' }) })),
      startWebhookDelivery: vi.fn(),
      getCheckoutState: vi.fn(async () => ({ paymentIntentId: 'pi_1', clientSecret: 'cs_1', status: 'pending_payment' })),
    },
    ...contextOverrides,
  };
  app.decorate('context', context as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(routes);
  return app;
}

function customQuestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q_1',
    event_id: 'evt_1',
    ticket_type_id: null,
    type: 'text',
    label: 'Old label',
    description: null,
    required: false,
    applies_to: 'attendee',
    options: null,
    placeholder: null,
    validation_pattern: null,
    conditional_visibility: null,
    status: 'active',
    is_hidden: false,
    hidden_at: null,
    deleted_at: null,
    sort_order: 0,
    is_consent_field: false,
    consent_text: null,
    consent_version: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('OAuth application CRUD', () => {
  it('GET /me returns admin-compatible permissions and legacy scopes', async () => {
    const app = await setupApp(authRoutes, makePrincipal({ scopes: ['events.read', 'orders.read'] }));
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scopes).toEqual(['events.read', 'orders.read']);
    expect(body.permissions).toEqual(['events.read', 'orders.read']);
    await app.close();
  });

  it('POST /oauth-applications creates an app and returns clientSecret', async () => {
    const app = await setupApp(developerRoutes, makePrincipal());
    const res = await app.inject({
      method: 'POST',
      url: '/oauth-applications',
      payload: {
        organizationId: 'org_1',
        name: 'My App',
        redirectUris: ['https://example.com/callback'],
        scopes: ['events.read'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.clientId).toMatch(/^gk_oauth_/);
    expect(body.clientSecret).toMatch(/^gk_secret_/);
    expect(body.status).toBe('active');
    expect(body.organizationId).toBe('org_1');
    expect(body.tenantId).toBe('tnt_1');
    await app.close();
  });

  it('GET /oauth-applications lists apps with tenantId, organizationId, updatedAt', async () => {
    const tables = {
      oauth_applications: [{
        id: 'oapp_1', tenant_id: 'tnt_1', organization_id: 'org_1', name: 'App1',
        client_id: 'gk_oauth_1', redirect_uris: JSON.stringify(['https://example.com']),
        scopes: JSON.stringify(['events.read']), status: 'active',
        created_at: new Date(), updated_at: new Date(),
      }],
    };
    const app = await setupApp(developerRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/oauth-applications' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items[0].tenantId).toBe('tnt_1');
    expect(body.items[0].organizationId).toBe('org_1');
    expect(body.items[0].updatedAt).toBeDefined();
    await app.close();
  });

  it('DELETE /oauth-applications/:appId revokes the app', async () => {
    const tables = {
      oauth_applications: [{
        id: 'oapp_1', tenant_id: 'tnt_1', organization_id: 'org_1', name: 'App1',
        client_id: 'gk_oauth_1', redirect_uris: '[]', scopes: '[]', status: 'active',
        created_at: new Date(), updated_at: new Date(),
      }],
    };
    const app = await setupApp(developerRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'DELETE', url: '/oauth-applications/oapp_1' });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});

describe('brand domain creation', () => {
  it('PATCH /organizations/:organizationId updates organization settings', async () => {
    const tables = {
      organizations: [{
        id: 'org_1',
        tenant_id: 'tnt_1',
        name: 'Old Org',
        slug: 'old-org',
        clerk_organization_id: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/organizations/org_1',
      payload: { name: 'New Org', slug: 'new-org' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'New Org', slug: 'new-org' });
    await app.close();
  });

  it('POST /brands/:brandId/domains creates a domain', async () => {
    const tables = {
      brands: [{
        id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1', name: 'Brand1',
        slug: 'brand1', status: 'active', theme: '{}', white_label: false,
        legal_urls: '{}', created_at: new Date(), updated_at: new Date(),
      }],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/brands/brd_1/domains',
      payload: { domain: 'example.com', isPrimary: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.domain).toBe('example.com');
    await app.close();
  });

  it('POST /brands rejects organizations outside the principal tenant', async () => {
    const tables = {
      organizations: [{
        id: 'org_other',
        tenant_id: 'tnt_other',
        name: 'Other Org',
        slug: 'other',
        clerk_organization_id: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/brands',
      payload: { organizationId: 'org_other', name: 'Other Brand', slug: 'other-brand' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /organizations/:organizationId/members/invitations persists an invited member', async () => {
    const tables = {
      organizations: [{
        id: 'org_1',
        tenant_id: 'tnt_1',
        name: 'Org',
        slug: 'org',
        clerk_organization_id: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }],
      user_profiles: [],
      organization_members: [],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/org_1/members/invitations',
      payload: { email: 'teammate@example.com', role: 'viewer' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      organizationId: 'org_1',
      email: 'teammate@example.com',
      role: 'viewer',
      status: 'invited',
    });
    expect(tables.user_profiles).toHaveLength(1);
    expect(tables.organization_members).toHaveLength(1);
    await app.close();
  });

  it('GET /organizations/:organizationId/payment-accounts returns accounts for the organization', async () => {
    const tables = {
      organizations: [{
        id: 'org_1',
        tenant_id: 'tnt_1',
        name: 'Org',
        slug: 'org',
        clerk_organization_id: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }],
      payment_accounts: [{
        id: 'pa_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_1',
        status: 'active',
        default_currency: 'USD',
        created_at: new Date(),
        updated_at: new Date(),
      }],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/organizations/org_1/payment-accounts' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 'pa_1', provider_account_id: 'acct_1' });
    await app.close();
  });

  it('GET /organizations/:organizationId/billing returns tenant-backed billing overview', async () => {
    const tables = {
      tenants: [{ id: 'tnt_1', name: 'Tenant', status: 'active', plan: 'pro', created_at: new Date(), updated_at: new Date() }],
      organizations: [{
        id: 'org_1',
        tenant_id: 'tnt_1',
        name: 'Org',
        slug: 'org',
        clerk_organization_id: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }],
      tickets: [{ id: 'tkt_1', tenant_id: 'tnt_1' }],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/organizations/org_1/billing' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      organizationId: 'org_1',
      plan: 'pro',
      status: 'active',
    });
    await app.close();
  });

  it('POST /organizations/:organizationId/payment-accounts/stripe-connect does not fake onboarding', async () => {
    const tables = {
      organizations: [{
        id: 'org_1',
        tenant_id: 'tnt_1',
        name: 'Org',
        slug: 'org',
        clerk_organization_id: null,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      }],
      payment_accounts: [],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/org_1/payment-accounts/stripe-connect',
    });
    expect(res.statusCode).toBe(400);
    expect(tables.payment_accounts).toHaveLength(0);
    await app.close();
  });
});

describe('public checkout questions', () => {
  const publishedEvent = {
    id: 'evt_1',
    slug: 'event',
    title: 'Event',
    description: null,
    status: 'published',
    timezone: 'America/New_York',
    starts_at: new Date('2026-06-01T00:00:00.000Z'),
    ends_at: null,
    venue: null,
    brand_id: 'br_1',
  };

  it('serializes conditionalVisibility for buyer and attendee questions', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [publishedEvent],
      questions: [
        customQuestionRow({
          id: 'q_parent',
          applies_to: 'buyer',
          type: 'select',
          label: 'Bring guest?',
          options: JSON.stringify(['yes', 'no']),
          required: true,
          sort_order: 1,
        }),
        customQuestionRow({
          id: 'q_child',
          applies_to: 'attendee',
          label: 'Guest name',
          required: true,
          conditional_visibility: JSON.stringify({
            field: 'q_parent',
            operator: 'equals',
            value: 'yes',
          }),
          sort_order: 2,
        }),
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/public/events/evt_1/questions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.buyerQuestions[0]).toMatchObject({ id: 'q_parent', appliesTo: 'buyer' });
    expect(body.attendeeQuestions[0]).toMatchObject({
      id: 'q_child',
      appliesTo: 'attendee',
      conditionalVisibility: { field: 'q_parent', operator: 'equals', value: 'yes' },
    });
    await app.close();
  });

  it('omits soft-hidden questions from public checkout', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [publishedEvent],
      questions: [
        customQuestionRow({ id: 'q_visible', label: 'Visible', applies_to: 'buyer' }),
        customQuestionRow({
          id: 'q_hidden',
          label: 'Hidden',
          applies_to: 'buyer',
          status: 'hidden',
          is_hidden: true,
          hidden_at: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/public/events/evt_1/questions' });
    expect(res.statusCode).toBe(200);
    expect(res.json().buyerQuestions.map((question: { id: string }) => question.id)).toEqual(['q_visible']);
    await app.close();
  });
});

describe('public access code validation', () => {
  it('accepts a valid access code for a published locked ticket', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [{
        id: 'evt_1',
        slug: 'event',
        title: 'Event',
        description: null,
        status: 'published',
        timezone: 'America/New_York',
        starts_at: now,
        ends_at: null,
        venue: null,
        brand_id: 'br_1',
      }],
      ticket_types: [{
        id: 'tt_locked',
        event_id: 'evt_1',
        name: 'VIP',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'locked',
        currency: 'USD',
        price_cents: 5000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 4,
        inventory_pool_id: 'inv_1',
        sort_order: 1,
        requires_access_code: true,
        access_code_hint: null,
      }],
      access_rules: [{
        id: 'acr_1',
        ticket_type_id: 'tt_locked',
        type: 'access_code',
        value: 'VIP123',
        max_uses: null,
        uses_count: 0,
        expires_at: null,
      }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/access-code',
      payload: {
        ticketTypeIds: ['tt_locked'],
        accessCode: 'VIP123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, ticketTypeIds: ['tt_locked'] });
    await app.close();
  });

  it('rejects an invalid access code for a locked ticket', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [{
        id: 'evt_1',
        slug: 'event',
        title: 'Event',
        description: null,
        status: 'published',
        timezone: 'America/New_York',
        starts_at: now,
        ends_at: null,
        venue: null,
        brand_id: 'br_1',
      }],
      ticket_types: [{
        id: 'tt_locked',
        event_id: 'evt_1',
        name: 'VIP',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'locked',
        currency: 'USD',
        price_cents: 5000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 4,
        inventory_pool_id: 'inv_1',
        sort_order: 1,
        requires_access_code: true,
        access_code_hint: null,
      }],
      access_rules: [{
        id: 'acr_1',
        ticket_type_id: 'tt_locked',
        type: 'access_code',
        value: 'VIP123',
        max_uses: null,
        uses_count: 0,
        expires_at: null,
      }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/access-code',
      payload: {
        ticketTypeIds: ['tt_locked'],
        accessCode: 'WRONG',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Access code is not valid');
    await app.close();
  });

  it('throttles repeated access-code validation attempts per event', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [{
        id: 'evt_1',
        slug: 'event',
        title: 'Event',
        description: null,
        status: 'published',
        timezone: 'America/New_York',
        starts_at: now,
        ends_at: null,
        venue: null,
        brand_id: 'br_1',
      }],
      ticket_types: [{
        id: 'tt_locked',
        event_id: 'evt_1',
        name: 'VIP',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'locked',
        currency: 'USD',
        price_cents: 5000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 4,
        inventory_pool_id: 'inv_1',
        sort_order: 1,
        requires_access_code: true,
        access_code_hint: null,
      }],
      access_rules: [{
        id: 'acr_1',
        ticket_type_id: 'tt_locked',
        type: 'access_code',
        value: 'VIP123',
        max_uses: null,
        uses_count: 0,
        expires_at: null,
      }],
    }, {}, { rateLimit: true });

    let lastStatus = 0;
    for (let attempt = 0; attempt < 11; attempt++) {
      // Sequential requests are required because the route-level limiter increments per completed request.
      // eslint-disable-next-line no-await-in-loop
      const res = await app.inject({
        method: 'POST',
        url: '/public/events/evt_1/access-code',
        payload: {
          ticketTypeIds: ['tt_locked'],
          accessCode: `WRONG-${attempt}`,
        },
      });
      lastStatus = res.statusCode;
    }

    expect(lastStatus).toBe(429);
    await app.close();
  });

  it('returns only locked ticket IDs unlocked by the supplied access code', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [{
        id: 'evt_1',
        slug: 'event',
        title: 'Event',
        description: null,
        status: 'published',
        timezone: 'America/New_York',
        starts_at: now,
        ends_at: null,
        venue: null,
        brand_id: 'br_1',
      }],
      ticket_types: [
        {
          id: 'tt_vip',
          event_id: 'evt_1',
          name: 'VIP',
          description: null,
          kind: 'paid',
          status: 'active',
          visibility: 'locked',
          currency: 'USD',
          price_cents: 5000,
          minimum_price_cents: null,
          sales_start_at: null,
          sales_end_at: null,
          min_per_order: 1,
          max_per_order: 4,
          inventory_pool_id: 'inv_1',
          sort_order: 1,
          requires_access_code: true,
          access_code_hint: null,
        },
        {
          id: 'tt_staff',
          event_id: 'evt_1',
          name: 'Staff',
          description: null,
          kind: 'paid',
          status: 'active',
          visibility: 'locked',
          currency: 'USD',
          price_cents: 0,
          minimum_price_cents: null,
          sales_start_at: null,
          sales_end_at: null,
          min_per_order: 1,
          max_per_order: 4,
          inventory_pool_id: 'inv_2',
          sort_order: 2,
          requires_access_code: true,
          access_code_hint: null,
        },
      ],
      access_rules: [
        {
          id: 'acr_vip',
          ticket_type_id: 'tt_vip',
          type: 'access_code',
          value: 'VIP123',
          max_uses: null,
          uses_count: 0,
          expires_at: null,
        },
        {
          id: 'acr_staff',
          ticket_type_id: 'tt_staff',
          type: 'access_code',
          value: 'STAFF123',
          max_uses: null,
          uses_count: 0,
          expires_at: null,
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/access-code',
      payload: {
        ticketTypeIds: ['tt_vip', 'tt_staff'],
        accessCode: 'VIP123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, ticketTypeIds: ['tt_vip'] });
    await app.close();
  });
});

describe('messaging endpoint', () => {
  it('POST /events/:eventId/messages queues real SMS jobs and starts delivery workflows', async () => {
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
      attendees: [{ id: 'att_1', tenant_id: 'tnt_1', order_id: 'ord_1', event_id: 'evt_1', ticket_type_id: 'tt_1', ticket_id: 'tkt_1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.com', phone: '+15550000002', status: 'confirmed', custom_answers: null, checked_in_at: null, check_in_device_id: null, created_at: new Date(), updated_at: new Date() }],
      message_consents: [{ id: 'msc_1', tenant_id: 'tnt_1', attendee_id: 'att_1', email: 'ada@test.com', phone: '+15550000002', email_opt_in: true, sms_opt_in: true, consent_text: 'Updates', consent_version: 'v1', consented_at: new Date(), revoked_at: null, created_at: new Date() }],
      sms_provider_routes: [{ id: 'spr_1', tenant_id: 'tnt_1', brand_id: 'brd_1', provider_type: 'capture', credentials_ref: 'capture', sender_identity_id: 'ssi_1', priority: 0, is_fallback: false, rate_limit_per_hour: null, allowed_categories: JSON.stringify(['bulk']), status: 'active', smoke_send_verified: true, webhook_url: null, created_at: new Date(), updated_at: new Date() }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_test_1' },
      payload: { templateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      status: 'queued',
      queuedSmsJobs: 1,
      queuedEmailJobs: 0,
    });
    await app.close();
  });

  it('POST /events/:eventId/messages persists consent exclusions without starting delivery workflows', async () => {
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
      attendees: [{ id: 'att_1', tenant_id: 'tnt_1', order_id: 'ord_1', event_id: 'evt_1', ticket_type_id: 'tt_1', ticket_id: 'tkt_1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.com', phone: '+15550000002', status: 'confirmed', custom_answers: null, checked_in_at: null, check_in_device_id: null, created_at: new Date(), updated_at: new Date() }],
      message_consents: [{ id: 'msc_1', tenant_id: 'tnt_1', attendee_id: 'att_1', email: 'ada@test.com', phone: '+15550000002', email_opt_in: true, sms_opt_in: false, consent_text: 'Updates', consent_version: 'v1', consented_at: new Date(), revoked_at: null, created_at: new Date() }],
      sms_provider_routes: [{ id: 'spr_1', tenant_id: 'tnt_1', brand_id: 'brd_1', provider_type: 'capture', credentials_ref: 'capture', sender_identity_id: 'ssi_1', priority: 0, is_fallback: false, rate_limit_per_hour: null, allowed_categories: JSON.stringify(['bulk']), status: 'active', smoke_send_verified: true, webhook_url: null, created_at: new Date(), updated_at: new Date() }],
      sms_jobs: [],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_test_consent' },
      payload: { templateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      status: 'suppressed',
      queuedSmsJobs: 0,
      suppressedRecipients: 1,
      consentExclusions: 1,
    });
    const smsJobs = tables.sms_jobs as Array<{ status: string }>;
    expect(tables.sms_jobs).toHaveLength(1);
    expect(smsJobs[0].status).toBe('suppressed');
    expect((app.context.temporalClient.startSmsDelivery as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await app.close();
  });

  it('GET /events/:eventId/messages returns persisted campaign summaries', async () => {
    const now = new Date();
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: now, visibility: 'public', seo: '{}' }],
      sms_jobs: [{
        id: 'smj_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        to_phone: '+15550000002',
        body: 'Update',
        template_key: 'attendee-message',
        variables: JSON.stringify({ eventId: 'evt_1', attendeeId: 'att_1', notificationType: 'bulk' }),
        provider_route_id: 'spr_1',
        status: 'queued',
        priority: 'low',
        scheduled_at: null,
        idempotency_key: 'msg_campaign:sms:att_1',
        workflow_id: null,
        created_at: now,
        updated_at: now,
      }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      id: 'msg_campaign',
      eventId: 'evt_1',
      channel: 'sms',
      status: 'queued',
      queuedSmsJobs: 1,
    });
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId returns jobs and deliveries', async () => {
    const now = new Date();
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: now, visibility: 'public', seo: '{}' }],
      sms_jobs: [{
        id: 'smj_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        to_phone: '+15550000002',
        body: 'Update',
        template_key: 'attendee-message',
        variables: JSON.stringify({ eventId: 'evt_1', attendeeId: 'att_1', notificationType: 'bulk' }),
        provider_route_id: 'spr_1',
        status: 'sent',
        priority: 'low',
        scheduled_at: null,
        idempotency_key: 'msg_detail:sms:att_1',
        workflow_id: null,
        created_at: now,
        updated_at: now,
      }],
      sms_deliveries: [{
        id: 'smd_1',
        tenant_id: 'tnt_1',
        job_id: 'smj_1',
        provider: 'capture',
        provider_message_id: 'provider_1',
        status: 'sent',
        attempted_providers: JSON.stringify(['capture']),
        accepted_provider: 'capture',
        sent_at: now,
        delivered_at: null,
        failed_at: null,
        failure_reason: null,
        metadata: '{}',
        created_at: now,
        updated_at: now,
      }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_detail' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'msg_detail',
      status: 'sent',
      smsJobs: [{ id: 'smj_1' }],
      smsDeliveries: [{ id: 'smd_1' }],
    });
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId/jobs lists and details persisted campaign jobs', async () => {
    const now = new Date();
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: now, visibility: 'public', seo: '{}' }],
      sms_jobs: [{
        id: 'smj_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        to_phone: '+15550000002',
        body: 'Update',
        template_key: 'attendee-message',
        variables: JSON.stringify({ eventId: 'evt_1', attendeeId: 'att_1', notificationType: 'bulk' }),
        provider_route_id: 'spr_1',
        status: 'queued',
        priority: 'low',
        scheduled_at: null,
        idempotency_key: 'msg_jobs:sms:att_1',
        workflow_id: null,
        created_at: now,
        updated_at: now,
      }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const list = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_jobs/jobs' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([{ channel: 'sms', campaignId: 'msg_jobs', job: { id: 'smj_1' } }]);

    const detail = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_jobs/jobs/sms/smj_1' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ channel: 'sms', campaignId: 'msg_jobs', job: { id: 'smj_1' } });
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId/delivery-logs scopes list and detail to campaign deliveries', async () => {
    const now = new Date();
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: now, visibility: 'public', seo: '{}' }],
      sms_jobs: [{
        id: 'smj_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        to_phone: '+15550000002',
        body: 'Update',
        template_key: 'attendee-message',
        variables: JSON.stringify({ eventId: 'evt_1', attendeeId: 'att_1', notificationType: 'bulk' }),
        provider_route_id: 'spr_1',
        status: 'sent',
        priority: 'low',
        scheduled_at: null,
        idempotency_key: 'msg_logs:sms:att_1',
        workflow_id: null,
        created_at: now,
        updated_at: now,
      }],
      sms_deliveries: [
        {
          id: 'smd_1',
          tenant_id: 'tnt_1',
          job_id: 'smj_1',
          provider: 'telnyx',
          provider_message_id: 'provider_1',
          status: 'delivered',
          attempted_providers: JSON.stringify(['telnyx']),
          accepted_provider: 'telnyx',
          sent_at: now,
          delivered_at: now,
          failed_at: null,
          failure_reason: null,
          metadata: '{}',
          created_at: now,
          updated_at: now,
        },
        {
          id: 'smd_other',
          tenant_id: 'tnt_1',
          job_id: 'smj_other',
          provider: 'telnyx',
          provider_message_id: 'provider_other',
          status: 'sent',
          attempted_providers: JSON.stringify(['telnyx']),
          accepted_provider: 'telnyx',
          sent_at: now,
          delivered_at: null,
          failed_at: null,
          failure_reason: null,
          metadata: '{}',
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const list = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_logs/delivery-logs' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ channel: 'sms', delivery: { id: 'smd_1' } });

    const detail = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_logs/delivery-logs/sms/smd_1' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ channel: 'sms', delivery: { id: 'smd_1', status: 'delivered' } });
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId/provider-events lists and details persisted SMS provider events', async () => {
    const now = new Date();
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: now, visibility: 'public', seo: '{}' }],
      sms_jobs: [{
        id: 'smj_1',
        tenant_id: 'tnt_1',
        brand_id: 'brd_1',
        to_phone: '+15550000002',
        body: 'Update',
        template_key: 'attendee-message',
        variables: JSON.stringify({ eventId: 'evt_1', attendeeId: 'att_1', notificationType: 'bulk' }),
        provider_route_id: 'spr_1',
        status: 'sent',
        priority: 'low',
        scheduled_at: null,
        idempotency_key: 'msg_events:sms:att_1',
        workflow_id: null,
        created_at: now,
        updated_at: now,
      }],
      sms_deliveries: [{
        id: 'smd_1',
        tenant_id: 'tnt_1',
        job_id: 'smj_1',
        provider: 'telnyx',
        provider_message_id: 'provider_1',
        status: 'sent',
        attempted_providers: JSON.stringify(['telnyx']),
        accepted_provider: 'telnyx',
        sent_at: now,
        delivered_at: null,
        failed_at: null,
        failure_reason: null,
        metadata: '{}',
        created_at: now,
        updated_at: now,
      }],
      sms_provider_events: [{
        id: 'spe_1',
        tenant_id: 'tnt_1',
        provider: 'telnyx',
        provider_event_id: 'evt_provider_1',
        event_type: 'message.sent',
        provider_message_id: 'provider_1',
        raw_payload: JSON.stringify({ data: { id: 'evt_provider_1' } }),
        processed_at: now,
        created_at: now,
      }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const list = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_events/provider-events' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([{ channel: 'sms', event: { id: 'spe_1', event_type: 'message.sent' } }]);

    const detail = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_events/provider-events/spe_1' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ channel: 'sms', event: { id: 'spe_1', provider_event_id: 'evt_provider_1' } });
    await app.close();
  });

  it('POST /events/:eventId/messages requires attendeeIds for specific audience', async () => {
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_test_2' },
      payload: { templateKey: 'attendee-message', audience: 'specific', channel: 'email' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /events/:eventId/messages requires Idempotency-Key', async () => {
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      payload: { templateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /events/:eventId/messages rejects no-recipient campaigns without fake success', async () => {
    const tables = {
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
      attendees: [],
      sms_provider_routes: [{ id: 'spr_1', tenant_id: 'tnt_1', brand_id: 'brd_1', provider_type: 'capture', credentials_ref: 'capture', sender_identity_id: 'ssi_1', priority: 0, is_fallback: false, rate_limit_per_hour: null, allowed_categories: JSON.stringify(['bulk']), status: 'active', smoke_send_verified: true, webhook_url: null, created_at: new Date(), updated_at: new Date() }],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_no_recipients' },
      payload: { templateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('ticket transfer and attendee update', () => {
  it('GET /attendees lists tenant attendees for the admin attendee index', async () => {
    const tables = {
      attendees: [
        {
          id: 'att_1',
          tenant_id: 'tnt_1',
          order_id: 'ord_1',
          event_id: 'evt_1',
          ticket_type_id: 'tt_1',
          ticket_id: 'tkt_1',
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@test.com',
          status: 'confirmed',
          phone: null,
          custom_answers: null,
          checked_in_at: null,
          check_in_device_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(checkInRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'GET',
      url: '/attendees',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('att_1');
    await app.close();
  });

  it('POST /tickets/:ticketId/transfer requires Idempotency-Key', async () => {
    const tables = {
      tickets: [{ id: 'tkt_1', tenant_id: 'tnt_1', order_id: 'ord_1', attendee_id: 'att_1', event_id: 'evt_1', ticket_type_id: 'tt_1', status: 'valid', code: 'CODE', qr_payload: 'payload', qr_hash: 'hash' }],
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
    };
    const app = await setupApp(checkInRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/tickets/tkt_1/transfer',
      payload: { toEmail: 'new@example.com' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH /attendees/:attendeeId updates attendee fields', async () => {
    const tables = {
      attendees: [{ id: 'att_1', tenant_id: 'tnt_1', order_id: 'ord_1', event_id: 'evt_1', ticket_type_id: 'tt_1', ticket_id: 'tkt_1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.com', status: 'confirmed', phone: null, custom_answers: null, checked_in_at: null, check_in_device_id: null, created_at: new Date(), updated_at: new Date() }],
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
    };
    const app = await setupApp(checkInRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/attendees/att_1',
      payload: { firstName: 'Updated', status: 'checked_in' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.firstName).toBe('Updated');
    await app.close();
  });
});

describe('custom questions CRUD', () => {
  const event = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    status: 'published',
    slug: 'evt',
    title: 'Event',
    timezone: 'UTC',
    starts_at: new Date(),
    visibility: 'public',
    seo: '{}',
  };

  it('POST /events/:eventId/questions creates a question', async () => {
    const tables = {
      events: [event],
    };
    const app = await setupApp(questionRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'text', label: 'What is your dietary preference?', appliesTo: 'attendee' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe('text');
    expect(body.label).toContain('dietary');
    await app.close();
  });

  it('POST /events/:eventId/questions rejects unsupported file questions', async () => {
    const app = await setupApp(questionRoutes, makePrincipal(), { events: [event] });
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'file', label: 'Upload waiver', appliesTo: 'buyer' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('File questions are not supported');
    await app.close();
  });

  it('POST /events/:eventId/questions validates option-bearing types', async () => {
    const app = await setupApp(questionRoutes, makePrincipal(), { events: [event] });
    const missingOptions = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'select', label: 'Meal choice' },
    });
    expect(missingOptions.statusCode).toBe(400);
    expect(missingOptions.json().message).toContain('select questions require at least one option');

    const invalidOptions = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'text', label: 'Nickname', options: ['VIP'] },
    });
    expect(invalidOptions.statusCode).toBe(400);
    expect(invalidOptions.json().message).toContain('text questions cannot define selectable options');
    await app.close();
  });

  it('POST /events/:eventId/questions denies cross-tenant and cross-organization events', async () => {
    const crossTenant = await setupApp(questionRoutes, makePrincipal(), {
      events: [{ ...event, tenant_id: 'tnt_2' }],
    });
    const tenantRes = await crossTenant.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'text', label: 'Denied' },
    });
    expect(tenantRes.statusCode).toBe(404);
    await crossTenant.close();

    const crossOrg = await setupApp(questionRoutes, makePrincipal(), {
      events: [{ ...event, organization_id: 'org_2' }],
    });
    const orgRes = await crossOrg.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'text', label: 'Denied' },
    });
    expect(orgRes.statusCode).toBe(404);
    await crossOrg.close();
  });

  it('POST /events/:eventId/questions requires ticket scope to belong to the event', async () => {
    const tables = {
      events: [event],
      ticket_types: [{ id: 'tt_other', event_id: 'evt_other' }],
    };
    const app = await setupApp(questionRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'text', label: 'Seat request', ticketTypeId: 'tt_other' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /questions/:questionId updates a question', async () => {
    const tables = {
      questions: [customQuestionRow()],
      events: [event],
    };
    const app = await setupApp(questionRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/questions/q_1',
      payload: { label: 'New label', required: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.label).toBe('New label');
    expect(body.required).toBe(true);
    await app.close();
  });

  it('PATCH /questions/:questionId requires a new consent version when consent text changes', async () => {
    const tables = {
      questions: [customQuestionRow({
        type: 'waiver',
        label: 'Waiver',
        is_consent_field: true,
        consent_text: 'Version one text',
        consent_version: 'v1',
      })],
      events: [event],
    };
    const app = await setupApp(questionRoutes, makePrincipal(), tables);
    const rejected = await app.inject({
      method: 'PATCH',
      url: '/questions/q_1',
      payload: { consentText: 'Version two text' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toContain('requires a new consent version');

    const accepted = await app.inject({
      method: 'PATCH',
      url: '/questions/q_1',
      payload: { consentText: 'Version two text', consentVersion: 'v2' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().consentVersion).toBe('v2');
    await app.close();
  });

  it('DELETE /questions/:questionId hides questions with historical answers when the schema supports it', async () => {
    const tables = {
      questions: [customQuestionRow({ status: 'active' })],
      events: [event],
      attendees: [{
        id: 'att_1',
        event_id: 'evt_1',
        custom_answers: JSON.stringify({ q_1: 'Ada Lovelace' }),
      }],
    };
    const app = await setupApp(questionRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'DELETE', url: '/questions/q_1' });
    expect(res.statusCode).toBe(204);
    expect((tables.questions as Array<Record<string, unknown>>)[0].status).toBe('hidden');
    await app.close();
  });

  it('DELETE /questions/:questionId hard-deletes questions without historical answers', async () => {
    const tables = {
      questions: [customQuestionRow()],
      events: [event],
    };
    const app = await setupApp(questionRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'DELETE', url: '/questions/q_1' });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});

describe('checkout confirm', () => {
  it('GET /checkout/sessions/:sessionId accepts native JSON session columns', async () => {
    const tables = {
      checkout_sessions: [{
        id: 'cs_1', tenant_id: 'tnt_1', event_id: 'evt_1', brand_id: 'brd_1', status: 'open',
        currency: 'USD', quote: { totalCents: 2500, subtotalCents: 2500, discountCents: 0, taxCents: 0, feeCents: 0 },
        buyer: { email: 'buyer@test.com' }, cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
        expires_at: new Date(Date.now() + 60000), hold_id: 'hld_1', order_id: null, client_token: 'tok_1',
        success_url: null, cancel_url: null, idempotency_key: 'key_1',
      }],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'GET',
      url: '/checkout/sessions/cs_1',
      headers: { 'x-checkout-session-token': 'tok_1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quote.totalCents).toBe(2500);
    expect(body.clientToken).toBe('tok_1');
    await app.close();
  });

  it('GET /checkout/sessions/:sessionId accepts matching Stripe client secret for pending confirmation', async () => {
    const tables = {
      checkout_sessions: [{
        id: 'cs_1', tenant_id: 'tnt_1', event_id: 'evt_1', brand_id: 'brd_1', status: 'pending_payment',
        currency: 'USD', quote: { totalCents: 2500, subtotalCents: 2500, discountCents: 0, taxCents: 0, feeCents: 0 },
        buyer: { email: 'buyer@test.com' }, cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
        expires_at: new Date(Date.now() + 60000), hold_id: 'hld_1', order_id: null, client_token: 'tok_1',
        success_url: null, cancel_url: null, idempotency_key: 'key_1',
      }],
      payment_intents: [{
        id: 'pi_db_1',
        checkout_session_id: 'cs_1',
        client_secret: 'pi_secret_123',
      }],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'GET',
      url: '/checkout/sessions/cs_1?payment_intent_client_secret=pi_secret_123',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('cs_1');
    expect(body.status).toBe('pending_payment');
    await app.close();
  });

  it('POST /checkout/sessions/:sessionId/confirm handles duplicate completed session', async () => {
    const tables = {
      checkout_sessions: [{
        id: 'cs_1', tenant_id: 'tnt_1', event_id: 'evt_1', brand_id: 'brd_1', status: 'completed',
        currency: 'USD', quote: JSON.stringify({ totalCents: 0, subtotalCents: 0, discountCents: 0, taxCents: 0, feeCents: 0 }),
        buyer: JSON.stringify({ email: 'buyer@test.com' }), cart: JSON.stringify({ items: [] }),
        expires_at: new Date(Date.now() + 60000), hold_id: 'hld_1', order_id: 'ord_1', client_token: 'tok_1',
        success_url: null, cancel_url: null, idempotency_key: 'key_1',
      }],
      events: [{ id: 'evt_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', status: 'published', slug: 'evt', title: 'Event', timezone: 'UTC', starts_at: new Date(), visibility: 'public', seo: '{}' }],
      orders: [{ id: 'ord_1', tenant_id: 'tnt_1', organization_id: 'org_1', brand_id: 'brd_1', event_id: 'evt_1', order_number: 'GK-1', status: 'paid', currency: 'USD', total_cents: 0, subtotal_cents: 0, discount_cents: 0, tax_cents: 0, fee_cents: 0, refunded_cents: 0, buyer_email: 'buyer@test.com', created_at: new Date(), updated_at: new Date() }],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_1/confirm',
      headers: { 'idempotency-key': 'key-2', 'x-checkout-session-token': 'tok_1' },
      payload: {},
    });
    // Should return the completed order
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.order.id).toBe('ord_1');
    await app.close();
  });
});

describe('checkout pricing tamper resistance', () => {
  const baseEvent = {
    id: 'evt_pricing',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    status: 'published',
    slug: 'pricing',
    title: 'Pricing Event',
    timezone: 'UTC',
    starts_at: new Date(Date.now() + 86_400_000),
    visibility: 'public',
    seo: '{}',
  };

  const paidTicketType = {
    id: 'tt_paid',
    event_id: 'evt_pricing',
    inventory_pool_id: 'inv_paid',
    name: 'General admission',
    description: null,
    kind: 'paid',
    status: 'active',
    visibility: 'public',
    currency: 'USD',
    price_cents: 10000,
    minimum_price_cents: null,
    sales_start_at: null,
    sales_end_at: null,
    min_per_order: 1,
    max_per_order: 10,
    requires_access_code: false,
    access_code_hint: null,
    sort_order: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const discountCode = {
    id: 'dc_save25',
    event_id: 'evt_pricing',
    code: 'SAVE25',
    type: 'percentage',
    value: 2500,
    currency: 'USD',
    max_uses: 100,
    uses_count: 0,
    valid_from: null,
    valid_until: null,
    min_order_cents: null,
    max_discount_cents: null,
    ticket_type_ids: JSON.stringify(['tt_paid']),
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const taxRule = {
    id: 'tax_ticket',
    event_id: 'evt_pricing',
    name: 'Sales tax',
    rate: 1000,
    type: 'exclusive',
    applied_to: 'ticket',
    countries: null,
    regions: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const feeRule = {
    id: 'fee_order',
    event_id: 'evt_pricing',
    name: 'Service fee',
    type: 'fixed',
    value: 300,
    applied_to: 'per_order',
    absorb_into_price: false,
    created_at: new Date(),
    updated_at: new Date(),
  };

  function pricingTables(overrides: Record<string, unknown> = {}) {
    return {
      events: [baseEvent],
      ticket_types: [paidTicketType],
      discount_codes: [discountCode],
      tax_rules: [taxRule],
      fee_rules: [feeRule],
      questions: [],
      checkout_sessions: [],
      idempotency_records: [],
      ...overrides,
    };
  }

  async function postPricingCheckoutSession(
    payload: Record<string, unknown>,
    tables: Record<string, unknown> = pricingTables(),
  ) {
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      pricingEngine: new PricingEngine(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { 'idempotency-key': `checkout_pricing_${Math.random()}` },
      payload: {
        eventId: 'evt_pricing',
        buyer: { email: 'buyer@test.com' },
        items: [{ ticketTypeId: 'tt_paid', quantity: 2 }],
        ...payload,
      },
    });
    await app.close();
    return res;
  }

  it('quotes from server-side ticket, discount, tax, and fee rows', async () => {
    const tables = pricingTables();
    const res = await postPricingCheckoutSession({ discountCode: 'SAVE25' }, tables);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quote).toMatchObject({
      currency: 'USD',
      subtotalCents: 20000,
      discountCents: 5000,
      taxCents: 1500,
      feeCents: 300,
      totalCents: 16800,
    });

    const storedSession = (tables.checkout_sessions as Array<{ quote: string }>)[0];
    const storedQuote = JSON.parse(storedSession.quote) as Record<string, unknown>;
    expect(storedQuote).toMatchObject({
      subtotalCents: 20000,
      discountCents: 5000,
      taxCents: 1500,
      feeCents: 300,
      totalCents: 16800,
    });
  });

  it('rejects client-supplied unit amounts for paid tickets', async () => {
    const res = await postPricingCheckoutSession({
      items: [{ ticketTypeId: 'tt_paid', quantity: 1, unitAmountCents: 1 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('unitAmountCents is only accepted for donation ticket tt_paid');
  });

  it('rejects client-supplied monetary totals during checkout session creation', async () => {
    const res = await postPricingCheckoutSession({
      discountCode: 'SAVE25',
      discountCents: 19999,
      feeCents: 0,
      taxCents: 0,
      totalCents: 1,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Unrecognized');
  });

  it('rejects client-supplied monetary totals during checkout confirmation', async () => {
    const startCheckoutSession = vi.fn(async () => ({
      workflowId: 'wf_pricing',
      result: async () => ({ status: 'completed', orderId: 'ord_1' }),
    }));
    const tables = {
      checkout_sessions: [{
        id: 'cs_pricing',
        tenant_id: 'tnt_1',
        event_id: 'evt_pricing',
        brand_id: 'brd_1',
        status: 'open',
        hold_id: 'hld_1',
        currency: 'USD',
        cart: JSON.stringify({ items: [{ ticketTypeId: 'tt_paid', quantity: 2 }], affiliateCode: 'AFF1' }),
        buyer: JSON.stringify({ email: 'buyer@test.com' }),
        quote: JSON.stringify({ totalCents: 16800, feeCents: 300 }),
        payment_intent_id: null,
        order_id: null,
        success_url: null,
        cancel_url: null,
        expires_at: new Date(Date.now() + 600_000),
        idempotency_key: 'create_key',
        client_token: 'tok_pricing',
        created_at: new Date(),
        updated_at: new Date(),
      }],
      events: [baseEvent],
      orders: [],
      idempotency_records: [],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState: vi.fn(async () => ({ paymentIntentId: 'pi_1', clientSecret: 'cs_1', status: 'pending_payment' })),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_pricing/confirm',
      headers: { 'idempotency-key': 'confirm_tampered_totals', 'x-checkout-session-token': 'tok_pricing' },
      payload: {
        paymentMethodId: 'pm_card_visa',
        amountCents: 1,
        feeCents: 0,
        discountCents: 19999,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Unrecognized');
    expect(startCheckoutSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('starts checkout confirmation with the stored quote amount and fee', async () => {
    const startCheckoutSession = vi.fn(async () => ({
      workflowId: 'wf_pricing',
      result: async () => ({ status: 'completed', orderId: 'ord_1' }),
    }));
    const tables = {
      checkout_sessions: [{
        id: 'cs_pricing',
        tenant_id: 'tnt_1',
        event_id: 'evt_pricing',
        brand_id: 'brd_1',
        status: 'open',
        hold_id: 'hld_1',
        currency: 'USD',
        cart: JSON.stringify({ items: [{ ticketTypeId: 'tt_paid', quantity: 2 }], affiliateCode: 'AFF1' }),
        buyer: JSON.stringify({ email: 'buyer@test.com' }),
        quote: JSON.stringify({ totalCents: 16800, feeCents: 300 }),
        payment_intent_id: null,
        order_id: null,
        success_url: null,
        cancel_url: null,
        expires_at: new Date(Date.now() + 600_000),
        idempotency_key: 'create_key',
        client_token: 'tok_pricing',
        created_at: new Date(),
        updated_at: new Date(),
      }],
      events: [baseEvent],
      orders: [],
      idempotency_records: [],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState: vi.fn(async () => ({ paymentIntentId: 'pi_1', clientSecret: 'cs_1', status: 'pending_payment' })),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_pricing/confirm',
      headers: { 'idempotency-key': 'confirm_authoritative_quote', 'x-checkout-session-token': 'tok_pricing' },
      payload: { paymentMethodId: 'pm_card_visa' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: 'cs_pricing',
      status: 'pending_payment',
      totalCents: 16800,
      currency: 'USD',
    });
    expect(startCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      checkoutSessionId: 'cs_pricing',
      amountCents: 16800,
      feeCents: 300,
      affiliateCode: 'AFF1',
    }));
    await app.close();
  });
});

describe('checkout question validation', () => {
  const baseEvent = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    status: 'published',
    slug: 'evt',
    title: 'Event',
    timezone: 'UTC',
    starts_at: new Date(Date.now() + 86_400_000),
    visibility: 'public',
    seo: '{}',
  };

  const baseTicketType = {
    id: 'tt_1',
    event_id: 'evt_1',
    inventory_pool_id: 'inv_1',
    name: 'General admission',
    description: null,
    kind: 'free',
    status: 'active',
    visibility: 'public',
    currency: 'USD',
    price_cents: 0,
    minimum_price_cents: null,
    sales_start_at: null,
    sales_end_at: null,
    min_per_order: 1,
    max_per_order: 10,
    requires_access_code: false,
    access_code_hint: null,
    sort_order: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };

  function question(overrides: Record<string, unknown>) {
    return {
      id: 'q_1',
      event_id: 'evt_1',
      ticket_type_id: null,
      type: 'text',
      label: 'Question',
      description: null,
      required: true,
      applies_to: 'buyer',
      options: null,
      placeholder: null,
      validation_pattern: null,
      conditional_visibility: null,
      status: 'active',
      is_hidden: false,
      hidden_at: null,
      deleted_at: null,
      sort_order: 0,
      is_consent_field: false,
      consent_text: null,
      consent_version: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
  }

  async function postCheckoutSession(tables: Record<string, unknown>, payload: Record<string, unknown>) {
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions',
      headers: { 'idempotency-key': `checkout_questions_${Math.random()}` },
      payload: {
        eventId: 'evt_1',
        buyer: { email: 'buyer@test.com' },
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        ...payload,
      },
    });
    await app.close();
    return res;
  }

  it('skips hidden conditional buyer questions and persists consent snapshots', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        question({
          id: 'q_parent',
          type: 'select',
          label: 'Bring a guest?',
          options: JSON.stringify(['yes', 'no']),
          applies_to: 'buyer',
        }),
        question({
          id: 'q_guest',
          label: 'Guest name',
          applies_to: 'buyer',
          conditional_visibility: JSON.stringify({ field: 'q_parent', operator: 'equals', value: 'yes' }),
        }),
        question({
          id: 'q_consent',
          type: 'waiver',
          label: 'Updates consent',
          applies_to: 'buyer',
          is_consent_field: true,
          consent_text: 'I agree to receive event updates.',
          consent_version: 'v2',
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: { q_parent: 'no', q_consent: true },
    });

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const cart = JSON.parse(storedSession.cart) as { buyerFields: Record<string, unknown> };
    expect(cart.buyerFields.q_guest).toBeUndefined();
    expect(cart.buyerFields.q_consent).toEqual({
      accepted: true,
      consentText: 'I agree to receive event updates.',
      consentVersion: 'v2',
      consentedAt: expect.any(String),
    });
  });

  it('fails when a visible required conditional buyer question is missing', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        question({
          id: 'q_parent',
          type: 'select',
          label: 'Bring a guest?',
          options: JSON.stringify(['yes', 'no']),
          applies_to: 'buyer',
        }),
        question({
          id: 'q_guest',
          label: 'Guest name',
          applies_to: 'buyer',
          conditional_visibility: JSON.stringify({ field: 'q_parent', operator: 'equals', value: 'yes' }),
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: { q_parent: 'yes' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Guest name is required');
  });

  it('ignores hidden and deleted required buyer questions during session validation', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        question({ id: 'q_hidden', label: 'Hidden required', status: 'hidden', is_hidden: true }),
        question({ id: 'q_deleted', label: 'Deleted required', deleted_at: new Date() }),
      ],
    };

    const res = await postCheckoutSession(tables, { buyerFields: {} });

    expect(res.statusCode).toBe(201);
  });

  it('persists trackingId separately from affiliateCode', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [],
    };

    const res = await postCheckoutSession(tables, { trackingId: 'utm-widget-1' });

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const cart = JSON.parse(storedSession.cart) as { affiliateCode?: string; trackingId?: string };
    expect(cart.trackingId).toBe('utm-widget-1');
    expect(cart.affiliateCode).toBeUndefined();
  });

  it('validates required attendee questions for every purchased quantity', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [question({ id: 'q_attendee_name', label: 'Attendee name', applies_to: 'attendee' })],
    };

    const res = await postCheckoutSession(tables, {
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 2,
          attendeeFields: [{ q_attendee_name: 'Ada Lovelace' }],
        },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Attendee name is required');
  });

  it('rejects file question answers during checkout session creation', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [question({ id: 'q_file', type: 'file', label: 'Upload waiver', applies_to: 'buyer', required: false })],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: { q_file: 'waiver.pdf' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('file uploads are not supported');
  });
});
