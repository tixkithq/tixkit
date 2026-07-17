import rateLimit from '@fastify/rate-limit';
import {
  createDb,
  OrganizationRepository,
  TenantRepository,
  WebhookEndpointRepository,
  WebhookEventRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { webhookRoutes } from '../../routes/modules/webhooks.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('webhook replay route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let activePrincipal: Principal;
  let requestSequence = 0;

  const suffix = ulid().slice(-10).toLowerCase();
  let tenantId: string;
  let organizationId: string;
  const userId = `usr_whr_${suffix}`;
  let eventId: string;
  let endpointId: string;
  let testRequestSequence = 0;
  const startWebhookDelivery = vi.fn(async () => ({ runId: `run_${suffix}` }));

  function authorizedPrincipal(overrides: Partial<Principal> = {}): Principal {
    return {
      type: 'user',
      id: userId,
      tenantId,
      organizationIds: [organizationId],
      scopes: ['developers.write'],
      ...overrides,
    };
  }

  async function persistenceSnapshot(): Promise<Readonly<{ audits: number; replays: number }>> {
    const [auditRow, replayRow] = await Promise.all([
      db
        .selectFrom('audit_logs')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('actor_id', '=', userId)
        .where('resource_type', '=', 'WebhookReplayRequest')
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('webhook_replay_requests')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow(),
    ]);
    return { audits: Number(auditRow.count), replays: Number(replayRow.count) };
  }

  async function testDeliverySnapshot() {
    const [events, deliveries, audits] = await Promise.all([
      db
        .selectFrom('webhook_events')
        .select(['id', 'tenant_id', 'organization_id', 'type', 'payload', 'status'])
        .where('organization_id', '=', organizationId)
        .where('type', '=', 'test.ping')
        .orderBy('id', 'asc')
        .execute(),
      db
        .selectFrom('webhook_deliveries')
        .innerJoin('webhook_events', 'webhook_events.id', 'webhook_deliveries.event_id')
        .select([
          'webhook_deliveries.id',
          'webhook_deliveries.endpoint_id',
          'webhook_deliveries.requested_endpoint_id',
          'webhook_deliveries.event_id',
          'webhook_deliveries.delivery_key',
          'webhook_deliveries.attempt',
          'webhook_deliveries.status',
        ])
        .where('webhook_events.organization_id', '=', organizationId)
        .where('webhook_events.type', '=', 'test.ping')
        .orderBy('webhook_deliveries.id', 'asc')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select([
          'id',
          'tenant_id',
          'organization_id',
          'actor_type',
          'actor_id',
          'action',
          'resource_type',
          'resource_id',
          'diff_summary',
        ])
        .where('actor_id', '=', userId)
        .where('action', 'like', 'webhook_endpoint.test_delivery_%')
        .orderBy('id', 'asc')
        .execute(),
    ]);
    return { events, deliveries, audits };
  }

  async function clearTestDeliveryEffects(): Promise<void> {
    const testEvents = await db
      .selectFrom('webhook_events')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('type', '=', 'test.ping')
      .execute();
    const testEventIds = testEvents.map((event) => event.id);
    if (testEventIds.length > 0) {
      await db.deleteFrom('webhook_deliveries').where('event_id', 'in', testEventIds).execute();
      await db.deleteFrom('webhook_events').where('id', 'in', testEventIds).execute();
    }
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', userId)
      .where('action', 'like', 'webhook_endpoint.test_delivery_%')
      .execute();
  }

  function invokeTestDelivery() {
    testRequestSequence += 1;
    return app.inject({
      method: 'POST',
      url: `/webhook-endpoints/${endpointId}/test`,
      remoteAddress: `198.51.100.${testRequestSequence}`,
    });
  }

  function nextIdempotencyKey(label: string): string {
    requestSequence += 1;
    return `webhook-replay-${label}-${requestSequence}`;
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const tenant = await new TenantRepository(db).create({
      name: `Webhook replay authorization ${suffix}`,
    });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Webhook replay organization ${suffix}`,
      slug: `webhook-replay-auth-${suffix}`,
    });
    tenantId = tenant.id;
    organizationId = organization.id;
    const event = await new WebhookEventRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      type: 'order.paid',
      payload: { orderId: `ord_whr_${suffix}` },
    });
    const endpoint = await new WebhookEndpointRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      url: 'https://webhook-authorization.example.test/events',
      events: ['order.paid'],
    });
    eventId = event.id;
    endpointId = endpoint.id;

    activePrincipal = authorizedPrincipal();
    app = Fastify();
    app.decorate('context', {
      db,
      temporalClient: { startWebhookDelivery },
    } as unknown as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(rateLimit, { global: false });
    await app.register(webhookRoutes);
  });

  beforeEach(async () => {
    activePrincipal = authorizedPrincipal();
    startWebhookDelivery.mockClear();
    await clearTestDeliveryEffects();
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', userId)
      .where('resource_type', '=', 'WebhookReplayRequest')
      .execute();
    await db.deleteFrom('webhook_replay_requests').where('event_id', '=', eventId).execute();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await clearTestDeliveryEffects();
      await db
        .deleteFrom('audit_logs')
        .where('actor_id', '=', userId)
        .where('resource_type', '=', 'WebhookReplayRequest')
        .execute();
      await db.deleteFrom('webhook_replay_requests').where('event_id', '=', eventId).execute();
      await db.deleteFrom('webhook_endpoints').where('id', '=', endpointId).execute();
      await db.deleteFrom('webhook_events').where('id', '=', eventId).execute();
      await db.deleteFrom('organizations').where('id', '=', organizationId).execute();
      await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  const operations = [
    {
      name: 'organization-wide replay',
      inject: (key: string) =>
        app.inject({
          method: 'POST',
          url: `/webhook-events/${eventId}/replay`,
          headers: { 'idempotency-key': key },
        }),
    },
    {
      name: 'endpoint-scoped replay',
      inject: (key: string) =>
        app.inject({
          method: 'POST',
          url: `/webhook-endpoints/${endpointId}/events/${eventId}/replay`,
          headers: { 'idempotency-key': key },
        }),
    },
  ] as const;

  for (const operation of operations) {
    describe(operation.name, () => {
      it('allows the exact organization principal and records one durable workflow intent', async () => {
        const response = await operation.inject(nextIdempotencyKey('authorized'));
        expect(response.statusCode, response.body).toBe(202);
        await expect(persistenceSnapshot()).resolves.toEqual({ audits: 2, replays: 1 });
        expect(startWebhookDelivery).toHaveBeenCalledTimes(1);
      });

      it('denies missing permission without persistence or workflow side effects', async () => {
        activePrincipal = authorizedPrincipal({ scopes: [] });
        const before = await persistenceSnapshot();
        const response = await operation.inject(nextIdempotencyKey('permission'));
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        await expect(persistenceSnapshot()).resolves.toEqual(before);
        expect(startWebhookDelivery).not.toHaveBeenCalled();
      });

      it.each([
        ['tenant', { tenantId: `tnt_other_${suffix}` }],
        ['organization', { organizationIds: [] }],
      ])(
        'returns indistinguishable not-found across the %s boundary',
        async (_label, overrides) => {
          activePrincipal = authorizedPrincipal(overrides);
          const before = await persistenceSnapshot();
          const response = await operation.inject(nextIdempotencyKey('resource'));
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
          await expect(persistenceSnapshot()).resolves.toEqual(before);
          expect(startWebhookDelivery).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['brand', { brandIds: [`brd_whr_${suffix}`] }],
        ['event', { eventIds: [eventId] }],
      ])(
        'rejects %s-scoped principals before persistence or workflow dispatch',
        async (_label, scope) => {
          activePrincipal = authorizedPrincipal(scope);
          const before = await persistenceSnapshot();
          const response = await operation.inject(nextIdempotencyKey('scoped'));
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
          await expect(persistenceSnapshot()).resolves.toEqual(before);
          expect(startWebhookDelivery).not.toHaveBeenCalled();
        },
      );
    });
  }

  describe('synthetic endpoint test delivery', () => {
    it('allows the exact organization principal and records only the bounded test-delivery effects', async () => {
      const endpoint = await db
        .selectFrom('webhook_endpoints')
        .select(['secret', 'url'])
        .where('id', '=', endpointId)
        .executeTakeFirstOrThrow();

      const response = await invokeTestDelivery();

      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({ queued: true, test: true, endpointId });
      const snapshot = await testDeliverySnapshot();
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0]).toMatchObject({
        tenant_id: tenantId,
        organization_id: organizationId,
        type: 'test.ping',
        status: 'pending',
      });
      const storedPayload = snapshot.events[0]!.payload;
      const payload =
        typeof storedPayload === 'string'
          ? (JSON.parse(storedPayload) as Record<string, unknown>)
          : (storedPayload as Record<string, unknown>);
      expect(payload).toMatchObject({
        type: 'test.ping',
        test: true,
        data: { endpointId },
      });
      expect(snapshot.deliveries).toHaveLength(1);
      expect(snapshot.deliveries[0]).toMatchObject({
        endpoint_id: endpointId,
        requested_endpoint_id: endpointId,
        event_id: snapshot.events[0]!.id,
        delivery_key: 'live',
        attempt: 1,
        status: 'pending',
      });
      expect(snapshot.audits).toHaveLength(1);
      expect(snapshot.audits[0]).toMatchObject({
        tenant_id: tenantId,
        organization_id: organizationId,
        actor_type: 'user',
        actor_id: userId,
        action: 'webhook_endpoint.test_delivery_queued',
        resource_type: 'WebhookEndpoint',
        resource_id: endpointId,
      });
      const persistedEvidence = JSON.stringify(snapshot);
      expect(persistedEvidence).not.toContain(endpoint.secret);
      expect(persistedEvidence).not.toContain(endpoint.url);
      expect(persistedEvidence).not.toMatch(/buyer|payment|order|ticket/iu);
      expect(startWebhookDelivery).toHaveBeenCalledTimes(1);
      expect(startWebhookDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          endpointId,
          eventId: snapshot.events[0]!.id,
          eventType: 'test.ping',
          payload,
          maxAttempts: 5,
        }),
      );
    });

    it('denies missing permission before persistence or workflow dispatch', async () => {
      activePrincipal = authorizedPrincipal({ scopes: [] });
      const before = await testDeliverySnapshot();

      const response = await invokeTestDelivery();

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      await expect(testDeliverySnapshot()).resolves.toEqual(before);
      expect(startWebhookDelivery).not.toHaveBeenCalled();
    });

    it.each([
      ['tenant', { tenantId: `tnt_other_${suffix}` }],
      ['organization', { organizationIds: [] }],
    ])('returns indistinguishable not-found across the %s boundary', async (_label, overrides) => {
      activePrincipal = authorizedPrincipal(overrides);
      const before = await testDeliverySnapshot();

      const response = await invokeTestDelivery();

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      await expect(testDeliverySnapshot()).resolves.toEqual(before);
      expect(startWebhookDelivery).not.toHaveBeenCalled();
    });

    it.each([
      ['brand', { brandIds: [`brd_whr_${suffix}`] }],
      ['event', { eventIds: [eventId] }],
    ])(
      'rejects %s-scoped principals before persistence or workflow dispatch',
      async (_label, scope) => {
        activePrincipal = authorizedPrincipal(scope);
        const before = await testDeliverySnapshot();

        const response = await invokeTestDelivery();

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        await expect(testDeliverySnapshot()).resolves.toEqual(before);
        expect(startWebhookDelivery).not.toHaveBeenCalled();
      },
    );
  });
});
