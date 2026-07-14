import type { Principal } from '@tixkit/domain';
import {
  createDb,
  type Database,
  runMigrations,
  TenantRepository,
  truncateAllData,
} from '@tixkit/db';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../app.js';
import { agentMemoryRoutes } from '../../routes/modules/agent-memory.js';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (candidate) =>
    candidate.url.length > 0 && (!requestedDriver || candidate.driver === requestedDriver),
) as DriverCase[];

if (driverCases.length === 0)
  it.skip('agent memory route integration (database URLs are not configured)', () => {});

async function buildApp(db: Database, principal: Principal) {
  const app = Fastify({ logger: false, genReqId: () => 'req_agent_memory_db' });
  app.decorate('context', { db } as never);
  app.addHook('preHandler', async (request) => {
    request.principal = principal;
  });
  registerErrorHandler(app);
  await app.register(agentMemoryRoutes);
  return app;
}

describe.sequential.each(driverCases)(
  'agent memory route persistence: $driver',
  ({ driver, url }) => {
    let db: Database;
    let tenantId: string;
    const sponsorId = 'user_memory_route_sponsor';
    const otherDeveloperId = 'user_memory_route_other';

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
      await truncateAllData(db);
      tenantId = (await new TenantRepository(db).create({ name: `Memory routes ${driver}` })).id;
      const now = new Date();
      await db
        .insertInto('user_profiles')
        .values(
          [sponsorId, otherDeveloperId].map((id, index) => ({
            id,
            tenant_id: tenantId,
            clerk_user_id: `clerk_memory_route_${driver}_${index}`,
            email: `memory-route-${driver}-${index}@example.test`,
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
        .values([
          {
            id: 'pg_memory_route_sponsor',
            tenant_id: tenantId,
            principal_type: 'user',
            principal_id: sponsorId,
            permission: 'settings.write',
            scope_type: 'tenant',
            scope_id: null,
            created_at: now,
            updated_at: now,
          },
          {
            id: 'pg_memory_route_other',
            tenant_id: tenantId,
            principal_type: 'user',
            principal_id: otherDeveloperId,
            permission: 'developers.write',
            scope_type: 'tenant',
            scope_id: null,
            created_at: now,
            updated_at: now,
          },
        ])
        .execute();
    });

    afterAll(async () => {
      await db?.destroy();
    });

    it('composes sponsor isolation, audit, versioning, export, erasure, and live replay denial', async () => {
      const sponsorApp = await buildApp(db, {
        type: 'user',
        id: sponsorId,
        tenantId,
        organizationIds: [],
        scopes: ['settings.write'],
      });
      const otherApp = await buildApp(db, {
        type: 'user',
        id: otherDeveloperId,
        tenantId,
        organizationIds: [],
        scopes: ['developers.write'],
      });
      const namespace = { scopeType: 'workspace', purpose: 'organizer_preferences' } as const;
      const createKey = 'memory-route-create-000001';
      try {
        const created = await sponsorApp.inject({
          method: 'POST',
          url: '/agent-memory',
          headers: { 'idempotency-key': createKey },
          payload: {
            namespace,
            key: 'copy_preferences',
            content: {
              kind: 'organizer_preferences',
              summary: 'Prefer concise updates',
            },
            retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        expect(created.statusCode).toBe(201);
        const entryId = created.json().id as string;
        const inspected = await sponsorApp.inject({
          method: 'POST',
          url: '/agent-memory/inspect',
          headers: { 'idempotency-key': 'x'.repeat(255) },
          payload: { namespace },
        });
        expect(inspected.statusCode).toBe(200);
        expect(inspected.json().entries).toHaveLength(1);
        const exported = await sponsorApp.inject({
          method: 'POST',
          url: '/agent-memory/export',
          headers: { 'idempotency-key': 'memory-route-export-000001' },
          payload: { namespace },
        });
        expect(exported.statusCode).toBe(200);
        expect(exported.json().sha256).toMatch(/^[a-f0-9]{64}$/u);
        const corrected = await sponsorApp.inject({
          method: 'PATCH',
          url: `/agent-memory/${entryId}`,
          headers: { 'idempotency-key': 'memory-route-correct-00001' },
          payload: {
            expectedVersion: 1,
            content: {
              kind: 'organizer_preferences',
              summary: 'Prefer direct updates',
            },
            retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        expect(corrected.statusCode).toBe(200);
        expect(corrected.json().version).toBe(2);
        const crossSponsor = await otherApp.inject({
          method: 'PATCH',
          url: `/agent-memory/${entryId}`,
          headers: { 'idempotency-key': 'memory-route-cross-sponsor-01' },
          payload: {
            expectedVersion: 2,
            content: {
              kind: 'organizer_preferences',
              summary: 'Unauthorized rewrite',
            },
            retentionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        expect(crossSponsor.statusCode).toBe(403);
        const removeRequest = {
          method: 'POST' as const,
          url: `/agent-memory/${entryId}/delete`,
          headers: { 'idempotency-key': 'memory-route-delete-000001' },
          payload: { namespace, expectedVersion: 2 },
        };
        expect((await sponsorApp.inject(removeRequest)).statusCode).toBe(200);
        expect(
          await db
            .selectFrom('agent_memory_entries')
            .select('id')
            .where('id', '=', entryId)
            .execute(),
        ).toHaveLength(0);
        await db
          .deleteFrom('permission_grants')
          .where('id', '=', 'pg_memory_route_sponsor')
          .execute();
        expect((await sponsorApp.inject(removeRequest)).statusCode).toBe(403);
        const events = await db
          .selectFrom('agent_memory_events')
          .select(['operation', 'actor_principal_id', 'previous_sha256', 'new_sha256'])
          .where('tenant_id', '=', tenantId)
          .execute();
        expect(events.map(({ operation }) => operation)).toEqual(
          expect.arrayContaining(['create', 'inspect', 'export', 'correct', 'delete']),
        );
        expect(JSON.stringify(events)).not.toContain('direct updates');
      } finally {
        await sponsorApp.close();
        await otherApp.close();
      }
    });
  },
);
