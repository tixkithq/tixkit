import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import { eventRoutes, isVenueForeignKeyError } from '../routes/modules/events.js';

function createEventListDb(
  rows: Record<string, unknown>[],
  thumbnailRows: Record<string, unknown>[] = [],
) {
  const whereCalls: unknown[][] = [];
  let countAlias: string | null = null;
  const query = {
    selectAll() {
      return query;
    },
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
      return query;
    },
    where(...args: unknown[]) {
      whereCalls.push(args);
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    async execute() {
      return rows;
    },
    async executeTakeFirst() {
      if (countAlias) return { [countAlias]: rows.length };
      return rows[0];
    },
  };
  // Mock query for stats aggregation tables (orders, tickets) – returns empty
  // results so computeEventStats produces zeroes without breaking the test.
  const emptyStatsQuery = {
    select() {
      return emptyStatsQuery;
    },
    innerJoin() {
      return emptyStatsQuery;
    },
    where(...args: unknown[]) {
      whereCalls.push(args);
      return emptyStatsQuery;
    },
    groupBy() {
      return emptyStatsQuery;
    },
    execute() {
      return Promise.resolve([]);
    },
  };
  const thumbnailQuery = {
    select() {
      return thumbnailQuery;
    },
    innerJoin() {
      return thumbnailQuery;
    },
    where(...args: unknown[]) {
      whereCalls.push(args);
      return thumbnailQuery;
    },
    execute() {
      return Promise.resolve(thumbnailRows);
    },
  };
  return {
    whereCalls,
    db: {
      selectFrom(table: string) {
        if (table === 'events') return query;
        if (table === 'event_media_renditions as rendition') return thumbnailQuery;
        return emptyStatsQuery;
      },
    } as unknown as Database,
  };
}

function baseEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    slug: 'event',
    title: 'Event',
    description: null,
    status: 'draft',
    currency: 'USD',
    timezone: 'America/New_York',
    starts_at: new Date('2026-07-01T00:00:00.000Z'),
    ends_at: null,
    venue: null,
    visibility: 'public',
    seo: JSON.stringify({}),
    capacity: null,
    cover_image_url: null,
    external_url: null,
    pass_fees_to_buyer: false,
    version: 1,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createEventMutationDb(
  seed: {
    event?: Record<string, unknown>;
    brand?: Record<string, unknown>;
    concurrentMarketingIntegration?: Record<string, unknown>;
    concurrentMarketingIntegrationError?: unknown;
    concurrentMarketingIntegrationSystemTimeAfterInsert?: Date;
    marketingIntegrations?: Record<string, unknown>[];
    marketingIntegrationAfterRecoveryUpdate?: Record<string, unknown>;
    feeRules?: Record<string, unknown>[];
  } = {},
) {
  const rows: Record<string, Record<string, unknown>[]> = {
    events: seed.event ? [seed.event] : [],
    brands: [
      seed.brand ?? {
        id: 'brd_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        name: 'Brand',
        slug: 'brand',
      },
    ],
    audit_logs: [],
    marketing_integrations: seed.marketingIntegrations ? [...seed.marketingIntegrations] : [],
    fee_rules: seed.feeRules ? [...seed.feeRules] : [],
  };
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  function selectFrom(table: string) {
    const conditions: Array<[string, unknown]> = [];
    const query = {
      select() {
        return query;
      },
      selectAll() {
        return query;
      },
      where(column: string, _op: string, value: unknown) {
        conditions.push([column, value]);
        return query;
      },
      limit() {
        return query;
      },
      forUpdate() {
        return query;
      },
      executeTakeFirst() {
        const found = (rows[table] ?? []).find((row) =>
          conditions.every(([column, value]) => row[column] === value),
        );
        return Promise.resolve(found);
      },
      execute() {
        return Promise.resolve(
          (rows[table] ?? []).filter((row) =>
            conditions.every(([column, value]) => row[column] === value),
          ),
        );
      },
      executeTakeFirstOrThrow() {
        return query.executeTakeFirst().then((row) => {
          if (!row) throw new Error(`No mock row for ${table}`);
          return row;
        });
      },
    };
    return query;
  }

  function insertInto(table: string) {
    return {
      values(values: Record<string, unknown> | Record<string, unknown>[]) {
        const valueRows = Array.isArray(values) ? values : [values];
        const insertRows = valueRows.map((value) =>
          table === 'events' ? baseEventRow(value) : value,
        );
        const row = insertRows[0];
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              rows[table] ??= [];
              rows[table].push(...insertRows);
              inserted.push(...insertRows);
              return row;
            },
          }),
          execute: async () => {
            if (table === 'marketing_integrations' && seed.concurrentMarketingIntegration) {
              rows.marketing_integrations.push(seed.concurrentMarketingIntegration);
              if (seed.concurrentMarketingIntegrationSystemTimeAfterInsert) {
                vi.setSystemTime(seed.concurrentMarketingIntegrationSystemTimeAfterInsert);
              }
              throw (
                seed.concurrentMarketingIntegrationError ??
                Object.assign(new Error('duplicate key value violates unique constraint'), {
                  code: '23505',
                })
              );
            }
            rows[table] ??= [];
            rows[table].push(...insertRows);
            inserted.push(...insertRows);
          },
        };
      },
    };
  }

  function updateTable(table: string) {
    return {
      set(values: Record<string, unknown>) {
        const conditions: Array<[string, unknown]> = [];
        const updateQuery = {
          where(column: string, _op: string, value: unknown) {
            conditions.push([column, value]);
            return updateQuery;
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              const row = (rows[table] ?? []).find((entry) =>
                conditions.every(([column, value]) => entry[column] === value),
              );
              if (!row) throw new Error(`No mock row for ${table} update`);
              Object.assign(row, values);
              updates.push(values);
              return { ...row };
            },
          }),
          execute: async () => {
            const row = (rows[table] ?? []).find((entry) =>
              conditions.every(([column, value]) => entry[column] === value),
            );
            if (!row) return { numUpdatedRows: BigInt(0) };
            Object.assign(row, values);
            updates.push(values);
            if (
              table === 'marketing_integrations' &&
              seed.marketingIntegrationAfterRecoveryUpdate
            ) {
              Object.assign(row, seed.marketingIntegrationAfterRecoveryUpdate);
            }
            return { numUpdatedRows: BigInt(1) };
          },
          executeTakeFirst: async () => updateQuery.execute(),
        };
        return updateQuery;
      },
    };
  }

  function deleteFrom(table: string) {
    return {
      where(column: string, _op: string, value: unknown) {
        return {
          execute: async () => {
            const before = rows[table] ?? [];
            rows[table] = before.filter((row) => row[column] !== value);
            return {
              numDeletedRows: BigInt(before.length - rows[table].length),
            };
          },
        };
      },
    };
  }

  const db = {
    selectFrom,
    insertInto,
    updateTable,
    deleteFrom,
    transaction: () => {
      const transaction = {
        setIsolationLevel: () => transaction,
        execute: async <T>(operation: (trx: Database) => Promise<T>) =>
          operation(db as unknown as Database),
      };
      return transaction;
    },
  } as unknown as Database;

  return {
    rows,
    inserted,
    updates,
    db,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function setupEventApp(
  db: Database,
  principal: Principal,
  readinessResult: {
    launchable: boolean;
    eventVersion: number;
    requiredBlockers: unknown[];
    recommendedWarnings: unknown[];
  } = {
    launchable: true,
    eventVersion: 1,
    requiredBlockers: [],
    recommendedWarnings: [],
  },
  beforeReadinessReturn?: () => void,
) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
    readinessServiceFactory: () =>
      ({
        getEventLaunchReadiness: async () => {
          beforeReadinessReturn?.();
          return readinessResult;
        },
      }) as never,
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(eventRoutes);
  return app;
}

