import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
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
  seed: { event?: Record<string, unknown>; brand?: Record<string, unknown> } = {},
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
  };
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  function selectFrom(table: string) {
    const conditions: Array<[string, unknown]> = [];
    const query = {
      selectAll() {
        return query;
      },
      where(column: string, _op: string, value: unknown) {
        conditions.push([column, value]);
        return query;
      },
      executeTakeFirst() {
        const found = (rows[table] ?? []).find((row) =>
          conditions.every(([column, value]) => row[column] === value),
        );
        return Promise.resolve(found);
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
        return {
          where(_column: string, _op: string, id: unknown) {
            const row = (rows[table] ?? []).find((entry) => entry.id === id);
            const updated = { ...(row ?? { id }), ...values };
            return {
              returningAll: () => ({
                executeTakeFirstOrThrow: async () => {
                  if (row) Object.assign(row, values);
                  updates.push(values);
                  return updated;
                },
              }),
              execute: async () => {
                if (row) Object.assign(row, values);
                updates.push(values);
              },
            };
          },
        };
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
