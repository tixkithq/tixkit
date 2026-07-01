import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import { createDefaultSmsTemplate } from '@tixkit/content-message';
import type { AppContext } from '../../app.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { checkoutRoutes } from '../../routes/modules/checkout.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import { authRoutes } from '../../routes/modules/auth.js';
import { publicRoutes } from '../../routes/modules/public.js';
import { PricingEngine } from '../../services/pricing.js';

const getMockColumnValue = (row: Record<string, unknown>, column: string) =>
  row[column] ?? row[column.split('.').at(-1) ?? column];

const mockValuesEqual = (rowValue: unknown, filterValue: unknown): boolean => {
  if (typeof filterValue === 'boolean' && typeof rowValue === 'number') {
    return rowValue === (filterValue ? 1 : 0);
  }
  return rowValue === filterValue;
};

const likePatternMatches = (rowValue: unknown, pattern: unknown): boolean => {
  if (typeof rowValue !== 'string' || typeof pattern !== 'string') return false;
  let regex = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      const escaped = pattern[index] ?? '\\';
      regex += escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (character === '%') {
      regex += '.*';
    } else if (character === '_') {
      regex += '.';
    } else {
      regex += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  regex += '$';
  return new RegExp(regex).test(rowValue);
};

function createMockDb(tables: Record<string, unknown> = {}): unknown {
  const tableState = tables as Record<string, unknown>;
  const getRows = (table: string): Record<string, unknown>[] => {
    if (!(table in tableState)) tableState[table] = [];
    return tableState[table] as Record<string, unknown>[];
  };
  function createQuery(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let countAlias: string | null = null;
    const query = {
      select: (selection?: unknown) => {
        if (typeof selection === 'function') {
          const aggregateBuilder = {
            fn: {
              countAll: () => ({
                as: (alias: string) => {
                  countAlias = alias;
                  return alias;
                },
              }),
            },
          };
          selection(aggregateBuilder);
        }
        return query;
      },
      selectAll: () => query,
      innerJoin: () => query,
      where: (...args: unknown[]) => {
        if (typeof args[0] === 'string' && typeof args[1] === 'string') {
          filters.push([args[0], args[1], args[2]]);
        }
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      forUpdate: () => query,
      fn: { sum: () => 'sum', countAll: () => 'count' },
      rows() {
        return getRows(table).filter((row) =>
          filters.every(([column, op, value]) => {
            const rowValue = getMockColumnValue(row, column);
            if (op === '=') return mockValuesEqual(rowValue, value);
            if (op === 'in' && Array.isArray(value)) return value.includes(rowValue);
            if (op === 'is') return value === null ? rowValue === null : rowValue === value;
            if (op === 'is not') return value === null ? rowValue !== null : rowValue !== value;
            if (op === 'like') return likePatternMatches(rowValue, value);
            return true;
          }),
        );
      },
      async executeTakeFirst() {
        if (countAlias) return { [countAlias]: query.rows().length };
        return query.rows()[0];
      },
      async executeTakeFirstOrThrow() {
        const row = query.rows()[0];
        if (!row) throw new Error(`No mock for ${table}`);
        return row;
      },
      async execute() {
        return query.rows();
      },
    };
    return query;
  }

  function createUpdate(table: string) {
    return {
      set: (values: Record<string, unknown>) => {
        const rows = getRows(table);
        const filters: Array<[string, string, unknown]> = [];
        const query = {
          where: (...args: unknown[]) => {
            if (typeof args[0] === 'string' && typeof args[1] === 'string') {
              filters.push([args[0], args[1], args[2]]);
            }
            return query;
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              const updated = applyUpdate();
              if (!updated[0]) throw new Error(`No mock update row for ${table}`);
              return updated[0];
            },
          }),
          executeTakeFirst: async () => ({ numUpdatedRows: BigInt(applyUpdate().length) }),
          execute: async () => {
            applyUpdate();
            return [];
          },
        };
        const applyUpdate = () => {
          const matching = rows.filter((row) =>
            filters.every(([column, op, value]) => {
              const rowValue = getMockColumnValue(row, column);
              if (op === '=') return mockValuesEqual(rowValue, value);
              if (op === 'in' && Array.isArray(value)) return value.includes(rowValue);
              if (op === 'is') return value === null ? rowValue === null : rowValue === value;
              if (op === 'is not') return value === null ? rowValue !== null : rowValue !== value;
              return true;
            }),
          );
          for (const row of matching) Object.assign(row, values);
          return matching;
        };
        return query;
      },
    };
  }

  function createInsert(table: string) {
    return {
      values: (vals: Record<string, unknown>) => {
        const row: Record<string, unknown> = { id: String(vals.id ?? 'new_1'), ...vals };
        const insertRow = async () => {
          const rows = getRows(table);
          if (table === 'payment_accounts' && tableState.paymentAccountInsertConflictRow) {
            rows.push(tableState.paymentAccountInsertConflictRow as Record<string, unknown>);
            tableState.paymentAccountInsertConflictRow = undefined;
            throw Object.assign(
              new Error(
                'duplicate key value violates unique constraint "uniq_payment_accounts_organization_provider"',
              ),
              { code: '23505' },
            );
          }
          const duplicateWidgetImpression =
            table === 'widget_impressions' &&
            rows.some((existing) => {
              const record = existing as Record<string, unknown>;
              return (
                record.event_id === row.event_id &&
                record.visitor_hash === row.visitor_hash &&
                record.impression_date === row.impression_date
              );
            });
          if (duplicateWidgetImpression) {
            throw Object.assign(
              new Error(
                'duplicate key value violates unique constraint "idx_widget_impressions_event_visitor_date"',
              ),
              { code: '23505' },
            );
          }
          rows.push(row);
          return row;
        };
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: insertRow,
          }),
          execute: async () => {
            await insertRow();
          },
        };
      },
    };
  }

  const mockDb = {
    selectFrom: createQuery,
    updateTable: createUpdate,
    insertInto: createInsert,
    deleteFrom: createDelete,
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(mockDb),
    }),
    destroy: vi.fn(),
  };
  return mockDb;
}

function createDelete(_table: string) {
  return {
    where: () => ({ execute: async () => {} }),
  };
}

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: [
      'developers.write',
      'events.read',
      'events.write',
      'messages.write',
      'attendees.read',
      'attendees.write',
      'checkins.read',
      'checkins.write',
      'settings.write',
      'billing.write',
      'reports.read',
    ],
    ...overrides,
  };
}