describe('event routes', () => {
  const writePrincipal: Principal = {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.read', 'events.write'],
  };

  it('recognizes PostgreSQL, MySQL, and MSSQL venue foreign-key errors', () => {
    expect(isVenueForeignKeyError({ code: '23503' })).toBe(true);
    expect(isVenueForeignKeyError({ code: 'ER_NO_REFERENCED_ROW_2' })).toBe(true);
    expect(isVenueForeignKeyError({ code: 'EREQUEST', number: 547 })).toBe(true);
    expect(
      isVenueForeignKeyError({
        cause: { code: 'EREQUEST', originalError: { number: 547 } },
      }),
    ).toBe(true);
    expect(isVenueForeignKeyError({ code: 'EREQUEST', number: 2627 })).toBe(false);
  });

  it('accepts only bounded privacy-safe onboarding telemetry', async () => {
    const { db } = createEventMutationDb();
    const app = await setupEventApp(db, writePrincipal);

    const accepted = await app.inject({
      method: 'POST',
      url: '/onboarding-events',
      payload: {
        stage: 'autosave_failure',
        outcome: 'failed',
        reasonCode: 'request_failed',
      },
    });
    expect(accepted.statusCode).toBe(204);

    const rejected = await app.inject({
      method: 'POST',
      url: '/onboarding-events',
      payload: {
        stage: 'autosave_failure',
        outcome: 'failed',
        reasonCode: 'database_error_with_email@example.com',
        eventTitle: 'Sensitive title',
      },
    });
    expect(rejected.statusCode).toBe(400);
    await app.close();
  });

  it('persists currency when creating events', async () => {
    const { db, inserted } = createEventMutationDb();
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        slug: 'eur-event',
        title: 'EUR Event',
        currency: 'EUR',
        timezone: 'Europe/Paris',
        startsAt: '2026-07-01T00:00:00.000Z',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(inserted.find((row) => row.slug === 'eur-event')?.currency).toBe('EUR');
    expect(response.json().currency).toBe('EUR');
    await app.close();
  });

  it('rejects arbitrary media URLs during draft creation', async () => {
    const { db } = createEventMutationDb();
    const app = await setupEventApp(db, writePrincipal);
    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        slug: 'unsafe-media',
        title: 'Unsafe',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: '2027-01-01T00:00:00.000Z',
        coverImageUrl: 'https://unowned.example/cover.jpg',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects non-canonical SEO image keys during draft creation', async () => {
    const { db } = createEventMutationDb();
    const app = await setupEventApp(db, writePrincipal);
    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        slug: 'unsafe-seo',
        title: 'Unsafe SEO',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: '2027-01-01T00:00:00.000Z',
        seo: { socialImageUrl: 'https://unowned.example/social.jpg' },
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects arbitrary media URLs during event updates', async () => {
    const { db } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, writePrincipal);
    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
        expectedVersion: 1,
        coverImageUrl: 'https://unowned.example/cover.jpg',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('rejects duplicate event slugs within the same brand', async () => {
    const { db } = createEventMutationDb({
      event: baseEventRow({
        id: 'evt_existing',
        brand_id: 'brd_1',
        slug: 'event',
      }),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        slug: 'event',
        title: 'Duplicate Event',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-07-01T00:00:00.000Z',
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('allows the same event slug on a different brand', async () => {
    const { db, inserted } = createEventMutationDb({
      event: baseEventRow({
        id: 'evt_existing',
        brand_id: 'brd_other',
        slug: 'event',
      }),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        slug: 'event',
        title: 'Brand Event',
        currency: 'USD',
        timezone: 'America/New_York',
        startsAt: '2026-07-01T00:00:00.000Z',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(inserted.find((row) => row.title === 'Brand Event')).toMatchObject({
      brand_id: 'brd_1',
      slug: 'event',
    });
    await app.close();
  });

  it('persists currency when updating events', async () => {
    const { db, updates } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
        expectedVersion: 1,
        title: 'Updated Event',
        currency: 'GBP',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().currency).toBe('GBP');
    expect(updates.some((update) => update.currency === 'GBP')).toBe(true);
    expect(updates.some((update) => update.checkout_configuration_updated_at instanceof Date)).toBe(
      true,
    );
    await app.close();
  });

  it('rejects status changes through generic event PATCH', async () => {
    const { db, updates } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
        expectedVersion: 1,
        status: 'paused',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Use the dedicated publish, pause, or archive endpoint to change event status',
    });
    expect(updates.some((update) => update.status === 'paused')).toBe(false);
    await app.close();
  });

  it('rejects stale event PATCH without overwriting the current event', async () => {
    const { db, updates } = createEventMutationDb({
      event: baseEventRow({ version: 3 }),
    });
    const app = await setupEventApp(db, writePrincipal);
    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: { expectedVersion: 2, title: 'Stale title' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'stale_event_version',
        details: { expectedVersion: 2, currentVersion: 3 },
      },
    });
    expect(updates.some((update) => update.title === 'Stale title')).toBe(false);
    await app.close();
  });

  it('returns the current event fee policy', async () => {
    const { db } = createEventMutationDb({
      event: baseEventRow({ pass_fees_to_buyer: true }),
      feeRules: [
        {
          id: 'fee_1',
          event_id: 'evt_1',
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          applied_to: 'per_ticket',
          absorb_into_price: false,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/fee-policy',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      eventId: 'evt_1',
      passFeesToBuyer: true,
      rules: [
        {
          id: 'fee_1',
          eventId: 'evt_1',
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          appliedTo: 'per_ticket',
          absorbIntoPrice: false,
        },
      ],
    });
    await app.close();
  });

  it('returns the saved pass-through setting when no fee rules exist', async () => {
    const { db } = createEventMutationDb({
      event: baseEventRow({ pass_fees_to_buyer: true }),
      feeRules: [],
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/fee-policy',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      eventId: 'evt_1',
      passFeesToBuyer: true,
      rules: [],
    });
    await app.close();
  });

  it('replaces the event fee policy and marks rules as buyer-paid or absorbed', async () => {
    const { db, inserted, updates } = createEventMutationDb({
      event: baseEventRow({ pass_fees_to_buyer: true }),
      feeRules: [
        {
          id: 'fee_old',
          event_id: 'evt_1',
          name: 'Old fee',
          type: 'fixed',
          value: 100,
          applied_to: 'per_order',
          absorb_into_price: false,
        },
      ],
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/fee-policy',
      payload: {
        expectedVersion: 1,
        passFeesToBuyer: false,
        rules: [
          {
            name: 'Organizer paid service fee',
            type: 'fixed',
            value: 250,
            appliedTo: 'per_order',
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      eventId: 'evt_1',
      passFeesToBuyer: false,
      rules: [
        {
          name: 'Organizer paid service fee',
          type: 'fixed',
          value: 250,
          appliedTo: 'per_order',
          absorbIntoPrice: true,
        },
      ],
    });
    expect(inserted).toContainEqual(
      expect.objectContaining({
        event_id: 'evt_1',
        name: 'Organizer paid service fee',
        absorb_into_price: true,
      }),
    );
    expect(updates).toContainEqual(expect.objectContaining({ pass_fees_to_buyer: false }));
    expect(inserted).toContainEqual(
      expect.objectContaining({
        action: 'event.fee_policy_updated',
        resource_type: 'Event',
        resource_id: 'evt_1',
      }),
    );
    await app.close();
  });

  it('saves pass-through setting without creating fee rules', async () => {
    const { db, inserted, updates } = createEventMutationDb({
      event: baseEventRow({ pass_fees_to_buyer: false }),
      feeRules: [],
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/fee-policy',
      payload: {
        expectedVersion: 1,
        passFeesToBuyer: true,
        rules: [],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      eventId: 'evt_1',
      passFeesToBuyer: true,
      rules: [],
    });
    expect(updates).toContainEqual(expect.objectContaining({ pass_fees_to_buyer: true }));
    expect(inserted).not.toContainEqual(expect.objectContaining({ event_id: 'evt_1' }));
    expect(inserted).toContainEqual(
      expect.objectContaining({
        action: 'event.fee_policy_updated',
        resource_type: 'Event',
        resource_id: 'evt_1',
      }),
    );
    await app.close();
  });

  it('writes an audit entry when publishing through the lifecycle endpoint', async () => {
    const { db, inserted, updates } = createEventMutationDb({
      event: baseEventRow(),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_1/publish',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('published');
    expect(updates).toContainEqual(expect.objectContaining({ status: 'published' }));
    expect(inserted).toContainEqual(
      expect.objectContaining({
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        actor_type: 'user',
        actor_id: 'usr_1',
        action: 'event.published',
        resource_type: 'Event',
        resource_id: 'evt_1',
      }),
    );
    await app.close();
  });

  it('returns structured launch blockers and does not publish when preflight fails', async () => {
    const { db, updates } = createEventMutationDb({ event: baseEventRow() });
    const blocker = {
      id: 'sellable_tickets',
      status: 'incomplete',
      priority: 'required',
      reasonCodes: ['sellable_ticket_missing'],
      actionId: 'manage_tickets',
      requiredPermission: 'tickets.write',
      updatedAt: null,
      acknowledgedAt: null,
    };
    const app = await setupEventApp(db, writePrincipal, {
      launchable: false,
      eventVersion: 1,
      requiredBlockers: [blocker],
      recommendedWarnings: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_1/publish',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'launch_readiness_failed',
        details: { requiredBlockers: [blocker] },
      },
    });
    expect(updates).not.toContainEqual(expect.objectContaining({ status: 'published' }));
    await app.close();
  });

  it('rejects publish when the event version changes during preflight', async () => {
    const { db, rows, updates } = createEventMutationDb({
      event: baseEventRow(),
    });
    const app = await setupEventApp(
      db,
      writePrincipal,
      {
        launchable: true,
        eventVersion: 1,
        requiredBlockers: [],
        recommendedWarnings: [],
      },
      () => {
        rows.events[0]!.version = 2;
      },
    );

    const response = await app.inject({
      method: 'POST',
      url: '/events/evt_1/publish',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'stale_event_version',
        details: { expectedVersion: 1, currentVersion: 2 },
      },
    });
    expect(updates).not.toContainEqual(expect.objectContaining({ status: 'published' }));
    await app.close();
  });

  it('persists full event detail fields when updating events through PATCH', async () => {
    const { db, updates } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
        expectedVersion: 1,
        venue: {
          name: 'Riverside',
          address: '100 River Walk',
          city: 'Austin',
          region: 'TX',
          postalCode: '78701',
          country: 'US',
        },
        visibility: 'unlisted',
        seo: { title: 'Search title', description: 'Search description' },
        capacity: 250,
        externalUrl: 'https://events.example.test/detail',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      venue: {
        name: 'Riverside',
        address: '100 River Walk',
        city: 'Austin',
        region: 'TX',
        postalCode: '78701',
        country: 'US',
      },
      visibility: 'unlisted',
      seo: { title: 'Search title', description: 'Search description' },
      capacity: 250,
      externalUrl: 'https://events.example.test/detail',
    });
    expect(updates).toContainEqual(
      expect.objectContaining({
        venue: JSON.stringify({
          name: 'Riverside',
          address: '100 River Walk',
          city: 'Austin',
          region: 'TX',
          postalCode: '78701',
          country: 'US',
        }),
        visibility: 'unlisted',
        seo: JSON.stringify({
          title: 'Search title',
          description: 'Search description',
        }),
        capacity: 250,
        external_url: 'https://events.example.test/detail',
      }),
    );
    await app.close();
  });

  it('clears nullable event detail fields when PATCH sends null', async () => {
    const { db, updates } = createEventMutationDb({
      event: baseEventRow({
        ends_at: new Date('2026-07-02T00:00:00.000Z'),
        venue: JSON.stringify({ name: 'Riverside' }),
        capacity: 250,
        cover_image_url: 'https://cdn.example.test/cover.jpg',
        external_url: 'https://events.example.test/detail',
      }),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
        expectedVersion: 1,
        endsAt: null,
        venue: null,
        capacity: null,
        coverImageUrl: null,
        externalUrl: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().venue).toBeNull();
    expect(updates).toContainEqual(
      expect.objectContaining({
        ends_at: null,
        venue: null,
        capacity: null,
        cover_image_url: null,
        external_url: null,
      }),
    );
    await app.close();
  });

  it('upserts GA4 marketing integrations for an event', async () => {
    const { db, inserted } = createEventMutationDb({
      event: baseEventRow({ status: 'published' }),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-TEST123' },
        consentRequired: true,
        status: 'active',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(inserted).toContainEqual(
      expect.objectContaining({
        event_id: 'evt_1',
        provider: 'ga4',
        config: JSON.stringify({ measurementId: 'G-TEST123' }),
        consent_required: true,
        status: 'active',
      }),
    );
    expect(response.json()).toMatchObject({
      provider: 'ga4',
      config: { measurementId: 'G-TEST123' },
      consentRequired: true,
      status: 'active',
    });
    await app.close();
  });

  it('rejects unsupported marketing integration config fields', async () => {
    const { db, inserted } = createEventMutationDb({
      event: baseEventRow({ status: 'published' }),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-TEST123', apiKey: 'secret-key' },
        consentRequired: true,
        status: 'active',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(inserted).toHaveLength(0);
    await app.close();
  });

  it('lists only marketing integrations that match the authorized event scope', async () => {
    const scopedIntegration = {
      id: 'mkt_scoped',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      provider: 'ga4',
      config: JSON.stringify({ measurementId: 'G-SCOPED' }),
      consent_required: true,
      status: 'active',
      created_at: new Date('2026-06-01T00:00:01.000Z'),
      updated_at: new Date('2026-06-01T00:00:01.000Z'),
    };
    const mismatchedIntegration = {
      ...scopedIntegration,
      id: 'mkt_mismatched',
      tenant_id: 'tnt_other',
      config: JSON.stringify({ measurementId: 'G-OTHER' }),
    };
    const { db } = createEventMutationDb({
      event: baseEventRow({ status: 'published' }),
      marketingIntegrations: [scopedIntegration, mismatchedIntegration],
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/marketing-integrations',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          id: 'mkt_scoped',
          provider: 'ga4',
          config: { measurementId: 'G-SCOPED' },
        },
      ],
    });
    await app.close();
  });

  it('does not update an existing marketing integration outside the event scope', async () => {
    const mismatchedIntegration = {
      id: 'mkt_mismatched',
      tenant_id: 'tnt_other',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      provider: 'ga4',
      config: JSON.stringify({ measurementId: 'G-OTHER' }),
      consent_required: true,
      status: 'disabled',
      created_at: new Date('2026-06-01T00:00:01.000Z'),
      updated_at: new Date('2026-06-01T00:00:01.000Z'),
    };
    const { db, inserted, updates } = createEventMutationDb({
      event: baseEventRow({ status: 'published' }),
      marketingIntegrations: [mismatchedIntegration],
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-SCOPED' },
        consentRequired: false,
        status: 'active',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(updates).toHaveLength(0);
    expect(inserted).toContainEqual(
      expect.objectContaining({
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        provider: 'ga4',
        config: JSON.stringify({ measurementId: 'G-SCOPED' }),
      }),
    );
    expect(mismatchedIntegration).toMatchObject({
      tenant_id: 'tnt_other',
      config: JSON.stringify({ measurementId: 'G-OTHER' }),
      status: 'disabled',
    });
    await app.close();
  });

  it.each([
    [
      'PostgreSQL unique error',
      Object.assign(
        new Error(
          'duplicate key value violates unique constraint "uniq_marketing_integrations_event_provider"',
        ),
        {
          code: '23505',
          constraint: 'uniq_marketing_integrations_event_provider',
        },
      ),
    ],
    [
      'MSSQL original error number',
      Object.assign(
        new Error(
          "Cannot insert duplicate key row in object 'marketing_integrations' with unique index 'uniq_marketing_integrations_event_provider'",
        ),
        {
          code: 'EREQUEST',
          originalError: { number: 2627 },
        },
      ),
    ],
    [
      'MySQL duplicate entry code',
      Object.assign(
        new Error(
          "Duplicate entry 'evt_1-ga4' for key 'uniq_marketing_integrations_event_provider'",
        ),
        {
          code: 'ER_DUP_ENTRY',
        },
      ),
    ],
    [
      'MySQL duplicate entry errno',
      Object.assign(
        new Error(
          "Duplicate entry 'evt_1-ga4' for key 'uniq_marketing_integrations_event_provider'",
        ),
        {
          errno: 1062,
        },
      ),
    ],
    [
      'SQLite unique constraint error',
      Object.assign(
        new Error(
          'UNIQUE constraint failed: marketing_integrations.event_id, marketing_integrations.provider',
        ),
        { code: 'SQLITE_CONSTRAINT_UNIQUE' },
      ),
    ],
  ])(
    'recovers when a concurrent marketing integration create wins the unique race with %s',
    async (_label, concurrentMarketingIntegrationError) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
      const existing = {
        id: 'mkt_existing',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        provider: 'ga4',
        config: JSON.stringify({ measurementId: 'G-OLD' }),
        consent_required: true,
        status: 'disabled',
        created_at: new Date('2026-06-01T00:00:01.000Z'),
        updated_at: new Date('2026-06-01T00:00:01.000Z'),
      };
      const existingUpdatedAt = existing.updated_at;
      const { db, updates } = createEventMutationDb({
        event: baseEventRow({ status: 'published' }),
        concurrentMarketingIntegration: existing,
        concurrentMarketingIntegrationError,
        concurrentMarketingIntegrationSystemTimeAfterInsert: new Date('2026-06-01T00:00:02.000Z'),
        marketingIntegrationAfterRecoveryUpdate: {
          config: JSON.stringify({ measurementId: 'G-LATER' }),
          consent_required: true,
          status: 'disabled',
          updated_at: new Date('2026-06-01T00:00:03.000Z'),
        },
      });
      const app = await setupEventApp(db, writePrincipal);

      const response = await app.inject({
        method: 'PUT',
        url: '/events/evt_1/marketing-integrations/ga4',
        payload: {
          config: { measurementId: 'G-RACED' },
          consentRequired: false,
          status: 'active',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(updates).toContainEqual(
        expect.objectContaining({
          config: JSON.stringify({ measurementId: 'G-RACED' }),
          consent_required: false,
          status: 'active',
        }),
      );
      const updatedAt = updates.find((update) => update.status === 'active')?.updated_at;
      expect(updatedAt).toBeInstanceOf(Date);
      expect((updatedAt as Date).getTime()).toBeGreaterThanOrEqual(existingUpdatedAt.getTime());
      expect(response.json()).toMatchObject({
        id: 'mkt_existing',
        provider: 'ga4',
        config: { measurementId: 'G-RACED' },
        consentRequired: false,
        status: 'active',
      });
      await app.close();
    },
  );

  it('does not recover unrelated duplicate errors while upserting marketing integrations', async () => {
    const existing = {
      id: 'mkt_existing',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      provider: 'ga4',
      config: JSON.stringify({ measurementId: 'G-OLD' }),
      consent_required: true,
      status: 'disabled',
      created_at: new Date('2026-06-01T00:00:01.000Z'),
      updated_at: new Date('2026-06-01T00:00:01.000Z'),
    };
    const { db, updates } = createEventMutationDb({
      event: baseEventRow({ status: 'published' }),
      concurrentMarketingIntegration: existing,
      concurrentMarketingIntegrationError: Object.assign(
        new Error('duplicate key value violates unique constraint "marketing_integrations_pkey"'),
        {
          code: '23505',
          constraint: 'marketing_integrations_pkey',
        },
      ),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/ga4',
      payload: {
        config: { measurementId: 'G-RACED' },
        consentRequired: false,
        status: 'active',
      },
    });

    expect(response.statusCode).toBe(500);
    expect(updates).toHaveLength(0);
    expect(existing).toMatchObject({
      config: JSON.stringify({ measurementId: 'G-OLD' }),
      status: 'disabled',
    });
    await app.close();
  });

  it.each([
    [
      'PostgreSQL bare unique error',
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    ],
    [
      'MSSQL bare original error number',
      Object.assign(new Error('Request failed'), {
        code: 'EREQUEST',
        originalError: { number: 2627 },
      }),
    ],
    [
      'MySQL bare duplicate entry code',
      Object.assign(new Error('Duplicate entry'), {
        code: 'ER_DUP_ENTRY',
      }),
    ],
    [
      'MySQL bare duplicate entry errno',
      Object.assign(new Error('Duplicate entry'), {
        errno: 1062,
      }),
    ],
  ])(
    'does not recover ambiguous duplicate errors while upserting marketing integrations with %s',
    async (_label, concurrentMarketingIntegrationError) => {
      const existing = {
        id: 'mkt_existing',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_1',
        provider: 'ga4',
        config: JSON.stringify({ measurementId: 'G-OLD' }),
        consent_required: true,
        status: 'disabled',
        created_at: new Date('2026-06-01T00:00:01.000Z'),
        updated_at: new Date('2026-06-01T00:00:01.000Z'),
      };
      const { db, updates } = createEventMutationDb({
        event: baseEventRow({ status: 'published' }),
        concurrentMarketingIntegration: existing,
        concurrentMarketingIntegrationError,
      });
      const app = await setupEventApp(db, writePrincipal);

      const response = await app.inject({
        method: 'PUT',
        url: '/events/evt_1/marketing-integrations/ga4',
        payload: {
          config: { measurementId: 'G-RACED' },
          consentRequired: false,
          status: 'active',
        },
      });

      expect(response.statusCode).toBe(500);
      expect(updates).toHaveLength(0);
      expect(existing).toMatchObject({
        config: JSON.stringify({ measurementId: 'G-OLD' }),
        status: 'disabled',
      });
      await app.close();
    },
  );

  it('rejects non-HTTPS generic marketing pixels', async () => {
    const { db } = createEventMutationDb({
      event: baseEventRow({ status: 'published' }),
    });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PUT',
      url: '/events/evt_1/marketing-integrations/generic_tag',
      payload: {
        config: { pixelUrl: 'http://analytics.example/pixel' },
        status: 'active',
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns event code format for a principal scoped to the event', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read'],
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
    };
    const { db } = createEventMutationDb({
      event: baseEventRow({
        code_format: JSON.stringify({
          symbology: 'pdf417',
          payloadFormat: 'compact_v2',
        }),
      }),
    });
    const app = await setupEventApp(db, principal);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/code-format',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eventId: 'evt_1',
      codeFormat: { symbology: 'pdf417', payloadFormat: 'compact_v2' },
    });
    expect(response.json().scannerContractVersion).toBeTypeOf('string');
    await app.close();
  });

  it('hides event code format from principals outside the event scope', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read'],
      brandIds: ['brd_1'],
      eventIds: ['evt_other'],
    };
    const { db } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, principal);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/code-format',
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('hides event code format from principals outside the brand scope', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read'],
      brandIds: ['brd_other'],
      eventIds: ['evt_1'],
    };
    const { db } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, principal);

    const response = await app.inject({
      method: 'GET',
      url: '/events/evt_1/code-format',
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('applies brand and event scope filters when listing events', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['events.read'],
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
    };
    const { db, whereCalls } = createEventListDb(
      [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'event',
          title: 'Event',
          description: null,
          status: 'published',
          timezone: 'America/New_York',
          starts_at: new Date('2026-07-01T00:00:00.000Z'),
          ends_at: null,
          venue: null,
          visibility: 'public',
          seo: JSON.stringify({}),
          capacity: null,
          cover_image_url: null,
          external_url: null,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      [
        {
          rendition_id: 'emr_cover',
          width: 480,
          height: 270,
          checksum_sha256: 'a'.repeat(64),
          event_id: 'evt_1',
          role: 'cover',
          variant: 'card',
          alt_text: 'Event crowd',
        },
      ],
    );
    const app = Fastify();
    app.decorate('context', {
      db,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(eventRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/events?limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(whereCalls).toContainEqual(['tenant_id', '=', 'tnt_1']);
    expect(whereCalls).toContainEqual(['brand_id', 'in', ['brd_1']]);
    expect(whereCalls).toContainEqual(['id', 'in', ['evt_1']]);
    expect(response.json().items[0].thumbnail).toEqual({
      renditionId: 'emr_cover',
      role: 'cover',
      variant: 'card',
      altText: 'Event crowd',
      width: 480,
      height: 270,
      checksumSha256: 'a'.repeat(64),
      url: '/v1/events/evt_1/media/renditions/emr_cover',
    });

    await app.close();
  });
});
