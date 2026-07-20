import { AGENT_PROTOCOL_VERSION } from '@tixkit/agent-protocol';
import type { Principal } from '@tixkit/domain';
import {
  AgentExecutionRepository,
  ApiKeyRepository,
  BrandRepository,
  createDb,
  type Database,
  EventRepository,
  OrganizationRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
} from '@tixkit/db';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { ClerkAuthService, createAuthMiddleware } from '../../auth/clerk.js';
import { agentControlRoutes } from '../../routes/modules/agent-control.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
) as DriverCase[];

if (driverCases.length === 0)
  it.skip('agent control route integration (database URLs are not configured)', () => {});

async function buildApp(db: Database, principal: Principal) {
  const app = Fastify({ logger: false, genReqId: () => 'req_agent_control_db' });
  app.decorate('context', { db } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = principal;
  });
  registerErrorHandler(app);
  await app.register(agentControlRoutes);
  return app;
}

async function controlCounts(db: Database) {
  const [principals, delegations, oauthClients, audit] = await Promise.all([
    db
      .selectFrom('agent_principals')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('agent_delegations')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('oauth_applications')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('agent_control_events')
      .select(({ fn }) => fn.countAll().as('count'))
      .executeTakeFirstOrThrow(),
  ]);
  return { principals, delegations, oauthClients, audit };
}

