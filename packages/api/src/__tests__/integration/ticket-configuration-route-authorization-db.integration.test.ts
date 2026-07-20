import Fastify, { type FastifyInstance } from 'fastify';
import {
  AccessRuleRepository,
  AuditLogRepository,
  createDb,
  EventOccurrenceRepository,
  EventRepository,
  InventoryPoolRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import {
  serializeAccessRule,
  serializeInventoryPool,
  serializeTicketType,
} from '../../http/contracts.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function ticketConfigurationContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) {
    throw new Error(`ticket configuration authorization contract ${operationId} missing`);
  }
  return contract;
}

const poolContract = ticketConfigurationContract('postEventsByEventIdInventoryPools');
const ticketContract = ticketConfigurationContract('postEventsByEventIdTicketTypes');
const batchContract = ticketConfigurationContract('postEventsByEventIdTicketTypesBatch');
const listAccessRulesContract = ticketConfigurationContract(
  'getTicketTypesByTicketTypeIdAccessRules',
);
const createAccessRuleContract = ticketConfigurationContract(
  'postTicketTypesByTicketTypeIdAccessRules',
);
const deleteAccessRuleContract = ticketConfigurationContract('deleteAccessRulesByAccessRuleId');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_tcfg_auth_a_${suffix}`;
const tenantB = `tnt_tcfg_auth_b_${suffix}`;
const organizationA = `org_tcfg_auth_a_${suffix}`;
const organizationAScoped = `org_tcfg_auth_scope_${suffix}`;
const organizationB = `org_tcfg_auth_b_${suffix}`;
const brandA = `brd_tcfg_auth_a_${suffix}`;
const brandAScoped = `brd_tcfg_auth_scope_${suffix}`;
const brandB = `brd_tcfg_auth_b_${suffix}`;
const actorId = `usr_tcfg_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;
let occurrenceA: string;
let occurrenceAScoped: string;
let occurrenceB: string;
let poolA: string;
let poolAScoped: string;
let poolB: string;

type TicketConfigurationOperation =
  | 'access_rule_create'
  | 'access_rule_delete'
  | 'access_rule_list'
  | 'inventory_pool_create'
  | 'ticket_type_create'
  | 'ticket_type_batch_create';

const ticketConfigurationCheckpoint = vi.fn(
  async (_input: {
    stage: 'before_transaction';
    operation: TicketConfigurationOperation;
    eventId: string;
  }) => undefined,
);
const onboardingEventsInc = vi.fn();
const onboardingMilestoneDurationObserve = vi.fn();

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
    venue: { name: 'Ticket configuration authorization hall' },
  });
  return event.id;
}

async function seedOccurrence(eventId: string, title: string): Promise<string> {
  const occurrence = await new EventOccurrenceRepository(db).create({
    eventId,
    title,
    startsAt: new Date('2027-02-01T18:00:00.000Z'),
    endsAt: new Date('2027-02-01T20:00:00.000Z'),
    timezone: 'UTC',
    venue: { name: `${title} hall` },
    capacity: 400,
    sortOrder: 1,
    status: 'scheduled',
  });
  return occurrence.id;
}

async function seedPool(eventId: string, name: string): Promise<string> {
  const pool = await new InventoryPoolRepository(db).create({
    eventId,
    name,
    totalCapacity: 400,
    holdTtlSeconds: 480,
  });
  return pool.id;
}

async function seedAccessRuleFixture(
  eventId: string,
  inventoryPoolId: string,
  eventOccurrenceId: string,
  name: string,
) {
  const ticketType = await new TicketTypeRepository(db).create({
    eventId,
    name,
    kind: 'paid',
    currency: 'USD',
    priceCents: 2500,
    inventoryPoolId,
    eventOccurrenceId,
    visibility: 'locked',
    requiresAccessCode: true,
  });
  const accessRule = await new AccessRuleRepository(db).create({
    ticketTypeId: ticketType.id,
    type: 'code',
    value: `${name}-initial-code`,
    maxUses: 20,
  });
  return { accessRule, ticketType };
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearTicketConfigurationEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', 'in', [
      'inventory_pool.created',
      'ticket_type.created',
      'ticket_type.batch_created',
    ])
    .execute();
  await db
    .deleteFrom('access_rules')
    .where(
      'ticket_type_id',
      'in',
      db
        .selectFrom('ticket_types')
        .select('id')
        .where('event_id', 'in', [eventA, eventAScoped, eventB]),
    )
    .execute();
  await db
    .deleteFrom('ticket_types')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
  await db
    .deleteFrom('inventory_pools')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
  await db
    .deleteFrom('event_occurrences')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
}

