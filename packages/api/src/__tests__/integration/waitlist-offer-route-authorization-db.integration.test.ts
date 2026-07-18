import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import {
  AuditLogRepository,
  createDb,
  EventRepository,
  InventoryPoolRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { openApiSpec } from '@tixkit/openapi';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { hashWaitlistClaimToken, waitlistRoutes } from '../../routes/modules/waitlist.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function waitlistOfferContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) throw new Error(`waitlist offer authorization contract ${operationId} missing`);
  return contract;
}

const offerContract = waitlistOfferContract('postEventsByEventIdWaitlistByEntryIdOffer');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_wofr_auth_a_${suffix}`;
const tenantB = `tnt_wofr_auth_b_${suffix}`;
const organizationA = `org_wofr_auth_a_${suffix}`;
const organizationAScoped = `org_wofr_auth_scope_${suffix}`;
const organizationB = `org_wofr_auth_b_${suffix}`;
const brandA = `brd_wofr_auth_a_${suffix}`;
const brandAScoped = `brd_wofr_auth_scope_${suffix}`;
const brandB = `brd_wofr_auth_b_${suffix}`;
const actorId = `usr_wofr_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;
let poolA: string;
let poolAScoped: string;
let poolB: string;
let ticketTypeA: string;
let ticketTypeAScoped: string;
let ticketTypeB: string;
let entryA: string;
let entryASecond: string;
let entryAWrongState: string;
let entryAScoped: string;
let entryB: string;

const waitlistOfferCheckpoint = vi.fn(
  async (_input: { stage: 'before_transaction'; eventId: string; entryId: string }) => undefined,
);

async function insertTenant(id: string, name: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
    .execute();
}