describe.sequential.each(driverCases)(
  'agent control route persistence: $driver',
  ({ driver, url }) => {
    let db: Database;
    let tenantId: string;
    let organizationId: string;
    let eventId: string;
    const sponsors = ['user_agent_route_a', 'user_agent_route_b'] as const;

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
      await truncateAllData(db);
      tenantId = (await new TenantRepository(db).create({ name: `Agent routes ${driver}` })).id;
      const organization = await new OrganizationRepository(db).create({
        tenantId,
        name: `Agent routes ${driver} organization`,
        slug: `agent-routes-${driver}-organization`,
      });
      organizationId = organization.id;
      const brand = await new BrandRepository(db).create({
        tenantId,
        organizationId: organization.id,
        name: `Agent routes ${driver} brand`,
        slug: `agent-routes-${driver}-brand`,
      });
      eventId = (
        await new EventRepository(db).create({
          tenantId,
          organizationId: organization.id,
          brandId: brand.id,
          slug: `agent-routes-${driver}-event`,
          title: `Agent routes ${driver} event`,
          currency: 'USD',
          timezone: 'America/Chicago',
          startsAt: new Date('2027-01-01T18:00:00.000Z'),
        })
      ).id;
      const now = new Date();
      await db
        .insertInto('user_profiles')
        .values(
          sponsors.map((id, index) => ({
            id,
            tenant_id: tenantId,
            clerk_user_id: `clerk_agent_route_${driver}_${index}`,
            email: `agent-route-${driver}-${index}@example.test`,
            first_name: null,
            last_name: null,
            avatar_url: null,
            status: 'active' as const,
            last_seen_at: null,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
      await db
        .insertInto('permission_grants')
        .values(
          sponsors.flatMap((principalId, sponsorIndex) =>
            ['developers.write', 'events.read'].map((permission, permissionIndex) => ({
              id: `pg_agent_route_${sponsorIndex}_${permissionIndex}`,
              tenant_id: tenantId,
              principal_type: 'user' as const,
              principal_id: principalId,
              permission,
              scope_type: 'tenant' as const,
              scope_id: null,
              created_at: now,
              updated_at: now,
            })),
          ),
        )
        .execute();
      await db
        .insertInto('organization_members')
        .values(
          sponsors.map((userId, index) => ({
            id: `member_agent_route_${index}`,
            tenant_id: tenantId,
            organization_id: organization.id,
            user_id: userId,
            role: 'owner',
            invited_at: now,
            accepted_at: now,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
    });

    afterAll(async () => {
      await db?.destroy();
    });

    it('composes sponsor namespacing, live replay authorization, and immutable audit', async () => {
      const apps = await Promise.all(
        sponsors.map((id) =>
          buildApp(db, {
            type: 'user',
            id,
            tenantId,
            organizationIds: [],
            scopes: ['developers.write', 'events.read'],
          }),
        ),
      );
      const principalIds: string[] = [];
      const delegationIds: string[] = [];
      try {
        for (const [index, app] of apps.entries()) {
          const registration = await app.inject({
            method: 'POST',
            url: '/agent-principals',
            headers: { 'idempotency-key': `agent-route-register-${index}-0001` },
            payload: {
              id: 'shared_external_agent',
              kind: 'third_party',
              capabilities: ['events.read'],
              maximumAutonomy: 'read',
            },
          });
          expect(registration.statusCode).toBe(201);
          const principalId = registration.json().id as string;
          principalIds.push(principalId);
          const delegation = await app.inject({
            method: 'POST',
            url: '/agent-delegations',
            headers: { 'idempotency-key': `agent-route-delegation-${index}-0001` },
            payload: {
              id: 'shared_external_delegation',
              agentPrincipalId: principalId,
              capabilities: ['events.read'],
              resourceScopes: [`event:${eventId}`],
              expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            },
          });
          expect(delegation.statusCode).toBe(201);
          delegationIds.push(delegation.json().id as string);
        }

        expect(new Set(principalIds).size).toBe(2);
        expect(new Set(delegationIds).size).toBe(2);
        await db
          .deleteFrom('permission_grants')
          .where('tenant_id', '=', tenantId)
          .where('principal_id', '=', sponsors[0])
          .where('permission', '=', 'developers.write')
          .execute();
        const deniedReplay = await apps[0]!.inject({
          method: 'POST',
          url: '/agent-principals',
          headers: { 'idempotency-key': 'agent-route-register-0-0001' },
          payload: {
            id: 'shared_external_agent',
            kind: 'third_party',
            capabilities: ['events.read'],
            maximumAutonomy: 'read',
          },
        });
        expect(deniedReplay.statusCode).toBe(403);
        const deniedRead = await apps[0]!.inject({
          method: 'GET',
          url: `/agent-principals/${principalIds[0]}`,
        });
        expect(deniedRead.statusCode).toBe(403);
        const events = await db
          .selectFrom('agent_control_events')
          .select(['actor_principal_id', 'operation', 'target_id'])
          .where('tenant_id', '=', tenantId)
          .execute();
        expect(events).toHaveLength(4);
        expect(new Set(events.map(({ actor_principal_id }) => actor_principal_id))).toEqual(
          new Set(sponsors),
        );
        expect(events.filter(({ operation }) => operation === 'register')).toHaveLength(2);
        expect(events.filter(({ operation }) => operation === 'grant')).toHaveLength(2);
      } finally {
        await Promise.all(apps.map((app) => app.close()));
      }
    });

    it('rejects stale capability claims inside the principal-registration transaction', async () => {
      const sponsorId = sponsors[1];
      await db
        .deleteFrom('permission_grants')
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', sponsorId)
        .where('permission', '=', 'events.read')
        .execute();
      const before = {
        principals: await db
          .selectFrom('agent_principals')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow(),
        audit: await db
          .selectFrom('agent_control_events')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow(),
      };
      const app = await buildApp(db, {
        type: 'user',
        id: sponsorId,
        tenantId,
        organizationIds: [],
        scopes: ['developers.write', 'events.read'],
      });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/agent-principals',
          headers: { 'idempotency-key': 'agent-stale-capability-register-0001' },
          payload: {
            id: 'stale_capability_agent',
            kind: 'third_party',
            capabilities: ['events.read'],
            maximumAutonomy: 'read',
          },
        });
        expect(response.statusCode).toBe(403);
        expect(
          await db
            .selectFrom('agent_principals')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow(),
        ).toEqual(before.principals);
        expect(
          await db
            .selectFrom('agent_control_events')
            .select(({ fn }) => fn.countAll().as('count'))
            .executeTakeFirstOrThrow(),
        ).toEqual(before.audit);
      } finally {
        await app.close();
        await db
          .insertInto('permission_grants')
          .values({
            id: 'pg_agent_route_1_1',
            tenant_id: tenantId,
            principal_type: 'user',
            principal_id: sponsorId,
            permission: 'events.read',
            scope_type: 'tenant',
            scope_id: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
      }
    });

    it('serializes live actor revocation before a sponsor-bound principal read', async () => {
      const sponsorId = sponsors[1];
      const app = await buildApp(db, {
        type: 'user',
        id: sponsorId,
        tenantId,
        organizationIds: [],
        scopes: ['developers.write', 'events.read'],
      });
      const registration = await app.inject({
        method: 'POST',
        url: '/agent-principals',
        headers: { 'idempotency-key': 'agent-atomic-read-register-0001' },
        payload: {
          id: 'atomic_read_agent',
          kind: 'third_party',
          capabilities: ['events.read'],
          maximumAutonomy: 'read',
        },
      });
      expect(registration.statusCode).toBe(201);
      const principalId = registration.json().id as string;
      const locked = deferred();
      const release = deferred();
      const mutation = db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('tenants')
          .select('id')
          .where('id', '=', tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await tx
          .deleteFrom('permission_grants')
          .where('tenant_id', '=', tenantId)
          .where('principal_id', '=', sponsorId)
          .where('permission', '=', 'developers.write')
          .execute();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const request = app.inject({ method: 'GET', url: `/agent-principals/${principalId}` });
      release.resolve();
      await mutation;
      try {
        const response = await request;
        expect(response.statusCode).toBe(403);
      } finally {
        await app.close();
        await db
          .insertInto('permission_grants')
          .values({
            id: 'pg_agent_route_1_0',
            tenant_id: tenantId,
            principal_type: 'user',
            principal_id: sponsorId,
            permission: 'developers.write',
            scope_type: 'tenant',
            scope_id: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
      }
    });

    it.each(['api_key', 'agent', 'mobile_device', 'system'] as const)(
      'denies %s principals on all lifecycle routes without persistent effects',
      async (type) => {
        const before = await controlCounts(db);
        const app = await buildApp(db, {
          type: type as never,
          id: `machine_agent_control_${type}`,
          tenantId,
          organizationIds: [],
          scopes: ['developers.write', 'events.read'],
        });
        const principalId = `agt_${'a'.repeat(48)}`;
        const delegationId = `dlg_${'b'.repeat(48)}`;
        const clientId = `oapp_${'c'.repeat(27)}`;
        try {
          const responses = await Promise.all([
            app.inject({
              method: 'POST',
              url: '/agent-principals',
              headers: { 'idempotency-key': `machine-register-${type}-0001` },
              payload: {
                id: 'machine_denied_agent',
                kind: 'third_party',
                capabilities: ['events.read'],
                maximumAutonomy: 'read',
              },
            }),
            app.inject({ method: 'GET', url: `/agent-principals/${principalId}` }),
            app.inject({
              method: 'POST',
              url: `/agent-principals/${principalId}/revoke`,
              headers: { 'idempotency-key': `machine-revoke-${type}-0001` },
            }),
            app.inject({
              method: 'POST',
              url: `/agent-principals/${principalId}/oauth-clients`,
              headers: { 'idempotency-key': `machine-client-${type}-0001` },
              payload: { organizationId: 'org_denied', name: 'Denied' },
            }),
            app.inject({
              method: 'POST',
              url: `/agent-principals/${principalId}/oauth-clients/${clientId}/revoke`,
              headers: { 'idempotency-key': `machine-client-revoke-${type}-0001` },
            }),
            app.inject({
              method: 'POST',
              url: '/agent-delegations',
              headers: { 'idempotency-key': `machine-delegation-${type}-0001` },
              payload: {
                id: 'machine_denied_delegation',
                agentPrincipalId: principalId,
                capabilities: ['events.read'],
                resourceScopes: [`event:${eventId}`],
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            }),
            app.inject({
              method: 'POST',
              url: `/agent-delegations/${delegationId}/revoke`,
              headers: { 'idempotency-key': `machine-delegation-revoke-${type}-0001` },
            }),
          ]);
          expect(responses.map(({ statusCode }) => statusCode)).toEqual(Array(7).fill(403));
          expect(await controlCounts(db)).toEqual(before);
        } finally {
          await app.close();
        }
      },
    );

    it('conceals cross-sponsor OAuth client lifecycle requests without persistent effects', async () => {
      const existingGrant = await db
        .selectFrom('permission_grants')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('principal_id', '=', sponsors[0])
        .where('permission', '=', 'developers.write')
        .executeTakeFirst();
      if (!existingGrant) {
        const timestamp = new Date();
        await db
          .insertInto('permission_grants')
          .values({
            id: 'pg_agent_route_0_0',
            tenant_id: tenantId,
            principal_type: 'user',
            principal_id: sponsors[0],
            permission: 'developers.write',
            scope_type: 'tenant',
            scope_id: null,
            created_at: timestamp,
            updated_at: timestamp,
          })
          .execute();
      }
      const owner = await buildApp(db, {
        type: 'user',
        id: sponsors[1],
        tenantId,
        organizationIds: [organizationId],
        scopes: ['developers.write', 'events.read'],
      });
      const foreignSponsor = await buildApp(db, {
        type: 'user',
        id: sponsors[0],
        tenantId,
        organizationIds: [organizationId],
        scopes: ['developers.write', 'events.read'],
      });
      try {
        const registration = await owner.inject({
          method: 'POST',
          url: '/agent-principals',
          headers: { 'idempotency-key': `cross-sponsor-register-${driver}-0001` },
          payload: {
            id: `cross_sponsor_oauth_${driver}`,
            kind: 'third_party',
            capabilities: ['events.read'],
            maximumAutonomy: 'read',
          },
        });
        expect(registration.statusCode).toBe(201);
        const principalId = registration.json().id as string;
        const created = await owner.inject({
          method: 'POST',
          url: `/agent-principals/${principalId}/oauth-clients`,
          headers: { 'idempotency-key': `cross-sponsor-owner-client-${driver}-0001` },
          payload: { organizationId, name: 'Owner client' },
        });
        expect(created.statusCode, created.body).toBe(201);
        const clientId = created.json().id as string;
        const before = await controlCounts(db);
        const deniedCreate = await foreignSponsor.inject({
          method: 'POST',
          url: `/agent-principals/${principalId}/oauth-clients`,
          headers: { 'idempotency-key': `cross-sponsor-client-create-${driver}-0001` },
          payload: { organizationId, name: 'Foreign client' },
        });
        const deniedRevoke = await foreignSponsor.inject({
          method: 'POST',
          url: `/agent-principals/${principalId}/oauth-clients/${clientId}/revoke`,
          headers: { 'idempotency-key': `cross-sponsor-client-revoke-${driver}-0001` },
        });
        expect(
          [deniedCreate.statusCode, deniedRevoke.statusCode],
          `${deniedCreate.body}\n${deniedRevoke.body}`,
        ).toEqual([404, 404]);
        expect(await controlCounts(db)).toEqual(before);
      } finally {
        await Promise.all([owner.close(), foreignSponsor.close()]);
      }
    });

    it('rolls principal registration back when immutable audit persistence fails', async () => {
      const repository = new AgentExecutionRepository(db);
      const sponsorId = sponsors[1];
      const firstId = `agt_${driver === 'postgres' ? 'd'.repeat(48) : 'e'.repeat(48)}`;
      const rolledBackId = `agt_${driver === 'postgres' ? 'f'.repeat(48) : '0'.repeat(48)}`;
      const auditId = `agent_audit_rollback_${driver}`;
      const principal = (id: string) => ({
        id,
        tenantId,
        sponsorPrincipalId: sponsorId,
        kind: 'third_party' as const,
        capabilities: ['events.read'] as const,
        maximumAutonomy: 'read' as const,
        protocolVersion: AGENT_PROTOCOL_VERSION,
        state: 'active' as const,
        registeredAt: new Date(0).toISOString(),
      });
      await repository.registerPrincipal(principal(firstId), {
        id: auditId,
        actorPrincipalId: sponsorId,
        reasonCode: 'PLATFORM_AGENT_PRINCIPAL_REGISTER',
        idempotencyKey: `agent-audit-first-${driver}`,
      });
      await expect(
        repository.registerPrincipal(principal(rolledBackId), {
          id: auditId,
          actorPrincipalId: sponsorId,
          reasonCode: 'PLATFORM_AGENT_PRINCIPAL_REGISTER',
          idempotencyKey: `agent-audit-second-${driver}`,
        }),
      ).rejects.toThrow();
      expect(
        await db
          .selectFrom('agent_principals')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', rolledBackId)
          .executeTakeFirst(),
      ).toBeUndefined();
      expect(
        await db
          .selectFrom('agent_control_events')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', auditId)
          .execute(),
      ).toHaveLength(1);
    });

    it('denies every lifecycle route through real API-key authentication', async () => {
      const issued = await new ApiKeyRepository(db).create({
        tenantId,
        organizationId,
        name: `Agent control recursive key ${driver}`,
        scopes: ['developers.write', 'events.read'],
      });
      const app = Fastify({ logger: false, genReqId: () => 'req_agent_control_api_key' });
      app.decorate('context', { db } as AppContext);
      app.addHook('onRequest', createAuthMiddleware(new ClerkAuthService('test_secret', db)));
      registerErrorHandler(app);
      await app.register(agentControlRoutes);
      const before = await controlCounts(db);
      const headers = {
        authorization: `Bearer ${issued.apiKey}`,
        'idempotency-key': `agent-control-api-key-${driver}`,
      };
      const principalId = `agt_${'a'.repeat(48)}`;
      const delegationId = `dlg_${'b'.repeat(48)}`;
      const clientId = `oapp_${'c'.repeat(27)}`;
      try {
        const responses = await Promise.all([
          app.inject({
            method: 'POST',
            url: '/agent-principals',
            headers,
            payload: {
              id: 'recursive_api_key_agent',
              kind: 'third_party',
              capabilities: ['events.read'],
              maximumAutonomy: 'read',
            },
          }),
          app.inject({ method: 'GET', url: `/agent-principals/${principalId}`, headers }),
          app.inject({
            method: 'POST',
            url: `/agent-principals/${principalId}/revoke`,
            headers,
          }),
          app.inject({
            method: 'POST',
            url: `/agent-principals/${principalId}/oauth-clients`,
            headers,
            payload: { organizationId, name: 'Denied recursive client' },
          }),
          app.inject({
            method: 'POST',
            url: `/agent-principals/${principalId}/oauth-clients/${clientId}/revoke`,
            headers,
          }),
          app.inject({
            method: 'POST',
            url: '/agent-delegations',
            headers,
            payload: {
              id: 'recursive_api_key_delegation',
              agentPrincipalId: principalId,
              capabilities: ['events.read'],
              resourceScopes: [`event:${eventId}`],
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
          app.inject({
            method: 'POST',
            url: `/agent-delegations/${delegationId}/revoke`,
            headers,
          }),
        ]);
        expect(responses.map(({ statusCode }) => statusCode)).toEqual(Array(7).fill(403));
        expect(await controlCounts(db)).toEqual(before);
      } finally {
        await app.close();
      }
    });
  },
);
