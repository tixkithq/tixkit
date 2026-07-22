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
import { BRAND_UPDATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

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

const updateContract = BRAND_UPDATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;

describeWithIntegrationDatabase('brand update route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let brandUpdateCheckpoint: AppContext['brandUpdateCheckpoint'];

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_bu_${suffix}`;
  const foreignTenantId = `tnt_bu_f_${suffix}`;
  const organizationId = `org_bu_${suffix}`;
  const siblingOrganizationId = `org_bu_s_${suffix}`;
  const foreignOrganizationId = `org_bu_f_${suffix}`;
  const brandId = `brd_bu_${suffix}`;
  const siblingBrandId = `brd_bu_s_${suffix}`;
  const foreignBrandId = `brd_bu_f_${suffix}`;
  const accountId = `pa_bu_${suffix}`;
  const siblingAccountId = `pa_bu_s_${suffix}`;
  const foreignAccountId = `pa_bu_f_${suffix}`;
  const actorId = `usr_bu_${suffix}`;
  const providerSecret = `provider-secret-${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId, siblingOrganizationId],
    scopes: ['settings.write'],
  };

  async function snapshot() {
    const [brand, accounts, audits] = await Promise.all([
      db
        .selectFrom('brands')
        .select([
          'id',
          'tenant_id',
          'organization_id',
          'name',
          'slug',
          'status',
          'theme',
          'payment_account_id',
          'support_url',
          'legal_urls',
          'white_label',
        ])
        .where('id', '=', brandId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('payment_accounts')
        .select(['id', 'tenant_id', 'organization_id'])
        .where('id', 'in', [accountId, siblingAccountId, foreignAccountId])
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select(['action', 'resource_id', 'diff_summary'])
        .where('tenant_id', '=', tenantId)
        .where('resource_id', '=', brandId)
        .orderBy('id')
        .execute(),
    ]);
    return { accounts, audits, brand };
  }

  async function invoke(id: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/brands/${id}`, payload });
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
          name: 'Brand update tenant',
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignTenantId,
          name: 'Foreign brand update tenant',
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
          name: 'Brand update workspace',
          slug: `brand-update-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: 'Brand update sibling workspace',
          slug: `brand-update-sibling-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignOrganizationId,
          tenant_id: foreignTenantId,
          name: 'Foreign brand update workspace',
          slug: `brand-update-foreign-${suffix}`,
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
          name: 'Brand update primary',
          slug: `brand-update-primary-${suffix}`,
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
          name: 'Brand update sibling',
          slug: `brand-update-sibling-${suffix}`,
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
          name: 'Brand update foreign',
          slug: `brand-update-foreign-${suffix}`,
          status: 'draft',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('payment_accounts')
      .values([
        {
          id: accountId,
          tenant_id: tenantId,
          organization_id: organizationId,
          provider: 'manual',
          provider_account_id: providerSecret,
          status: 'active',
          default_currency: 'usd',
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: '{}',
          disabled_reason: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingAccountId,
          tenant_id: tenantId,
          organization_id: siblingOrganizationId,
          provider: 'stripe_connect',
          provider_account_id: `acct_${siblingAccountId}`,
          status: 'active',
          default_currency: 'usd',
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: '{}',
          disabled_reason: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignAccountId,
          tenant_id: foreignTenantId,
          organization_id: foreignOrganizationId,
          provider: 'stripe_connect',
          provider_account_id: `acct_${foreignAccountId}`,
          status: 'active',
          default_currency: 'usd',
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: '{}',
          disabled_reason: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    app = Fastify({ logger: false, genReqId: () => `req_brand_update_${suffix}` });
    app.decorate('context', {
      db,
      brandUpdateCheckpoint: (
        input: Parameters<NonNullable<AppContext['brandUpdateCheckpoint']>>[0],
      ) => brandUpdateCheckpoint?.(input),
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
    brandUpdateCheckpoint = undefined;
    const now = new Date('2026-07-22T12:00:00.000Z');
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db
      .updateTable('brands')
      .set({
        name: 'Brand update primary',
        slug: `brand-update-primary-${suffix}`,
        status: 'draft',
        theme: '{}',
        payment_account_id: null,
        support_url: null,
        legal_urls: '{}',
        white_label: false,
        updated_at: now,
      })
      .where('id', '=', brandId)
      .execute();
    await db
      .updateTable('payment_accounts')
      .set({ organization_id: organizationId, updated_at: now })
      .where('id', '=', accountId)
      .execute();
    const account = await db
      .selectFrom('payment_accounts')
      .select('id')
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account) {
      await db
        .insertInto('payment_accounts')
        .values({
          id: accountId,
          tenant_id: tenantId,
          organization_id: organizationId,
          provider: 'manual',
          provider_account_id: providerSecret,
          status: 'active',
          default_currency: 'usd',
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: '{}',
          disabled_reason: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
      if (db) {
        await db
          .deleteFrom('audit_logs')
          .where('tenant_id', 'in', [tenantId, foreignTenantId])
          .execute();
        await db
          .deleteFrom('payment_accounts')
          .where('id', 'in', [accountId, siblingAccountId, foreignAccountId])
          .execute();
        await db
          .deleteFrom('brands')
          .where('id', 'in', [brandId, siblingBrandId, foreignBrandId])
          .execute();
        await db
          .deleteFrom('organizations')
          .where('id', 'in', [organizationId, siblingOrganizationId, foreignOrganizationId])
          .execute();
        await db.deleteFrom('tenants').where('id', 'in', [tenantId, foreignTenantId]).execute();
      }
    } finally {
      if (db) await db.destroy();
      restoreDatabaseDriver(previousDriver);
    }
  });

  it('binds five executable denials to the brand update contract', () => {
    expect(updateContract).toMatchObject({
      method: 'PATCH',
      path: '/brands/{brandId}',
      authorizedControl: { required: true, status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
      persistenceSource: 'brand-update-route-authorization-db.integration.test.ts',
      sideEffectAssertions: ['persistence'],
    });
  });

  it('updates the locked brand and writes a truthful sanitized audit in the same transaction', async () => {
    const response = await invoke(brandId, {
      name: 'Updated brand',
      theme: { accent: '#123456' },
      supportUrl: 'https://support.example.test',
      legalUrls: { terms: 'https://example.test/terms' },
      whiteLabel: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    const after = await snapshot();
    expect(after.brand).toMatchObject({
      name: 'Updated brand',
      theme: expect.anything(),
      support_url: 'https://support.example.test',
      legal_urls: expect.anything(),
      white_label: expect.anything(),
    });
    const storedWhiteLabel = after.brand.white_label as unknown;
    expect(storedWhiteLabel === true || storedWhiteLabel === 1).toBe(true);
    expect(
      typeof after.brand.theme === 'string' ? JSON.parse(after.brand.theme) : after.brand.theme,
    ).toEqual({
      accent: '#123456',
    });
    expect(
      typeof after.brand.legal_urls === 'string'
        ? JSON.parse(after.brand.legal_urls)
        : after.brand.legal_urls,
    ).toEqual({ terms: 'https://example.test/terms' });
    expect(after.audits).toHaveLength(1);
    expect(parseAuditDiff(after.audits[0]!.diff_summary)).toEqual(
      expect.objectContaining({
        before: expect.objectContaining({ name: 'Brand update primary', paymentAccountId: null }),
        after: expect.objectContaining({
          name: 'Updated brand',
          theme: { accent: '#123456' },
          supportUrl: 'https://support.example.test',
          legalUrls: { terms: 'https://example.test/terms' },
          whiteLabel: true,
        }),
        changedFields: expect.arrayContaining([
          'name',
          'theme',
          'supportUrl',
          'legalUrls',
          'whiteLabel',
        ]),
        noOp: false,
      }),
    );
    expect(response.body).not.toContain(providerSecret);
    expect(JSON.stringify(after.audits)).not.toContain(providerSecret);
  });

  it.each([
    [
      'permission',
      { ...basePrincipal, scopes: [] },
      brandId,
      { name: 'Denied permission' },
      403,
      'FORBIDDEN',
    ],
    [
      'tenant',
      { ...basePrincipal, tenantId: foreignTenantId },
      brandId,
      { name: 'Denied tenant' },
      404,
      'NOT_FOUND',
    ],
    [
      'organization',
      { ...basePrincipal, organizationIds: [siblingOrganizationId] },
      brandId,
      { name: 'Denied organization' },
      404,
      'NOT_FOUND',
    ],
    [
      'brand',
      { ...basePrincipal, brandIds: [siblingBrandId] },
      brandId,
      { name: 'Denied brand' },
      404,
      'NOT_FOUND',
    ],
    [
      'event scope',
      { ...basePrincipal, eventIds: ['evt_scoped'] },
      brandId,
      { name: 'Denied event scope' },
      403,
      'FORBIDDEN',
    ],
  ] as const)(
    'is %s-first and side-effect free',
    async (_boundary, deniedPrincipal, id, payload, status, code) => {
      const before = await snapshot();
      principal = {
        ...deniedPrincipal,
        ...(deniedPrincipal.brandIds ? { brandIds: [...deniedPrincipal.brandIds] } : {}),
        ...(deniedPrincipal.eventIds ? { eventIds: [...deniedPrincipal.eventIds] } : {}),
        organizationIds: [...deniedPrincipal.organizationIds],
        scopes: [...deniedPrincipal.scopes],
      } as Principal;
      const response = await invoke(id, payload);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      await expect(snapshot()).resolves.toEqual(before);
    },
  );

  it('returns byte-identical concealed Brand 404 bodies for tenant, organization, brand, and nonexistent selectors', async () => {
    const before = await snapshot();
    const requests: Array<readonly [Principal, string]> = [
      [{ ...basePrincipal, tenantId: foreignTenantId }, brandId],
      [{ ...basePrincipal, organizationIds: [siblingOrganizationId] }, brandId],
      [{ ...basePrincipal, brandIds: [siblingBrandId] }, brandId],
      [basePrincipal, `brd_missing_${suffix}`],
    ];
    const bodies: string[] = [];
    for (const [deniedPrincipal, id] of requests) {
      principal = {
        ...deniedPrincipal,
        ...(deniedPrincipal.brandIds ? { brandIds: [...deniedPrincipal.brandIds] } : {}),
        organizationIds: [...deniedPrincipal.organizationIds],
        scopes: [...deniedPrincipal.scopes],
      };
      const response = await invoke(id, { name: 'Concealed brand update' });
      expect(response.statusCode, response.body).toBe(404);
      bodies.push(response.body);
    }
    expect(new Set(bodies).size).toBe(1);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('denies malformed settings and payment-binding shapes before schema parsing without effects', async () => {
    const before = await snapshot();
    principal = { ...basePrincipal, scopes: [] };
    for (const payload of [{ name: 42 }, { paymentAccountId: 42 }]) {
      const response = await invoke(brandId, payload);
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('permits billing-only payment-account bindings but denies mixed settings smuggling', async () => {
    principal = { ...basePrincipal, scopes: ['billing.write'] };
    const stages: string[] = [];
    brandUpdateCheckpoint = async (input) => {
      stages.push(input.stage);
    };
    const binding = await invoke(brandId, { paymentAccountId: accountId });
    expect(binding.statusCode, binding.body).toBe(200);
    expect((await snapshot()).brand.payment_account_id).toBe(accountId);
    expect(stages).toEqual(['before_brand_lock', 'after_brand_lock', 'after_account_lock']);

    const before = await snapshot();
    const smuggled = await invoke(brandId, {
      paymentAccountId: null,
      name: 'Billing must not change settings',
    });
    expect(smuggled.statusCode, smuggled.body).toBe(403);
    expect(smuggled.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('locks the brand before its account and rejects invalid account hierarchy without effects', async () => {
    const before = await snapshot();
    const response = await invoke(brandId, { paymentAccountId: siblingAccountId });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('normalizes missing and foreign payment accounts without locking or exposing the foreign account', async () => {
    const blockerDb = createDb(integrationDatabaseUrl());
    const locked = deferred();
    const release = deferred();
    const blocker = blockerDb.transaction().execute(async (trx) => {
      await trx
        .selectFrom('payment_accounts')
        .select('id')
        .where('id', '=', foreignAccountId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const before = await snapshot();
      const stages: string[] = [];
      brandUpdateCheckpoint = async (input) => {
        stages.push(input.stage);
      };
      const foreign = await invoke(brandId, { paymentAccountId: foreignAccountId });
      const missing = await invoke(brandId, { paymentAccountId: `pa_missing_${suffix}` });
      expect([foreign.statusCode, missing.statusCode]).toEqual([400, 400]);
      expect(foreign.body).toBe(missing.body);
      expect(stages).toEqual([]);
      await expect(snapshot()).resolves.toEqual(before);
    } finally {
      release.resolve();
      await blocker.catch(() => undefined);
      await blockerDb.destroy();
    }
  });

  it.each([
    [
      'deletion',
      async () => db.deleteFrom('payment_accounts').where('id', '=', accountId).execute(),
    ],
    [
      'reassignment',
      async () =>
        db
          .updateTable('payment_accounts')
          .set({ organization_id: siblingOrganizationId })
          .where('id', '=', accountId)
          .execute(),
    ],
  ] as const)(
    'revalidates account %s after the checkpoint without persistence',
    async (_race, mutate) => {
      const before = await snapshot();
      const stages: string[] = [];
      let mutated = false;
      brandUpdateCheckpoint = async (input) => {
        stages.push(input.stage);
        if (input.stage === 'after_brand_lock' && !mutated) {
          mutated = true;
          await mutate();
        }
      };
      const response = await invoke(brandId, { paymentAccountId: accountId });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(stages.slice(0, 2)).toEqual(['before_brand_lock', 'after_brand_lock']);
      expect(stages).not.toContain('after_account_lock');
      expect((await snapshot()).audits).toEqual(before.audits);
    },
  );

  it('serializes same-brand updates into truthful ordered audits', async () => {
    const locked = deferred();
    const release = deferred();
    let afterBrandLocks = 0;
    brandUpdateCheckpoint = async (input) => {
      if (input.stage !== 'after_brand_lock') return;
      afterBrandLocks += 1;
      if (afterBrandLocks === 1) {
        locked.resolve();
        await release.promise;
      }
    };
    const first = invoke(brandId, { name: 'Brand concurrent first' });
    await locked.promise;
    const second = invoke(brandId, { name: 'Brand concurrent second' });
    release.resolve();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(
      [firstResponse.statusCode, secondResponse.statusCode],
      `${firstResponse.body}\n${secondResponse.body}`,
    ).toEqual([200, 200]);
    const after = await snapshot();
    expect(after.brand.name).toBe('Brand concurrent second');
    expect(after.audits).toHaveLength(2);
    const diffs = after.audits.map((audit) => parseAuditDiff(audit.diff_summary));
    expect(diffs[0]!.after).toMatchObject({ name: 'Brand concurrent first' });
    expect(diffs[1]!.before).toMatchObject({ name: 'Brand concurrent first' });
    expect(diffs[1]!.after).toMatchObject({ name: 'Brand concurrent second' });
  });

  it('records an explicit truthful no-op audit', async () => {
    const response = await invoke(brandId, { name: 'Brand update primary' });
    expect(response.statusCode, response.body).toBe(200);
    const audit = (await snapshot()).audits[0]!;
    expect(parseAuditDiff(audit.diff_summary)).toMatchObject({
      noOp: true,
      changedFields: [],
    });
  });

  it('retries recognized transaction conflicts with one atomic success and rolls back failed audits', async () => {
    const before = await snapshot();
    let attempts = 0;
    brandUpdateCheckpoint = async (input) => {
      if (input.stage !== 'before_brand_lock') return;
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error('injected serialization'), { cause: { code: '40001' } });
    };
    const retried = await invoke(brandId, { name: 'Retried brand update' });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(attempts).toBe(2);
    expect((await snapshot()).audits).toHaveLength(1);

    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected audit failure'));
    try {
      const failed = await invoke(brandId, { name: 'Audit rollback brand update' });
      expect(failed.statusCode, failed.body).toBe(500);
      expect((await snapshot()).brand.name).toBe('Retried brand update');
      expect((await snapshot()).audits).toEqual([]);
    } finally {
      failure.mockRestore();
    }
    const retry = await invoke(brandId, { name: 'Audit rollback brand update' });
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await snapshot()).audits).toHaveLength(1);
    expect(before.brand.name).toBe('Brand update primary');
  });

  it('exhausts retryable conflicts after exactly three attempts and does not retry nonretryable failures', async () => {
    const before = await snapshot();
    let attempts = 0;
    brandUpdateCheckpoint = async (input) => {
      if (input.stage !== 'before_brand_lock') return;
      attempts += 1;
      throw Object.assign(new Error('injected retryable conflict'), { code: 'ER_LOCK_DEADLOCK' });
    };
    const exhausted = await invoke(brandId, { name: 'Must not persist' });
    expect(exhausted.statusCode, exhausted.body).toBe(500);
    expect(attempts).toBe(3);
    await expect(snapshot()).resolves.toEqual(before);

    attempts = 0;
    brandUpdateCheckpoint = async (input) => {
      if (input.stage !== 'before_brand_lock') return;
      attempts += 1;
      throw new Error('injected nonretryable failure');
    };
    const nonretryable = await invoke(brandId, { name: 'Must not retry' });
    expect(nonretryable.statusCode, nonretryable.body).toBe(500);
    expect(attempts).toBe(1);
    await expect(snapshot()).resolves.toEqual(before);
  });
});
