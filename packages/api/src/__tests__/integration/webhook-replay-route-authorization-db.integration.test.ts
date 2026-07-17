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
});
