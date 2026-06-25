import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
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

describe('event routes', () => {
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
