import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { AuditLogRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { hashRequest } from '../../services/idempotency.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_CREATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const contract = EVENT_CREATE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0]!;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeWithIntegrationDatabase('event create route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let principal: Principal;
  let checkpoint: AppContext['eventCreateCheckpoint'];
  const metricInc = vi.fn();
  const metricObserve = vi.fn();
  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_ec_${suffix}`;
  const foreignTenantId = `tnt_ec_f_${suffix}`;
  const organizationId = `org_ec_${suffix}`;
  const siblingOrganizationId = `org_ec_s_${suffix}`;
  const foreignOrganizationId = `org_ec_f_${suffix}`;
  const brandId = `brd_ec_${suffix}`;
  const siblingBrandId = `brd_ec_s_${suffix}`;
  const foreignBrandId = `brd_ec_f_${suffix}`;
  const venueId = `ven_ec_${suffix}`;
  const foreignVenueId = `ven_ec_f_${suffix}`;
  const actorId = `usr_ec_${suffix}`;
  const grantId = `pgr_ec_${suffix}`;
  const basePrincipal: Principal = {
    type: 'user',
    id: actorId,
    tenantId,
    organizationIds: [organizationId],
    scopes: ['events.write'],
  };

  const payload = (slug: string, input: Record<string, unknown> = {}) => ({
    organizationId,
    brandId,
    slug,
    title: `Event create ${slug}`,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: '2027-09-01T18:00:00.000Z',
    ...input,
  });

  async function invoke(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: '/events', headers, payload: body });
  }

  async function snapshot() {
    const [events, pools, tickets, occurrences, audits, idempotency] = await Promise.all([
      db
        .selectFrom('events')
        .select(['id', 'organization_id', 'brand_id', 'slug', 'title'])
        .where('tenant_id', '=', tenantId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('inventory_pools')
        .innerJoin('events', 'events.id', 'inventory_pools.event_id')
        .select(['inventory_pools.id', 'inventory_pools.event_id'])
        .where('events.tenant_id', '=', tenantId)
        .orderBy('inventory_pools.id')
        .execute(),
      db
        .selectFrom('ticket_types')
        .innerJoin('events', 'events.id', 'ticket_types.event_id')
        .select(['ticket_types.id', 'ticket_types.event_id'])
        .where('events.tenant_id', '=', tenantId)
        .orderBy('ticket_types.id')
        .execute(),
      db
        .selectFrom('event_occurrences')
        .innerJoin('events', 'events.id', 'event_occurrences.event_id')
        .select(['event_occurrences.id', 'event_occurrences.event_id'])
        .where('events.tenant_id', '=', tenantId)
        .orderBy('event_occurrences.id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select(['id', 'action', 'resource_id', 'diff_summary'])
        .where('tenant_id', '=', tenantId)
        .where('actor_id', '=', actorId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('idempotency_records')
        .select(['key', 'request_hash', 'response_status', 'status'])
        .where('tenant_id', '=', tenantId)
        .orderBy('key')
        .execute(),
    ]);
    return { audits, events, idempotency, occurrences, pools, tickets };
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
          name: 'Event create tenant',
          status: 'active',
          plan: 'test',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignTenantId,
          name: 'Foreign event create tenant',
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
          name: 'Event create organization',
          slug: `ec-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: siblingOrganizationId,
          tenant_id: tenantId,
          name: 'Event create sibling',
          slug: `ec-s-${suffix}`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignOrganizationId,
          tenant_id: foreignTenantId,
          name: 'Foreign event create organization',
          slug: `ec-f-${suffix}`,
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
          name: 'Event create brand',
          slug: `ec-${suffix}`,
          status: 'active',
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
          name: 'Event create sibling brand',
          slug: `ec-s-${suffix}`,
          status: 'active',
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
          name: 'Foreign event create brand',
          slug: `ec-f-${suffix}`,
          status: 'active',
          theme: '{}',
          legal_urls: '{}',
          white_label: false,
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
          name: 'Event create venue',
          address: '{"city":"Austin"}',
          timezone: 'UTC',
          created_at: now,
          updated_at: now,
        },
        {
          id: foreignVenueId,
          tenant_id: foreignTenantId,
          organization_id: foreignOrganizationId,
          name: 'Foreign event create venue',
          address: '{}',
          timezone: 'UTC',
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    app = Fastify({ logger: false, genReqId: () => `req_ec_${suffix}` });
    app.decorate('observability', {
      metrics: {
        metrics: {
          onboardingEvents: { inc: metricInc },
          onboardingMilestoneDuration: { observe: metricObserve },
        },
      },
    } as never);
    app.decorate('context', {
      db,
      eventCreateCheckpoint: (
        input: Parameters<NonNullable<AppContext['eventCreateCheckpoint']>>[0],
      ) => checkpoint?.(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(eventRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    principal = {
      ...basePrincipal,
      organizationIds: [...basePrincipal.organizationIds],
      scopes: [...basePrincipal.scopes],
    };
    checkpoint = undefined;
    app.context.eventCreateIdempotencyOptions = undefined;
    vi.restoreAllMocks();
    metricInc.mockReset();
    metricObserve.mockReset();
    const eventIds = await db
      .selectFrom('events')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .execute();
    if (eventIds.length > 0) {
      const ids = eventIds.map((event) => event.id);
      await db.deleteFrom('ticket_types').where('event_id', 'in', ids).execute();
      await db.deleteFrom('inventory_pools').where('event_id', 'in', ids).execute();
      await db.deleteFrom('event_occurrences').where('event_id', 'in', ids).execute();
    }
    await db.deleteFrom('audit_logs').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('idempotency_records').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('oauth_access_tokens').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('oauth_applications').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('api_keys').where('tenant_id', '=', tenantId).execute();
    await db.deleteFrom('events').where('tenant_id', '=', tenantId).execute();
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
        permission: 'events.write',
        scope_type: 'organization',
        scope_id: organizationId,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  });

  afterAll(async () => {
    try {
      await app?.close();
      const eventIds = await db
        ?.selectFrom('events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .execute();
      if (eventIds?.length) {
        const ids = eventIds.map((event) => event.id);
        await db?.deleteFrom('ticket_types').where('event_id', 'in', ids).execute();
        await db?.deleteFrom('inventory_pools').where('event_id', 'in', ids).execute();
        await db?.deleteFrom('event_occurrences').where('event_id', 'in', ids).execute();
      }
      await db
        ?.deleteFrom('audit_logs')
        .where('tenant_id', 'in', [tenantId, foreignTenantId])
        .execute();
      await db?.deleteFrom('idempotency_records').where('tenant_id', '=', tenantId).execute();
      await db?.deleteFrom('oauth_access_tokens').where('tenant_id', '=', tenantId).execute();
      await db?.deleteFrom('oauth_applications').where('tenant_id', '=', tenantId).execute();
      await db?.deleteFrom('api_keys').where('tenant_id', '=', tenantId).execute();
      await db
        ?.deleteFrom('events')
        .where('tenant_id', 'in', [tenantId, foreignTenantId])
        .execute();
      await db?.deleteFrom('permission_grants').where('tenant_id', '=', tenantId).execute();
      await db?.deleteFrom('venues').where('id', 'in', [venueId, foreignVenueId]).execute();
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

  it('binds executable tenant, organization, brand, venue, and permission denials to the contract', () => {
    expect(contract).toMatchObject({
      method: 'POST',
      path: '/events',
      authorizedControl: { required: true, status: 201 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'venue'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      principalTypeDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
      policyDeniedBoundaries: ['event'],
      persistenceSource: 'event-create-route-authorization-db.integration.test.ts',
    });
  });

  it('creates a preset with a sanitized atomic audit and a private idempotency key', async () => {
    const key = `event-create-${suffix}`;
    const request = () =>
      invoke(
        payload(`preset-${suffix}`, {
          startingPoint: 'paid',
          venueId,
          description: `private-description-${suffix}`,
          externalUrl: `https://private.example/${suffix}`,
          seo: { description: `private-seo-${suffix}`, title: `private-seo-title-${suffix}` },
        }),
        { 'Idempotency-Key': key },
      );
    const [response, concurrent] = await Promise.all([request(), request()]);
    expect(response.statusCode, response.body).toBe(201);
    expect(concurrent.statusCode, concurrent.body).toBe(201);
    const eventId = (response.json() as { id: string }).id;
    expect((concurrent.json() as { id: string }).id).toBe(eventId);
    expect(metricInc).toHaveBeenCalledTimes(3);
    expect(metricObserve).toHaveBeenCalledTimes(2);
    const state = await snapshot();
    expect(state.events).toHaveLength(1);
    expect(state.pools).toHaveLength(1);
    expect(state.tickets).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: 'event.created', resource_id: eventId });
    expect(JSON.stringify(state.audits[0]!.diff_summary)).not.toContain(key);
    expect(JSON.stringify(state.audits[0]!.diff_summary)).not.toContain(
      `private-description-${suffix}`,
    );
    expect(JSON.stringify(state.audits[0]!.diff_summary)).not.toContain(`private-seo-${suffix}`);
    expect(JSON.stringify(state.audits[0]!.diff_summary)).not.toContain(
      `https://private.example/${suffix}`,
    );
    expect(state.idempotency).toEqual([
      expect.objectContaining({ response_status: 201, status: 'completed' }),
    ]);
    expect(state.idempotency[0]!.key).not.toBe(key);
    const persisted = await db
      .selectFrom('events')
      .select(['version', 'public_revision'])
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(response.json()).toMatchObject({ version: persisted.version });
    expect(persisted.public_revision).toBeTruthy();
    const replay = await request();
    expect(replay.statusCode, replay.body).toBe(201);
    expect((replay.json() as { id: string }).id).toBe(eventId);
    expect(metricInc).toHaveBeenCalledTimes(3);
    expect(metricObserve).toHaveBeenCalledTimes(2);
    await expect(snapshot()).resolves.toEqual(state);
    const changedPayload = await invoke(
      payload(`preset-${suffix}`, { startingPoint: 'paid', venueId, title: 'changed payload' }),
      { 'Idempotency-Key': key },
    );
    expect(changedPayload.statusCode).toBe(409);
  });

  it('returns an in-progress conflict without mutating for a matching live reservation', async () => {
    const key = `in-progress-${suffix}`;
    const body = payload(`in-progress-${suffix}`, { startingPoint: 'blank' });
    const storedKey = hashRequest({
      operation: 'event.create',
      principal: { id: principal.id, type: principal.type },
      key,
    });
    await db
      .insertInto('idempotency_records')
      .values({
        id: `idm_ec_${suffix}`,
        key: storedKey,
        tenant_id: tenantId,
        request_hash: hashRequest({
          operation: 'event.create',
          principal: { id: principal.id, type: principal.type },
          organizationId,
          brandId,
          body,
        }),
        response_status: 0,
        response_body: 'null',
        status: 'in_progress',
        created_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
      })
      .execute();
    app.context.eventCreateIdempotencyOptions = { inProgressWaitMs: 0 };
    const before = await snapshot();
    const response = await invoke(body, { 'Idempotency-Key': key });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_IN_PROGRESS' } });
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('conceals organization, brand, and saved-venue boundaries without side effects', async () => {
    const before = await snapshot();
    const cases = [
      payload(`missing-org-${suffix}`, {
        organizationId: `org_missing_${suffix}`,
        brandId: `brd_missing_${suffix}`,
      }),
      payload(`missing-brand-${suffix}`, { brandId: `brd_missing_${suffix}` }),
      payload(`wrong-org-${suffix}`, {
        organizationId: siblingOrganizationId,
        brandId: siblingBrandId,
      }),
      payload(`wrong-brand-${suffix}`, { brandId: siblingBrandId }),
      payload(`foreign-brand-${suffix}`, {
        organizationId: foreignOrganizationId,
        brandId: foreignBrandId,
      }),
      payload(`foreign-venue-${suffix}`, { venueId: foreignVenueId }),
      payload(`missing-venue-${suffix}`, { venueId: `ven_missing_${suffix}` }),
    ];
    const bodies: string[] = [];
    for (const body of cases) {
      const response = await invoke(body);
      expect(response.statusCode, response.body).toBe(404);
      bodies.push(response.body);
      await expect(snapshot()).resolves.toEqual(before);
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('does not contend on a held foreign brand or venue row while concealing it', async () => {
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('brands')
        .select('id')
        .where('id', '=', foreignBrandId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const response = await invoke(
        payload(`held-foreign-brand-${suffix}`, {
          organizationId: foreignOrganizationId,
          brandId: foreignBrandId,
        }),
      );
      expect(response.statusCode, response.body).toBe(404);
    });
    await db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('venues')
        .select('id')
        .where('id', '=', foreignVenueId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const response = await invoke(
        payload(`held-foreign-venue-${suffix}`, { venueId: foreignVenueId }),
      );
      expect(response.statusCode, response.body).toBe(404);
    });
  });

  it('fails closed when a once-local brand or venue is reparented after preflight', async () => {
    let reparentedBrand = false;
    checkpoint = async (input) => {
      if (input.stage === 'after_preflight_before_transaction' && !reparentedBrand) {
        reparentedBrand = true;
        await db
          .updateTable('brands')
          .set({ organization_id: siblingOrganizationId })
          .where('id', '=', brandId)
          .execute();
      }
    };
    try {
      const response = await invoke(payload(`brand-reparent-${suffix}`));
      expect(response.statusCode, response.body).toBe(404);
    } finally {
      checkpoint = undefined;
      await db
        .updateTable('brands')
        .set({ organization_id: organizationId })
        .where('id', '=', brandId)
        .execute();
    }
    let reparentedVenue = false;
    checkpoint = async (input) => {
      if (input.stage === 'after_preflight_before_transaction' && !reparentedVenue) {
        reparentedVenue = true;
        await db
          .updateTable('venues')
          .set({ organization_id: siblingOrganizationId })
          .where('id', '=', venueId)
          .execute();
      }
    };
    try {
      const response = await invoke(payload(`venue-reparent-${suffix}`, { venueId }));
      expect(response.statusCode, response.body).toBe(404);
    } finally {
      checkpoint = undefined;
      await db
        .updateTable('venues')
        .set({ organization_id: organizationId })
        .where('id', '=', venueId)
        .execute();
    }
  });

  it('does not seek a once-local moved brand or venue primary key after the moved row is held', async () => {
    for (const target of [
      { id: brandId, table: 'brands' as const, payload: payload(`held-moved-brand-${suffix}`) },
      {
        id: venueId,
        table: 'venues' as const,
        payload: payload(`held-moved-venue-${suffix}`, { venueId }),
      },
    ]) {
      const release = deferred();
      const locked = deferred();
      let moved = false;
      let holder: Promise<unknown> | undefined;
      checkpoint = async (input) => {
        if (input.stage !== 'after_preflight_before_transaction' || moved) return;
        moved = true;
        await db
          .updateTable(target.table)
          .set({ organization_id: siblingOrganizationId })
          .where('id', '=', target.id)
          .execute();
        holder = db.transaction().execute(async (trx) => {
          await trx
            .selectFrom(target.table)
            .select('id')
            .where('id', '=', target.id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
      };
      try {
        const response = await Promise.race([
          invoke(target.payload),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`moved ${target.table} lock was contended`)), 1_000),
          ),
        ]);
        expect(response.statusCode, response.body).toBe(404);
      } finally {
        checkpoint = undefined;
        release.resolve();
        await holder;
        await db
          .updateTable(target.table)
          .set({ organization_id: organizationId })
          .where('id', '=', target.id)
          .execute();
      }
    }
  });

  it('checks permission before parsing and preserves all state for denied callers', async () => {
    principal = { ...principal, scopes: [] };
    const before = await snapshot();
    const response = await invoke({ unexpected: 'invalid' });
    expect(response.statusCode, response.body).toBe(403);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('rejects event-scoped principals before parsing or locking tenant-wide creation resources', async () => {
    principal = { ...principal, eventIds: [`evt_scope_${suffix}`] };
    const before = await snapshot();
    const response = await invoke({ malformed: true });
    expect(response.statusCode, response.body).toBe(403);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it.each(['mobile_device', 'agent'] as const)(
    'rejects a direct %s principal without persistence',
    async (type) => {
      principal = {
        ...basePrincipal,
        type,
        organizationIds: [organizationId],
        scopes: ['events.write'],
      };
      const before = await snapshot();
      const response = await invoke(payload(`direct-${type}-${suffix}`));
      expect(response.statusCode, response.body).toBe(403);
      await expect(snapshot()).resolves.toEqual(before);
    },
  );

  it('allows a system principal on the persisted tenant resources', async () => {
    principal = {
      type: 'system',
      id: `sys_ec_${suffix}`,
      tenantId,
      organizationIds: [],
      scopes: ['events.write'],
    };
    const response = await invoke(payload(`system-${suffix}`));
    expect(response.statusCode, response.body).toBe(201);
  });

  it('revalidates the locked live grant before inserting', async () => {
    checkpoint = async (input) => {
      if (input.stage === 'after_resource_lock') {
        await db.deleteFrom('permission_grants').where('id', '=', grantId).execute();
      }
    };
    const before = await snapshot();
    const response = await invoke(payload(`revoked-${suffix}`));
    expect(response.statusCode, response.body).toBe(403);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('revalidates the principal scope after resource locking', async () => {
    checkpoint = (input) => {
      if (input.stage === 'after_resource_lock') principal.organizationIds = [];
    };
    const before = await snapshot();
    const response = await invoke(payload(`scope-revoked-${suffix}`));
    expect(response.statusCode, response.body).toBe(404);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('accepts a persisted exact-brand user grant', async () => {
    await db.deleteFrom('permission_grants').where('id', '=', grantId).execute();
    await db
      .insertInto('permission_grants')
      .values({
        id: `${grantId}_brand`,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: actorId,
        permission: 'events.write',
        scope_type: 'brand',
        scope_id: brandId,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    principal = { ...principal, brandIds: [brandId] };
    const response = await invoke(payload(`brand-grant-${suffix}`));
    expect(response.statusCode, response.body).toBe(201);
  });

  it('revalidates persisted API-key and OAuth credentials', async () => {
    const now = new Date();
    const apiKeyId = `key_ec_${suffix}`;
    await db
      .insertInto('api_keys')
      .values({
        id: apiKeyId,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: 'Event create key',
        key_prefix: `tk_${suffix}`,
        hashed_key: `hash_${suffix}`,
        scopes: JSON.stringify(['events.write']),
        brand_ids: JSON.stringify([brandId]),
        event_ids: null,
        last_used_at: null,
        expires_at: new Date(now.getTime() + 60_000),
        revoked_at: null,
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
    principal = {
      type: 'api_key',
      id: apiKeyId,
      tenantId,
      organizationIds: [organizationId],
      brandIds: [brandId],
      scopes: ['events.write'],
    };
    const apiSuccess = await invoke(payload(`api-key-${suffix}`));
    expect(apiSuccess.statusCode, apiSuccess.body).toBe(201);
    checkpoint = async (input) => {
      if (input.stage === 'after_preflight_before_transaction') {
        await db
          .updateTable('api_keys')
          .set({ revoked_at: new Date() })
          .where('id', '=', apiKeyId)
          .execute();
      }
    };
    const apiRevoked = await invoke(payload(`api-key-revoked-${suffix}`));
    expect(apiRevoked.statusCode, apiRevoked.body).toBe(403);
    checkpoint = undefined;
    await db
      .updateTable('api_keys')
      .set({ revoked_at: null, brand_ids: JSON.stringify([siblingBrandId]) })
      .where('id', '=', apiKeyId)
      .execute();
    const apiRescoped = await invoke(payload(`api-key-rescoped-${suffix}`));
    expect(apiRescoped.statusCode, apiRescoped.body).toBe(403);
    const applicationId = `oap_ec_${suffix}`;
    const tokenId = `oat_ec_${suffix}`;
    await db
      .insertInto('oauth_applications')
      .values({
        id: applicationId,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: 'Event create OAuth app',
        client_id: `client_ec_${suffix}`,
        client_secret_hash: 'secret-hash',
        redirect_uris: '[]',
        scopes: JSON.stringify(['events.write']),
        status: 'active',
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
    await db
      .insertInto('oauth_access_tokens')
      .values({
        id: tokenId,
        oauth_application_id: applicationId,
        refresh_token_id: null,
        tenant_id: tenantId,
        organization_id: organizationId,
        token_hash: `token_${suffix}`,
        scopes: JSON.stringify(['events.write']),
        expires_at: new Date(now.getTime() + 60_000),
        revoked_at: null,
        created_at: now,
        updated_at: now,
      } as never)
      .execute();
    principal = { ...principal, id: tokenId, brandIds: undefined };
    const oauthSuccess = await invoke(payload(`oauth-${suffix}`));
    expect(oauthSuccess.statusCode, oauthSuccess.body).toBe(201);
    checkpoint = async (input) => {
      if (input.stage === 'after_preflight_before_transaction') {
        await db
          .updateTable('oauth_access_tokens')
          .set({ revoked_at: new Date() })
          .where('id', '=', tokenId)
          .execute();
      }
    };
    const oauthRevoked = await invoke(payload(`oauth-revoked-${suffix}`));
    expect(oauthRevoked.statusCode, oauthRevoked.body).toBe(403);
    checkpoint = undefined;
    await db
      .updateTable('oauth_access_tokens')
      .set({ revoked_at: null })
      .where('id', '=', tokenId)
      .execute();
    checkpoint = async (input) => {
      if (input.stage === 'after_preflight_before_transaction') {
        await db
          .updateTable('oauth_applications')
          .set({ status: 'disabled' })
          .where('id', '=', applicationId)
          .execute();
      }
    };
    const oauthDisabled = await invoke(payload(`oauth-disabled-${suffix}`));
    expect(oauthDisabled.statusCode, oauthDisabled.body).toBe(403);
    checkpoint = undefined;
  });

  it('rolls back the event, preset children, audit, and idempotency when auditing fails', async () => {
    const key = `audit-${suffix}`;
    const before = await snapshot();
    const auditFailure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('audit failed'));
    try {
      const failed = await invoke(payload(`audit-${suffix}`, { startingPoint: 'free' }), {
        'Idempotency-Key': key,
      });
      expect(failed.statusCode, failed.body).toBe(500);
    } finally {
      auditFailure.mockRestore();
    }
    await expect(snapshot()).resolves.toEqual(before);
    expect(metricInc).not.toHaveBeenCalled();
    const retried = await invoke(payload(`audit-${suffix}`, { startingPoint: 'free' }), {
      'Idempotency-Key': key,
    });
    expect(retried.statusCode, retried.body).toBe(201);
  });

  it('does not surface metric-emission errors after a durable commit', async () => {
    metricInc.mockImplementationOnce(() => {
      throw new Error('metrics unavailable');
    });
    const response = await invoke(payload(`metrics-failure-${suffix}`));
    expect(response.statusCode, response.body).toBe(201);
    await expect(
      db
        .selectFrom('events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('slug', '=', `metrics-failure-${suffix}`)
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it.each([0, 1, 2])('retries exactly %i retryable transaction conflict(s)', async (failures) => {
    let attempts = 0;
    checkpoint = (input) => {
      if (input.stage !== 'before_resource_lock') return;
      attempts += 1;
      if (attempts <= failures) {
        throw Object.assign(new Error('injected serialization conflict'), { code: '40001' });
      }
    };
    try {
      const response = await invoke(payload(`retry-${failures}-${suffix}`));
      expect(response.statusCode, response.body).toBe(201);
      expect(attempts).toBe(failures + 1);
    } finally {
      checkpoint = undefined;
    }
  });

  it('exhausts retryable conflicts after exactly three attempts without persistence', async () => {
    let attempts = 0;
    checkpoint = (input) => {
      if (input.stage !== 'before_resource_lock') return;
      attempts += 1;
      throw Object.assign(new Error('injected serialization conflict'), { code: '40001' });
    };
    const before = await snapshot();
    try {
      const response = await invoke(payload(`retry-exhausted-${suffix}`));
      expect(response.statusCode).toBe(500);
      expect(attempts).toBe(3);
      await expect(snapshot()).resolves.toEqual(before);
    } finally {
      checkpoint = undefined;
    }
  });

  it('does not retry a nonretryable transaction failure and rolls back', async () => {
    let attempts = 0;
    checkpoint = (input) => {
      if (input.stage !== 'before_resource_lock') return;
      attempts += 1;
      throw Object.assign(new Error('injected nonretryable failure'), { code: '23505' });
    };
    const before = await snapshot();
    try {
      const response = await invoke(payload(`nonretryable-${suffix}`));
      expect(response.statusCode).toBe(500);
      expect(attempts).toBe(1);
      await expect(snapshot()).resolves.toEqual(before);
    } finally {
      checkpoint = undefined;
    }
  });

  it('has exactly one slug winner under concurrent non-idempotent creation', async () => {
    const slug = `race-${suffix}`;
    const [first, second] = await Promise.all([invoke(payload(slug)), invoke(payload(slug))]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    await expect(
      db
        .selectFrom('events')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('slug', '=', slug)
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it('derives idempotency state by principal so a second authorized actor cannot replay another actor', async () => {
    const sharedKey = `cross-principal-${suffix}`;
    const first = await invoke(payload(`actor-one-${suffix}`), { 'Idempotency-Key': sharedKey });
    expect(first.statusCode, first.body).toBe(201);
    const secondActorId = `usr_ec_second_${suffix}`;
    await db
      .insertInto('permission_grants')
      .values({
        id: `pgr_ec_second_${suffix}`,
        tenant_id: tenantId,
        principal_type: 'user',
        principal_id: secondActorId,
        permission: 'events.write',
        scope_type: 'organization',
        scope_id: organizationId,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    principal = {
      ...basePrincipal,
      id: secondActorId,
      organizationIds: [organizationId],
      scopes: ['events.write'],
    };
    const second = await invoke(payload(`actor-two-${suffix}`), { 'Idempotency-Key': sharedKey });
    expect(second.statusCode, second.body).toBe(201);
    expect((second.json() as { id: string }).id).not.toBe((first.json() as { id: string }).id);
  });

  it('enforces database-compatible title and multibyte description bounds before mutation', async () => {
    const before = await snapshot();
    const titleTooLong = await invoke(payload(`title-${suffix}`, { title: 't'.repeat(501) }));
    expect(titleTooLong.statusCode).toBe(400);
    const descriptionAtLimit = await invoke(
      payload(`description-ok-${suffix}`, { description: '😀'.repeat(16_383) }),
    );
    expect(descriptionAtLimit.statusCode, descriptionAtLimit.body).toBe(201);
    const descriptionOverLimit = await invoke(
      payload(`description-bad-${suffix}`, { description: '😀'.repeat(16_384) }),
    );
    expect(descriptionOverLimit.statusCode).toBe(400);
    const after = await snapshot();
    expect(after.events).toHaveLength(before.events.length + 1);
  });

  it.each([
    ['empty', ''],
    ['too-long', 'x'.repeat(129)],
    ['control', `key\u0000${suffix}`],
  ])('rejects %s idempotency keys before mutation', async (name, key) => {
    const before = await snapshot();
    const response = await invoke(payload(`invalid-key-${name}-${suffix}`), {
      'Idempotency-Key': key,
    });
    expect(response.statusCode).toBe(400);
    await expect(snapshot()).resolves.toEqual(before);
  });

  it('uses a valid saved-venue name when a legacy address is corrupt', async () => {
    await db
      .updateTable('venues')
      .set({ address: '{not-json' })
      .where('id', '=', venueId)
      .execute();
    const response = await invoke(payload(`corrupt-venue-${suffix}`, { venueId }));
    expect(response.statusCode, response.body).toBe(201);
    const created = await db
      .selectFrom('events')
      .select('venue')
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', `corrupt-venue-${suffix}`)
      .executeTakeFirstOrThrow();
    const venue = typeof created.venue === 'string' ? JSON.parse(created.venue) : created.venue;
    expect(venue).toEqual({ name: 'Event create venue' });
  });

  it('preserves the saved-venue name over an untrusted address name field', async () => {
    await db
      .updateTable('venues')
      .set({ address: JSON.stringify({ city: 'Austin', name: `attacker-${suffix}` }) })
      .where('id', '=', venueId)
      .execute();
    const response = await invoke(payload(`venue-name-${suffix}`, { venueId }));
    expect(response.statusCode, response.body).toBe(201);
    const created = await db
      .selectFrom('events')
      .select('venue')
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', `venue-name-${suffix}`)
      .executeTakeFirstOrThrow();
    const venue = typeof created.venue === 'string' ? JSON.parse(created.venue) : created.venue;
    expect(venue).toMatchObject({ city: 'Austin', name: 'Event create venue' });
    expect(venue).not.toMatchObject({ name: `attacker-${suffix}` });
  });

  it('rejects ambiguous venue input before mutation', async () => {
    const before = await snapshot();
    const response = await invoke(
      payload(`ambiguous-venue-${suffix}`, { venue: { name: 'Inline venue' }, venueId }),
    );
    expect(response.statusCode).toBe(400);
    await expect(snapshot()).resolves.toEqual(before);
  });
});