function publishedSmsContentRows(now: Date) {
  return {
    document: {
      id: 'cdoc_sms_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      channel: 'sms',
      key: 'attendee-message',
      name: 'Attendee SMS',
      status: 'published',
      locale: 'en',
      current_draft_version_id: null,
      published_version_id: 'cver_sms_1',
      created_at: now,
      updated_at: now,
    },
    version: {
      id: 'cver_sms_1',
      document_id: 'cdoc_sms_1',
      version_number: 1,
      status: 'published',
      schema_version: 1,
      subject: null,
      preview_text: null,
      content_json: JSON.stringify(
        createDefaultSmsTemplate({
          editor: { body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.' },
          settings: {
            templateKey: 'attendee-message',
            category: 'bulk',
            consentCategory: 'marketing',
            segmentLimit: 3,
            optOutText: 'Reply STOP to opt out',
          },
        }),
      ),
      rendered_html: null,
      rendered_text: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.',
      variables: '[]',
      validation: '{"valid":true,"severity":"warning","issues":[]}',
      created_by: 'usr_1',
      created_at: now,
      published_at: now,
    },
  };
}

function checkoutQuestion(overrides: Record<string, unknown>) {
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

function checkoutOccurrence(id: string, startsAt: Date) {
  return {
    id,
    event_id: 'evt_1',
    title: id,
    starts_at: startsAt,
    ends_at: new Date(startsAt.getTime() + 60 * 60 * 1000),
    timezone: 'UTC',
    venue: null,
    capacity: null,
    sort_order: 0,
    status: 'scheduled',
    created_at: new Date(),
    updated_at: new Date(),
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
      startCheckoutSession: vi.fn(async () => ({
        workflowId: 'wf_1',
        result: async () => ({ status: 'completed', orderId: 'ord_1' }),
      })),
      startWebhookDelivery: vi.fn(),
      getCheckoutState: vi.fn(async () => ({
        paymentIntentId: 'pi_1',
        clientSecret: 'cs_1',
        status: 'pending_payment',
      })),
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

describe('ticketing route inventory pool invariants', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const ticketPrincipal = () =>
    makePrincipal({ scopes: [...makePrincipal().scopes, 'tickets.write'] });

  const event = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    status: 'published',
    slug: 'evt',
    title: 'Event',
    timezone: 'UTC',
    starts_at: now,
    visibility: 'public',
    seo: '{}',
    created_at: now,
    updated_at: now,
  };

  const ticketType = {
    id: 'tt_1',
    event_id: 'evt_1',
    inventory_pool_id: 'ip_old',
    name: 'General admission',
    description: null,
    kind: 'paid',
    status: 'active',
    visibility: 'public',
    currency: 'USD',
    price_cents: 2500,
    minimum_price_cents: null,
    sales_start_at: null,
    sales_end_at: null,
    min_per_order: 1,
    max_per_order: 10,
    requires_access_code: false,
    access_code_hint: null,
    event_occurrence_id: null,
    sort_order: 0,
    created_at: now,
    updated_at: now,
  };

  const pools = [
    {
      id: 'ip_old',
      event_id: 'evt_1',
      name: 'Original pool',
      total_capacity: 10,
      reserved_count: 0,
      sold_count: 1,
      hold_ttl_seconds: 900,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'ip_new',
      event_id: 'evt_1',
      name: 'Replacement pool',
      total_capacity: 10,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: 900,
      created_at: now,
      updated_at: now,
    },
  ];

  it('rejects direct inventory pool changes after checkout holds exist', async () => {
    const tables = {
      events: [event],
      ticket_types: [{ ...ticketType }],
      inventory_pools: pools,
      checkout_holds: [
        {
          id: 'hold_1',
          inventory_pool_id: 'ip_old',
          checkout_session_id: 'cs_1',
          ticket_type_id: 'tt_1',
          quantity: 1,
          status: 'converted',
          expires_at: now,
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const app = await setupApp(ticketingRoutes, ticketPrincipal(), tables);

    const res = await app.inject({
      method: 'PATCH',
      url: '/ticket-types/tt_1',
      payload: { inventoryPoolId: 'ip_new' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Inventory pool cannot be changed');
    expect((tables.ticket_types[0] as Record<string, unknown>).inventory_pool_id).toBe('ip_old');
    await app.close();
  });

  it('rejects batch inventory pool changes after order line items exist', async () => {
    const tables = {
      events: [event],
      ticket_types: [{ ...ticketType }],
      inventory_pools: pools,
      order_line_items: [
        {
          id: 'oli_1',
          order_id: 'ord_1',
          ticket_type_id: 'tt_1',
          product_id: null,
          event_occurrence_id: null,
          resale_listing_id: null,
          attendee_id: null,
          description: 'General admission',
          quantity: 1,
          unit_price_cents: 2500,
          subtotal_cents: 2500,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: 2500,
          currency: 'USD',
          created_at: now,
          updated_at: now,
        },
      ],
      access_rules: [],
    };
    const app = await setupApp(ticketingRoutes, ticketPrincipal(), tables);

    const res = await app.inject({
      method: 'PATCH',
      url: '/ticket-types/tt_1/batch',
      payload: { ticketType: { inventoryPoolId: 'ip_new' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Inventory pool cannot be changed');
    expect((tables.ticket_types[0] as Record<string, unknown>).inventory_pool_id).toBe('ip_old');
    await app.close();
  });
});

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
    const app = await setupApp(
      authRoutes,
      makePrincipal({ scopes: ['events.read', 'orders.read'] }),
    );
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
    expect(body.clientId).toMatch(/^tk_oauth_/);
    expect(body.clientSecret).toMatch(/^tk_secret_/);
    expect(body.status).toBe('active');
    expect(body.organizationId).toBe('org_1');
    expect(body.tenantId).toBe('tnt_1');
    await app.close();
  });

  it('GET /oauth-applications lists apps with tenantId, organizationId, updatedAt', async () => {
    const tables = {
      oauth_applications: [
        {
          id: 'oapp_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          name: 'App1',
          client_id: 'tk_oauth_1',
          redirect_uris: JSON.stringify(['https://example.com']),
          scopes: JSON.stringify(['events.read']),
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
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
      oauth_applications: [
        {
          id: 'oapp_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          name: 'App1',
          client_id: 'tk_oauth_1',
          redirect_uris: '[]',
          scopes: '[]',
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
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
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Old Org',
          slug: 'old-org',
          clerk_organization_id: null,
          box_office_settings: {
            enabled: true,
            allowedTenderTypes: ['cash', 'manual_card', 'comp'],
            requireBuyerEmail: false,
            receiptMode: 'email',
          },
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/organizations/org_1',
      payload: {
        name: 'New Org',
        slug: 'new-org',
        boxOfficeSettings: {
          enabled: true,
          allowedTenderTypes: ['cash', 'comp'],
          requireBuyerEmail: true,
          receiptMode: 'both',
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'New Org',
      slug: 'new-org',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
    });
    expect(tables.organizations[0].box_office_settings).toBe(
      JSON.stringify({
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      }),
    );
    await app.close();
  });

  it('PATCH /organizations/:organizationId rejects invalid box-office settings', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Old Org',
          slug: 'old-org',
          clerk_organization_id: null,
          box_office_settings: {
            enabled: true,
            allowedTenderTypes: ['cash', 'manual_card', 'comp'],
            requireBuyerEmail: false,
            receiptMode: 'email',
          },
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/organizations/org_1',
      payload: {
        boxOfficeSettings: {
          enabled: true,
          allowedTenderTypes: ['cash', 'cash'],
          requireBuyerEmail: false,
          receiptMode: 'email',
        },
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('PATCH /organizations/:organizationId rejects whitespace-only organization names', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Old Org',
          slug: 'old-org',
          clerk_organization_id: null,
          box_office_settings: {
            enabled: true,
            allowedTenderTypes: ['cash', 'manual_card', 'comp'],
            requireBuyerEmail: false,
            receiptMode: 'email',
          },
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/organizations/org_1',
      payload: {
        name: '   ',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(tables.organizations[0].name).toBe('Old Org');
    await app.close();
  });

  it('POST /brands/:brandId/domains creates a domain', async () => {
    const tables = {
      brands: [
        {
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
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/brands/brd_1/domains',
      payload: { domain: 'Example.com.', isPrimary: true },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.domain).toBe('example.com');
    await app.close();
  });

  it('POST /brands/:brandId/domains rejects malformed domains', async () => {
    const tables = {
      brands: [
        {
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
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);

    const schemeRes = await app.inject({
      method: 'POST',
      url: '/brands/brd_1/domains',
      payload: { domain: 'https://events.example.com/path', isPrimary: true },
    });
    const missingRes = await app.inject({
      method: 'POST',
      url: '/brands/brd_1/domains',
      payload: { isPrimary: true },
    });

    expect(schemeRes.statusCode).toBe(400);
    expect(missingRes.statusCode).toBe(400);
    await app.close();
  });

  it('POST /brands rejects organizations outside the principal tenant', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_other',
          tenant_id: 'tnt_other',
          name: 'Other Org',
          slug: 'other',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
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
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
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
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
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
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/organizations/org_1/payment-accounts' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: 'pa_1', providerAccountId: 'acct_1' });
    await app.close();
  });

  it('GET /organizations/:organizationId/billing returns tenant-backed billing overview', async () => {
    const tables = {
      tenants: [
        {
          id: 'tnt_1',
          name: 'Tenant',
          status: 'active',
          plan: 'pro',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      events: [
        {
          id: 'evt_org_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
        },
        {
          id: 'evt_org_other',
          tenant_id: 'tnt_1',
          organization_id: 'org_other',
        },
        {
          id: 'evt_other_tenant',
          tenant_id: 'tnt_2',
          organization_id: 'org_external',
        },
      ],
      tickets: [
        {
          id: 'tkt_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_org_1',
          'events.tenant_id': 'tnt_1',
          'events.organization_id': 'org_1',
        },
        {
          id: 'tkt_2',
          tenant_id: 'tnt_1',
          event_id: 'evt_org_1',
          'events.tenant_id': 'tnt_1',
          'events.organization_id': 'org_1',
        },
        {
          id: 'tkt_other_org',
          tenant_id: 'tnt_1',
          event_id: 'evt_org_other',
          'events.tenant_id': 'tnt_1',
          'events.organization_id': 'org_other',
        },
        {
          id: 'tkt_other_tenant',
          tenant_id: 'tnt_2',
          event_id: 'evt_other_tenant',
          'events.tenant_id': 'tnt_2',
          'events.organization_id': 'org_external',
        },
      ],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/organizations/org_1/billing' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      organizationId: 'org_1',
      plan: 'pro',
      status: 'active',
      ticketsThisMonth: 2,
    });
    await app.close();
  });

  it('POST /organizations/:organizationId/payment-accounts/stripe-connect does not fake onboarding', async () => {
    const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const originalStripeConnectClientId = process.env.STRIPE_CONNECT_CLIENT_ID;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_CONNECT_CLIENT_ID;
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      payment_accounts: [],
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/organizations/org_1/payment-accounts/stripe-connect',
      });
      expect(res.statusCode).toBe(400);
      expect(tables.payment_accounts).toHaveLength(0);
    } finally {
      if (originalStripeSecretKey === undefined) {
        delete process.env.STRIPE_SECRET_KEY;
      } else {
        process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
      }
      if (originalStripeConnectClientId === undefined) {
        delete process.env.STRIPE_CONNECT_CLIENT_ID;
      } else {
        process.env.STRIPE_CONNECT_CLIENT_ID = originalStripeConnectClientId;
      }
      await app.close();
    }
  });

  it('POST /organizations/:organizationId/payment-accounts/stripe-connect creates a Stripe account and onboarding link when configured', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      payment_accounts: [],
      audit_logs: [],
    };
    const stripe = {
      accounts: {
        create: vi.fn(async () => ({
          id: 'acct_created_1',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          default_currency: 'usd',
          requirements: {
            currently_due: ['business_profile.url'],
            pending_verification: [],
            disabled_reason: null,
          },
        })),
      },
      accountLinks: {
        create: vi.fn(async () => ({ url: 'https://connect.stripe.test/onboard/acct_created_1' })),
      },
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables, { stripe });
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/org_1/payment-accounts/stripe-connect',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      provider: 'stripe_connect',
      providerAccountId: 'acct_created_1',
      status: 'pending',
      defaultCurrency: 'USD',
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      requirements: {
        currently_due: ['business_profile.url'],
        pending_verification: [],
        disabled_reason: null,
      },
      disabledReason: null,
      onboardingUrl: 'https://connect.stripe.test/onboard/acct_created_1',
    });
    expect(tables.payment_accounts).toHaveLength(1);
    expect(tables.payment_accounts[0]).toMatchObject({
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      provider: 'stripe_connect',
      provider_account_id: 'acct_created_1',
      status: 'pending',
      default_currency: 'USD',
      details_submitted: false,
      charges_enabled: false,
      payouts_enabled: false,
      disabled_reason: null,
    });
    expect(
      JSON.parse(
        String((tables.payment_accounts as Array<Record<string, unknown>>)[0].requirements),
      ),
    ).toMatchObject({
      currently_due: ['business_profile.url'],
    });
    expect(stripe.accounts.create).toHaveBeenCalledWith({
      type: 'express',
      country: 'US',
      business_profile: { name: 'Org' },
      metadata: {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
      },
    });
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_created_1',
      type: 'account_onboarding',
      refresh_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=refresh',
      ),
      return_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=return',
      ),
    });
    await app.close();
  });

  it('POST /organizations/:organizationId/payment-accounts/stripe-connect recovers when concurrent first-create wins', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      payment_accounts: [],
      audit_logs: [],
      paymentAccountInsertConflictRow: {
        id: 'pa_winner',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_winner',
        status: 'pending',
        default_currency: 'USD',
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: JSON.stringify({ currently_due: ['business_profile.url'] }),
        disabled_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    };
    const stripe = {
      accounts: {
        create: vi.fn(async () => ({
          id: 'acct_loser',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          default_currency: 'usd',
          requirements: {
            currently_due: [],
            pending_verification: [],
            disabled_reason: null,
          },
        })),
        del: vi.fn(async () => {
          throw new Error('Stripe cleanup unavailable');
        }),
      },
      accountLinks: {
        create: vi.fn(async () => ({ url: 'https://connect.stripe.test/onboard/acct_winner' })),
      },
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables, { stripe });
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/org_1/payment-accounts/stripe-connect',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'pa_winner',
      provider: 'stripe_connect',
      providerAccountId: 'acct_winner',
      onboardingUrl: 'https://connect.stripe.test/onboard/acct_winner',
    });
    expect(tables.payment_accounts).toHaveLength(1);
    expect(tables.audit_logs).toHaveLength(0);
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(stripe.accounts.del).toHaveBeenCalledWith('acct_loser');
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_winner',
      type: 'account_onboarding',
      refresh_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=refresh',
      ),
      return_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=return',
      ),
    });
    await app.close();
  });

  it('POST /organizations/:organizationId/payment-accounts/stripe-connect returns the winner without waiting for loser cleanup', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      payment_accounts: [],
      audit_logs: [],
      paymentAccountInsertConflictRow: {
        id: 'pa_winner',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        provider: 'stripe_connect',
        provider_account_id: 'acct_winner',
        status: 'pending',
        default_currency: 'USD',
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        requirements: JSON.stringify({ currently_due: [] }),
        disabled_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    };
    const cleanupPromise = new Promise<never>(() => undefined);
    const stripe = {
      accounts: {
        create: vi.fn(async () => ({
          id: 'acct_loser',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
          default_currency: 'usd',
          requirements: {
            currently_due: [],
            pending_verification: [],
            disabled_reason: null,
          },
        })),
        del: vi.fn(() => cleanupPromise),
      },
      accountLinks: {
        create: vi.fn(async () => ({ url: 'https://connect.stripe.test/onboard/acct_winner' })),
      },
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables, { stripe });
    const startedAt = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/org_1/payment-accounts/stripe-connect',
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'pa_winner',
      providerAccountId: 'acct_winner',
      onboardingUrl: 'https://connect.stripe.test/onboard/acct_winner',
    });
    expect(stripe.accounts.del).toHaveBeenCalledWith('acct_loser');
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_winner',
      type: 'account_onboarding',
      refresh_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=refresh',
      ),
      return_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=return',
      ),
    });
    await app.close();
  });

  it('POST /organizations/:organizationId/payment-accounts/:paymentAccountId/stripe-connect/refresh syncs status from Stripe', async () => {
    const tables = {
      organizations: [
        {
          id: 'org_1',
          tenant_id: 'tnt_1',
          name: 'Org',
          slug: 'org',
          clerk_organization_id: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      payment_accounts: [
        {
          id: 'pa_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          provider: 'stripe_connect',
          provider_account_id: 'acct_refresh_1',
          status: 'pending',
          default_currency: 'USD',
          details_submitted: false,
          charges_enabled: false,
          payouts_enabled: false,
          requirements: null,
          disabled_reason: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      audit_logs: [],
    };
    const stripe = {
      accounts: {
        retrieve: vi.fn(async () => ({
          id: 'acct_refresh_1',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          default_currency: 'cad',
          requirements: { disabled_reason: null },
        })),
      },
      accountLinks: {
        create: vi.fn(async () => ({ url: 'https://connect.stripe.test/update/acct_refresh_1' })),
      },
    };
    const app = await setupApp(tenantRoutes, makePrincipal(), tables, { stripe });
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/org_1/payment-accounts/pa_1/stripe-connect/refresh',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'pa_1',
      providerAccountId: 'acct_refresh_1',
      status: 'active',
      defaultCurrency: 'CAD',
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      requirements: { disabled_reason: null },
      disabledReason: null,
      onboardingUrl: 'https://connect.stripe.test/update/acct_refresh_1',
    });
    expect(tables.payment_accounts[0]).toMatchObject({
      status: 'active',
      default_currency: 'CAD',
      details_submitted: true,
      charges_enabled: true,
      payouts_enabled: true,
      disabled_reason: null,
    });
    expect(
      JSON.parse(
        String((tables.payment_accounts as Array<Record<string, unknown>>)[0].requirements),
      ),
    ).toMatchObject({
      disabled_reason: null,
    });
    expect(tables.audit_logs).toHaveLength(1);
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith('acct_refresh_1');
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_refresh_1',
      type: 'account_update',
      refresh_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=refresh',
      ),
      return_url: expect.stringContaining(
        '/settings/payments?organizationId=org_1&stripeConnect=return',
      ),
    });
    await app.close();
  });
});

