import type { Principal } from '@tixkit/domain';
import {
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
import { registerErrorHandler } from '../../app.js';
import { agentControlRoutes } from '../../routes/modules/agent-control.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
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

describe.sequential.each(driverCases)(
  'agent control route persistence: $driver',
  ({ driver, url }) => {
    let db: Database;
    let tenantId: string;
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
  },
);