async function seedBaselineConfiguration(): Promise<void> {
  occurrenceA = await seedOccurrence(eventA, 'Allowed ticket occurrence');
  occurrenceAScoped = await seedOccurrence(eventAScoped, 'Scoped ticket occurrence');
  occurrenceB = await seedOccurrence(eventB, 'Foreign ticket occurrence');
  poolA = await seedPool(eventA, 'Allowed ticket pool');
  poolAScoped = await seedPool(eventAScoped, 'Scoped ticket pool');
  poolB = await seedPool(eventB, 'Foreign ticket pool');
}

async function evidenceSnapshot() {
  const [events, occurrences, pools, ticketTypes, accessRules, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'version', 'public_revision'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('event_occurrences')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('ticket_types')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('access_rules')
      .selectAll()
      .where(
        'ticket_type_id',
        'in',
        db
          .selectFrom('ticket_types')
          .select('id')
          .where('event_id', 'in', [eventA, eventAScoped, eventB]),
      )
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', 'in', [
        'inventory_pool.created',
        'ticket_type.created',
        'ticket_type.batch_created',
      ])
      .orderBy('id')
      .execute(),
  ]);
  return { events, occurrences, pools, ticketTypes, accessRules, audits };
}

function poolPayload(name = 'Created inventory pool') {
  return { name, totalCapacity: 525, holdTtlSeconds: 720 };
}

function ticketPayload(
  inventoryPoolId: string,
  eventOccurrenceId: string,
  name = 'Created ticket type',
) {
  return {
    name,
    description: `${name} description`,
    kind: 'paid' as const,
    visibility: 'locked' as const,
    currency: 'USD',
    priceCents: 4200,
    minimumPriceCents: 1800,
    salesStartAt: '2026-12-01T10:00:00.000Z',
    salesEndAt: '2027-01-31T23:00:00.000Z',
    minPerOrder: 2,
    maxPerOrder: 8,
    inventoryPoolId,
    eventOccurrenceId,
    requiresAccessCode: true,
    accessCodeHint: 'Members only',
  };
}

function batchPayloadWithExistingPool(
  inventoryPoolId: string,
  eventOccurrenceId: string,
  name = 'Created batch ticket type',
) {
  return {
    ticketType: ticketPayload(inventoryPoolId, eventOccurrenceId, name),
    accessRules: [
      { type: 'code' as const, value: '  FOUNDERS-2027  ', maxUses: 25 },
      {
        type: 'email_domain' as const,
        value: '  @Example.COM  ',
        expiresAt: '2027-01-15T18:00:00.000Z',
      },
    ],
  };
}

function batchPayloadWithNewPool(
  eventOccurrenceId: string,
  name = 'Created batch ticket and pool',
) {
  const ticketType = ticketPayload(poolA, eventOccurrenceId, name);
  const { inventoryPoolId: _inventoryPoolId, ...ticketTypeWithoutPool } = ticketType;
  return {
    ticketType: ticketTypeWithoutPool,
    inventoryPool: poolPayload(`${name} pool`),
    accessRules: [{ type: 'code' as const, value: `${name}-code`, maxUses: 11 }],
  };
}

function invokePool(targetEventId: string, name?: string) {
  return app.inject({
    method: poolContract.method,
    url: poolContract.path.replace('{eventId}', targetEventId),
    payload: poolPayload(name),
  });
}

