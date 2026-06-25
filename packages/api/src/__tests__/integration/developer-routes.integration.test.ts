import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../../app.js';
import { developerRoutes } from '../../routes/modules/developer.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';

function createApiKeyListDb(rows: Record<string, unknown>[]) {
  return {
    selectFrom(table: string) {
      expect(table).toBe('api_keys');
      const query = {
        select() {
          return query;
        },
        where() {
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
      return query;
    },
  };
}

function createWebhookDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    selectFrom(table: string) {
      const query = {
        select() {
          return query;
        },
        selectAll() {
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        execute() {
          return Promise.resolve(tables[table] ?? []);
        },
        executeTakeFirst() {
          return Promise.resolve((tables[table] ?? [])[0]);
        },
      };
      return query;
    },
  };
}

describe('developer routes integration', () => {
  it('lists API keys as a paginated public contract without secret material', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: createApiKeyListDb([
        {
          id: 'ak_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          name: 'Server key',
          key_prefix: 'gk_1234',
          hashed_key: 'must-not-leak',
          scopes: JSON.stringify(['events.read']),
          brand_ids: JSON.stringify(['brd_1']),
          event_ids: null,
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: new Date('2026-06-01T00:00:00Z'),
          updated_at: new Date('2026-06-01T00:00:00Z'),
        },
        {
          id: 'ak_2',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          name: 'Next page',
          key_prefix: 'gk_5678',
          hashed_key: 'must-not-leak-either',
          scopes: JSON.stringify(['events.read']),
          brand_ids: null,
          event_ids: null,
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
          created_at: new Date('2026-06-02T00:00:00Z'),
          updated_at: new Date('2026-06-02T00:00:00Z'),
        },
      ]) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(developerRoutes);

    const response = await app.inject({ method: 'GET', url: '/api-keys?limit=1' });
    const body = response.json() as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(response.statusCode).toBe(200);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe('ak_1');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: 'ak_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      keyPrefix: 'gk_1234',
      scopes: ['events.read'],
      brandIds: ['brd_1'],
    });
    expect(body.items[0]).not.toHaveProperty('hashed_key');
    expect(body.items[0]).not.toHaveProperty('hashedKey');

    await app.close();
  });

  it('blocks event-scoped API keys from minting unscoped API keys', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write', 'events.read'],
      eventIds: ['evt_1'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: {} as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(developerRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: {
        organizationId: 'org_1',
        name: 'Escalated key',
        scopes: ['events.read'],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Event-scoped principals must create event-scoped credentials',
    });

    await app.close();
  });

  it('blocks scoped principals from creating unscoped scanner devices', async () => {
    const principal: Principal = {
      type: 'api_key',
      id: 'key_parent',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
      brandIds: ['brd_1'],
    };
    const app = Fastify();
    app.decorate('context', {
      db: {} as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(developerRoutes);

    const response = await app.inject({
      method: 'POST',
      url: '/scanner-devices',
      payload: {
        organizationId: 'org_1',
        name: 'Unscoped scanner',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Scoped principals must bind scanner devices to explicit events',
    });

    await app.close();
  });

  it('lists webhook delivery events for an endpoint as a paginated admin contract', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const deliveredAt = new Date('2026-06-01T00:01:00Z');
    const createdAt = new Date('2026-06-01T00:00:00Z');
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookDb({
        webhook_endpoints: [
          {
            id: 'wh_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            url: 'https://example.com/webhooks',
            secret: 'secret',
            events: JSON.stringify(['order.paid']),
            status: 'active',
            description: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
        webhook_deliveries: [
          {
            id: 'whe_1',
            endpoint_id: 'wh_1',
            event_type: 'order.paid',
            status: 'succeeded',
            status_code: 200,
            attempt_count: 1,
            delivered_at: deliveredAt,
            created_at: createdAt,
          },
        ],
      }) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: {},
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const response = await app.inject({
      method: 'GET',
      url: '/webhook-endpoints/wh_1/events?limit=1',
    });
    const body = response.json() as {
      items: Array<Record<string, unknown>>;
      hasMore: boolean;
    };

    expect(response.statusCode).toBe(200);
    expect(body.hasMore).toBe(false);
    expect(body.items).toEqual([
      {
        id: 'whe_1',
        endpointId: 'wh_1',
        eventType: 'order.paid',
        status: 'succeeded',
        statusCode: 200,
        attemptCount: 1,
        deliveredAt: '2026-06-01T00:01:00.000Z',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ]);

    await app.close();
  });

  it('returns queued true when replaying a webhook event', async () => {
    const principal: Principal = {
      type: 'user',
      id: 'usr_1',
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      scopes: ['developers.write'],
    };
    const startWebhookDelivery = vi.fn(async () => undefined);
    const createdAt = new Date('2026-06-01T00:00:00Z');
    const app = Fastify();
    app.decorate('context', {
      db: createWebhookDb({
        webhook_events: [
          {
            id: 'whe_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            type: 'order.paid',
            payload: JSON.stringify({ orderId: 'ord_1' }),
            status: 'pending',
            created_at: createdAt,
          },
        ],
        webhook_endpoints: [
          {
            id: 'wh_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            url: 'https://example.com/webhooks',
            secret: 'secret',
            events: JSON.stringify(['order.paid']),
            status: 'active',
            description: null,
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
      }) as unknown as Database,
      pricingEngine: {},
      inventoryService: {},
      qrService: {},
      authService: {},
      temporalClient: { startWebhookDelivery },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    await app.register(webhookRoutes);

    const response = await app.inject({ method: 'POST', url: '/webhook-events/whe_1/replay' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ queued: true, eventId: 'whe_1', endpoints: 1 });
    expect(startWebhookDelivery).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
