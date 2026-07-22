import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { BRAND_CREATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function parseAuditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

const contract = BRAND_CREATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;

describeWithIntegrationDatabase('brand create route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let checkpoint: AppContext['brandCreateCheckpoint'];
  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_bc_${suffix}`;
  const foreignTenantId = `tnt_bc_f_${suffix}`;
  const organizationId = `org_bc_${suffix}`;
  const siblingOrganizationId = `org_bc_s_${suffix}`;
  const foreignOrganizationId = `org_bc_f_${suffix}`;
  const actorId = `usr_bc_${suffix}`;
  const grantId = `pgr_bc_${suffix}`;
  const foreignSlug = `foreign-shared-${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId],
    scopes: ['settings.write'],
  };

  const payload = (slug: string, organization = organizationId) => ({
    organizationId: organization,
    name: `Create brand ${slug}`,
    slug,
    theme: { accent: '#123456', providerSecret: `must-not-audit-${suffix}` },
    whiteLabel: true,
  });

  async function invoke(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/brands', payload: body });
  }

  async function created(slug: string) {
    return db
      .selectFrom('brands')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', slug)
      .execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db
      .insertInto('tenants')
      .values([
        {
          id: tenantId,
          name: 'Brand create tenant',
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignTenantId,
          name: 'Foreign brand create tenant',
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('organizations')
      .values([
        {
          id: organizationId,
          tenant_id: tenantId,
          name: 'Brand create workspace',
          slug: `bc-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: 'Brand create sibling',
          slug: `bc-s-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignOrganizationId,
          tenant_id: foreignTenantId,
          name: 'Foreign brand create workspace',
          slug: `bc-f-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('brands')
      .values({
        id: `brd_foreign_${suffix}`,
        tenant_id: foreignTenantId,
        organization_id: foreignOrganizationId,
        name: 'Foreign shared slug',
        slug: foreignSlug,
        status: 'draft',
        theme: '{}',
        legal_urls: '{}',
        white_label: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
    app = Fastify({ logger: false, genReqId: () => `req_bc_${suffix}` });
    app.decorate('context', {
      db,
      brandCreateCheckpoint: (
        input: Parameters<NonNullable<AppContext['brandCreateCheckpoint']>>[0],
      ) => checkpoint?.(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(tenantRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = undefined;
    vi.restoreAllMocks();
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db
      .deleteFrom('permission_grants')
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', actorId)
      .execute();
    await db
      .insertInto('permission_grants')
      .values({
        id: grantId,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: actorId,
        permission: 'settings.write',
        scope_type: 'organization',
        scope_id: organizationId,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db.deleteFrom('brands').where('tenant_id', '=', tenantId).execute();
  });

  afterAll(async () => {
    try {
      await app?.close();
      await db
        ?.deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, foreignTenantId])
        .execute();
      await db
        ?.deleteFrom('brands')
        .where('tenant_id', 'in', [tenantId, foreignTenantId])
        .execute();
      await db?.deleteFrom('permission_grants').where('tenant_id', '=', tenantId).execute();
      await db
        ?.deleteFrom('organizations')
        .where('id', 'in', [organizationId, siblingOrganizationId, foreignOrganizationId])
        .execute();
      await db?.deleteFrom('tenants').where('id', 'in', [tenantId, foreignTenantId]).execute();
    } finally {
      await db?.destroy();
      restoreDatabaseDriver(previousDriver);
    }
  });

  it('binds executable tenant, organization, permission, and scope policy denials to the contract', () => {
    expect(contract).toMatchObject({
      method: 'POST',
      path: '/brands',
      authorizedControl: { required: true, status: 201 },
      deniedBoundaries: ['tenant', 'organization'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      persistenceSource: 'brand-create-route-authorization-db.integration.test.ts',
    });
  });

  it('persists defaults and a sanitized atomic audit from the stored brand', async () => {
    const slug = `created-${suffix}`;
    const stages: string[] = [];
    checkpoint = (input) => {
      stages.push(input.stage);
    };
    const response = await invoke(payload(slug));
    expect(stages).toEqual([
      'before_organization_lock',
      'after_organization_lock',
      'before_brand_insert',
    ]);
    expect(response.statusCode, response.body).toBe(201);
    const row = (await created(slug))[0]!;
    expect(row).toMatchObject({
      organization_id: organizationId,
      name: `Create brand ${slug}`,
      slug,
      status: 'draft',
    });
    expect([true, 1]).toContain(row.white_label);
    const persistedTheme = typeof row.theme === 'string' ? JSON.parse(row.theme) : row.theme;
    expect(persistedTheme).toMatchObject({
      accent: '#123456',
      providerSecret: `must-not-audit-${suffix}`,
    });
    const audits = await db
      .selectFrom('audit_logs')
      .select(['action', 'resource_id', 'diff_summary'])
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(audits).toHaveLength(1);
    const diff = parseAuditDiff(audits[0]!.diff_summary);
    expect(audits[0]).toMatchObject({ action: 'brand.created', resource_id: row.id });
    expect(diff.after).toMatchObject({
      id: row.id,
      organizationId,
      slug,
      status: 'draft',
      whiteLabel: true,
      paymentAccountId: null,
    });
    expect(JSON.stringify(diff)).not.toContain('providerSecret');
  });

  it('checks permission and creation policy before full body parsing', async () => {
    const malformed = { organizationId, unexpected: true };
    principal = { ...basePrincipal, scopes: [] };
    expect((await invoke(malformed)).statusCode).toBe(403);
    principal = { ...basePrincipal, organizationIds: [organizationId], brandIds: ['brd_scope'] };
    expect((await invoke(malformed)).statusCode).toBe(403);
    principal = { ...basePrincipal, organizationIds: [organizationId], eventIds: ['evt_scope'] };
    expect((await invoke(malformed)).statusCode).toBe(403);
    principal = basePrincipal;
    expect((await invoke(malformed)).statusCode).toBe(400);
    expect(await created(`unexpected-${suffix}`)).toEqual([]);
  });

  it('conceals missing, foreign, and wrong-scope organizations with identical responses', async () => {
    const missing = await invoke(payload(`missing-${suffix}`, `org_missing_${suffix}`));
    const foreign = await invoke(payload(`foreign-${suffix}`, foreignOrganizationId));
    principal = { ...basePrincipal, organizationIds: [siblingOrganizationId] };
    const wrongScope = await invoke(payload(`scope-${suffix}`, organizationId));
    for (const response of [missing, foreign, wrongScope]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(missing.body);
    }
  });

  it('does not contend on a held foreign organization lock before returning the concealed response', async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', foreignOrganizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const response = await Promise.race([
        invoke(payload(`held-foreign-${suffix}`, foreignOrganizationId)),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('FOREIGN_ORGANIZATION_PRECHECK_BLOCKED')), 1_000);
        }),
      ]);
      expect(response.statusCode).toBe(404);
    });
  });

  it('re-authorizes permission and organization scope after the authoritative lock', async () => {
    checkpoint = async (input) => {
      if (input.stage !== 'after_organization_lock') return;
      principal.scopes = [];
    };
    expect((await invoke(payload(`permission-race-${suffix}`))).statusCode).toBe(403);
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = async (input) => {
      if (input.stage !== 'after_organization_lock') return;
      principal.organizationIds = [siblingOrganizationId];
    };
    expect((await invoke(payload(`scope-race-${suffix}`))).statusCode).toBe(404);
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = async (input) => {
      if (input.stage !== 'after_organization_lock') return;
      principal.brandIds = ['brd_post_lock_scope'];
    };
    expect((await invoke(payload(`brand-scope-race-${suffix}`))).statusCode).toBe(403);
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = async (input) => {
      if (input.stage !== 'after_organization_lock') return;
      principal.eventIds = ['evt_post_lock_scope'];
    };
    expect((await invoke(payload(`event-scope-race-${suffix}`))).statusCode).toBe(403);
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = async (input) => {
      if (input.stage !== 'after_organization_lock') return;
      principal.tenantId = foreignTenantId;
    };
    expect((await invoke(payload(`tenant-race-${suffix}`))).statusCode).toBe(404);
  });

  it('fails closed when the persisted organization grant disappears before the lock', async () => {
    checkpoint = async (input) => {
      if (input.stage !== 'before_organization_lock') return;
      await db
        .deleteFrom('permission_grants')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', grantId)
        .execute();
    };
    const response = await invoke(payload(`pre-lock-revoked-${suffix}`));
    expect(response.statusCode).toBe(403);
    expect(await created(`pre-lock-revoked-${suffix}`)).toEqual([]);
  });

  it('fails closed when revocation occurs while creation waits on the organization lock', async () => {
    const beforeLock = deferred();
    const releaseToLock = deferred();
    const afterLock = deferred();
    let requestHasLock = false;
    checkpoint = async (input) => {
      if (input.stage === 'before_organization_lock') {
        beforeLock.resolve();
        await releaseToLock.promise;
      }
      if (input.stage === 'after_organization_lock') {
        requestHasLock = true;
        afterLock.resolve();
      }
    };
    const responsePromise = invoke(payload(`wait-revoked-${suffix}`));
    try {
      await beforeLock.promise;
      await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('organizations')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', organizationId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        releaseToLock.resolve();
        await Promise.race([
          afterLock.promise.then(() => {
            throw new Error('REQUEST_DID_NOT_WAIT_ON_ORGANIZATION_LOCK');
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 25)),
        ]);
        expect(requestHasLock).toBe(false);
        await trx
          .deleteFrom('permission_grants')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', grantId)
          .execute();
      });
      const response = await responsePromise;
      expect(response.statusCode).toBe(403);
      expect(await created(`wait-revoked-${suffix}`)).toEqual([]);
    } finally {
      releaseToLock.resolve();
      await responsePromise.catch(() => undefined);
    }
  });

  it('conceals an organization deleted between preflight and the authoritative lock', async () => {
    const siblingGrantId = `pgr_bc_s_${suffix}`;
    const now = new Date();
    await db
      .insertInto('permission_grants')
      .values({
        id: siblingGrantId,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: actorId,
        permission: 'settings.write',
        scope_type: 'organization',
        scope_id: siblingOrganizationId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    principal = { ...basePrincipal, organizationIds: [siblingOrganizationId] };
    let siblingDeleted = false;
    checkpoint = async (input) => {
      if (input.stage !== 'before_organization_lock') return;
      await db.deleteFrom('organizations').where('id', '=', siblingOrganizationId).execute();
      siblingDeleted = true;
    };
    try {
      const response = await invoke(payload(`deleted-org-${suffix}`, siblingOrganizationId));
      expect(response.statusCode).toBe(404);
    } finally {
      if (siblingDeleted) {
        await db
          .insertInto('organizations')
          .values({
            id: siblingOrganizationId,
            tenant_id: tenantId,
            name: 'Brand create sibling',
            slug: `bc-s-${suffix}`,
            clerk_organization_id: null,
            box_office_settings: '{}',
            status: 'active',
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
    }
  });

  it('fails closed when the persisted organization grant is revoked after the organization lock', async () => {
    checkpoint = async (input) => {
      if (input.stage !== 'after_organization_lock') return;
      await db
        .deleteFrom('permission_grants')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', grantId)
        .execute();
    };
    const response = await invoke(payload(`revoked-grant-${suffix}`));
    expect(response.statusCode).toBe(403);
    expect(await created(`revoked-grant-${suffix}`)).toEqual([]);
  });

  it('normalizes same-tenant slug collisions and permits the same slug in a foreign tenant', async () => {
    const slug = `collision-${suffix}`;
    await db
      .insertInto('brands')
      .values({
        id: `brd_existing_${suffix}`,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: 'Existing',
        slug,
        status: 'draft',
        theme: '{}',
        legal_urls: '{}',
        white_label: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const collision = await invoke(payload(slug));
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(collision.body).not.toContain(organizationId);
    expect(collision.body).not.toContain(slug);
    expect(
      await db
        .selectFrom('audit_logs')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('action', '=', 'brand.created')
        .execute(),
    ).toHaveLength(0);
    await db.deleteFrom('brands').where('id', '=', `brd_existing_${suffix}`).execute();
    expect((await invoke(payload(foreignSlug))).statusCode).toBe(201);
  });

  it('serializes two cross-organization arrivals on the tenant-wide slug constraint', async () => {
    const slug = `concurrent-${suffix}`;
    const arrival = deferred();
    let arrivals = 0;
    principal = {
      type: 'system',
      id: `sys_bc_${suffix}`,
      tenantId,
      organizationIds: [organizationId, siblingOrganizationId],
      scopes: ['settings.write'],
    };
    checkpoint = async (input) => {
      if (input.stage !== 'before_brand_insert' || input.slug !== slug) return;
      arrivals += 1;
      if (arrivals === 2) arrival.resolve();
      await arrival.promise;
    };
    const [first, second] = await Promise.all([
      invoke(payload(slug, organizationId)),
      invoke(payload(slug, siblingOrganizationId)),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(arrivals).toBe(2);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.body).not.toContain(organizationId);
    expect(loser.body).not.toContain(siblingOrganizationId);
    expect(loser.body).not.toContain(slug);
    expect(await created(slug)).toHaveLength(1);
    const auditCount = await db
      .selectFrom('audit_logs')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'brand.created')
      .execute();
    expect(auditCount).toHaveLength(1);
  });

  it('retries only retryable transaction conflicts and stops after three attempts', async () => {
    let attempts = 0;
    checkpoint = (input) => {
      if (input.stage !== 'before_organization_lock') return;
      attempts += 1;
      if (attempts < 2) throw Object.assign(new Error('serialization retry'), { code: '40001' });
    };
    expect((await invoke(payload(`retry-two-${suffix}`))).statusCode).toBe(201);
    expect(attempts).toBe(2);

    attempts = 0;
    checkpoint = (input) => {
      if (input.stage !== 'before_organization_lock') return;
      attempts += 1;
      throw Object.assign(new Error('not retryable'), { code: 'XX000' });
    };
    expect((await invoke(payload(`retry-one-${suffix}`))).statusCode).toBe(500);
    expect(attempts).toBe(1);

    attempts = 0;
    checkpoint = (input) => {
      if (input.stage !== 'before_organization_lock') return;
      attempts += 1;
      throw Object.assign(new Error('serialization exhausted'), { code: '40001' });
    };
    expect((await invoke(payload(`retry-exhausted-${suffix}`))).statusCode).toBe(500);
    expect(attempts).toBe(3);
  });

  it('rolls the new brand back when the required audit cannot be persisted', async () => {
    vi.spyOn(AuditLogRepository.prototype, 'create').mockRejectedValueOnce(
      new Error('audit unavailable'),
    );
    const slug = `audit-rollback-${suffix}`;
    expect((await invoke(payload(slug))).statusCode).toBe(500);
    expect(await created(slug)).toEqual([]);
  });
});