function invokeTicket(
  targetEventId: string,
  inventoryPoolId: string,
  eventOccurrenceId: string,
  name?: string,
) {
  return app.inject({
    method: ticketContract.method,
    url: ticketContract.path.replace('{eventId}', targetEventId),
    payload: ticketPayload(inventoryPoolId, eventOccurrenceId, name),
  });
}

function invokeBatchWithExistingPool(
  targetEventId: string,
  inventoryPoolId: string,
  eventOccurrenceId: string,
  name?: string,
) {
  return app.inject({
    method: batchContract.method,
    url: batchContract.path.replace('{eventId}', targetEventId),
    payload: batchPayloadWithExistingPool(inventoryPoolId, eventOccurrenceId, name),
  });
}

function invokeBatchWithNewPool(targetEventId: string, eventOccurrenceId: string, name?: string) {
  return app.inject({
    method: batchContract.method,
    url: batchContract.path.replace('{eventId}', targetEventId),
    payload: batchPayloadWithNewPool(eventOccurrenceId, name),
  });
}

function invokeListAccessRules(ticketTypeId: string) {
  return app.inject({
    method: listAccessRulesContract.method,
    url: listAccessRulesContract.path.replace('{ticketTypeId}', ticketTypeId),
  });
}

function invokeCreateAccessRule(ticketTypeId: string, value = 'SECOND-ACCESS-CODE') {
  return app.inject({
    method: createAccessRuleContract.method,
    url: createAccessRuleContract.path.replace('{ticketTypeId}', ticketTypeId),
    payload: { type: 'code', value, maxUses: 12 },
  });
}

function invokeDeleteAccessRule(accessRuleId: string) {
  return app.inject({
    method: deleteAccessRuleContract.method,
    url: deleteAccessRuleContract.path.replace('{accessRuleId}', accessRuleId),
  });
}

function eventFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return snapshot.events.find((event) => event.id === eventId)!;
}

function expectEventDelta(
  before: Awaited<ReturnType<typeof evidenceSnapshot>>,
  after: Awaited<ReturnType<typeof evidenceSnapshot>>,
  eventId: string,
  expectedDelta: number,
): void {
  const beforeEvent = eventFrom(before, eventId);
  const afterEvent = eventFrom(after, eventId);
  expect(Number(afterEvent.version)).toBe(Number(beforeEvent.version) + expectedDelta);
  expect(revisionMillis(afterEvent.public_revision)).toBeGreaterThan(
    revisionMillis(beforeEvent.public_revision),
  );
}

function exactAuditAfter(
  audit: Awaited<ReturnType<typeof evidenceSnapshot>>['audits'][number],
  expected: {
    action: string;
    brandId: string;
    organizationId: string;
    resourceId: string;
    resourceType: string;
    after: unknown;
    eventId: string;
  },
): void {
  expect(audit).toMatchObject({
    tenant_id: tenantA,
    organization_id: expected.organizationId,
    brand_id: expected.brandId,
    actor_id: actorId,
    action: expected.action,
    resource_type: expected.resourceType,
    resource_id: expected.resourceId,
  });
  expect(auditDiff(audit.diff_summary)).toEqual({
    eventId: expected.eventId,
    after: expected.after,
  });
}

function sortAccessRules<T extends { type: unknown }>(rules: T[]): T[] {
  return [...rules].sort((left, right) => String(left.type).localeCompare(String(right.type)));
}

