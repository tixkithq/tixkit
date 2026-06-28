import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import type { AppContext } from '../app.js';
import { eventRoutes } from '../routes/modules/events.js';

function createEventListDb(rows: Record<string, unknown>[]) {
  const whereCalls: unknown[][] = [];
  const query = {
    selectAll() {
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
    execute() {
      return Promise.resolve(rows);
    },
  };
  return {
    whereCalls,
    db: {
      selectFrom(table: string) {
        expect(table).toBe('events');
        return query;
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
      values(values: Record<string, unknown>) {
        const row = table === 'events' ? baseEventRow(values) : values;
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              rows[table] ??= [];
              rows[table].push(row);
              inserted.push(row);
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
            rows[table].push(row);
            inserted.push(row);
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
        };
        return updateQuery;
      },
    };
  }

  return {
    inserted,
    updates,
    db: {
      selectFrom,
      insertInto,
      updateTable,
    } as unknown as Database,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function setupEventApp(db: Database, principal: Principal) {
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

  it('rejects duplicate event slugs within the same brand', async () => {
    const { db } = createEventMutationDb({
      event: baseEventRow({ id: 'evt_existing', brand_id: 'brd_1', slug: 'event' }),
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
      event: baseEventRow({ id: 'evt_existing', brand_id: 'brd_other', slug: 'event' }),
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
        title: 'Updated Event',
        currency: 'GBP',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().currency).toBe('GBP');
    expect(updates.some((update) => update.currency === 'GBP')).toBe(true);
    await app.close();
  });

  it('persists status when updating events through PATCH', async () => {
    const { db, updates } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
        status: 'paused',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('paused');
    expect(updates.some((update) => update.status === 'paused')).toBe(true);
    await app.close();
  });

  it('persists full event detail fields when updating events through PATCH', async () => {
    const { db, updates } = createEventMutationDb({ event: baseEventRow() });
    const app = await setupEventApp(db, writePrincipal);

    const response = await app.inject({
      method: 'PATCH',
      url: '/events/evt_1',
      payload: {
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
        coverImageUrl: 'https://cdn.example.test/cover.jpg',
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
      coverImageUrl: 'https://cdn.example.test/cover.jpg',
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
        seo: JSON.stringify({ title: 'Search title', description: 'Search description' }),
        capacity: 250,
        cover_image_url: 'https://cdn.example.test/cover.jpg',
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
    const { db } = createEventMutationDb({ event: baseEventRow({ status: 'published' }) });
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
    const { db, whereCalls } = createEventListDb([
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
    ]);
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

    const response = await app.inject({ method: 'GET', url: '/events?limit=10' });

    expect(response.statusCode).toBe(200);
    expect(whereCalls).toContainEqual(['tenant_id', '=', 'tnt_1']);
    expect(whereCalls).toContainEqual(['brand_id', 'in', ['brd_1']]);
    expect(whereCalls).toContainEqual(['id', 'in', ['evt_1']]);

    await app.close();
  });
});