async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('organizations')
    .values({
      id,
      tenant_id: tenantId,
      name,
      slug: `${id}-slug`,
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertBrand(
  id: string,
  tenantId: string,
  organizationId: string,
  name: string,
): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('brands')
    .values({
      id,
      tenant_id: tenantId,
      organization_id: organizationId,
      name,
      slug: `${id}-slug`,
      status: 'active',
      theme: '{}',
      support_url: null,
      legal_urls: '{}',
      white_label: false,
      payment_account_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function createEvent(
  tenantId: string,
  organizationId: string,
  brandId: string,
  title: string,
): Promise<string> {
  const event = await new EventRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    slug: `${title.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
    title,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
    endsAt: new Date('2027-01-01T22:00:00.000Z'),
    venue: { name: 'Waitlist offer authorization hall' },
  });
  return event.id;
}

async function createInventory(eventId: string, label: string) {
  const pool = await new InventoryPoolRepository(db).create({
    eventId,
    name: `${label} pool`,
    totalCapacity: 1,
  });
  const ticketType = await new TicketTypeRepository(db).create({
    eventId,
    inventoryPoolId: pool.id,
    name: `${label} ticket`,
    kind: 'paid',
    currency: 'USD',
    priceCents: 2500,
  });
  return { poolId: pool.id, ticketTypeId: ticketType.id };
}

type EntrySeed = Readonly<{
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  ticketTypeId: string;
  email: string;
  status?: string;
}>;

async function insertEntry(seed: EntrySeed): Promise<void> {
  const now = new Date('2026-07-17T12:30:00.000Z');
  await db
    .insertInto('waitlist_entries')
    .values({
      id: seed.id,
      tenant_id: seed.tenantId,
      organization_id: seed.organizationId,
      brand_id: seed.brandId,
      event_id: seed.eventId,
      ticket_type_id: seed.ticketTypeId,
      buyer_email: seed.email,
      buyer_first_name: 'Waitlist',
      buyer_last_name: 'Buyer',
      buyer_phone: null,
      quantity: 1,
      status: seed.status ?? 'joined',
      offer_expires_at: null,
      claim_token_hash: null,
      reserved_checkout_session_id: null,
      reserved_until: null,
      offered_at: null,
      claimed_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function entrySeeds(): readonly EntrySeed[] {
  return [
    {
      id: entryA,
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      eventId: eventA,
      ticketTypeId: ticketTypeA,
      email: `allowed-${suffix}@example.test`,
    },
    {
      id: entryASecond,
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      eventId: eventA,
      ticketTypeId: ticketTypeA,
      email: `second-${suffix}@example.test`,
    },
    {
      id: entryAWrongState,
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      eventId: eventA,
      ticketTypeId: ticketTypeA,
      email: `claimed-${suffix}@example.test`,
      status: 'claimed',
    },
    {
      id: entryAScoped,
      tenantId: tenantA,
      organizationId: organizationAScoped,
      brandId: brandAScoped,
      eventId: eventAScoped,
      ticketTypeId: ticketTypeAScoped,
      email: `scoped-${suffix}@example.test`,
    },
    {
      id: entryB,
      tenantId: tenantB,
      organizationId: organizationB,
      brandId: brandB,
      eventId: eventB,
      ticketTypeId: ticketTypeB,
      email: `foreign-${suffix}@example.test`,
    },
  ];
}

async function clearOfferEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', '=', 'event.waitlist.offer.created')
    .execute();
  await db
    .deleteFrom('waitlist_entries')
    .where('id', 'in', [entryA, entryASecond, entryAWrongState, entryAScoped, entryB])
    .execute();
}

async function seedOfferEvidence(): Promise<void> {
  await db
    .updateTable('events')
    .set({ waitlist_offer_ttl_minutes: 37 })
    .where('id', 'in', [eventA, eventAScoped, eventB])
    .execute();
  await db
    .updateTable('inventory_pools')
    .set({ total_capacity: 1, sold_count: 0 })
    .where('id', 'in', [poolA, poolAScoped, poolB])
    .execute();
  await db
    .updateTable('ticket_types')
    .set({ event_id: eventA, inventory_pool_id: poolA })
    .where('id', '=', ticketTypeA)
    .execute();
  await db
    .updateTable('ticket_types')
    .set({ event_id: eventAScoped, inventory_pool_id: poolAScoped })
    .where('id', '=', ticketTypeAScoped)
    .execute();
  await db
    .updateTable('ticket_types')
    .set({ event_id: eventB, inventory_pool_id: poolB })
    .where('id', '=', ticketTypeB)
    .execute();
  for (const seed of entrySeeds()) await insertEntry(seed);
}

async function evidenceSnapshot() {
  const [events, ticketTypes, pools, entries, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'waitlist_offer_ttl_minutes'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('ticket_types')
      .selectAll()
      .where('id', 'in', [ticketTypeA, ticketTypeAScoped, ticketTypeB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', 'in', [poolA, poolAScoped, poolB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('id', 'in', [entryA, entryASecond, entryAWrongState, entryAScoped, entryB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.waitlist.offer.created')
      .orderBy('id')
      .execute(),
  ]);
  return { events, ticketTypes, pools, entries, audits };
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function entryFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, entryId: string) {
  return snapshot.entries.find((entry) => entry.id === entryId)!;
}

function normalizedPublicEntry(entry: ReturnType<typeof entryFrom>) {
  return JSON.parse(
    JSON.stringify({
      id: entry.id,
      eventId: entry.event_id,
      ticketTypeId: entry.ticket_type_id,
      email: entry.buyer_email,
      firstName: entry.buyer_first_name ?? undefined,
      lastName: entry.buyer_last_name ?? undefined,
      phone: entry.buyer_phone ?? undefined,
      quantity: Number(entry.quantity),
      status: entry.status,
      offerExpiresAt: entry.offer_expires_at ?? undefined,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    }),
  ) as Record<string, unknown>;
}

function invokeOffer(
  targetEventId: string,
  targetEntryId: string,
  payload?: InjectOptions['payload'],
) {
  return app.inject({
    method: offerContract.method,
    url: offerContract.path.replace('{eventId}', targetEventId).replace('{entryId}', targetEntryId),
    ...(payload === undefined ? {} : { payload }),
  });
}

function expectExactOfferAudit(
  snapshotBefore: Awaited<ReturnType<typeof evidenceSnapshot>>,
  snapshotAfter: Awaited<ReturnType<typeof evidenceSnapshot>>,
  targetEntryId: string,
  claimToken: string,
): void {
  const audit = snapshotAfter.audits.find((candidate) => candidate.resource_id === targetEntryId);
  expect(audit).toMatchObject({
    tenant_id: tenantA,
    organization_id: organizationA,
    brand_id: brandA,
    actor_type: 'user',
    actor_id: actorId,
    action: 'event.waitlist.offer.created',
    resource_type: 'WaitlistEntry',
    resource_id: targetEntryId,
  });
  expect(auditDiff(audit!.diff_summary)).toEqual({
    before: normalizedPublicEntry(entryFrom(snapshotBefore, targetEntryId)),
    after: normalizedPublicEntry(entryFrom(snapshotAfter, targetEntryId)),
  });
  const serializedAudit = JSON.stringify(audit);
  expect(serializedAudit).not.toContain(claimToken);
  expect(serializedAudit).not.toContain(hashWaitlistClaimToken(claimToken));
  expect(auditDiff(audit!.diff_summary)).not.toHaveProperty('claimToken');
  expect(auditDiff(audit!.diff_summary)).not.toHaveProperty('claimTokenHash');
}

describeWithIntegrationDatabase('waitlist offer write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Waitlist offer authorization tenant A');
    await insertTenant(tenantB, 'Waitlist offer authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Waitlist offer authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Waitlist offer authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Waitlist offer authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Waitlist offer authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Waitlist offer authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Waitlist offer authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed waitlist offer event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped waitlist offer event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign waitlist offer event');

    ({ poolId: poolA, ticketTypeId: ticketTypeA } = await createInventory(eventA, 'Allowed'));
    ({ poolId: poolAScoped, ticketTypeId: ticketTypeAScoped } = await createInventory(
      eventAScoped,
      'Scoped',
    ));
    ({ poolId: poolB, ticketTypeId: ticketTypeB } = await createInventory(eventB, 'Foreign'));

    entryA = `wle_${ulid()}`;
    entryASecond = `wle_${ulid()}`;
    entryAWrongState = `wle_${ulid()}`;
    entryAScoped = `wle_${ulid()}`;
    entryB = `wle_${ulid()}`;

    basePrincipal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    activePrincipal = basePrincipal;

    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      waitlistOfferCheckpoint: (input: {
        stage: 'before_transaction';
        eventId: string;
        entryId: string;
      }) => waitlistOfferCheckpoint(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(waitlistRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    activePrincipal = basePrincipal;
    waitlistOfferCheckpoint.mockReset();
    waitlistOfferCheckpoint.mockResolvedValue(undefined);
    await clearOfferEvidence();
    await seedOfferEvidence();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (app) await cleanup(() => app.close());
    if (db) {
      await cleanup(clearOfferEvidence);
      await cleanup(() =>
        db
          .deleteFrom('ticket_types')
          .where('id', 'in', [ticketTypeA, ticketTypeAScoped, ticketTypeB])
          .execute(),
      );
      await cleanup(() =>
        db.deleteFrom('inventory_pools').where('id', 'in', [poolA, poolAScoped, poolB]).execute(),
      );
      for (const eventId of [eventA, eventAScoped, eventB]) {
        await cleanup(() => db.deleteFrom('events').where('id', '=', eventId).execute());
      }
      for (const brandId of [brandA, brandAScoped, brandB]) {
        await cleanup(() => db.deleteFrom('brands').where('id', '=', brandId).execute());
      }
      for (const organizationId of [organizationA, organizationAScoped, organizationB]) {
        await cleanup(() =>
          db.deleteFrom('organizations').where('id', '=', organizationId).execute(),
        );
      }
      for (const tenantId of [tenantA, tenantB]) {
        await cleanup(() => db.deleteFrom('tenants').where('id', '=', tenantId).execute());
      }
      await cleanup(() => db.destroy());
    }
    try {
      restoreDatabaseDriver(previousDriver);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up waitlist offer proof');
    }
  });

  it('binds the immutable route contract and strict public TTL bounds to this proof', () => {
    expect(offerContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'waitlist-offer-route-authorization-db.integration.test.ts',
      source: 'waitlist-offer-route-authorization-db.integration.test.ts',
    });
    const requestSchema =
      openApiSpec.paths['/events/{eventId}/waitlist/{entryId}/offer'].post.requestBody.content[
        'application/json'
      ].schema;
    expect(requestSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        expiresInMinutes: { type: 'integer', minimum: 5, maximum: 20_160 },
      },
    });
  });

  it('returns and persists the exact offer while auditing the actor without token material', async () => {
    const before = await evidenceSnapshot();
    const response = await invokeOffer(eventA, entryA, { expiresInMinutes: 45 });

    expect(response.statusCode, response.body).toBe(offerContract.authorizedControl.status);
    const body = response.json<{
      entry: Record<string, unknown>;
      claimToken: string;
    }>();
    expect(body.claimToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const after = await evidenceSnapshot();
    const persisted = entryFrom(after, entryA);
    expect(body.entry).toEqual(normalizedPublicEntry(persisted));
    expect(persisted.status).toBe('offered');
    expect(persisted.claim_token_hash).toBe(hashWaitlistClaimToken(body.claimToken));
    expect(persisted.offered_at).not.toBeNull();
    expect(persisted.offer_expires_at).not.toBeNull();
    expect(new Date(persisted.offer_expires_at!).getTime()).toBe(
      new Date(persisted.offered_at!).getTime() + 45 * 60_000,
    );
    expect(after.audits).toHaveLength(1);
    expectExactOfferAudit(before, after, entryA, body.claimToken);
  });

  it.each([
    [
      'permission',
      () => ({ ...basePrincipal, scopes: [] }),
      () => eventA,
      () => entryA,
      403,
      'FORBIDDEN',
    ],
    ['tenant', () => basePrincipal, () => eventB, () => entryB, 404, 'NOT_FOUND'],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
      () => entryAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => eventAScoped,
      () => entryAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'event',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA, brandAScoped],
        eventIds: [eventA],
      }),
      () => eventAScoped,
      () => entryAScoped,
      404,
      'NOT_FOUND',
    ],
  ] as const)(
    'denies the %s boundary without entry, capacity, or audit mutation',
    async (_boundary, makePrincipal, targetEvent, targetEntry, status, code) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();
      const response = await invokeOffer(targetEvent(), targetEntry(), { expiresInMinutes: 30 });
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('denies an entry bound to another event without mutation or audit', async () => {
    const before = await evidenceSnapshot();
    const response = await invokeOffer(eventA, entryAScoped, { expiresInMinutes: 30 });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it.each([
    ['tenant', { tenant_id: tenantB }],
    ['organization', { organization_id: organizationAScoped }],
    ['brand', { brand_id: brandAScoped }],
  ] as const)(
    'denies an entry whose %s does not match the locked event without mutation or audit',
    async (_scope, mismatch) => {
      await db.updateTable('waitlist_entries').set(mismatch).where('id', '=', entryA).execute();
      const before = await evidenceSnapshot();

      const response = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });

      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('denies an entry referencing a ticket type from another event without mutation or audit', async () => {
    await db
      .updateTable('ticket_types')
      .set({ event_id: eventAScoped, inventory_pool_id: poolAScoped })
      .where('id', '=', ticketTypeA)
      .execute();
    const before = await evidenceSnapshot();

    const response = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('denies a ticket type referencing an inventory pool from another event without mutation or audit', async () => {
    await db
      .updateTable('ticket_types')
      .set({ inventory_pool_id: poolAScoped })
      .where('id', '=', ticketTypeA)
      .execute();
    const before = await evidenceSnapshot();

    const response = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('revalidates the locked event after a real organization and brand scope swap', async () => {
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    waitlistOfferCheckpoint.mockImplementationOnce(async () => {
      await db
        .updateTable('events')
        .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
        .where('id', '=', eventA)
        .execute();
      checkpointSnapshot = await evidenceSnapshot();
    });

    try {
      const response = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(checkpointSnapshot).toBeDefined();
      await expect(evidenceSnapshot()).resolves.toEqual(checkpointSnapshot);
    } finally {
      await db
        .updateTable('events')
        .set({ organization_id: organizationA, brand_id: brandA })
        .where('id', '=', eventA)
        .execute();
    }
  });

  describe('strict offer expiry schema', () => {
    it.each([
      ['minimum', { expiresInMinutes: 5 }, 5],
      ['maximum', { expiresInMinutes: 20_160 }, 20_160],
      ['event default', undefined, 37],
    ] as const)('accepts the %s TTL', async (_name, payload, expectedMinutes) => {
      const response = await invokeOffer(eventA, entryA, payload);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ entry: Record<string, unknown>; claimToken: string }>();
      const after = await evidenceSnapshot();
      const persisted = entryFrom(after, entryA);
      expect(body.entry).toEqual(normalizedPublicEntry(persisted));
      expect(new Date(persisted.offer_expires_at!).getTime()).toBe(
        new Date(persisted.offered_at!).getTime() + expectedMinutes * 60_000,
      );
      expect(after.audits).toHaveLength(1);
    });

    it.each([
      ['below minimum', { expiresInMinutes: 4 }],
      ['above maximum', { expiresInMinutes: 20_161 }],
      ['fractional', { expiresInMinutes: 5.5 }],
      ['unknown field', { expiresInMinutes: 30, unexpected: true }],
    ] as const)('rejects the %s TTL without mutation or audit', async (_name, payload) => {
      const before = await evidenceSnapshot();
      const response = await invokeOffer(eventA, entryA, payload);
      expect(response.statusCode, response.body).toBe(400);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    });

    it.each([
      ['below minimum', 4],
      ['above maximum', 20_161],
    ] as const)(
      'fails closed for a persisted event default %s without mutation or audit',
      async (_name, storedTtl) => {
        await db
          .updateTable('events')
          .set({ waitlist_offer_ttl_minutes: storedTtl })
          .where('id', '=', eventA)
          .execute();
        const before = await evidenceSnapshot();

        const response = await invokeOffer(eventA, entryA);

        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      },
    );

    it('rejects a fractional persisted TTL at the integer column or fails closed after normalization', async () => {
      const beforeWrite = await evidenceSnapshot();
      try {
        await db
          .updateTable('events')
          .set({ waitlist_offer_ttl_minutes: 3.5 })
          .where('id', '=', eventA)
          .execute();
      } catch {
        await expect(evidenceSnapshot()).resolves.toEqual(beforeWrite);
        return;
      }

      const beforeRoute = await evidenceSnapshot();
      const storedTtl = Number(
        beforeRoute.events.find((event) => event.id === eventA)!.waitlist_offer_ttl_minutes,
      );
      expect(Number.isInteger(storedTtl)).toBe(true);
      expect(storedTtl).toBeLessThan(5);

      const response = await invokeOffer(eventA, entryA);

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      await expect(evidenceSnapshot()).resolves.toEqual(beforeRoute);
    });
  });

  it('rejects a non-joined entry without mutation or audit', async () => {
    const before = await evidenceSnapshot();
    const response = await invokeOffer(eventA, entryAWrongState, { expiresInMinutes: 30 });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('rejects insufficient capacity without mutation or audit', async () => {
    await db
      .updateTable('inventory_pools')
      .set({ sold_count: 1 })
      .where('id', '=', poolA)
      .execute();
    const before = await evidenceSnapshot();
    const response = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('rolls back an audit failure and permits an exact clean retry', async () => {
    const before = await evidenceSnapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected waitlist offer audit failure'));
    try {
      const failed = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeOffer(eventA, entryA, { expiresInMinutes: 30 });
    expect(retry.statusCode, retry.body).toBe(200);
    const body = retry.json<{ entry: Record<string, unknown>; claimToken: string }>();
    const after = await evidenceSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(body.entry).toEqual(normalizedPublicEntry(entryFrom(after, entryA)));
    expectExactOfferAudit(before, after, entryA, body.claimToken);
  });

  it('serializes concurrent offers to one capacity winner without over-allocation', async () => {
    const before = await evidenceSnapshot();
    const responses = await Promise.all([
      invokeOffer(eventA, entryA, { expiresInMinutes: 30 }),
      invokeOffer(eventA, entryASecond, { expiresInMinutes: 30 }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.statusCode === 200)!;
    const loser = responses.find((response) => response.statusCode === 409)!;
    expect(loser.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    const winnerBody = winner.json<{ entry: { id: string }; claimToken: string }>();
    const after = await evidenceSnapshot();
    const competingEntries = [entryFrom(after, entryA), entryFrom(after, entryASecond)];
    expect(competingEntries.filter((entry) => entry.status === 'offered')).toHaveLength(1);
    expect(competingEntries.filter((entry) => entry.status === 'joined')).toHaveLength(1);
    expect(
      competingEntries
        .filter((entry) => entry.status === 'offered')
        .reduce((total, entry) => total + Number(entry.quantity), 0),
    ).toBe(1);
    expect(winnerBody.entry.id).toBe(
      competingEntries.find((entry) => entry.status === 'offered')!.id,
    );
    expect(entryFrom(after, winnerBody.entry.id).claim_token_hash).toBe(
      hashWaitlistClaimToken(winnerBody.claimToken),
    );
    expect(after.audits).toHaveLength(1);
    expectExactOfferAudit(before, after, winnerBody.entry.id, winnerBody.claimToken);
  });
});