describeWithIntegrationDatabase('ticket configuration write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Ticket configuration authorization tenant A');
    await insertTenant(tenantB, 'Ticket configuration authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Ticket configuration authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Ticket configuration authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Ticket configuration authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Ticket configuration authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Ticket configuration authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Ticket configuration authorization brand B');
    eventA = await createEvent(
      tenantA,
      organizationA,
      brandA,
      'Allowed ticket configuration event',
    );
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped ticket configuration event',
    );
    eventB = await createEvent(
      tenantB,
      organizationB,
      brandB,
      'Foreign ticket configuration event',
    );

    basePrincipal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    activePrincipal = basePrincipal;

    app = Fastify({ logger: false });
    app.decorate('observability', {
      metrics: {
        metrics: {
          onboardingEvents: { inc: onboardingEventsInc },
          onboardingMilestoneDuration: { observe: onboardingMilestoneDurationObserve },
        },
      },
    } as unknown as FastifyInstance['observability']);
    app.decorate('context', {
      db,
      ticketConfigurationCheckpoint: (input: {
        stage: 'before_transaction';
        operation: TicketConfigurationOperation;
        eventId: string;
      }) => ticketConfigurationCheckpoint(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(ticketingRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    activePrincipal = basePrincipal;
    ticketConfigurationCheckpoint.mockReset();
    ticketConfigurationCheckpoint.mockResolvedValue(undefined);
    onboardingEventsInc.mockReset();
    onboardingMilestoneDurationObserve.mockReset();
    await clearTicketConfigurationEvidence();
    await seedBaselineConfiguration();
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
      await cleanup(clearTicketConfigurationEvidence);
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
      throw new AggregateError(
        cleanupErrors,
        'Failed to clean up ticket configuration authorization proof',
      );
    }
  });

  it('binds all ticket-configuration route contracts to this executable proof', () => {
    for (const contract of [
      poolContract,
      ticketContract,
      batchContract,
      listAccessRulesContract,
      createAccessRuleContract,
      deleteAccessRuleContract,
    ]) {
      expect(contract).toMatchObject({
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        source: 'ticket-configuration-route-authorization-db.integration.test.ts',
      });
    }
  });

  it('lists, creates, and deletes access rules through exact authorized persistence controls', async () => {
    const fixture = await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Allowed access rule');
    const before = await evidenceSnapshot();

    const listed = await invokeListAccessRules(fixture.ticketType.id);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      items: [serializeAccessRule(fixture.accessRule as Record<string, unknown>)],
      nextCursor: null,
      hasMore: false,
    });

    const created = await invokeCreateAccessRule(fixture.ticketType.id);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      ticketTypeId: fixture.ticketType.id,
      type: 'code',
      value: 'SECOND-ACCESS-CODE',
      maxUses: 12,
    });

    const deleted = await invokeDeleteAccessRule(fixture.accessRule.id);
    expect(deleted.statusCode, deleted.body).toBe(204);
    const after = await evidenceSnapshot();
    expect(after.accessRules.find((rule) => rule.id === fixture.accessRule.id)).toBeUndefined();
    expect(after.accessRules.find((rule) => rule.id === created.json().id)).toBeDefined();
    expect(after.ticketTypes).toEqual(before.ticketTypes);
    expect(after.audits).toEqual(before.audits);
  });

  it('denies access-rule permission failures without changing persistent state', async () => {
    const fixture = await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Denied access rule');
    const before = await evidenceSnapshot();
    activePrincipal = { ...basePrincipal, scopes: [] };

    for (const response of [
      await invokeListAccessRules(fixture.ticketType.id),
      await invokeCreateAccessRule(fixture.ticketType.id, 'DENIED-SECOND-CODE'),
      await invokeDeleteAccessRule(fixture.accessRule.id),
    ]) {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it.each([
    ['tenant', () => basePrincipal, () => eventB, () => poolB, () => occurrenceB],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
      () => poolAScoped,
      () => occurrenceAScoped,
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => eventAScoped,
      () => poolAScoped,
      () => occurrenceAScoped,
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
      () => poolAScoped,
      () => occurrenceAScoped,
    ],
  ] as const)(
    'denies the %s boundary for access-rule list/create/delete with exact persistence snapshots',
    async (_boundary, makePrincipal, targetEvent, targetPool, targetOccurrence) => {
      const fixture = await seedAccessRuleFixture(
        targetEvent(),
        targetPool(),
        targetOccurrence(),
        `Forbidden ${_boundary} access rule`,
      );
      const before = await evidenceSnapshot();
      activePrincipal = makePrincipal();

      for (const response of [
        await invokeListAccessRules(fixture.ticketType.id),
        await invokeCreateAccessRule(fixture.ticketType.id, `DENIED-${_boundary}-CODE`),
        await invokeDeleteAccessRule(fixture.accessRule.id),
      ]) {
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('persists exact pool, single ticket, and both batch variants with atomic audit and revision evidence', async () => {
    const beforePool = await evidenceSnapshot();
    const poolResponse = await invokePool(eventA);
    expect(poolResponse.statusCode, poolResponse.body).toBe(201);
    const createdPool = poolResponse.json();
    const afterPool = await evidenceSnapshot();
    expectEventDelta(beforePool, afterPool, eventA, 1);
    expect(
      serializeInventoryPool(
        afterPool.pools.find((row) => row.id === createdPool.id) as Record<string, unknown>,
      ),
    ).toEqual(createdPool);
    exactAuditAfter(afterPool.audits[0]!, {
      action: 'inventory_pool.created',
      brandId: brandA,
      organizationId: organizationA,
      resourceId: createdPool.id,
      resourceType: 'InventoryPool',
      after: createdPool,
      eventId: eventA,
    });

    const beforeTicket = afterPool;
    const ticketResponse = await invokeTicket(eventA, poolA, occurrenceA);
    expect(ticketResponse.statusCode, ticketResponse.body).toBe(201);
    const createdTicket = ticketResponse.json();
    const afterTicket = await evidenceSnapshot();
    expectEventDelta(beforeTicket, afterTicket, eventA, 1);
    expect(createdTicket.eventOccurrenceId).toBe(occurrenceA);
    expect(
      serializeTicketType(
        afterTicket.ticketTypes.find((row) => row.id === createdTicket.id) as Record<
          string,
          unknown
        >,
      ),
    ).toEqual(createdTicket);
    exactAuditAfter(afterTicket.audits.find((audit) => audit.resource_id === createdTicket.id)!, {
      action: 'ticket_type.created',
      brandId: brandA,
      organizationId: organizationA,
      resourceId: createdTicket.id,
      resourceType: 'TicketType',
      after: createdTicket,
      eventId: eventA,
    });

    const beforeExistingBatch = afterTicket;
    const existingBatchResponse = await invokeBatchWithExistingPool(eventA, poolA, occurrenceA);
    expect(existingBatchResponse.statusCode, existingBatchResponse.body).toBe(201);
    const existingBatch = existingBatchResponse.json();
    const afterExistingBatch = await evidenceSnapshot();
    expectEventDelta(beforeExistingBatch, afterExistingBatch, eventA, 1);
    expect(existingBatch.ticketType.eventOccurrenceId).toBe(occurrenceA);
    expect(existingBatch.accessRules).toHaveLength(2);
    expect(existingBatch.accessRules.map((rule: { value: string }) => rule.value)).toEqual([
      'FOUNDERS-2027',
      'example.com',
    ]);
    expect(
      serializeTicketType(
        afterExistingBatch.ticketTypes.find(
          (row) => row.id === existingBatch.ticketType.id,
        ) as Record<string, unknown>,
      ),
    ).toEqual(existingBatch.ticketType);
    expect(
      sortAccessRules(
        afterExistingBatch.accessRules
          .filter((row) => row.ticket_type_id === existingBatch.ticketType.id)
          .map((row) => serializeAccessRule(row as Record<string, unknown>)),
      ),
    ).toEqual(sortAccessRules(existingBatch.accessRules));
    exactAuditAfter(
      afterExistingBatch.audits.find((audit) => audit.resource_id === existingBatch.ticketType.id)!,
      {
        action: 'ticket_type.batch_created',
        brandId: brandA,
        organizationId: organizationA,
        resourceId: existingBatch.ticketType.id,
        resourceType: 'TicketType',
        after: { ...existingBatch, inventoryPool: null },
        eventId: eventA,
      },
    );

    const beforeNewPoolBatch = afterExistingBatch;
    const newPoolBatchResponse = await invokeBatchWithNewPool(eventA, occurrenceA);
    expect(newPoolBatchResponse.statusCode, newPoolBatchResponse.body).toBe(201);
    const newPoolBatch = newPoolBatchResponse.json();
    const afterNewPoolBatch = await evidenceSnapshot();
    expectEventDelta(beforeNewPoolBatch, afterNewPoolBatch, eventA, 2);
    expect(newPoolBatch.ticketType.eventOccurrenceId).toBe(occurrenceA);
    const batchPool = afterNewPoolBatch.pools.find(
      (row) => row.id === newPoolBatch.ticketType.inventoryPoolId,
    );
    expect(batchPool).toBeDefined();
    const serializedBatchPool = serializeInventoryPool(batchPool as Record<string, unknown>);
    expect(serializedBatchPool).toMatchObject(poolPayload('Created batch ticket and pool pool'));
    expect(
      sortAccessRules(
        afterNewPoolBatch.accessRules
          .filter((row) => row.ticket_type_id === newPoolBatch.ticketType.id)
          .map((row) => serializeAccessRule(row as Record<string, unknown>)),
      ),
    ).toEqual(sortAccessRules(newPoolBatch.accessRules));
    exactAuditAfter(
      afterNewPoolBatch.audits.find((audit) => audit.resource_id === newPoolBatch.ticketType.id)!,
      {
        action: 'ticket_type.batch_created',
        brandId: brandA,
        organizationId: organizationA,
        resourceId: newPoolBatch.ticketType.id,
        resourceType: 'TicketType',
        after: { ...newPoolBatch, inventoryPool: serializedBatchPool },
        eventId: eventA,
      },
    );
    expect(afterNewPoolBatch.audits).toHaveLength(4);
    expect(onboardingEventsInc).toHaveBeenCalledTimes(1);
    expect(onboardingEventsInc).toHaveBeenCalledWith({
      stage: 'first_ticket',
      outcome: 'completed',
      reason_code: 'none',
    });
    expect(onboardingMilestoneDurationObserve).toHaveBeenCalledTimes(1);
    expect(onboardingMilestoneDurationObserve).toHaveBeenCalledWith(
      { milestone: 'first_ticket' },
      expect.any(Number),
    );
  });

  it.each([
    [
      'inventory pool create',
      () => invokePool(eventA, 'Audit retry pool'),
      'inventory_pool.created',
      1,
    ],
    [
      'single ticket create',
      () => invokeTicket(eventA, poolA, occurrenceA, 'Audit retry ticket'),
      'ticket_type.created',
      1,
    ],
    [
      'batch ticket and pool create',
      () => invokeBatchWithNewPool(eventA, occurrenceA, 'Audit retry batch'),
      'ticket_type.batch_created',
      2,
    ],
  ] as const)(
    '%s rolls back on audit failure and permits an exact clean retry',
    async (_operation, invoke, expectedAction, expectedDelta) => {
      const before = await evidenceSnapshot();
      const failure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('injected ticket configuration audit failure'));
      try {
        const failed = await invoke();
        expect(failed.statusCode).toBe(500);
        await expect(evidenceSnapshot()).resolves.toEqual(before);
        expect(onboardingEventsInc).not.toHaveBeenCalled();
        expect(onboardingMilestoneDurationObserve).not.toHaveBeenCalled();
      } finally {
        failure.mockRestore();
      }

      const retry = await invoke();
      expect(retry.statusCode, retry.body).toBe(201);
      const afterRetry = await evidenceSnapshot();
      expectEventDelta(before, afterRetry, eventA, expectedDelta);
      expect(afterRetry.audits).toHaveLength(1);
      expect(afterRetry.audits[0]?.action).toBe(expectedAction);
      const expectedMilestones = expectedAction === 'inventory_pool.created' ? 0 : 1;
      expect(onboardingEventsInc).toHaveBeenCalledTimes(expectedMilestones);
      expect(onboardingMilestoneDurationObserve).toHaveBeenCalledTimes(expectedMilestones);
    },
  );

  it.each([
    [
      'list',
      'access_rule_list',
      async (fixture: Awaited<ReturnType<typeof seedAccessRuleFixture>>) =>
        invokeListAccessRules(fixture.ticketType.id),
    ],
    [
      'create',
      'access_rule_create',
      async (fixture: Awaited<ReturnType<typeof seedAccessRuleFixture>>) =>
        invokeCreateAccessRule(fixture.ticketType.id, 'SCOPE-RACE-CREATE'),
    ],
    [
      'delete',
      'access_rule_delete',
      async (fixture: Awaited<ReturnType<typeof seedAccessRuleFixture>>) =>
        invokeDeleteAccessRule(fixture.accessRule.id),
    ],
  ] as const)(
    'access-rule %s reauthorizes after a concurrent organization and brand scope swap',
    async (_action, expectedOperation, invoke) => {
      const fixture = await seedAccessRuleFixture(
        eventA,
        poolA,
        occurrenceA,
        `Scope-race access rule ${_action}`,
      );
      let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
      ticketConfigurationCheckpoint.mockImplementationOnce(async (input) => {
        expect(input).toEqual({
          stage: 'before_transaction',
          operation: expectedOperation,
          eventId: eventA,
        });
        await db
          .updateTable('events')
          .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
          .where('id', '=', eventA)
          .execute();
        checkpointSnapshot = await evidenceSnapshot();
      });

      try {
        const response = await invoke(fixture);
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
    },
  );

  it.each([
    ['permission', () => ({ ...basePrincipal, scopes: [] }), () => eventA, 403, 'FORBIDDEN'],
    ['tenant', () => basePrincipal, () => eventB, 404, 'NOT_FOUND'],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
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
      404,
      'NOT_FOUND',
    ],
  ] as const)(
    'denies the %s boundary for all three routes with exact configuration and audit snapshots',
    async (_boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const eventId = targetEvent();
      const targetPool =
        eventId === eventA ? poolA : eventId === eventAScoped ? poolAScoped : poolB;
      const targetOccurrence =
        eventId === eventA
          ? occurrenceA
          : eventId === eventAScoped
            ? occurrenceAScoped
            : occurrenceB;
      const before = await evidenceSnapshot();

      const responses = [
        await invokePool(eventId, 'Forbidden pool'),
        await invokeTicket(eventId, targetPool, targetOccurrence, 'Forbidden ticket'),
        await invokeBatchWithExistingPool(
          eventId,
          targetPool,
          targetOccurrence,
          'Forbidden batch ticket',
        ),
      ];
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('rejects foreign pools and occurrences with 404 and no partial configuration', async () => {
    const before = await evidenceSnapshot();
    const responses = [
      await invokeTicket(eventA, poolAScoped, occurrenceA, 'Foreign pool single'),
      await invokeTicket(eventA, poolA, occurrenceAScoped, 'Foreign occurrence single'),
      await invokeBatchWithExistingPool(eventA, poolAScoped, occurrenceA, 'Foreign pool batch'),
      await invokeBatchWithExistingPool(
        eventA,
        poolA,
        occurrenceAScoped,
        'Foreign occurrence batch',
      ),
      await invokeBatchWithNewPool(eventA, occurrenceAScoped, 'Rolled back foreign occurrence'),
    ];
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it.each([
    ['inventory pool create', () => invokePool(eventA, 'Scope-race pool')],
    ['single ticket create', () => invokeTicket(eventA, poolA, occurrenceA, 'Scope-race ticket')],
    [
      'batch ticket create',
      () => invokeBatchWithExistingPool(eventA, poolA, occurrenceA, 'Scope-race batch'),
    ],
  ] as const)(
    '%s fails closed after a real organization and brand scope swap',
    async (_operation, invoke) => {
      let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
      ticketConfigurationCheckpoint.mockImplementationOnce(async () => {
        await db
          .updateTable('events')
          .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
          .where('id', '=', eventA)
          .execute();
        checkpointSnapshot = await evidenceSnapshot();
      });

      try {
        const response = await invoke();
        expect(response.statusCode).toBe(404);
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
    },
  );

  it('rolls back an earlier batch access rule when a later rule fails, then persists exact rules', async () => {
    const before = await evidenceSnapshot();
    const originalCreate = AccessRuleRepository.prototype.create;
    const failure = vi
      .spyOn(AccessRuleRepository.prototype, 'create')
      .mockImplementationOnce(originalCreate)
      .mockRejectedValueOnce(new Error('injected second access rule failure'));
    try {
      const failed = await invokeBatchWithExistingPool(
        eventA,
        poolA,
        occurrenceA,
        'Atomic access rules',
      );
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeBatchWithExistingPool(
      eventA,
      poolA,
      occurrenceA,
      'Atomic access rules',
    );
    expect(retry.statusCode, retry.body).toBe(201);
    const response = retry.json();
    expect(response.ticketType.eventOccurrenceId).toBe(occurrenceA);
    expect(response.accessRules.map((rule: { value: string }) => rule.value)).toEqual([
      'FOUNDERS-2027',
      'example.com',
    ]);
    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 1);
    expect(
      sortAccessRules(
        after.accessRules
          .filter((rule) => rule.ticket_type_id === response.ticketType.id)
          .map((rule) => serializeAccessRule(rule as Record<string, unknown>)),
      ),
    ).toEqual(sortAccessRules(response.accessRules));
    expect(after.audits).toHaveLength(1);
  });

  it.each([
    [
      'inventory pools',
      () =>
        Promise.all([
          invokePool(eventA, 'Concurrent pool alpha'),
          invokePool(eventA, 'Concurrent pool beta'),
        ]),
      2,
      'inventory_pool.created',
    ],
    [
      'single ticket types',
      () =>
        Promise.all([
          invokeTicket(eventA, poolA, occurrenceA, 'Concurrent ticket alpha'),
          invokeTicket(eventA, poolA, occurrenceA, 'Concurrent ticket beta'),
        ]),
      2,
      'ticket_type.created',
    ],
    [
      'batch ticket types with new pools',
      () =>
        Promise.all([
          invokeBatchWithNewPool(eventA, occurrenceA, 'Concurrent batch alpha'),
          invokeBatchWithNewPool(eventA, occurrenceA, 'Concurrent batch beta'),
        ]),
      4,
      'ticket_type.batch_created',
    ],
  ] as const)(
    'serializes concurrent %s into exact revision and audit increments',
    async (_operation, invoke, expectedDelta, expectedAction) => {
      const before = await evidenceSnapshot();
      const responses = await invoke();
      expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
      const responseBodies = responses.map((response) => response.json());
      const after = await evidenceSnapshot();
      expectEventDelta(before, after, eventA, expectedDelta);
      const audits = after.audits.filter((audit) => audit.action === expectedAction);
      expect(audits).toHaveLength(2);
      const auditAfters = audits.map(
        (audit) => auditDiff(audit.diff_summary).after as Record<string, unknown>,
      );
      if (expectedAction === 'ticket_type.batch_created') {
        const auditedResponses = auditAfters.map(({ inventoryPool, ...response }) => {
          expect(inventoryPool).toBeTruthy();
          const pool = inventoryPool as { id: string };
          expect(pool.id).toBe(
            (response.ticketType as { inventoryPoolId: string }).inventoryPoolId,
          );
          expect(
            serializeInventoryPool(
              after.pools.find((row) => row.id === pool.id) as Record<string, unknown>,
            ),
          ).toEqual(inventoryPool);
          return response;
        });
        expect(auditedResponses).toEqual(expect.arrayContaining(responseBodies));
      } else {
        expect(auditAfters).toEqual(expect.arrayContaining(responseBodies));
      }
      const expectedMilestones = expectedAction === 'inventory_pool.created' ? 0 : 1;
      expect(onboardingEventsInc).toHaveBeenCalledTimes(expectedMilestones);
      expect(onboardingMilestoneDurationObserve).toHaveBeenCalledTimes(expectedMilestones);
    },
  );

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
