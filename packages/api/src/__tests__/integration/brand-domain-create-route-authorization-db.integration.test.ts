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
import { BRAND_DOMAIN_CREATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const contract = BRAND_DOMAIN_CREATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;

describeWithIntegrationDatabase('brand domain create route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let checkpoint: AppContext['brandDomainCreateCheckpoint'];
  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_bdc_${suffix}`;
  const foreignTenantId = `tnt_bdc_f_${suffix}`;
  const organizationId = `org_bdc_${suffix}`;
  const siblingOrganizationId = `org_bdc_s_${suffix}`;
  const foreignOrganizationId = `org_bdc_f_${suffix}`;
  const brandId = `brd_bdc_${suffix}`;
  const siblingBrandId = `brd_bdc_s_${suffix}`;
  const foreignBrandId = `brd_bdc_f_${suffix}`;
  const actorId = `usr_bdc_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId, siblingOrganizationId],
    scopes: ['settings.write'],
  };

  const domain = (label: string) => `${label}-${suffix}.example.test`;

  async function snapshot() {
    const [domains, audits] = await Promise.all([
      db
        .selectFrom('brand_domains')
        .select(['id', 'brand_id', 'domain', 'is_primary', 'is_verified', 'ssl_status'])
        .where('brand_id', 'in', [brandId, siblingBrandId, foreignBrandId])
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select(['action', 'resource_id', 'resource_type', 'diff_summary'])
        .where('tenant_id', '=', tenantId)
        .orderBy('id')
        .execute(),
    ]);
    return { audits, domains };
  }

  async function invoke(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/brands/${id}/domains`,
      payload,
    });
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
          name: 'Brand domain tenant',
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignTenantId,
          name: 'Foreign domain tenant',
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
          name: 'Brand domain workspace',
          slug: `bdc-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: 'Brand domain sibling workspace',
          slug: `bdc-s-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignOrganizationId,
          tenant_id: foreignTenantId,
          name: 'Foreign domain workspace',
          slug: `bdc-f-${suffix}`,
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
      .values([
        {
          id: brandId,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: 'Brand domain primary',
          slug: `bdc-primary-${suffix}`,
          status: 'draft',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingBrandId,
          tenant_id: tenantId,
          organization_id: siblingOrganizationId,
          name: 'Brand domain sibling',
          slug: `bdc-sibling-${suffix}`,
          status: 'draft',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignBrandId,
          tenant_id: foreignTenantId,
          organization_id: foreignOrganizationId,
          name: 'Brand domain foreign',
          slug: `bdc-foreign-${suffix}`,
          status: 'draft',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    app = Fastify({ logger: false, genReqId: () => `req_bdc_${suffix}` });
    app.decorate('context', {
      db,
      brandDomainCreateCheckpoint: (
        input: Parameters<NonNullable<AppContext['brandDomainCreateCheckpoint']>>[0],
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
    principal = basePrincipal;
    checkpoint = undefined;
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db
      .deleteFrom('brand_domains')
      .where('brand_id', 'in', [brandId, siblingBrandId, foreignBrandId])
      .execute();
  });

  afterAll(async () => {
    try {
      await app?.close();
      await db
        ?.deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, foreignTenantId])
        .execute();
      await db
        ?.deleteFrom('brand_domains')
        .where('brand_id', 'in', [brandId, siblingBrandId, foreignBrandId])
        .execute();
      await db
        ?.deleteFrom('brands')
        .where('id', 'in', [brandId, siblingBrandId, foreignBrandId])
        .execute();
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

  it('binds executable resource and event policy denials to the contract', () => {
    expect(contract).toMatchObject({
      method: 'POST',
      path: '/brands/{brandId}/domains',
      authorizedControl: { required: true, status: 201 },
      deniedBoundaries: ['tenant', 'organization', 'brand'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: {
        discriminator: 'principal-scope',
        value: 'no-event-scope',
      },
      persistenceSource: 'brand-domain-create-route-authorization-db.integration.test.ts',
      sideEffectAssertions: ['persistence'],
    });
  });

  it('creates a domain and persists a truthful sanitized atomic audit', async () => {
    const response = await invoke(brandId, {
      domain: domain('created'),
      isPrimary: true,
    });
    expect(response.statusCode, response.body).toBe(201);
    const after = await snapshot();
    expect(after.domains).toHaveLength(1);
    expect(after.domains[0]).toMatchObject({
      brand_id: brandId,
      domain: domain('created'),
    });
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      action: 'brand_domain.created',
      resource_id: response.json().id,
      resource_type: 'BrandDomain',
    });
    const audit =
      typeof after.audits[0]!.diff_summary === 'string'
        ? JSON.parse(after.audits[0]!.diff_summary as string)
        : after.audits[0]!.diff_summary;
    expect(audit).toEqual({
      after: {
        brandId,
        domain: domain('created'),
        isPrimary: true,
        demotedPrimaries: [],
      },
    });
  });

  it('persists and audits an omitted primary flag as false', async () => {
    const response = await invoke(brandId, { domain: domain('non-primary') });
    expect(response.statusCode, response.body).toBe(201);
    const after = await snapshot();
    expect(
      after.domains[0]!.is_primary === false || (after.domains[0]!.is_primary as unknown) === 0,
    ).toBe(true);
    const audit =
      typeof after.audits[0]!.diff_summary === 'string'
        ? JSON.parse(after.audits[0]!.diff_summary as string)
        : after.audits[0]!.diff_summary;
    expect(audit).toEqual({
      after: {
        brandId,
        domain: domain('non-primary'),
        isPrimary: false,
        demotedPrimaries: [],
      },
    });
  });

  it.each([
    ['permission', { ...basePrincipal, scopes: [] }, brandId, 403, 'FORBIDDEN'],
    ['tenant', { ...basePrincipal, tenantId: foreignTenantId }, brandId, 404, 'NOT_FOUND'],
    [
      'organization',
      { ...basePrincipal, organizationIds: [siblingOrganizationId] },
      brandId,
      404,
      'NOT_FOUND',
    ],
    ['brand', { ...basePrincipal, brandIds: [siblingBrandId] }, brandId, 404, 'NOT_FOUND'],
    ['event scope', { ...basePrincipal, eventIds: ['evt_bdc_scoped'] }, brandId, 403, 'FORBIDDEN'],
  ] as const)('is %s-first and side-effect free', async (_boundary, denied, id, status, code) => {
    const before = await snapshot();
    principal = {
      ...denied,
      organizationIds: [...denied.organizationIds],
      scopes: [...denied.scopes],
    } as Principal;
    const response = await invoke(id, { domain: domain(`denied-${code}`) });
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('returns byte-identical concealed Brand 404 responses before parsing', async () => {
    const before = await snapshot();
    const requests: Array<readonly [Principal, string]> = [
      [{ ...basePrincipal, tenantId: foreignTenantId }, brandId],
      [{ ...basePrincipal, organizationIds: [siblingOrganizationId] }, brandId],
      [{ ...basePrincipal, brandIds: [siblingBrandId] }, brandId],
      [basePrincipal, `brd_missing_${suffix}`],
    ];
    const bodies: string[] = [];
    for (const [denied, id] of requests) {
      principal = {
        ...denied,
        organizationIds: [...denied.organizationIds],
        scopes: [...denied.scopes],
      } as Principal;
      const response = await invoke(id, { domain: 42 });
      expect(response.statusCode, response.body).toBe(404);
      bodies.push(response.body);
    }
    expect(new Set(bodies).size).toBe(1);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('denies malformed payloads before parsing when permission or event policy is absent', async () => {
    const before = await snapshot();
    principal = { ...basePrincipal, scopes: [] };
    const permissionDenied = await invoke(brandId, { domain: 42 });
    expect(permissionDenied.statusCode, permissionDenied.body).toBe(403);
    principal = { ...basePrincipal, eventIds: ['evt_bdc_malformed'] };
    const eventDenied = await invoke(brandId, { domain: 42 });
    expect(eventDenied.statusCode, eventDenied.body).toBe(403);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('does not contend on a foreign Brand lock during tenant-scoped nonlocking preflight', async () => {
    const blockerDb = createDb(integrationDatabaseUrl());
    const locked = deferred();
    const release = deferred();
    const blocker = blockerDb.transaction().execute(async (trx) => {
      await trx
        .selectFrom('brands')
        .select('id')
        .where('id', '=', foreignBrandId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const result = await Promise.race([
        invoke(foreignBrandId, { domain: domain('foreign-lock') }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('foreign lock blocked preflight')), 1_500),
        ),
      ]);
      expect(result.statusCode, result.body).toBe(404);
    } finally {
      release.resolve();
      await blocker.catch(() => undefined);
      await blockerDb.destroy();
    }
  });

  it('rechecks locked permission, event policy, resource authority, and Brand existence before persistence', async () => {
    const before = await snapshot();
    principal = { ...basePrincipal, scopes: [...basePrincipal.scopes] };
    checkpoint = async (input) => {
      if (input.stage === 'after_brand_lock') principal.scopes = [];
    };
    const permission = await invoke(brandId, { domain: domain('permission-race') });
    expect(permission.statusCode, permission.body).toBe(403);

    principal = { ...basePrincipal };
    checkpoint = async (input) => {
      if (input.stage === 'after_brand_lock') principal.eventIds = ['evt_bdc_race'];
    };
    const event = await invoke(brandId, { domain: domain('event-race') });
    expect(event.statusCode, event.body).toBe(403);

    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
    };
    checkpoint = async (input) => {
      if (input.stage === 'after_brand_lock') principal.organizationIds = [siblingOrganizationId];
    };
    const authority = await invoke(brandId, { domain: domain('authority') });
    expect(authority.statusCode, authority.body).toBe(404);
    expect(authority.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    principal = basePrincipal;
    checkpoint = async (input) => {
      if (input.stage === 'before_brand_lock')
        await db.deleteFrom('brands').where('id', '=', brandId).execute();
    };
    const removed = await invoke(brandId, { domain: domain('removed') });
    expect(removed.statusCode, removed.body).toBe(404);
    await db
      .insertInto('brands')
      .values({
        id: brandId,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: 'Brand domain primary',
        slug: `bdc-primary-${suffix}`,
        status: 'draft',
        theme: '{}',
        legal_urls: '{}',
        white_label: false,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('normalizes existing and concurrent cross-brand domain collisions without an owner leak', async () => {
    await db
      .insertInto('brand_domains')
      .values({
        id: `bdom_existing_${suffix}`,
        brand_id: siblingBrandId,
        domain: domain('taken'),
        is_primary: false,
        is_verified: false,
        ssl_status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const existing = await invoke(brandId, { domain: domain('taken') });
    expect(existing.statusCode, existing.body).toBe(409);
    expect(existing.body).not.toContain(siblingBrandId);
    await db.deleteFrom('brand_domains').where('domain', '=', domain('taken')).execute();
    const firstAttempts = new Set<string>();
    const releaseInsertBarrier = deferred();
    checkpoint = async (input) => {
      if (input.stage !== 'before_domain_insert' || input.domain !== domain('collision')) return;
      if (firstAttempts.has(input.brandId)) return;
      firstAttempts.add(input.brandId);
      if (firstAttempts.size === 2) {
        releaseInsertBarrier.resolve();
        return;
      }
      await releaseInsertBarrier.promise;
    };
    const [first, second] = await Promise.all([
      invoke(brandId, { domain: domain('collision') }),
      invoke(siblingBrandId, { domain: domain('collision') }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(firstAttempts).toEqual(new Set([brandId, siblingBrandId]));
    const loser = [first, second].find((response) => response.statusCode === 409)!;
    expect(loser.body).not.toContain(brandId);
    expect(loser.body).not.toContain(siblingBrandId);
    const after = await snapshot();
    expect(after.domains.filter((entry) => entry.domain === domain('collision'))).toHaveLength(1);
    expect(after.audits).toHaveLength(1);
  });

  it('serializes primary replacement so each completed request has one final primary', async () => {
    const lowerPrimaryId = `bdom_primary_a_${suffix}`;
    const higherPrimaryId = `bdom_primary_z_${suffix}`;
    const now = new Date();
    await db
      .insertInto('brand_domains')
      .values([
        {
          id: higherPrimaryId,
          brand_id: brandId,
          domain: domain('legacy-z'),
          is_primary: true,
          is_verified: false,
          ssl_status: 'pending',
          created_at: now,
          updated_at: now,
        },
        {
          id: lowerPrimaryId,
          brand_id: brandId,
          domain: domain('legacy-a'),
          is_primary: true,
          is_verified: false,
          ssl_status: 'pending',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    const [first, second] = await Promise.all([
      invoke(brandId, { domain: domain('primary-one'), isPrimary: true }),
      invoke(brandId, { domain: domain('primary-two'), isPrimary: true }),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    const after = await snapshot();
    expect(
      after.domains.filter(
        (entry) =>
          entry.brand_id === brandId &&
          (entry.is_primary === true || (entry.is_primary as unknown) === 1),
      ),
    ).toHaveLength(1);
    const finalPrimary = after.domains.find(
      (entry) =>
        entry.brand_id === brandId &&
        (entry.is_primary === true || (entry.is_primary as unknown) === 1),
    )!;
    const finalAudit = after.audits.find((entry) => entry.resource_id === finalPrimary.id)!;
    const finalAuditDiff =
      typeof finalAudit.diff_summary === 'string'
        ? JSON.parse(finalAudit.diff_summary)
        : finalAudit.diff_summary;
    expect(finalAuditDiff).toMatchObject({
      after: {
        domain: finalPrimary.domain,
        isPrimary: true,
        demotedPrimaries: expect.any(Array),
      },
    });
    const audits = after.audits.map((entry) =>
      typeof entry.diff_summary === 'string' ? JSON.parse(entry.diff_summary) : entry.diff_summary,
    );
    const legacyDemotion = audits.find((entry) => entry.after.demotedPrimaries.length === 2)!;
    expect(legacyDemotion.after.demotedPrimaries).toEqual([
      { id: lowerPrimaryId, domain: domain('legacy-a') },
      { id: higherPrimaryId, domain: domain('legacy-z') },
    ]);
    expect(
      after.domains
        .filter((entry) => [lowerPrimaryId, higherPrimaryId].includes(entry.id))
        .every((entry) => entry.is_primary === false || (entry.is_primary as unknown) === 0),
    ).toBe(true);
  });

  it('rolls back the domain when its required audit cannot be persisted', async () => {
    await db
      .insertInto('brand_domains')
      .values({
        id: `bdom_audit_seed_${suffix}`,
        brand_id: brandId,
        domain: domain('audit-seed'),
        is_primary: true,
        is_verified: false,
        ssl_status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    const before = await snapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected audit failure'));
    try {
      const response = await invoke(brandId, {
        domain: domain('audit-rollback'),
        isPrimary: true,
      });
      expect(response.statusCode, response.body).toBe(500);
      await expect(snapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }
  });

  it('retries only recognized transaction conflicts with the three-attempt cap', async () => {
    let attempts = 0;
    checkpoint = async (input) => {
      if (input.stage !== 'before_brand_lock') return;
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('injected serialization'), {
          code: '40001',
        });
      }
    };
    const retried = await invoke(brandId, { domain: domain('retry') });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(attempts).toBe(2);

    attempts = 0;
    checkpoint = async (input) => {
      if (input.stage !== 'before_brand_lock') return;
      attempts += 1;
      throw Object.assign(new Error('injected deadlock'), {
        code: 'ER_LOCK_DEADLOCK',
      });
    };
    const exhausted = await invoke(brandId, {
      domain: domain('retry-exhausted'),
    });
    expect(exhausted.statusCode, exhausted.body).toBe(500);
    expect(attempts).toBe(3);

    attempts = 0;
    checkpoint = async (input) => {
      if (input.stage !== 'before_brand_lock') return;
      attempts += 1;
      throw new Error('injected nonretryable error');
    };
    const nonretryable = await invoke(brandId, {
      domain: domain('nonretryable'),
    });
    expect(nonretryable.statusCode, nonretryable.body).toBe(500);
    expect(attempts).toBe(1);
  });
});
