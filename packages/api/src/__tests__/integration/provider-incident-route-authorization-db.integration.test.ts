import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { providerIncidentRoutes } from '../../routes/modules/provider-incidents.js';
import type { ProviderIncidentEvidenceService } from '../../services/provider-incident-evidence.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('provider incident route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let activePrincipal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_pie_${suffix}`;
  const organizationId = `org_pie_${suffix}`;
  const userId = `usr_pie_${suffix}`;
  const evidenceId = 'pie_01HZZZZZZZZZZZZZZZZZZZZZZZ';
  const correlationSha256 = `sha256:${'a'.repeat(64)}`;
  const findActiveByCorrelation = vi.fn(async () => []);
  const reveal = vi.fn(async () => 'req_authorized_control');

  function authorizedPrincipal(overrides: Partial<Principal> = {}): Principal {
    return {
      type: 'user',
      id: userId,
      tenantId,
      organizationIds: [organizationId],
      scopes: ['provider_incidents.read'],
      ...overrides,
    };
  }

  async function persistenceSnapshot(): Promise<Readonly<{ audits: number; evidence: number }>> {
    const [auditRow, evidenceRow] = await Promise.all([
      db
        .selectFrom('audit_logs')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('provider_incident_evidence')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .executeTakeFirstOrThrow(),
    ]);
    return { audits: Number(auditRow.count), evidence: Number(evidenceRow.count) };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: `Provider incident authorization ${suffix}`,
        status: 'active',
        plan: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organizations')
      .values({
        id: organizationId,
        tenant_id: tenantId,
        name: `Provider incident organization ${suffix}`,
        slug: `provider-incident-${suffix}`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('user_profiles')
      .values({
        id: userId,
        tenant_id: tenantId,
        clerk_user_id: `clerk_pie_${suffix}`,
        email: `provider-incident-${suffix}@example.test`,
        first_name: null,
        last_name: null,
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organization_members')
      .values({
        id: `mem_pie_${suffix}`,
        tenant_id: tenantId,
        organization_id: organizationId,
        user_id: userId,
        role: 'owner',
        invited_at: now,
        accepted_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('permission_grants')
      .values({
        id: `pgr_pie_${suffix}`,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: userId,
        permission: 'provider_incidents.read',
        scope_type: 'organization',
        scope_id: organizationId,
        created_at: now,
        updated_at: now,
      })
      .execute();

    activePrincipal = authorizedPrincipal();
    app = Fastify();
    app.decorate('context', { db } as AppContext);
    app.addHook('preHandler', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(rateLimit, { global: false });
    await app.register(providerIncidentRoutes, {
      service: { findActiveByCorrelation, reveal } as unknown as ProviderIncidentEvidenceService,
    });
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.deleteFrom('permission_grants').where('id', '=', `pgr_pie_${suffix}`).execute();
      await db.deleteFrom('organization_members').where('id', '=', `mem_pie_${suffix}`).execute();
      await db.deleteFrom('user_profiles').where('id', '=', userId).execute();
      await db.deleteFrom('organizations').where('id', '=', organizationId).execute();
      await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  const operations = [
    {
      name: 'hash lookup',
      inject: () =>
        app.inject({
          method: 'GET',
          url: `/provider-incidents?organizationId=${organizationId}&correlationSha256=${correlationSha256}`,
        }),
    },
    {
      name: 'plaintext reveal',
      inject: () =>
        app.inject({
          method: 'POST',
          url: `/provider-incidents/${evidenceId}/reveal`,
          payload: { organizationId, reason: 'Authorization matrix control' },
        }),
    },
  ] as const;

  for (const operation of operations) {
    describe(operation.name, () => {
      it('allows the exact current organization owner with the scoped grant', async () => {
        activePrincipal = authorizedPrincipal();
        const response = await operation.inject();
        expect(response.statusCode).toBe(200);
      });

      it.each([
        ['tenant', { tenantId: `tnt_other_${suffix}` }],
        ['organization membership and grant', { id: `usr_other_${suffix}` }],
      ])(
        'returns indistinguishable not-found across the %s boundary',
        async (_label, overrides) => {
          vi.clearAllMocks();
          const before = await persistenceSnapshot();
          activePrincipal = authorizedPrincipal(overrides);
          const response = await operation.inject();
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
          expect(findActiveByCorrelation).not.toHaveBeenCalled();
          expect(reveal).not.toHaveBeenCalled();
          await expect(persistenceSnapshot()).resolves.toEqual(before);
        },
      );
    });
  }
});