describe('public checkout questions', () => {
  const publishedEvent = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
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

  it('resolves published custom-domain events by brand-scoped slug', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [
        {
          ...publishedEvent,
          id: 'evt_other',
          tenant_id: 'tnt_2',
          brand_id: 'br_other',
          slug: 'event',
        },
        publishedEvent,
      ],
      tenants: [
        { id: 'tnt_1', plan: 'pro' },
        { id: 'tnt_2', plan: 'pro' },
      ],
      brands: [
        { id: 'br_1', name: 'Brand', slug: 'brand', white_label: 1 },
        { id: 'br_other', name: 'Other Brand', slug: 'other-brand', white_label: 1 },
      ],
      brand_domains: [
        {
          id: 'bdom_1',
          brand_id: 'br_1',
          domain: 'events.example.com',
          is_primary: true,
          is_verified: 1,
          ssl_status: 'active',
        },
      ],
      marketing_integrations: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/public/events/by-slug/event?host=events.example.com',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'evt_1',
      slug: 'event',
      brandId: 'br_1',
    });
    await app.close();
  });

  it('does not resolve root slugs for brands without white-label enabled', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [publishedEvent],
      tenants: [{ id: 'tnt_1', plan: 'pro' }],
      brands: [{ id: 'br_1', name: 'Brand', slug: 'brand', white_label: 0 }],
      brand_domains: [
        {
          id: 'bdom_1',
          brand_id: 'br_1',
          domain: 'events.example.com',
          is_primary: true,
          is_verified: 1,
          ssl_status: 'active',
        },
      ],
      marketing_integrations: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/public/events/by-slug/event?host=events.example.com',
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('does not resolve root slugs for unverified custom domains', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [publishedEvent],
      tenants: [{ id: 'tnt_1', plan: 'pro' }],
      brands: [{ id: 'br_1', name: 'Brand', slug: 'brand', white_label: true }],
      brand_domains: [
        {
          id: 'bdom_1',
          brand_id: 'br_1',
          domain: 'events.example.com',
          is_primary: true,
          is_verified: false,
          ssl_status: 'pending',
        },
      ],
      marketing_integrations: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/public/events/by-slug/event?host=events.example.com',
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('does not resolve root slugs for free-plan tenants', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [publishedEvent],
      tenants: [{ id: 'tnt_1', plan: 'free' }],
      brands: [{ id: 'br_1', name: 'Brand', slug: 'brand', white_label: true }],
      brand_domains: [
        {
          id: 'bdom_1',
          brand_id: 'br_1',
          domain: 'events.example.com',
          is_primary: true,
          is_verified: true,
          ssl_status: 'active',
        },
      ],
      marketing_integrations: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/public/events/by-slug/event?host=events.example.com',
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('does not resolve root slugs for malformed host values', async () => {
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [publishedEvent],
      tenants: [{ id: 'tnt_1', plan: 'pro' }],
      brands: [{ id: 'br_1', name: 'Brand', slug: 'brand', white_label: true }],
      brand_domains: [
        {
          id: 'bdom_1',
          brand_id: 'br_1',
          domain: 'events.example.com',
          is_primary: true,
          is_verified: true,
          ssl_status: 'active',
        },
      ],
      marketing_integrations: [],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/public/events/by-slug/event?host=events.example.com%3Abad',
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

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
    expect(res.json().buyerQuestions.map((question: { id: string }) => question.id)).toEqual([
      'q_visible',
    ]);
    await app.close();
  });
});

describe('public access code validation', () => {
  it('records deduped widget impressions without storing raw visitor identifiers', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'br_1',
          slug: 'event',
          title: 'Event',
          description: null,
          status: 'published',
          timezone: 'America/New_York',
          starts_at: now,
          ends_at: null,
          venue: null,
        },
      ],
      widget_impressions: [],
    };
    const app = await setupApp(publicRoutes, makePrincipal(), tables);

    const res = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/widget-impressions',
      headers: { 'user-agent': 'vitest' },
      payload: {
        visitorId: 'visitor_123456',
        trackingId: 'utm-widget',
        affiliateCode: 'AFF123',
        host: 'example.test',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ tracked: true, deduped: false });
    const row = (tables.widget_impressions as Array<Record<string, unknown>>)[0];
    expect(row.event_id).toBe('evt_1');
    expect(row.tenant_id).toBe('tnt_1');
    expect(row.organization_id).toBe('org_1');
    expect(row.brand_id).toBe('br_1');
    expect(row.visitor_hash).toEqual(expect.any(String));
    expect(row.visitor_hash).not.toBe('visitor_123456');
    expect(row.tracking_id).toBe('utm-widget');
    expect(row.affiliate_code).toBe('AFF123');
    await app.close();
  });

  it('normalizes widget impression analytics URLs before persistence', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'br_1',
          slug: 'event',
          title: 'Event',
          description: null,
          status: 'published',
          timezone: 'America/New_York',
          starts_at: now,
          ends_at: null,
          venue: null,
        },
      ],
      widget_impressions: [],
    };
    const app = await setupApp(publicRoutes, makePrincipal(), tables);

    const pageUrlWithUserinfo = new URL('https://tickets.example.test/events/evt_1');
    pageUrlWithUserinfo.username = 'userinfo';
    pageUrlWithUserinfo.searchParams.set('email', 'buyer@example.test');
    pageUrlWithUserinfo.searchParams.set('token', 'checkout-token');
    pageUrlWithUserinfo.hash = 'payment';

    const res = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/widget-impressions',
      headers: { 'user-agent': 'vitest' },
      payload: {
        visitorId: 'visitor_123456',
        host: 'Tickets.Example.Test.',
        pageUrl: pageUrlWithUserinfo.toString(),
        referrer:
          'https://partner.example.test/campaigns/summer?email=referrer@example.test&token=ref-token#cta',
      },
    });

    expect(res.statusCode).toBe(201);
    const row = (tables.widget_impressions as Array<Record<string, unknown>>)[0];
    expect(row.host).toBe('tickets.example.test');
    expect(row.page_url).toBe('https://tickets.example.test/events/evt_1');
    expect(row.referrer).toBe('https://partner.example.test/campaigns/summer');
    expect(String(row.page_url)).not.toMatch(/[?#]|buyer@example\.test|checkout-token|userinfo@/);
    expect(String(row.referrer)).not.toMatch(/[?#]|referrer@example\.test|ref-token/);

    const invalidRes = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/widget-impressions',
      headers: { 'user-agent': 'vitest' },
      payload: {
        visitorId: 'visitor_abcdef',
        host: 'https://tickets.example.test/path?email=buyer@example.test&token=checkout-token#payment',
        pageUrl: 'javascript:alert("buyer@example.test")',
        referrer: 'not a url with token=ref-token',
      },
    });

    expect(invalidRes.statusCode).toBe(201);
    const invalidRow = (tables.widget_impressions as Array<Record<string, unknown>>)[1];
    expect(invalidRow.host).toBeNull();
    expect(invalidRow.page_url).toBeNull();
    expect(invalidRow.referrer).toBeNull();
    await app.close();
  });

  it('fails closed for widget impressions in production without a hash secret', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousHashSecret = process.env.WIDGET_IMPRESSION_HASH_SECRET;
    process.env.NODE_ENV = 'production';
    delete process.env.WIDGET_IMPRESSION_HASH_SECRET;

    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'br_1',
          slug: 'event',
          title: 'Event',
          description: null,
          status: 'published',
          timezone: 'America/New_York',
          starts_at: new Date('2026-06-01T00:00:00.000Z'),
          ends_at: null,
          venue: null,
        },
      ],
      widget_impressions: [],
    };
    const app = await setupApp(publicRoutes, makePrincipal(), tables);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/public/events/evt_1/widget-impressions',
        headers: { 'user-agent': 'vitest' },
        payload: { visitorId: 'visitor_123456' },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        error: {
          code: 'WIDGET_IMPRESSION_HASH_NOT_CONFIGURED',
          message: 'Widget impression hashing is not configured',
        },
      });
      expect(tables.widget_impressions).toHaveLength(0);
    } finally {
      await app.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousHashSecret === undefined) delete process.env.WIDGET_IMPRESSION_HASH_SECRET;
      else process.env.WIDGET_IMPRESSION_HASH_SECRET = previousHashSecret;
    }
  });

  it('dedupes widget impressions with different X-Forwarded-For values when trustProxy is disabled', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'br_1',
          slug: 'event',
          title: 'Event',
          description: null,
          status: 'published',
          timezone: 'America/New_York',
          starts_at: now,
          ends_at: null,
          venue: null,
        },
      ],
      widget_impressions: [],
    };
    const app = await setupApp(publicRoutes, makePrincipal(), tables);
    const payload = {
      trackingId: 'utm-widget',
      affiliateCode: 'AFF123',
      host: 'example.test',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/widget-impressions',
      headers: {
        'user-agent': 'vitest',
        'x-forwarded-for': '203.0.113.10',
      },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/widget-impressions',
      headers: {
        'user-agent': 'vitest',
        'x-forwarded-for': '203.0.113.11',
      },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ tracked: true, deduped: false });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ tracked: false, deduped: true });
    expect(tables.widget_impressions).toHaveLength(1);
    await app.close();
  });

  it('accepts a valid access code for a published locked ticket', async () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const app = await setupApp(publicRoutes, makePrincipal(), {
      events: [
        {
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
        },
      ],
      ticket_types: [
        {
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
        },
      ],
      access_rules: [
        {
          id: 'acr_1',
          ticket_type_id: 'tt_locked',
          type: 'access_code',
          value: 'VIP123',
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
      events: [
        {
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
        },
      ],
      ticket_types: [
        {
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
        },
      ],
      access_rules: [
        {
          id: 'acr_1',
          ticket_type_id: 'tt_locked',
          type: 'access_code',
          value: 'VIP123',
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
    const app = await setupApp(
      publicRoutes,
      makePrincipal(),
      {
        events: [
          {
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
          },
        ],
        ticket_types: [
          {
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
          },
        ],
        access_rules: [
          {
            id: 'acr_1',
            ticket_type_id: 'tt_locked',
            type: 'access_code',
            value: 'VIP123',
            max_uses: null,
            uses_count: 0,
            expires_at: null,
          },
        ],
      },
      {},
      { rateLimit: true },
    );

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
      events: [
        {
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
        },
      ],
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
    const now = new Date();
    const smsContent = publishedSmsContentRows(now);
    const tables = {
      events: [
        {
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
        },
      ],
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
          phone: '+15550000002',
          status: 'confirmed',
          custom_answers: null,
          checked_in_at: null,
          check_in_device_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      message_consents: [
        {
          id: 'msc_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          email: 'ada@test.com',
          phone: '+15550000002',
          email_opt_in: true,
          sms_opt_in: true,
          consent_text: 'Updates',
          consent_version: 'v1',
          consented_at: new Date(),
          revoked_at: null,
          created_at: new Date(),
        },
      ],
      sms_provider_routes: [
        {
          id: 'spr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_identity_id: 'ssi_1',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          webhook_url: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      content_documents: [smsContent.document],
      content_document_versions: [smsContent.version],
      sms_jobs: [],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_test_1' },
      payload: {
        smsTemplateKey: 'attendee-message',
        audience: 'all',
        channel: 'sms',
        variables: { body: 'Update' },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      status: 'queued',
      queuedSmsJobs: 1,
      queuedEmailJobs: 0,
    });
    expect((tables.sms_jobs as Array<{ body: string }>)[0].body).toContain(
      'Hi Ada Lovelace, Event starts',
    );
    await app.close();
  });

  it('POST /events/:eventId/messages excludes same-event attendees from another tenant', async () => {
    const now = new Date();
    const smsContent = publishedSmsContentRows(now);
    const validAttendee = {
      id: 'att_1',
      tenant_id: 'tnt_1',
      order_id: 'ord_1',
      event_id: 'evt_1',
      ticket_type_id: 'tt_1',
      ticket_id: 'tkt_1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@test.com',
      phone: '+15550000002',
      status: 'confirmed',
      custom_answers: null,
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    };
    const foreignTenantAttendee = {
      ...validAttendee,
      id: 'att_foreign',
      tenant_id: 'tnt_other',
      order_id: 'ord_foreign',
      ticket_id: 'tkt_foreign',
      first_name: 'Foreign',
      last_name: 'Guest',
      email: 'foreign@test.com',
      phone: '+15550000999',
    };
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      attendees: [validAttendee, foreignTenantAttendee],
      message_consents: [validAttendee, foreignTenantAttendee].map((attendee) => ({
        id: `msc_${attendee.id}`,
        tenant_id: 'tnt_1',
        attendee_id: attendee.id,
        email: attendee.email,
        phone: attendee.phone,
        email_opt_in: true,
        sms_opt_in: true,
        consent_text: 'Updates',
        consent_version: 'v1',
        consented_at: now,
        revoked_at: null,
        created_at: now,
      })),
      sms_provider_routes: [
        {
          id: 'spr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_identity_id: 'ssi_1',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          webhook_url: null,
          created_at: now,
          updated_at: now,
        },
      ],
      content_documents: [smsContent.document],
      content_document_versions: [smsContent.version],
      sms_jobs: [],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);

    const preview = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: { audience: 'all', channel: 'sms' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      audienceCount: 1,
      eligibleCount: 1,
      recipients: [expect.objectContaining({ id: 'att_1', phone: '+15550000002' })],
    });
    expect(JSON.stringify(preview.json())).not.toContain('foreign@test.com');
    expect(JSON.stringify(preview.json())).not.toContain('+15550000999');

    const send = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_tenant_scoped_audience' },
      payload: {
        smsTemplateKey: 'attendee-message',
        audience: 'all',
        channel: 'sms',
      },
    });
    expect(send.statusCode).toBe(202);
    expect(send.json()).toMatchObject({
      status: 'queued',
      audienceCount: 1,
      queuedSmsJobs: 1,
    });
    const smsJobs = tables.sms_jobs as Array<{ to_phone: string; variables: string }>;
    expect(smsJobs).toHaveLength(1);
    expect(smsJobs[0].to_phone).toBe('+15550000002');
    expect(JSON.parse(smsJobs[0].variables)).toMatchObject({ attendeeId: 'att_1' });

    await app.close();
  });

  it('POST /events/:eventId/messages rejects all-suppressed campaigns without persisting jobs', async () => {
    const now = new Date();
    const smsContent = publishedSmsContentRows(now);
    const tables = {
      events: [
        {
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
        },
      ],
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
          phone: '+15550000002',
          status: 'confirmed',
          custom_answers: null,
          checked_in_at: null,
          check_in_device_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      message_consents: [
        {
          id: 'msc_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          email: 'ada@test.com',
          phone: '+15550000002',
          email_opt_in: true,
          sms_opt_in: false,
          consent_text: 'Updates',
          consent_version: 'v1',
          consented_at: new Date(),
          revoked_at: null,
          created_at: new Date(),
        },
      ],
      sms_provider_routes: [
        {
          id: 'spr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_identity_id: 'ssi_1',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          webhook_url: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      sms_jobs: [],
      content_documents: [smsContent.document],
      content_document_versions: [smsContent.version],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_test_consent' },
      payload: { smsTemplateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      message: 'No eligible recipients for this message campaign',
    });
    expect(tables.sms_jobs).toHaveLength(0);
    expect(
      app.context.temporalClient.startSmsDelivery as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /events/:eventId/messages/preview uses backend eligibility for more than 100 recipients', async () => {
    const now = new Date();
    const attendees = Array.from({ length: 125 }, (_, index) => ({
      id: `att_${index}`,
      tenant_id: 'tnt_1',
      order_id: `ord_${index}`,
      event_id: 'evt_1',
      ticket_type_id: 'tt_1',
      ticket_id: `tkt_${index}`,
      first_name: 'Guest',
      last_name: String(index),
      email: `guest${index}@test.com`,
      phone: `+1555000${String(index).padStart(4, '0')}`,
      status: 'confirmed',
      custom_answers: null,
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    }));
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      attendees,
      message_consents: attendees.map((attendee) => ({
        id: `msc_${attendee.id}`,
        tenant_id: 'tnt_1',
        attendee_id: attendee.id,
        email: attendee.email,
        phone: attendee.phone,
        email_opt_in: true,
        sms_opt_in: true,
        consent_text: 'Updates',
        consent_version: 'v1',
        consented_at: now,
        revoked_at: null,
        created_at: now,
      })),
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: { audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      audience: 'all_attendees',
      audienceCount: 125,
      eligibleCount: 125,
      suppressedRecipients: 0,
      consentExclusions: 0,
    });
    expect(res.json().recipients).toHaveLength(25);
    await app.close();
  });

  it('POST /events/:eventId/messages/preview applies check-in and specific-recipient audiences', async () => {
    const now = new Date();
    const attendees = [
      {
        id: 'att_checked',
        tenant_id: 'tnt_1',
        order_id: 'ord_1',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        ticket_id: 'tkt_1',
        first_name: 'Checked',
        last_name: 'Guest',
        email: 'checked@test.com',
        phone: '+15550000001',
        status: 'checked_in',
        custom_answers: null,
        checked_in_at: now,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'att_waiting',
        tenant_id: 'tnt_1',
        order_id: 'ord_2',
        event_id: 'evt_1',
        ticket_type_id: 'tt_1',
        ticket_id: 'tkt_2',
        first_name: 'Waiting',
        last_name: 'Guest',
        email: 'waiting@test.com',
        phone: '+15550000002',
        status: 'confirmed',
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'att_other_event',
        tenant_id: 'tnt_1',
        order_id: 'ord_3',
        event_id: 'evt_other',
        ticket_type_id: 'tt_1',
        ticket_id: 'tkt_3',
        first_name: 'Other',
        last_name: 'Event',
        email: 'other@test.com',
        phone: '+15550000003',
        status: 'confirmed',
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      },
    ];
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      attendees,
      message_consents: attendees.map((attendee) => ({
        id: `msc_${attendee.id}`,
        tenant_id: 'tnt_1',
        attendee_id: attendee.id,
        email: attendee.email,
        phone: attendee.phone,
        email_opt_in: true,
        sms_opt_in: true,
        consent_text: 'Updates',
        consent_version: 'v1',
        consented_at: now,
        revoked_at: null,
        created_at: now,
      })),
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);

    const checkedIn = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: { audience: 'checked_in', channel: 'sms' },
    });
    expect(checkedIn.statusCode).toBe(200);
    expect(checkedIn.json().recipients.map((recipient: { id: string }) => recipient.id)).toEqual([
      'att_checked',
    ]);

    const notCheckedIn = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: { audience: 'not_checked_in', channel: 'sms' },
    });
    expect(notCheckedIn.statusCode).toBe(200);
    expect(notCheckedIn.json().recipients.map((recipient: { id: string }) => recipient.id)).toEqual(
      ['att_waiting'],
    );

    const specific = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: {
        audience: 'specific',
        attendeeIds: ['att_waiting', 'att_other_event'],
        channel: 'sms',
      },
    });
    expect(specific.statusCode).toBe(200);
    expect(specific.json().recipients.map((recipient: { id: string }) => recipient.id)).toEqual([
      'att_waiting',
    ]);
    await app.close();
  });

  it('POST /events/:eventId/messages/preview reports suppression and consent exclusions', async () => {
    const now = new Date();
    const attendee = {
      id: 'att_1',
      tenant_id: 'tnt_1',
      order_id: 'ord_1',
      event_id: 'evt_1',
      ticket_type_id: 'tt_1',
      ticket_id: 'tkt_1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@test.com',
      phone: '+15550000002',
      status: 'confirmed',
      custom_answers: null,
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    };
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      attendees: [attendee],
      message_consents: [
        {
          id: 'msc_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          email: 'ada@test.com',
          phone: '+15550000002',
          email_opt_in: false,
          sms_opt_in: true,
          consent_text: 'Updates',
          consent_version: 'v1',
          consented_at: now,
          revoked_at: null,
          created_at: now,
        },
      ],
      email_suppressions: [
        {
          id: 'esu_1',
          tenant_id: 'tnt_1',
          email: 'ada@test.com',
          reason: 'bounce',
          bounce_type: 'hard',
          source: 'provider',
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: { audience: 'all', channel: 'email' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      audienceCount: 1,
      eligibleCount: 0,
      suppressedRecipients: 1,
      consentExclusions: 1,
    });
    await app.close();
  });

  it('POST /events/:eventId/messages/preview reports missing channel contacts as skipped', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
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
          email: null,
          phone: '+15550000002',
          status: 'confirmed',
          custom_answers: null,
          checked_in_at: null,
          check_in_device_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
      message_consents: [
        {
          id: 'msc_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          email: '',
          phone: '+15550000002',
          email_opt_in: true,
          sms_opt_in: true,
          consent_text: 'Updates',
          consent_version: 'v1',
          consented_at: now,
          revoked_at: null,
          created_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: { audience: 'all', channel: 'email' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      audienceCount: 1,
      eligibleCount: 0,
      suppressedRecipients: 0,
      consentExclusions: 0,
      skippedRecipients: 1,
      recipients: [],
    });
    await app.close();
  });

  it('POST /events/:eventId/messages/preview and send share mixed-channel eligibility decisions', async () => {
    const now = new Date();
    const smsContent = publishedSmsContentRows(now);
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
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
          phone: '+15550000002',
          status: 'confirmed',
          custom_answers: null,
          checked_in_at: null,
          check_in_device_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
      message_consents: [
        {
          id: 'msc_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          email: 'ada@test.com',
          phone: '+15550000002',
          email_opt_in: true,
          sms_opt_in: false,
          consent_text: 'Updates',
          consent_version: 'v1',
          consented_at: now,
          revoked_at: null,
          created_at: now,
        },
      ],
      content_documents: [
        {
          id: 'cdoc_msg_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          channel: 'email',
          key: 'attendee-email',
          name: 'Attendee email',
          status: 'published',
          locale: 'en',
          current_draft_version_id: null,
          published_version_id: 'cver_msg_1',
          created_at: now,
          updated_at: now,
        },
        smsContent.document,
      ],
      content_document_versions: [
        {
          id: 'cver_msg_1',
          document_id: 'cdoc_msg_1',
          version_number: 1,
          status: 'published',
          schema_version: 1,
          subject: 'Update',
          preview_text: null,
          content_json: '{}',
          rendered_html: '<p>Update</p>',
          rendered_text: 'Update',
          variables: '[]',
          validation: '{"valid":true,"severity":"warning","issues":[]}',
          created_by: 'usr_1',
          created_at: now,
          published_at: now,
        },
        smsContent.version,
      ],
      email_provider_routes: [
        {
          id: 'epr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_domain: 'example.com',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          created_at: now,
          updated_at: now,
        },
      ],
      sms_provider_routes: [
        {
          id: 'spr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_identity_id: 'ssi_1',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          webhook_url: null,
          created_at: now,
          updated_at: now,
        },
      ],
      email_jobs: [],
      sms_jobs: [],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const previewPayload = { audience: 'all', channel: 'both' };
    const sendPayload = {
      emailTemplateKey: 'attendee-email',
      smsTemplateKey: 'attendee-message',
      audience: 'all',
      channel: 'both',
    };

    const preview = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/preview',
      payload: previewPayload,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      audienceCount: 1,
      eligibleCount: 1,
      suppressedRecipients: 1,
      consentExclusions: 1,
      skippedRecipients: 0,
      recipients: [{ id: 'att_1' }],
    });

    const send = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_preview_parity' },
      payload: sendPayload,
    });
    expect(send.statusCode, send.body).toBe(202);
    expect(send.json()).toMatchObject({
      audienceCount: preview.json().audienceCount,
      suppressedRecipients: preview.json().suppressedRecipients,
      consentExclusions: preview.json().consentExclusions,
      skippedRecipients: preview.json().skippedRecipients,
      queuedEmailJobs: 1,
      queuedSmsJobs: 0,
    });
    expect(tables.email_jobs).toHaveLength(1);
    expect(tables.sms_jobs).toHaveLength(0);
    expect((tables.email_jobs as Array<{ template_key: string }>)[0].template_key).toBe(
      'attendee-email',
    );
    expect(
      JSON.parse((tables.email_jobs as Array<{ variables: string }>)[0].variables),
    ).toMatchObject({
      campaignAudience: 'all',
      campaignEmailTemplateKey: 'attendee-email',
      campaignSmsTemplateKey: 'attendee-message',
      campaignAudienceAttendeeIds: [],
      campaignAudienceCount: 1,
      campaignSuppressedRecipients: 1,
      campaignConsentExclusions: 1,
      campaignSkippedRecipients: 0,
    });
    expect(
      app.context.temporalClient.startSmsDelivery as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /events/:eventId/messages queues the published content email version when available', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
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
          phone: '+15550000002',
          status: 'confirmed',
          custom_answers: null,
          checked_in_at: null,
          check_in_device_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
      message_consents: [
        {
          id: 'msc_1',
          tenant_id: 'tnt_1',
          attendee_id: 'att_1',
          email: 'ada@test.com',
          phone: '+15550000002',
          email_opt_in: true,
          sms_opt_in: true,
          consent_text: 'Updates',
          consent_version: 'v1',
          consented_at: now,
          revoked_at: null,
          created_at: now,
        },
      ],
      content_documents: [
        {
          id: 'cdoc_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          channel: 'email',
          key: 'attendee-message',
          name: 'Attendee message',
          status: 'published',
          locale: 'en',
          current_draft_version_id: null,
          published_version_id: 'cver_email_1',
          created_at: now,
          updated_at: now,
        },
      ],
      content_document_versions: [
        {
          id: 'cver_email_1',
          document_id: 'cdoc_1',
          version_number: 1,
          status: 'published',
          schema_version: 1,
          subject: 'Event update',
          preview_text: 'Preview',
          content_json: '{}',
          rendered_html: '<p>Update</p>',
          rendered_text: 'Update',
          variables: '[]',
          validation: '{"valid":true,"severity":"warning","issues":[]}',
          created_by: 'usr_1',
          created_at: now,
          published_at: now,
        },
      ],
      email_provider_routes: [
        {
          id: 'epr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_domain: 'example.com',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          created_at: now,
          updated_at: now,
        },
      ],
      email_jobs: [],
    };
    const startNotificationDelivery = vi.fn();
    const app = await setupApp(messagingRoutes, makePrincipal(), tables, {
      temporalClient: { startNotificationDelivery },
    });

    const send = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_content_email' },
      payload: {
        emailTemplateKey: 'attendee-message',
        audience: 'all',
        channel: 'email',
        variables: {
          body: 'Doors open at 6pm.',
          event: { title: 'Client supplied title' },
          recipient: { email: 'client-supplied@example.test' },
        },
      },
    });

    expect(send.statusCode, send.body).toBe(202);
    expect(send.json()).toMatchObject({
      queuedEmailJobs: 1,
      queuedSmsJobs: 0,
    });
    expect(tables.email_jobs).toHaveLength(1);
    expect(
      (tables.email_jobs as Array<{ template_version_id: string }>)[0].template_version_id,
    ).toBe('cver_email_1');
    const emailVariables = JSON.parse(
      (tables.email_jobs as Array<{ variables: string }>)[0].variables,
    );
    expect(emailVariables).toMatchObject({
      body: 'Doors open at 6pm.',
      attendeeId: 'att_1',
      eventId: 'evt_1',
      notificationType: 'bulk',
      event: {
        title: 'Event',
        startsAt: now.toISOString(),
        timezone: 'UTC',
      },
      recipient: {
        name: 'Ada Lovelace',
        email: 'ada@test.com',
        phone: '+15550000002',
      },
      attendee: {
        name: 'Ada Lovelace',
        checkedIn: false,
      },
    });
    expect(startNotificationDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: 'attendee-message',
        templateVersionId: 'cver_email_1',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        variables: expect.objectContaining({
          body: 'Doors open at 6pm.',
          event: expect.objectContaining({ title: 'Event', timezone: 'UTC' }),
          recipient: expect.objectContaining({
            name: 'Ada Lovelace',
            email: 'ada@test.com',
          }),
          attendee: expect.objectContaining({ checkedIn: false }),
        }),
      }),
    );
    await app.close();
  });

  it('GET /events/:eventId/messages returns persisted campaign summaries', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          id: 'smj_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          to_phone: '+15550000002',
          body: 'Update',
          template_key: 'attendee-message',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_1',
            notificationType: 'bulk',
            campaignAudience: 'checked_in',
            campaignAudienceCount: 7,
          }),
          provider_route_id: 'spr_1',
          status: 'queued',
          priority: 'low',
          scheduled_at: null,
          idempotency_key: 'msg_campaign:sms:att_1',
          workflow_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      id: 'msg_campaign',
      eventId: 'evt_1',
      channel: 'sms',
      status: 'queued',
      audience: 'checked_in',
      audienceKey: 'checked_in',
      audienceLabel: 'Checked in',
      audienceAttendeeIds: [],
      audienceCount: 7,
      queuedSmsJobs: 1,
    });
    await app.close();
  });

  it('GET /events/:eventId/messages serializes specific-audience metadata for reload labels', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          id: 'smj_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          to_phone: '+15550000002',
          body: 'Update',
          template_key: 'attendee-message',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_1',
            notificationType: 'bulk',
            campaignAudience: 'specific',
            campaignAudienceAttendeeIds: ['att_1', 'att_2'],
            campaignAudienceCount: 2,
          }),
          provider_route_id: 'spr_1',
          status: 'queued',
          priority: 'low',
          scheduled_at: null,
          idempotency_key: 'msg_specific:sms:att_1',
          workflow_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/messages' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      id: 'msg_specific',
      audience: 'custom',
      audienceKey: 'specific',
      audienceLabel: 'Custom (2 attendees)',
      audienceAttendeeIds: ['att_1', 'att_2'],
      audienceCount: 2,
    });
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId returns jobs and deliveries', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          id: 'smj_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          to_phone: '+15550000002',
          body: 'Update',
          template_key: 'attendee-message',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_1',
            notificationType: 'bulk',
          }),
          provider_route_id: 'spr_1',
          status: 'sent',
          priority: 'low',
          scheduled_at: null,
          idempotency_key: 'msg_detail:sms:att_1',
          workflow_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
      sms_deliveries: [
        {
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
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_detail' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'msg_detail',
      status: 'sent',
      smsJobs: [{ id: 'smj_1', recipient: '***0002' }],
      smsDeliveries: [{ id: 'smd_1' }],
    });
    expect(JSON.stringify(res.json())).not.toContain('+15550000002');
    expect(JSON.stringify(res.json())).not.toContain('"body"');
    expect(JSON.stringify(res.json())).not.toContain('"variables"');
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId treats LIKE metacharacters as literals', async () => {
    const now = new Date();
    const baseJob = {
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      to_phone: '+15550000002',
      body: 'Update',
      template_key: 'attendee-message',
      variables: JSON.stringify({
        eventId: 'evt_1',
        attendeeId: 'att_1',
        notificationType: 'bulk',
      }),
      provider_route_id: 'spr_1',
      status: 'queued',
      priority: 'low',
      scheduled_at: null,
      workflow_id: null,
      created_at: now,
      updated_at: now,
    };
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          ...baseJob,
          id: 'smj_literal',
          idempotency_key: 'msg_%:sms:att_1',
        },
        {
          ...baseJob,
          id: 'smj_wildcard_neighbor',
          to_phone: '+15550000003',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_2',
            notificationType: 'bulk',
          }),
          idempotency_key: 'msg_ab:sms:att_2',
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_%25' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: 'msg_%',
      smsJobs: [{ id: 'smj_literal' }],
    });
    expect(res.json().smsJobs.map((job: { id: string }) => job.id)).toEqual(['smj_literal']);

    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId requires an exact derived campaign id', async () => {
    const now = new Date();
    const baseJob = {
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      to_phone: '+15550000002',
      body: 'Update',
      template_key: 'attendee-message',
      variables: JSON.stringify({
        eventId: 'evt_1',
        attendeeId: 'att_1',
        notificationType: 'bulk',
      }),
      provider_route_id: 'spr_1',
      status: 'queued',
      priority: 'low',
      scheduled_at: null,
      workflow_id: null,
      created_at: now,
      updated_at: now,
    };
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          ...baseJob,
          id: 'smj_colon_campaign',
          idempotency_key: 'msg:foo:sms:att_1',
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);

    const prefixRes = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg' });
    expect(prefixRes.statusCode).toBe(400);
    expect(prefixRes.json().message).toBe('Message campaign not found');

    const exactRes = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg%3Afoo' });
    expect(exactRes.statusCode).toBe(200);
    expect(exactRes.json()).toMatchObject({
      id: 'msg:foo',
      smsJobs: [{ id: 'smj_colon_campaign' }],
    });

    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId/jobs lists and details persisted campaign jobs', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          id: 'smj_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          to_phone: '+15550000002',
          body: 'Update',
          template_key: 'attendee-message',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_1',
            notificationType: 'bulk',
          }),
          provider_route_id: 'spr_1',
          status: 'queued',
          priority: 'low',
          scheduled_at: null,
          idempotency_key: 'msg_jobs:sms:att_1',
          workflow_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const list = await app.inject({ method: 'GET', url: '/events/evt_1/messages/msg_jobs/jobs' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([
      {
        channel: 'sms',
        campaignId: 'msg_jobs',
        job: { id: 'smj_1', recipient: '***0002', template_key: 'attendee-message' },
      },
    ]);
    expect(JSON.stringify(list.json())).not.toContain('+15550000002');
    expect(JSON.stringify(list.json())).not.toContain('"body"');
    expect(JSON.stringify(list.json())).not.toContain('"variables"');
    expect(JSON.stringify(list.json())).not.toContain('"idempotency_key"');

    const detail = await app.inject({
      method: 'GET',
      url: '/events/evt_1/messages/msg_jobs/jobs/sms/smj_1',
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      channel: 'sms',
      campaignId: 'msg_jobs',
      job: { id: 'smj_1', recipient: '***0002', template_key: 'attendee-message' },
    });
    expect(JSON.stringify(detail.json())).not.toContain('+15550000002');
    expect(JSON.stringify(detail.json())).not.toContain('"body"');
    expect(JSON.stringify(detail.json())).not.toContain('"variables"');
    expect(JSON.stringify(detail.json())).not.toContain('"idempotency_key"');
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId/delivery-logs scopes list and detail to campaign deliveries', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          id: 'smj_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          to_phone: '+15550000002',
          body: 'Update',
          template_key: 'attendee-message',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_1',
            notificationType: 'bulk',
          }),
          provider_route_id: 'spr_1',
          status: 'sent',
          priority: 'low',
          scheduled_at: null,
          idempotency_key: 'msg_logs:sms:att_1',
          workflow_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
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
    const list = await app.inject({
      method: 'GET',
      url: '/events/evt_1/messages/msg_logs/delivery-logs',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ channel: 'sms', delivery: { id: 'smd_1' } });

    const detail = await app.inject({
      method: 'GET',
      url: '/events/evt_1/messages/msg_logs/delivery-logs/sms/smd_1',
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      channel: 'sms',
      delivery: { id: 'smd_1', status: 'delivered' },
    });
    await app.close();
  });

  it('GET /events/:eventId/messages/:campaignId/provider-events lists and details persisted SMS provider events', async () => {
    const now = new Date();
    const tables = {
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
          slug: 'evt',
          title: 'Event',
          timezone: 'UTC',
          starts_at: now,
          visibility: 'public',
          seo: '{}',
        },
      ],
      sms_jobs: [
        {
          id: 'smj_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          to_phone: '+15550000002',
          body: 'Update',
          template_key: 'attendee-message',
          variables: JSON.stringify({
            eventId: 'evt_1',
            attendeeId: 'att_1',
            notificationType: 'bulk',
          }),
          provider_route_id: 'spr_1',
          status: 'sent',
          priority: 'low',
          scheduled_at: null,
          idempotency_key: 'msg_events:sms:att_1',
          workflow_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
      sms_deliveries: [
        {
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
        },
      ],
      sms_provider_events: [
        {
          id: 'spe_1',
          tenant_id: 'tnt_1',
          provider: 'telnyx',
          provider_event_id: 'evt_provider_1',
          event_type: 'message.sent',
          provider_message_id: 'provider_1',
          raw_payload: JSON.stringify({ data: { id: 'evt_provider_1' } }),
          processed_at: now,
          created_at: now,
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const list = await app.inject({
      method: 'GET',
      url: '/events/evt_1/messages/msg_events/provider-events',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toMatchObject([
      { channel: 'sms', event: { id: 'spe_1', event_type: 'message.sent' } },
    ]);
    expect(JSON.stringify(list.json())).not.toContain('raw_payload');
    expect(JSON.stringify(list.json())).not.toContain('"data"');

    const detail = await app.inject({
      method: 'GET',
      url: '/events/evt_1/messages/msg_events/provider-events/spe_1',
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      channel: 'sms',
      event: { id: 'spe_1', provider_event_id: 'evt_provider_1' },
    });
    expect(JSON.stringify(detail.json())).not.toContain('raw_payload');
    expect(JSON.stringify(detail.json())).not.toContain('"data"');
    await app.close();
  });

  it('POST /events/:eventId/messages requires attendeeIds for specific audience', async () => {
    const tables = {
      events: [
        {
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
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_test_2' },
      payload: { emailTemplateKey: 'attendee-message', audience: 'specific', channel: 'email' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /events/:eventId/messages requires Idempotency-Key', async () => {
    const tables = {
      events: [
        {
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
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      payload: { smsTemplateKey: 'attendee-message', audience: 'all', channel: 'sms' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /events/:eventId/messages rejects no-recipient campaigns without fake success', async () => {
    const tables = {
      events: [
        {
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
        },
      ],
      attendees: [],
      sms_provider_routes: [
        {
          id: 'spr_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_identity_id: 'ssi_1',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          webhook_url: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(messagingRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages',
      headers: { 'Idempotency-Key': 'msg_no_recipients' },
      payload: { smsTemplateKey: 'attendee-message', audience: 'all', channel: 'sms' },
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
      tickets: [
        {
          id: 'tkt_1',
          tenant_id: 'tnt_1',
          order_id: 'ord_1',
          attendee_id: 'att_1',
          event_id: 'evt_1',
          ticket_type_id: 'tt_1',
          status: 'valid',
          code: 'CODE',
          qr_payload: 'payload',
          qr_hash: 'hash',
        },
      ],
      events: [
        {
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
        },
      ],
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
      events: [
        {
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
        },
      ],
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

describe('resale listing routes', () => {
  const principal = () => makePrincipal({ scopes: [...makePrincipal().scopes, 'tickets.write'] });
  const now = new Date('2026-01-01T00:00:00.000Z');
  const event = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    status: 'published',
    slug: 'evt',
    title: 'Event',
    currency: 'USD',
    timezone: 'UTC',
    starts_at: now,
    ends_at: null,
    visibility: 'public',
    seo: '{}',
    resale_enabled: true,
    resale_max_multiplier: 1.2,
    resale_max_absolute_cents: null,
    created_at: now,
    updated_at: now,
  };
  const ticketType = {
    id: 'tt_1',
    event_id: 'evt_1',
    name: 'GA',
    kind: 'paid',
    status: 'active',
    visibility: 'public',
    currency: 'USD',
    price_cents: 5000,
    inventory_pool_id: 'pool_1',
    min_per_order: 1,
    max_per_order: 10,
    sort_order: 0,
    requires_access_code: false,
    created_at: now,
    updated_at: now,
  };
  const ticket = {
    id: 'tkt_1',
    tenant_id: 'tnt_1',
    order_id: 'ord_1',
    attendee_id: 'att_1',
    event_id: 'evt_1',
    ticket_type_id: 'tt_1',
    event_occurrence_id: null,
    status: 'valid',
    code: 'CODE',
    qr_payload: 'payload',
    qr_hash: 'hash',
    transferred_to_email: null,
    transferred_at: null,
    checked_in_at: null,
    checked_in_by_device_id: null,
    wallet_pass_id: null,
    created_at: now,
    updated_at: now,
  };

  it('reads and updates persisted event resale policy', async () => {
    const tables = { events: [{ ...event, resale_enabled: false, resale_max_multiplier: 1 }] };
    const app = await setupApp(ticketingRoutes, principal(), tables);

    const read = await app.inject({ method: 'GET', url: '/events/evt_1/resale-policy' });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({ enabled: false, maxMultiplier: 1 });

    const update = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/resale-policy',
      payload: { enabled: true, maxMultiplier: 1.1, maxAbsoluteCents: 5500 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({
      enabled: true,
      maxMultiplier: 1.1,
      maxAbsoluteCents: 5500,
    });
    expect((tables.events[0] as Record<string, unknown>).resale_enabled).toBe(true);
    await app.close();
  });

  it('creates a resale listing once and replays the same idempotency key', async () => {
    const tables = {
      events: [event],
      tickets: [ticket],
      ticket_types: [ticketType],
      ticket_listings: [] as Record<string, unknown>[],
    };
    const app = await setupApp(ticketingRoutes, principal(), tables);

    const first = await app.inject({
      method: 'POST',
      url: '/tickets/tkt_1/resale-listings',
      headers: { 'Idempotency-Key': 'resale_idem_1' },
      payload: { priceCents: 5500 },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json();
    expect(firstBody).toMatchObject({
      eventId: 'evt_1',
      ticketId: 'tkt_1',
      sellerId: 'ord_1',
      status: 'listed',
      priceCents: 5500,
      faceValueCents: 5000,
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/tickets/tkt_1/resale-listings',
      headers: { 'Idempotency-Key': 'resale_idem_1' },
      payload: { priceCents: 5500 },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(firstBody.id);
    expect(tables.ticket_listings).toHaveLength(1);
    await app.close();
  });

  it('rejects resale listings without idempotency or above the event cap', async () => {
    const tables = {
      events: [event],
      tickets: [ticket],
      ticket_types: [ticketType],
      ticket_listings: [] as Record<string, unknown>[],
    };
    const app = await setupApp(ticketingRoutes, principal(), tables);

    const missingKey = await app.inject({
      method: 'POST',
      url: '/tickets/tkt_1/resale-listings',
      payload: { priceCents: 5500 },
    });
    expect(missingKey.statusCode).toBe(400);

    const capped = await app.inject({
      method: 'POST',
      url: '/tickets/tkt_1/resale-listings',
      headers: { 'Idempotency-Key': 'resale_cap_1' },
      payload: { priceCents: 6001 },
    });
    expect(capped.statusCode).toBe(400);
    expect(tables.ticket_listings).toHaveLength(0);
    await app.close();
  });

  it('lists and delists active resale listings', async () => {
    const listing = {
      id: 'lst_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      ticket_id: 'tkt_1',
      seller_id: 'usr_1',
      status: 'listed',
      price_cents: 5500,
      currency: 'USD',
      face_value_cents: 5000,
      sold_to_id: null,
      active_listing_key: 'tkt_1',
      expires_at: null,
      sold_at: null,
      created_at: now,
      updated_at: now,
    };
    const tables = {
      events: [event],
      ticket_listings: [listing],
    };
    const app = await setupApp(ticketingRoutes, principal(), tables);

    const list = await app.inject({ method: 'GET', url: '/events/evt_1/resale-listings' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].id).toBe('lst_1');

    const delist = await app.inject({
      method: 'POST',
      url: '/ticket-listings/lst_1/delist',
      headers: { 'Idempotency-Key': 'resale_delist_1' },
    });
    expect(delist.statusCode).toBe(200);
    expect(delist.json()).toMatchObject({ id: 'lst_1', status: 'delisted' });
    expect(listing.active_listing_key).toBe('lst_1');
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

  it('POST /events/:eventId/questions creates file questions', async () => {
    const app = await setupApp(questionRoutes, makePrincipal(), { events: [event] });
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions',
      payload: { type: 'file', label: 'Upload waiver', appliesTo: 'buyer' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      type: 'file',
      label: 'Upload waiver',
      appliesTo: 'buyer',
    });
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
    expect(invalidOptions.json().message).toContain(
      'text questions cannot define selectable options',
    );
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
      questions: [
        customQuestionRow({
          type: 'waiver',
          label: 'Waiver',
          is_consent_field: true,
          consent_text: 'Version one text',
          consent_version: 'v1',
        }),
      ],
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
      attendees: [
        {
          id: 'att_1',
          event_id: 'evt_1',
          custom_answers: JSON.stringify({ q_1: 'Ada Lovelace' }),
        },
      ],
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
  it('PATCH /checkout/sessions/:sessionId rejects open sessions that already have a payment intent', async () => {
    const session = {
      id: 'cs_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      brand_id: 'brd_1',
      status: 'open',
      currency: 'USD',
      quote: { totalCents: 2500, subtotalCents: 2500, discountCents: 0, taxCents: 0, feeCents: 0 },
      buyer: { email: 'buyer@test.com' },
      cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
      expires_at: new Date(Date.now() + 60000),
      hold_id: 'hld_1',
      order_id: null,
      client_token: 'tok_1',
      success_url: null,
      cancel_url: null,
      idempotency_key: 'key_1',
      payment_intent_id: 'pi_1',
    };
    const tables = {
      checkout_sessions: [session],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'PATCH',
      url: '/checkout/sessions/cs_1',
      headers: { 'x-checkout-session-token': 'tok_1' },
      payload: { buyer: { email: 'updated@test.com' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('payment is in progress');
    expect(session.buyer).toEqual({ email: 'buyer@test.com' });
    await app.close();
  });

  it('GET /checkout/sessions/:sessionId accepts native JSON session columns', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'open',
          currency: 'USD',
          quote: {
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          },
          buyer: { email: 'buyer@test.com' },
          cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: null,
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
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

  it('GET /checkout/sessions/:sessionId omits bearer token on tokenless completed reads', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'completed',
          currency: 'USD',
          quote: {
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          },
          buyer: { email: 'buyer@test.com' },
          cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: 'ord_1',
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);

    const tokenless = await app.inject({
      method: 'GET',
      url: '/checkout/sessions/cs_1',
    });
    expect(tokenless.statusCode).toBe(200);
    expect(tokenless.json()).not.toHaveProperty('clientToken');

    const withToken = await app.inject({
      method: 'GET',
      url: '/checkout/sessions/cs_1',
      headers: { 'x-checkout-session-token': 'tok_1' },
    });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.json().clientToken).toBe('tok_1');
    await app.close();
  });

  it('GET /checkout/sessions/:sessionId/wallet-passes requires the checkout session token', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'completed',
          currency: 'USD',
          quote: {
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          },
          buyer: { email: 'buyer@test.com' },
          cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: 'ord_1',
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'GET',
      url: '/checkout/sessions/cs_1/wallet-passes',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('X-Checkout-Session-Token header is required');
    await app.close();
  });

  it('GET /checkout/sessions/:sessionId accepts matching Stripe client secret for pending confirmation', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'pending_payment',
          currency: 'USD',
          quote: {
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          },
          buyer: { email: 'buyer@test.com' },
          cart: { items: [{ ticketTypeId: 'tt_1', quantity: 1 }] },
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: null,
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
      payment_intents: [
        {
          id: 'pi_db_1',
          checkout_session_id: 'cs_1',
          client_secret: 'pi_secret_123',
        },
      ],
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
    expect(body).not.toHaveProperty('clientToken');
    await app.close();
  });

  it('POST /checkout/sessions/:sessionId/confirm handles duplicate completed session', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'completed',
          currency: 'USD',
          quote: JSON.stringify({
            totalCents: 0,
            subtotalCents: 0,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          }),
          buyer: JSON.stringify({ email: 'buyer@test.com' }),
          cart: JSON.stringify({ items: [] }),
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: 'ord_1',
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
      events: [
        {
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
        },
      ],
      orders: [
        {
          id: 'ord_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          order_number: 'TK-1',
          status: 'paid',
          currency: 'USD',
          total_cents: 0,
          subtotal_cents: 0,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          refunded_cents: 0,
          buyer_email: 'buyer@test.com',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
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

  it('POST /checkout/sessions/:sessionId/confirm replays completed sessions after expiry', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'completed',
          currency: 'USD',
          quote: JSON.stringify({
            totalCents: 0,
            subtotalCents: 0,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          }),
          buyer: JSON.stringify({ email: 'buyer@test.com' }),
          cart: JSON.stringify({ items: [] }),
          expires_at: new Date(Date.now() - 60000),
          hold_id: 'hld_1',
          order_id: 'ord_1',
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
      events: [
        {
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
        },
      ],
      orders: [
        {
          id: 'ord_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          order_number: 'TK-1',
          status: 'paid',
          currency: 'USD',
          total_cents: 0,
          subtotal_cents: 0,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          refunded_cents: 0,
          buyer_email: 'buyer@test.com',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables);
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_1/confirm',
      headers: { 'idempotency-key': 'key-2', 'x-checkout-session-token': 'tok_1' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('completed');
    expect(body.order.id).toBe('ord_1');
    await app.close();
  });

  it('POST /checkout/sessions/:sessionId/confirm requires retry when pending workflow failed with stale payment details', async () => {
    const startCheckoutSession = vi.fn();
    const getCheckoutState = vi.fn(async () => ({
      status: 'failed',
      paymentIntentId: 'pi_stale_1',
      clientSecret: 'cs_stale_1',
      error: 'Payment was cancelled and must be retried.',
    }));
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'pending_payment',
          currency: 'USD',
          quote: JSON.stringify({
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          }),
          buyer: JSON.stringify({ email: 'buyer@test.com' }),
          cart: JSON.stringify({ items: [{ ticketTypeId: 'tt_1', quantity: 1 }] }),
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: null,
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
      events: [
        {
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
        },
      ],
      idempotency_records: [],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_1/confirm',
      headers: { 'idempotency-key': 'key-2', 'x-checkout-session-token': 'tok_1' },
      payload: {},
    });

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body).not.toHaveProperty('paymentIntentId');
    expect(body).not.toHaveProperty('clientSecret');
    expect(body.error).toMatchObject({
      code: 'PAYMENT_RETRY_REQUIRED',
      message: 'Payment was cancelled and must be retried.',
    });
    expect(getCheckoutState).toHaveBeenCalledWith('checkout-session:cs_1');
    expect(startCheckoutSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('POST /checkout/sessions/:sessionId/confirm falls back to attached PaymentIntent when Temporal query is transiently unavailable', async () => {
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'open',
          currency: 'USD',
          quote: JSON.stringify({
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          }),
          buyer: JSON.stringify({ email: 'buyer@test.com' }),
          cart: JSON.stringify({ items: [{ ticketTypeId: 'tt_1', quantity: 1 }] }),
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: null,
          payment_intent_id: null,
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
      events: [
        {
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
        },
      ],
      payment_intents: [
        {
          id: 'pi_db_1',
          tenant_id: 'tnt_1',
          checkout_session_id: 'cs_1',
          provider_intent_id: 'pi_provider_1',
          amount_cents: 2500,
          currency: 'USD',
          status: 'requires_payment_method',
          client_secret: 'pi_provider_1_secret_123',
        },
      ],
      idempotency_records: [],
    };
    const startCheckoutSession = vi.fn(async () => {
      Object.assign((tables.checkout_sessions as Array<Record<string, unknown>>)[0], {
        status: 'pending_payment',
        payment_intent_id: 'pi_db_1',
      });
      return {
        workflowId: 'checkout-session:cs_1',
        result: async () => ({ status: 'completed', orderId: 'ord_1' }),
      };
    });
    const getCheckoutState = vi.fn(async () => {
      throw new Error('Failed to query Workflow');
    });
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_1/confirm',
      headers: { 'idempotency-key': 'key-2', 'x-checkout-session-token': 'tok_1' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: 'cs_1',
      status: 'pending_payment',
      paymentIntentId: 'pi_provider_1',
      clientSecret: 'pi_provider_1_secret_123',
      totalCents: 2500,
      currency: 'USD',
    });
    expect(startCheckoutSession).toHaveBeenCalledOnce();
    expect(getCheckoutState).toHaveBeenCalledWith('checkout-session:cs_1');
    await app.close();
  });

  it('POST /checkout/sessions/:sessionId/confirm finalizes local capture intents server-side', async () => {
    const startCheckoutSession = vi.fn(async () => ({
      workflowId: 'checkout-session:cs_1',
      result: async () => ({ status: 'completed', orderId: 'ord_1' }),
    }));
    const tables = {
      checkout_sessions: [
        {
          id: 'cs_1',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          brand_id: 'brd_1',
          status: 'open',
          currency: 'USD',
          quote: JSON.stringify({
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          }),
          buyer: JSON.stringify({ email: 'buyer@test.com' }),
          cart: JSON.stringify({ items: [{ ticketTypeId: 'tt_1', quantity: 1 }] }),
          expires_at: new Date(Date.now() + 60000),
          hold_id: 'hld_1',
          order_id: null,
          client_token: 'tok_1',
          success_url: null,
          cancel_url: null,
          idempotency_key: 'key_1',
        },
      ],
      events: [
        {
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
        },
      ],
      orders: [
        {
          id: 'ord_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          order_number: 'TK-1',
          status: 'paid',
          currency: 'USD',
          total_cents: 2500,
          subtotal_cents: 2500,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          refunded_cents: 0,
          buyer_email: 'buyer@test.com',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
      idempotency_records: [],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState: vi.fn(async () => ({
          paymentIntentId: 'pi_capture_cs_1',
          clientSecret: 'pi_capture_cs_1_secret',
          status: 'payment_pending',
        })),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_1/confirm',
      headers: { 'idempotency-key': 'key-2', 'x-checkout-session-token': 'tok_1' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: 'cs_1',
      status: 'completed',
      order: { id: 'ord_1', status: 'paid' },
    });
    expect(startCheckoutSession).toHaveBeenCalledTimes(1);
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

  it('persists matched access-rule redemptions for locked checkout sessions', async () => {
    const lockedTicketType = {
      ...paidTicketType,
      id: 'tt_locked',
      inventory_pool_id: 'inv_locked',
      visibility: 'locked',
      requires_access_code: true,
    };
    const tables = pricingTables({
      ticket_types: [lockedTicketType],
      access_rules: [
        {
          id: 'ar_vip',
          ticket_type_id: 'tt_locked',
          type: 'access_code',
          value: 'VIP123',
          max_uses: 1,
          uses_count: 0,
          expires_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const res = await postPricingCheckoutSession(
      {
        items: [{ ticketTypeId: 'tt_locked', quantity: 1 }],
        accessCode: 'VIP123',
      },
      tables,
    );

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const storedCart = JSON.parse(storedSession.cart) as Record<string, unknown>;
    expect(storedCart).toMatchObject({
      accessRuleRedemptions: [{ accessRuleId: 'ar_vip', ticketTypeId: 'tt_locked' }],
    });
    expect(storedCart).not.toHaveProperty('accessCode');
  });

  it('rejects checkout session creation for private published events without reserving inventory', async () => {
    const tables = pricingTables({
      events: [{ ...baseEvent, visibility: 'private' }],
    });
    const res = await postPricingCheckoutSession({}, tables);

    expect(res.statusCode).toBe(404);
    expect(tables.checkout_sessions).toEqual([]);
  });

  it('rejects client-supplied unit amounts for paid tickets', async () => {
    const res = await postPricingCheckoutSession({
      items: [{ ticketTypeId: 'tt_paid', quantity: 1, unitAmountCents: 1 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain(
      'unitAmountCents is only accepted for donation ticket tt_paid',
    );
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
      checkout_sessions: [
        {
          id: 'cs_pricing',
          tenant_id: 'tnt_1',
          event_id: 'evt_pricing',
          brand_id: 'brd_1',
          status: 'open',
          hold_id: 'hld_1',
          currency: 'USD',
          cart: JSON.stringify({
            items: [{ ticketTypeId: 'tt_paid', quantity: 2 }],
            affiliateCode: 'AFF1',
          }),
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
        },
      ],
      events: [baseEvent],
      orders: [],
      idempotency_records: [],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState: vi.fn(async () => ({
          paymentIntentId: 'pi_1',
          clientSecret: 'cs_1',
          status: 'pending_payment',
        })),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_pricing/confirm',
      headers: {
        'idempotency-key': 'confirm_tampered_totals',
        'x-checkout-session-token': 'tok_pricing',
      },
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
      checkout_sessions: [
        {
          id: 'cs_pricing',
          tenant_id: 'tnt_1',
          event_id: 'evt_pricing',
          brand_id: 'brd_1',
          status: 'open',
          hold_id: 'hld_1',
          currency: 'USD',
          cart: JSON.stringify({
            items: [{ ticketTypeId: 'tt_paid', quantity: 2 }],
            affiliateCode: 'AFF1',
          }),
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
        },
      ],
      events: [baseEvent],
      orders: [],
      idempotency_records: [],
    };
    const app = await setupApp(checkoutRoutes, makePrincipal(), tables, {
      temporalClient: {
        startCheckoutSession,
        getCheckoutState: vi.fn(async () => ({
          paymentIntentId: 'pi_1',
          clientSecret: 'cs_1',
          status: 'pending_payment',
        })),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/checkout/sessions/cs_pricing/confirm',
      headers: {
        'idempotency-key': 'confirm_authoritative_quote',
        'x-checkout-session-token': 'tok_pricing',
      },
      payload: { paymentMethodId: 'pm_card_visa' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: 'cs_pricing',
      status: 'pending_payment',
      totalCents: 16800,
      currency: 'USD',
    });
    expect(startCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: 'cs_pricing',
        amountCents: 16800,
        feeCents: 300,
        affiliateCode: 'AFF1',
      }),
    );
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

  async function postCheckoutSession(
    tables: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
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
        checkoutQuestion({
          id: 'q_parent',
          type: 'select',
          label: 'Bring a guest?',
          options: JSON.stringify(['yes', 'no']),
          applies_to: 'buyer',
        }),
        checkoutQuestion({
          id: 'q_guest',
          label: 'Guest name',
          applies_to: 'buyer',
          conditional_visibility: JSON.stringify({
            field: 'q_parent',
            operator: 'equals',
            value: 'yes',
          }),
        }),
        checkoutQuestion({
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
        checkoutQuestion({
          id: 'q_parent',
          type: 'select',
          label: 'Bring a guest?',
          options: JSON.stringify(['yes', 'no']),
          applies_to: 'buyer',
        }),
        checkoutQuestion({
          id: 'q_guest',
          label: 'Guest name',
          applies_to: 'buyer',
          conditional_visibility: JSON.stringify({
            field: 'q_parent',
            operator: 'equals',
            value: 'yes',
          }),
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
        checkoutQuestion({
          id: 'q_hidden',
          label: 'Hidden required',
          status: 'hidden',
          is_hidden: true,
        }),
        checkoutQuestion({ id: 'q_deleted', label: 'Deleted required', deleted_at: new Date() }),
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
      questions: [
        checkoutQuestion({ id: 'q_attendee_name', label: 'Attendee name', applies_to: 'attendee' }),
      ],
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

  it('rejects malformed stored select question options without leaking parser errors', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_bad_options',
          type: 'select',
          label: 'Meal preference',
          options: '{not-json',
          applies_to: 'buyer',
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: { q_bad_options: 'VIP' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Meal preference has an invalid option');
    expect(tables.checkout_sessions).toHaveLength(0);
  });

  it('persists normalized attendee answers without raw hidden attendee fields', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_attendee_parent',
          type: 'select',
          label: 'Needs accommodation?',
          options: JSON.stringify(['yes', 'no']),
          applies_to: 'attendee',
        }),
        checkoutQuestion({
          id: 'q_attendee_hidden',
          label: 'Accommodation detail',
          applies_to: 'attendee',
          conditional_visibility: JSON.stringify({
            field: 'q_attendee_parent',
            operator: 'equals',
            value: 'yes',
          }),
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [
            {
              q_attendee_parent: 'no',
              q_attendee_hidden: 'raw stale accommodation text',
            },
          ],
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const cart = JSON.parse(storedSession.cart) as {
      items: Array<{ attendeeFields?: unknown }>;
      attendeeFields: Record<string, unknown[]>;
    };
    expect(cart.items[0].attendeeFields).toEqual([{ q_attendee_parent: 'no' }]);
    expect(cart.attendeeFields.tt_1).toEqual([{ q_attendee_parent: 'no' }]);
    expect(storedSession.cart).not.toContain('q_attendee_hidden');
    expect(storedSession.cart).not.toContain('raw stale accommodation text');
  });

  it('persists sanitized attendee answers per normalized cart line when ticket types repeat', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_attendee_name',
          label: 'Attendee name',
          applies_to: 'attendee',
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      items: [
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ q_attendee_name: 'Ada Lovelace' }],
        },
        {
          ticketTypeId: 'tt_1',
          quantity: 1,
          attendeeFields: [{ q_attendee_name: 'Grace Hopper' }],
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const cart = JSON.parse(storedSession.cart) as {
      items: Array<{ quantity: number; attendeeFields?: unknown }>;
      attendeeFields: Record<string, unknown[]>;
    };
    expect(cart.items).toEqual([
      expect.objectContaining({
        quantity: 2,
        attendeeFields: [{ q_attendee_name: 'Ada Lovelace' }, { q_attendee_name: 'Grace Hopper' }],
      }),
    ]);
    expect(cart.attendeeFields.tt_1).toEqual([
      { q_attendee_name: 'Ada Lovelace' },
      { q_attendee_name: 'Grace Hopper' },
    ]);
  });

  it('persists sanitized attendee answers per occurrence when ticket types repeat', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      event_occurrences: [
        checkoutOccurrence('occ_morning', new Date(Date.now() + 86_400_000)),
        checkoutOccurrence('occ_evening', new Date(Date.now() + 90_000_000)),
      ],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_attendee_name',
          label: 'Attendee name',
          applies_to: 'attendee',
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      items: [
        {
          ticketTypeId: 'tt_1',
          occurrenceId: 'occ_morning',
          quantity: 1,
          attendeeFields: [{ q_attendee_name: 'Morning buyer' }],
        },
        {
          ticketTypeId: 'tt_1',
          occurrenceId: 'occ_evening',
          quantity: 1,
          attendeeFields: [{ q_attendee_name: 'Evening buyer' }],
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const cart = JSON.parse(storedSession.cart) as {
      items: Array<{ occurrenceId?: string; attendeeFields?: unknown }>;
      attendeeFields: Record<string, unknown[]>;
    };
    expect(cart.items).toEqual([
      expect.objectContaining({
        occurrenceId: 'occ_morning',
        attendeeFields: [{ q_attendee_name: 'Morning buyer' }],
      }),
      expect.objectContaining({
        occurrenceId: 'occ_evening',
        attendeeFields: [{ q_attendee_name: 'Evening buyer' }],
      }),
    ]);
    expect(cart.attendeeFields.tt_1).toEqual([
      { q_attendee_name: 'Morning buyer' },
      { q_attendee_name: 'Evening buyer' },
    ]);
  });

  it('rejects raw file question answers during checkout session creation', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_file',
          type: 'file',
          label: 'Upload waiver',
          applies_to: 'buyer',
          required: false,
        }),
      ],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: { q_file: 'waiver.pdf' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('must reference a completed upload artifact');
  });

  it('accepts completed clean file upload artifact answers during checkout session creation', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_file',
          type: 'file',
          label: 'Upload waiver',
          applies_to: 'buyer',
          required: true,
        }),
      ],
      upload_artifacts: [
        {
          id: 'upl_clean',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
          consumed_by_checkout_session_id: null,
          consumed_at: null,
        },
      ],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: {
        q_file: {
          artifactId: 'upl_clean',
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const storedSession = (tables.checkout_sessions as Array<{ cart: string }>)[0];
    const cart = JSON.parse(storedSession.cart) as {
      buyerFields: Record<string, { artifactId: string }>;
    };
    expect(cart.buyerFields.q_file.artifactId).toBe('upl_clean');
  });

  it('rejects required file question artifacts uploaded for another question during checkout session creation', async () => {
    const tables = {
      events: [baseEvent],
      ticket_types: [baseTicketType],
      checkout_sessions: [],
      idempotency_records: [],
      questions: [
        checkoutQuestion({
          id: 'q_file',
          type: 'file',
          label: 'Upload waiver',
          applies_to: 'buyer',
          required: true,
        }),
      ],
      upload_artifacts: [
        {
          id: 'upl_mismatch',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_other' }),
          consumed_by_checkout_session_id: null,
          consumed_at: null,
        },
      ],
    };

    const res = await postCheckoutSession(tables, {
      buyerFields: {
        q_file: {
          artifactId: 'upl_mismatch',
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('different question');
    expect(tables.checkout_sessions).toHaveLength(0);
  });
});

describe('POST /events/:eventId/messages/render-preview (C-076/C-077 merge-tag preview)', () => {
  const event = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    slug: 'event',
    title: 'Summer Showcase',
    description: null,
    status: 'published',
    timezone: 'America/New_York',
    starts_at: new Date('2026-07-04T19:00:00.000Z'),
    ends_at: null,
    venue: null,
    brand_id: 'br_1',
  };

  const sampleContext = {
    recipient: { name: 'Jordan Lee' },
    event: { title: 'Summer Showcase', venueCity: 'Brooklyn' },
    ticket: { type: 'General Admission', code: 'TKT-ABC123' },
    brand: { name: 'Acme Events' },
  };

  it('renders email templates with HTML-escaped merge tags and reports unknown tags', async () => {
    const app = await setupApp(messagingRoutes, makePrincipal(), { events: [event] });
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/render-preview',
      payload: {
        channel: 'email',
        subjectTemplate: 'Hi {{recipient.name}}, your ticket is ready',
        htmlTemplate: '<p>Welcome {{recipient.name}} to {{event.title}}! {{bogus.tag}}</p>',
        context: {
          ...sampleContext,
          recipient: { name: '<script>alert(1)</script>' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.channel).toBe('email');
    expect(json.subject).toBe('Hi <script>alert(1)</script>, your ticket is ready');
    expect(json.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(json.html).toContain('Summer Showcase');
    expect(json.validation.valid).toBe(false);
    expect(json.validation.unknownTags).toEqual(['bogus.tag']);
    await app.close();
  });

  it('renders SMS templates, injects opt-out token, and counts segments', async () => {
    const app = await setupApp(messagingRoutes, makePrincipal(), { events: [event] });
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/render-preview',
      payload: {
        channel: 'sms',
        subjectTemplate: 'Hi {{recipient.name}}, ticket {{ticket.code}} ready',
        textTemplate: 'Hi {{recipient.name}}, ticket {{ticket.code}} ready',
        context: sampleContext,
        optOutToken: 'Reply STOP to opt out',
      },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.text).toBe('Hi Jordan Lee, ticket TKT-ABC123 ready. Reply STOP to opt out');
    expect(json.segments).toMatchObject({ encoding: 'gsm' });
    expect(json.segments.segments).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('rejects requests without messages.write permission', async () => {
    const app = await setupApp(messagingRoutes, makePrincipal({ scopes: ['events.read'] }), {
      events: [event],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/render-preview',
      payload: { channel: 'email', htmlTemplate: '<p>Hi {{recipient.name}}</p>' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects malformed render-preview payloads before rendering merge tags', async () => {
    const app = await setupApp(messagingRoutes, makePrincipal(), { events: [event] });
    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/messages/render-preview',
      payload: {
        channel: 'email',
        subjectTemplate: 123,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Invalid message render preview request');

    await app.close();
  });
});
