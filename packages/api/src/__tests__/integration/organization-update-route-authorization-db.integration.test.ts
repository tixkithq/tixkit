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
import { ORGANIZATION_UPDATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

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

function parseJsonObject(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

const updateContract = ORGANIZATION_UPDATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;
const defaultBoxOfficeSettings = {
  enabled: true,
  allowedTenderTypes: ['cash', 'manual_card', 'comp'],
  requireBuyerEmail: false,
  receiptMode: 'email',
};

describeWithIntegrationDatabase('organization update route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let organizationUpdateCheckpoint: AppContext['organizationUpdateCheckpoint'];

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_org_update_${suffix}`;
  const foreignTenantId = `tnt_org_u_f_${suffix}`;
  const organizationId = `org_update_${suffix}`;
  const siblingOrganizationId = `org_update_sibling_${suffix}`;
  const foreignOrganizationId = `org_update_foreign_${suffix}`;
  const venueId = `ven_org_update_${suffix}`;
  const siblingVenueId = `ven_org_update_s_${suffix}`;
  const foreignVenueId = `ven_org_update_f_${suffix}`;
  const actorId = `usr_org_update_${suffix}`;
  const actorMemberId = `mem_org_update_${suffix}`;
  const siblingActorMemberId = `mem_org_update_s_${suffix}`;
  const grantId = `pg_org_update_${suffix}`;
  const siblingGrantId = `pg_org_update_s_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId, siblingOrganizationId],
    scopes: ['settings.write'],
  };

  async function snapshot() {
    const [organization, audits] = await Promise.all([
      db
        .selectFrom('organizations')
        .select([
          'id',
          'tenant_id',
          'name',
          'slug',
          'clerk_organization_id',
          'box_office_settings',
          'event_defaults',
        ])
        .where('id', '=', organizationId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('audit_logs')
        .select([
          'tenant_id',
          'organization_id',
          'actor_id',
          'action',
          'resource_type',
          'resource_id',
          'diff_summary',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('id')
        .execute(),
    ]);
    return { organization, audits };
  }

  async function invoke(payload: Record<string, unknown>) {
    return invokeOrganization(organizationId, payload);
  }

  async function invokeOrganization(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/organizations/${id}`,
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
          name: 'Organization update tenant',
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignTenantId,
          name: 'Foreign organization update tenant',
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
          name: 'Organization update workspace',
          slug: `organization-update-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: JSON.stringify(defaultBoxOfficeSettings),
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: 'Organization update sibling workspace',
          slug: `organization-update-sibling-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: JSON.stringify(defaultBoxOfficeSettings),
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignOrganizationId,
          tenant_id: foreignTenantId,
          name: 'Foreign organization update workspace',
          slug: `organization-update-foreign-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: JSON.stringify(defaultBoxOfficeSettings),
          status: 'active',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('user_profiles')
      .values({
        id: actorId,
        tenant_id: tenantId,
        clerk_user_id: `clerk_${actorId}`,
        email: `organization-update-${suffix}@example.test`,
        first_name: 'Organization',
        last_name: 'Updater',
        avatar_url: null,
        status: 'active',
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('organization_members')
      .values([
        {
          id: actorMemberId,
          tenant_id: tenantId,
          organization_id: organizationId,
          user_id: actorId,
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingActorMemberId,
          tenant_id: tenantId,
          organization_id: siblingOrganizationId,
          user_id: actorId,
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('venues')
      .values([
        {
          id: venueId,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: 'Organization update venue',
          address: '{}',
          timezone: 'UTC',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingVenueId,
          tenant_id: tenantId,
          organization_id: siblingOrganizationId,
          name: 'Sibling organization update venue',
          address: '{}',
          timezone: 'UTC',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignVenueId,
          tenant_id: foreignTenantId,
          organization_id: foreignOrganizationId,
          name: 'Foreign organization update venue',
          address: '{}',
          timezone: 'UTC',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    principal = basePrincipal;
    app = Fastify({ logger: false, genReqId: () => `req_org_update_${suffix}` });
    app.decorate('context', {
      db,
      organizationUpdateCheckpoint: (
        input: Parameters<NonNullable<AppContext['organizationUpdateCheckpoint']>>[0],
      ) => organizationUpdateCheckpoint?.(input),
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
    organizationUpdateCheckpoint = undefined;
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db
      .deleteFrom('permission_grants')
      .where('tenant_id', '=', tenantId)
      .where('principal_id', '=', actorId)
      .execute();
    await db
      .insertInto('permission_grants')
      .values([
        {
          id: grantId,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: actorId,
          permission: 'settings.write',
          scope_type: 'organization',
          scope_id: organizationId,
          organization_member_id: actorMemberId,
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingGrantId,
          tenant_id: tenantId,
          principal_type: 'user',
          principal_id: actorId,
          permission: 'settings.write',
          scope_type: 'organization',
          scope_id: siblingOrganizationId,
          organization_member_id: siblingActorMemberId,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .updateTable('organizations')
      .set({
        name: 'Organization update workspace',
        slug: `organization-update-${suffix}`,
        clerk_organization_id: null,
        box_office_settings: JSON.stringify(defaultBoxOfficeSettings),
        event_defaults: '{}',
        updated_at: now,
      })
      .where('id', '=', organizationId)
      .execute();
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      if (db) {
        await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('permission_grants').where('tenant_id', '=', tenantId).execute();
        await db
          .deleteFrom('venues')
          .where('tenant_id', 'in', [tenantId, foreignTenantId])
          .execute();
        await db.deleteFrom('organization_members').where('tenant_id', '=', tenantId).execute();
        await db.deleteFrom('user_profiles').where('tenant_id', '=', tenantId).execute();
        await db
          .deleteFrom('organizations')
          .where('id', 'in', [organizationId, siblingOrganizationId])
          .execute();
        await db.deleteFrom('organizations').where('id', '=', foreignOrganizationId).execute();
        await db.deleteFrom('tenants').where('id', 'in', [tenantId, foreignTenantId]).execute();
      }
    } finally {
      if (db) await db.destroy();
      restoreDatabaseDriver(previousDriver);
    }
  });

  it('binds the executable matrix to the organization update contract', () => {
    expect(updateContract).toMatchObject({
      method: 'PATCH',
      path: '/organizations/{organizationId}',
      authorizedControl: { required: true, status: 200 },
      deniedBoundaries: ['tenant', 'organization'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      principalTypeDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'organization-update-route-authorization-db.integration.test.ts',
      sideEffectAssertions: ['persistence'],
    });
  });

  it('updates exact fields and persists the corresponding audit in the same transaction', async () => {
    const response = await invoke({
      name: 'Updated organization workspace',
      slug: `updated-organization-${suffix}`,
      clerkOrganizationId: `clerk_updated_${suffix}`,
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
      eventDefaults: { timezone: 'America/Chicago', defaultVenueId: venueId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: organizationId,
      name: 'Updated organization workspace',
      slug: `updated-organization-${suffix}`,
      clerkOrganizationId: `clerk_updated_${suffix}`,
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash'],
        requireBuyerEmail: true,
        receiptMode: 'both',
      },
      eventDefaults: { timezone: 'America/Chicago', defaultVenueId: venueId },
    });
    const after = await snapshot();
    expect(after.organization).toMatchObject({
      id: organizationId,
      tenant_id: tenantId,
      name: 'Updated organization workspace',
      slug: `updated-organization-${suffix}`,
      clerk_organization_id: `clerk_updated_${suffix}`,
      box_office_settings: expect.anything(),
      event_defaults: JSON.stringify({ timezone: 'America/Chicago', defaultVenueId: venueId }),
    });
    expect(parseJsonObject(after.organization.box_office_settings)).toEqual({
      enabled: true,
      allowedTenderTypes: ['cash'],
      requireBuyerEmail: true,
      receiptMode: 'both',
    });
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      tenant_id: tenantId,
      organization_id: organizationId,
      actor_id: actorId,
      action: 'organization.updated',
      resource_type: 'Organization',
      resource_id: organizationId,
    });
    expect(parseAuditDiff(after.audits[0]!.diff_summary)).toEqual({
      before: {
        id: organizationId,
        name: 'Organization update workspace',
        slug: `organization-update-${suffix}`,
        clerkOrganizationId: null,
        boxOfficeSettings: defaultBoxOfficeSettings,
        eventDefaults: {},
      },
      after: {
        id: organizationId,
        name: 'Updated organization workspace',
        slug: `updated-organization-${suffix}`,
        clerkOrganizationId: `clerk_updated_${suffix}`,
        boxOfficeSettings: {
          enabled: true,
          allowedTenderTypes: ['cash'],
          requireBuyerEmail: true,
          receiptMode: 'both',
        },
        eventDefaults: { timezone: 'America/Chicago', defaultVenueId: venueId },
      },
      changedFields: ['name', 'slug', 'clerkOrganizationId', 'boxOfficeSettings', 'eventDefaults'],
      noOp: false,
    });
  });

  it('is permission-first and makes denied requests side-effect free', async () => {
    const before = await snapshot();
    principal = { ...basePrincipal, scopes: [] };
    const response = await invoke({ name: 'Denied without settings permission' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('records explicit identical snapshots for a no-op update', async () => {
    const response = await invoke({
      name: 'Organization update workspace',
      slug: `organization-update-${suffix}`,
      boxOfficeSettings: defaultBoxOfficeSettings,
      eventDefaults: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    const after = await snapshot();
    expect(after.audits).toHaveLength(1);
    const diff = parseAuditDiff(after.audits[0]!.diff_summary);
    expect(diff.noOp).toBe(true);
    expect(diff.changedFields).toEqual([]);
    expect(diff.before).toEqual(diff.after);
  });

  it.each(['api_key', 'agent', 'mobile_device', 'system'] as const)(
    'denies %s principals even when the claim carries settings.write',
    async (type) => {
      const before = await snapshot();
      principal = { ...basePrincipal, type, id: `${type}_${suffix}` };
      const response = await invoke({ name: `${type} denied update` });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      await expect(snapshot()).resolves.toEqual(before);
    },
  );

  it.each([
    ['organization scope', { ...basePrincipal, organizationIds: [siblingOrganizationId] }],
    [
      'tenant scope',
      { ...basePrincipal, tenantId: foreignTenantId, organizationIds: [organizationId] },
    ],
  ] as const)('conceals the workspace after a denied %s', async (_case, deniedPrincipal) => {
    const before = await snapshot();
    principal = {
      ...deniedPrincipal,
      organizationIds: [...deniedPrincipal.organizationIds],
      scopes: [...deniedPrincipal.scopes],
    };
    const response = await invoke({ name: 'Concealed organization update' });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('returns identical concealed bodies for organization, tenant, and nonexistent selectors', async () => {
    const before = await snapshot();
    principal = { ...basePrincipal, organizationIds: [siblingOrganizationId] };
    const organizationDenied = await invokeOrganization(organizationId, { name: 'Concealed' });
    principal = { ...basePrincipal, tenantId: foreignTenantId, organizationIds: [organizationId] };
    const tenantDenied = await invokeOrganization(organizationId, { name: 'Concealed' });
    principal = { ...basePrincipal, organizationIds: [organizationId] };
    const nonexistentDenied = await invokeOrganization(`org_missing_${suffix}`, {
      name: 'Concealed',
    });
    for (const response of [organizationDenied, tenantDenied, nonexistentDenied]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(organizationDenied.body).toBe(tenantDenied.body);
    expect(tenantDenied.body).toBe(nonexistentDenied.body);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('rechecks the live grant after waiting on the organization lock', async () => {
    const blockerDb = createDb(integrationDatabaseUrl());
    const locked = deferred();
    const release = deferred();
    const blocker = blockerDb.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('organizations')
        .select('id')
        .where('id', '=', organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const before = await snapshot();
      const pending = invoke({ name: 'Revoked while waiting' });
      await db
        .deleteFrom('permission_grants')
        .where('id', '=', grantId)
        .where('tenant_id', '=', tenantId)
        .execute();
      release.resolve();
      const response = await pending;
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      await expect(blocker).resolves.toBeUndefined();
      expect(await snapshot()).toEqual(before);
    } finally {
      release.resolve();
      await blocker.catch(() => undefined);
      await blockerDb.destroy();
    }
  });

  it('rechecks the live grant at the immediate pre-lock checkpoint', async () => {
    const before = await snapshot();
    organizationUpdateCheckpoint = async (input) => {
      if (input.stage !== 'before_lock') return;
      expect(input).toEqual({ stage: 'before_lock', organizationId });
      await db
        .deleteFrom('permission_grants')
        .where('id', '=', grantId)
        .where('tenant_id', '=', tenantId)
        .execute();
    };
    const response = await invoke({ name: 'Revoked at organization checkpoint' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('accepts only an exact in-workspace default venue and rejects foreign venues', async () => {
    const valid = await invoke({ eventDefaults: { defaultVenueId: venueId } });
    expect(valid.statusCode, valid.body).toBe(200);
    expect(valid.json()).toMatchObject({ eventDefaults: { defaultVenueId: venueId } });

    const afterValid = await snapshot();
    const crossOrganization = await invoke({ eventDefaults: { defaultVenueId: siblingVenueId } });
    expect(crossOrganization.statusCode, crossOrganization.body).toBe(400);
    expect(crossOrganization.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await expect(snapshot()).resolves.toEqual(afterValid);

    const foreignTenant = await invoke({ eventDefaults: { defaultVenueId: foreignVenueId } });
    expect(foreignTenant.statusCode, foreignTenant.body).toBe(400);
    expect(foreignTenant.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await expect(snapshot()).resolves.toEqual(afterValid);
  });

  it.each([
    [
      'deletion',
      async () => {
        await db.deleteFrom('venues').where('id', '=', venueId).execute();
      },
      async () => {
        const now = new Date('2026-07-22T12:00:00.000Z');
        await db
          .insertInto('venues')
          .values({
            id: venueId,
            tenant_id: tenantId,
            organization_id: organizationId,
            name: 'Organization update venue',
            address: '{}',
            timezone: 'UTC',
            created_at: now,
            updated_at: now,
          })
          .execute();
      },
    ],
    [
      'cross-organization reparent',
      async () => {
        await db
          .updateTable('venues')
          .set({ organization_id: siblingOrganizationId })
          .where('id', '=', venueId)
          .execute();
      },
      async () => {
        await db
          .updateTable('venues')
          .set({ organization_id: organizationId })
          .where('id', '=', venueId)
          .execute();
      },
    ],
  ] as const)(
    'freshly revalidates a default venue after a pre-lock %s mutation without persisting an invalid reference',
    async (_race, mutateVenue, restoreVenue) => {
      const before = await snapshot();
      organizationUpdateCheckpoint = async (input) => {
        if (input.stage !== 'before_lock') return;
        await mutateVenue();
      };
      try {
        const response = await invoke({ eventDefaults: { defaultVenueId: venueId } });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
        expect(await snapshot()).toEqual(before);
      } finally {
        await restoreVenue();
      }
    },
  );

  it('serializes concurrent same-workspace patches into truthful ordered audits', async () => {
    const firstLocked = deferred();
    const secondAttemptedLock = deferred();
    const releaseFirst = deferred();
    let beforeLockCount = 0;
    let afterLockCount = 0;
    organizationUpdateCheckpoint = async (input) => {
      expect(input.organizationId).toBe(organizationId);
      if (input.stage === 'before_lock') {
        beforeLockCount += 1;
        if (beforeLockCount === 2) secondAttemptedLock.resolve();
        return;
      }
      afterLockCount += 1;
      if (afterLockCount !== 1) return;
      firstLocked.resolve();
      await releaseFirst.promise;
    };
    const firstPending = invoke({ name: 'Concurrent organization update first' });
    await firstLocked.promise;
    const secondPending = invoke({ name: 'Concurrent organization update second' });
    await secondAttemptedLock.promise;
    releaseFirst.resolve();
    const [first, second] = await Promise.all([firstPending, secondPending]);
    expect([first.statusCode, second.statusCode], `${first.body}\n${second.body}`).toEqual([
      200, 200,
    ]);
    expect(beforeLockCount).toBeGreaterThanOrEqual(2);
    expect(afterLockCount).toBeGreaterThanOrEqual(2);
    const after = await snapshot();
    expect(after.organization.name).toBe('Concurrent organization update second');
    expect(after.audits).toHaveLength(2);
    const diffs = after.audits.map((audit) => parseAuditDiff(audit.diff_summary));
    expect(diffs[0]!.before).toMatchObject({ name: 'Organization update workspace' });
    expect(diffs[0]!.after).toMatchObject({ name: 'Concurrent organization update first' });
    expect(diffs[1]!.before).toMatchObject({ name: 'Concurrent organization update first' });
    expect(diffs[1]!.after).toMatchObject({ name: 'Concurrent organization update second' });
    expect(diffs.every((diff) => diff.noOp === false)).toBe(true);
  });

  it('retries recognized nested and symbolic transaction conflicts before one atomic success', async () => {
    const before = await snapshot();
    let attempts = 0;
    const checkpointStages: string[] = [];
    organizationUpdateCheckpoint = async (input) => {
      checkpointStages.push(input.stage);
      if (input.stage !== 'before_lock') return;
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('injected PostgreSQL serialization'), {
          cause: { code: '40001' },
        });
      }
      if (attempts === 2) {
        throw Object.assign(new Error('injected MySQL deadlock'), { code: 'ER_LOCK_DEADLOCK' });
      }
    };
    const response = await invoke({ name: 'Retry committed organization update' });
    expect(
      response.statusCode,
      `retry checkpoint attempts=${attempts}; stages=${checkpointStages.join(',')}; body=${response.body}`,
    ).toBe(200);
    expect(attempts).toBe(3);
    const after = await snapshot();
    expect(after.organization.name).toBe('Retry committed organization update');
    expect(after.audits).toHaveLength(1);
    expect(parseAuditDiff(after.audits[0]!.diff_summary)).toMatchObject({
      before: expect.objectContaining({ name: before.organization.name }),
      after: expect.objectContaining({ name: 'Retry committed organization update' }),
      noOp: false,
    });
  });

  it('exhausts retryable transaction conflicts after exactly three attempts without effects', async () => {
    const before = await snapshot();
    let attempts = 0;
    organizationUpdateCheckpoint = async (input) => {
      if (input.stage !== 'before_lock') return;
      attempts += 1;
      throw Object.assign(new Error('injected lock timeout'), { errno: 1205 });
    };
    const response = await invoke({ name: 'Retry exhaustion must not persist' });
    expect(response.statusCode, response.body).toBe(500);
    expect(attempts).toBe(3);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('does not retry nonretryable transaction failures', async () => {
    const before = await snapshot();
    let attempts = 0;
    organizationUpdateCheckpoint = async (input) => {
      if (input.stage !== 'before_lock') return;
      attempts += 1;
      throw new Error('injected nonretryable organization update failure');
    };
    const response = await invoke({ name: 'Nonretryable failure must not persist' });
    expect(response.statusCode, response.body).toBe(500);
    expect(attempts).toBe(1);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('normalizes a concurrent cross-organization Clerk ID collision without partial effects', async () => {
    const clerkOrganizationId = `clerk_collision_${suffix}`;
    const [first, second] = await Promise.all([
      invokeOrganization(organizationId, {
        name: 'Clerk collision primary organization',
        clerkOrganizationId,
      }),
      invokeOrganization(siblingOrganizationId, {
        name: 'Clerk collision sibling organization',
        clerkOrganizationId,
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses, `${first.body}\n${second.body}`).toEqual([200, 400]);
    const organizations = await db
      .selectFrom('organizations')
      .select(['id', 'name', 'clerk_organization_id'])
      .where('id', 'in', [organizationId, siblingOrganizationId])
      .orderBy('id')
      .execute();
    expect(
      organizations.filter(
        (organization) => organization.clerk_organization_id === clerkOrganizationId,
      ),
    ).toHaveLength(1);
    expect(
      organizations.filter((organization) =>
        ['Clerk collision primary organization', 'Clerk collision sibling organization'].includes(
          organization.name,
        ),
      ),
    ).toHaveLength(1);
    const audits = await db
      .selectFrom('audit_logs')
      .select(['organization_id', 'action', 'diff_summary'])
      .where('tenant_id', '=', tenantId)
      .where('action', '=', 'organization.updated')
      .execute();
    expect(audits).toHaveLength(1);
    expect(parseAuditDiff(audits[0]!.diff_summary).after).toMatchObject({
      clerkOrganizationId,
    });
  });

  it('rolls the organization change back when the required audit write fails', async () => {
    const before = await snapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected organization update audit failure'));
    try {
      const response = await invoke({ name: 'Audit rollback organization update' });
      expect(response.statusCode, response.body).toBe(500);
      await expect(snapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }
    const retry = await invoke({ name: 'Audit rollback organization update' });
    expect(retry.statusCode, retry.body).toBe(200);
    const after = await snapshot();
    expect(after.organization.name).toBe('Audit rollback organization update');
    expect(after.audits).toHaveLength(1);
  });
});
