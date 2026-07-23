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
import { InventoryService } from '../../services/inventory.js';
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
const ticketUpdateContract = ticketConfigurationContract('patchTicketTypesByTicketTypeId');
const poolReadContract = ticketConfigurationContract('getEventsByEventIdInventoryPools');
const ticketReadContract = ticketConfigurationContract('getEventsByEventIdTicketTypes');
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
  | 'ticket_type_batch_create'
  | 'ticket_type_update';

const ticketConfigurationCheckpoint = vi.fn(
  async (_input: {
    stage: 'after_lock' | 'before_lock' | 'before_transaction';
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
    .values({
      id,
      name,
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function isNowaitLockError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as {
      cause?: unknown;
      code?: unknown;
      errno?: unknown;
    };
    if (record.code === '55P03' || record.code === 'ER_LOCK_NOWAIT' || record.errno === 3572) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function expectPoolWriteLocked(poolId: string): Promise<void> {
  try {
    await db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('inventory_pools')
        .select('id')
        .where('id', '=', poolId)
        .forUpdate()
        .noWait()
        .executeTakeFirstOrThrow();
    });
  } catch (error) {
    if (isNowaitLockError(error)) return;
    throw error;
  }
  throw new Error(`Expected inventory pool ${poolId} to be locked`);
}

async function expectOccurrenceWriteLocked(occurrenceId: string): Promise<void> {
  try {
    await db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('event_occurrences')
        .select('id')
        .where('id', '=', occurrenceId)
        .forUpdate()
        .noWait()
        .executeTakeFirstOrThrow();
    });
  } catch (error) {
    if (isNowaitLockError(error)) return;
    throw error;
  }
  throw new Error(`Expected event occurrence ${occurrenceId} to be locked`);
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
    .deleteFrom('access_rule_redemptions')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
  await db
    .deleteFrom('checkout_holds')
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
    .deleteFrom('checkout_sessions')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', 'in', [
      'inventory_pool.created',
      'ticket_type.created',
      'ticket_type.batch_created',
      'ticket_type.updated',
      'access_rule.created',
      'access_rule.deleted',
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
        'ticket_type.updated',
        'access_rule.created',
        'access_rule.deleted',
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

function invokePoolRead(targetEventId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '1' });
  if (cursor) query.set('cursor', cursor);
  return app.inject({
    method: poolReadContract.method,
    url: `${poolReadContract.path.replace('{eventId}', targetEventId)}?${query}`,
  });
}

function invokeTicketRead(targetEventId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '1' });
  if (cursor) query.set('cursor', cursor);
  return app.inject({
    method: ticketReadContract.method,
    url: `${ticketReadContract.path.replace('{eventId}', targetEventId)}?${query}`,
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

function ticketUpdatePayload(inventoryPoolId: string, eventOccurrenceId: string) {
  return {
    name: 'Updated ticket type',
    description: 'Updated ticket type description',
    kind: 'donation' as const,
    status: 'paused' as const,
    visibility: 'hidden' as const,
    currency: 'USD',
    priceCents: 5300,
    minimumPriceCents: 2100,
    salesStartAt: '2027-02-10T10:00:00.000Z',
    salesEndAt: '2027-03-10T20:00:00.000Z',
    minPerOrder: 3,
    maxPerOrder: 9,
    inventoryPoolId,
    eventOccurrenceId,
    requiresAccessCode: false,
    accessCodeHint: null,
    sortOrder: 7,
  };
}

function invokeTicketUpdate(
  ticketTypeId: string,
  inventoryPoolId: string,
  eventOccurrenceId: string,
) {
  return app.inject({
    method: ticketUpdateContract.method,
    url: ticketUpdateContract.path.replace('{ticketTypeId}', ticketTypeId),
    payload: ticketUpdatePayload(inventoryPoolId, eventOccurrenceId),
  });
}

function expectTicketTypeConcealed(
  response: Awaited<ReturnType<typeof invokeTicketUpdate>>,
  ticketTypeId: string,
): void {
  expect(response.statusCode, response.body).toBe(404);
  expect(response.json()).toEqual({
    error: {
      code: 'NOT_FOUND',
      details: { id: ticketTypeId, resource: 'TicketType' },
      message: `TicketType not found: ${ticketTypeId}`,
      requestId: expect.any(String),
    },
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

function redactBatchAccessRules(response: {
  accessRules: Array<{
    expiresAt?: string | null;
    id: string;
    maxUses?: number | null;
    type: string;
  }>;
  ticketType: unknown;
}) {
  return {
    ticketType: response.ticketType,
    accessRuleCount: response.accessRules.length,
    accessRules: response.accessRules.map((rule) => ({
      id: rule.id,
      type: rule.type,
      maxUses: rule.maxUses ?? null,
      expiresAt: rule.expiresAt ?? null,
    })),
  };
}

describeWithIntegrationDatabase('ticket configuration route authorization matrix', () => {
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
          onboardingMilestoneDuration: {
            observe: onboardingMilestoneDurationObserve,
          },
        },
      },
    } as unknown as FastifyInstance['observability']);
    app.decorate('context', {
      db,
      ticketConfigurationCheckpoint: (input: {
        stage: 'after_lock' | 'before_lock' | 'before_transaction';
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
      poolReadContract,
      ticketReadContract,
      poolContract,
      ticketContract,
      batchContract,
      ticketUpdateContract,
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

  it('returns only the exact authorized inventory pools and ticket types', async () => {
    await seedPool(eventA, 'Allowed read pool two');
    await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Allowed read ticket one');
    await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Allowed read ticket two');
    const scopedTicket = await seedAccessRuleFixture(
      eventAScoped,
      poolAScoped,
      occurrenceAScoped,
      'Scoped read ticket',
    );
    const foreignTicket = await seedAccessRuleFixture(
      eventB,
      poolB,
      occurrenceB,
      'Foreign read ticket',
    );
    const before = await evidenceSnapshot();
    const expectedPools = before.pools
      .filter((pool) => pool.event_id === eventA)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((pool) => serializeInventoryPool(pool as Record<string, unknown>));
    const expectedTickets = before.ticketTypes
      .filter((ticket) => ticket.event_id === eventA)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((ticket) => serializeTicketType(ticket as Record<string, unknown>));
    expect(expectedPools).toHaveLength(2);
    expect(expectedTickets).toHaveLength(2);
    const poolQuery = vi.spyOn(InventoryPoolRepository.prototype, 'findByEvent');
    const ticketQuery = vi.spyOn(TicketTypeRepository.prototype, 'findByEvent');

    try {
      const [firstPoolResponse, firstTicketResponse] = await Promise.all([
        invokePoolRead(eventA),
        invokeTicketRead(eventA),
      ]);
      const [secondPoolResponse, secondTicketResponse] = await Promise.all([
        invokePoolRead(eventA, firstPoolResponse.json().nextCursor),
        invokeTicketRead(eventA, firstTicketResponse.json().nextCursor),
      ]);

      expect(firstPoolResponse.statusCode, firstPoolResponse.body).toBe(200);
      expect(firstPoolResponse.json()).toEqual({
        items: [expectedPools[0]],
        nextCursor: expectedPools[0]!.id,
        hasMore: true,
      });
      expect(secondPoolResponse.statusCode, secondPoolResponse.body).toBe(200);
      expect(secondPoolResponse.json()).toEqual({
        items: [expectedPools[1]],
        nextCursor: null,
        hasMore: false,
      });
      expect(firstTicketResponse.statusCode, firstTicketResponse.body).toBe(200);
      expect(firstTicketResponse.json()).toEqual({
        items: [expectedTickets[0]],
        nextCursor: expectedTickets[0]!.id,
        hasMore: true,
      });
      expect(secondTicketResponse.statusCode, secondTicketResponse.body).toBe(200);
      expect(secondTicketResponse.json()).toEqual({
        items: [expectedTickets[1]],
        nextCursor: null,
        hasMore: false,
      });
      expect(poolQuery.mock.calls).toEqual([
        [eventA, 2, undefined],
        [eventA, 2, expectedPools[0]!.id],
      ]);
      expect(ticketQuery.mock.calls).toEqual([
        [eventA, 2, undefined],
        [eventA, 2, expectedTickets[0]!.id],
      ]);
      for (const response of [
        firstPoolResponse,
        secondPoolResponse,
        firstTicketResponse,
        secondTicketResponse,
      ]) {
        expect(response.body).not.toContain(poolAScoped);
        expect(response.body).not.toContain(poolB);
        expect(response.body).not.toContain('Scoped');
        expect(response.body).not.toContain('Foreign');
        expect(response.body).not.toContain(scopedTicket.ticketType.id);
        expect(response.body).not.toContain(scopedTicket.ticketType.name);
        expect(response.body).not.toContain(foreignTicket.ticketType.id);
        expect(response.body).not.toContain(foreignTicket.ticketType.name);
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      poolQuery.mockRestore();
      ticketQuery.mockRestore();
    }
  });

  it('lists, creates, and deletes access rules through exact authorized persistence controls', async () => {
    const fixture = await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Allowed access rule');
    const before = await evidenceSnapshot();

    const listed = await invokeListAccessRules(fixture.ticketType.id);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        {
          ...serializeAccessRule(fixture.accessRule as Record<string, unknown>),
          value: '[redacted]',
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(listed.body).not.toContain(`${fixture.ticketType.name}-initial-code`);

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
    expectEventDelta(before, after, eventA, 2);
    expect(after.audits).toHaveLength(2);
    const createAudit = after.audits.find((audit) => audit.action === 'access_rule.created')!;
    const deleteAudit = after.audits.find((audit) => audit.action === 'access_rule.deleted')!;
    expect(createAudit).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_id: actorId,
      resource_type: 'AccessRule',
      resource_id: created.json().id,
    });
    expect(auditDiff(createAudit.diff_summary)).toEqual({
      eventId: eventA,
      accessRuleId: created.json().id,
      accessRuleType: 'code',
      accessRuleCount: 2,
    });
    expect(deleteAudit).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_id: actorId,
      resource_type: 'AccessRule',
      resource_id: fixture.accessRule.id,
    });
    expect(auditDiff(deleteAudit.diff_summary)).toEqual({
      eventId: eventA,
      accessRuleId: fixture.accessRule.id,
      accessRuleType: 'code',
      accessRuleCount: 1,
    });
    expect(JSON.stringify(after.audits)).not.toContain('SECOND-ACCESS-CODE');
    expect(JSON.stringify(after.audits)).not.toContain(`${fixture.ticketType.name}-initial-code`);
  });

  it('authorizes access-rule creation before parsing an invalid payload', async () => {
    const fixture = await seedAccessRuleFixture(
      eventAScoped,
      poolAScoped,
      occurrenceAScoped,
      'Unauthorized malformed access rule',
    );
    const before = await evidenceSnapshot();
    activePrincipal = { ...basePrincipal, scopes: [] };

    const response = await app.inject({
      method: createAccessRuleContract.method,
      url: createAccessRuleContract.path.replace('{ticketTypeId}', fixture.ticketType.id),
      payload: { type: 'unsupported', value: 42 },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('enforces the access-rule cap and normalizes exact duplicate create races to one winner', async () => {
    const fixture = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Capped and concurrent access rules',
    );
    const capRows = Array.from({ length: 498 }, (_, index) => ({
      id: `acr_${ulid()}`,
      ticket_type_id: fixture.ticketType.id,
      type: 'code',
      value: `cap-${index}`,
      max_uses: null,
      uses_count: 0,
      expires_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }));
    await db.insertInto('access_rules').values(capRows).execute();
    const beforeCap = await evidenceSnapshot();
    const boundary = await invokeCreateAccessRule(fixture.ticketType.id, 'CAP-BOUNDARY');
    expect(boundary.statusCode, boundary.body).toBe(201);
    const afterBoundary = await evidenceSnapshot();
    expect(
      afterBoundary.accessRules.filter((rule) => rule.ticket_type_id === fixture.ticketType.id),
    ).toHaveLength(500);
    expectEventDelta(beforeCap, afterBoundary, eventA, 1);
    const capped = await invokeCreateAccessRule(fixture.ticketType.id, 'CAP-OVERFLOW');
    expect(capped.statusCode, capped.body).toBe(400);
    expect(capped.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    await expect(evidenceSnapshot()).resolves.toEqual(afterBoundary);

    await db
      .deleteFrom('access_rules')
      .where('ticket_type_id', '=', fixture.ticketType.id)
      .execute();
    await new AccessRuleRepository(db).create({
      ticketTypeId: fixture.ticketType.id,
      type: 'code',
      value: 'initial-race-rule',
    });
    const beforeRace = await evidenceSnapshot();
    const [first, second] = await Promise.all([
      invokeCreateAccessRule(fixture.ticketType.id, 'RACE-RULE'),
      invokeCreateAccessRule(fixture.ticketType.id, 'RACE-RULE'),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 400]);
    const afterRace = await evidenceSnapshot();
    expect(
      afterRace.accessRules.filter((rule) => rule.ticket_type_id === fixture.ticketType.id),
    ).toHaveLength(2);
    expectEventDelta(beforeRace, afterRace, eventA, 1);
    expect(afterRace.audits).toHaveLength(beforeRace.audits.length + 1);
  });

  it('keeps code credentials case-sensitive while normalizing surrounding whitespace', async () => {
    const fixture = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Case-sensitive access rules',
    );
    const before = await evidenceSnapshot();

    const upper = await invokeCreateAccessRule(fixture.ticketType.id, 'CASE-RULE');
    const lower = await invokeCreateAccessRule(fixture.ticketType.id, 'case-rule');
    const whitespaceDuplicate = await invokeCreateAccessRule(fixture.ticketType.id, ' CASE-RULE ');

    expect(upper.statusCode, upper.body).toBe(201);
    expect(lower.statusCode, lower.body).toBe(201);
    expect(whitespaceDuplicate.statusCode, whitespaceDuplicate.body).toBe(400);
    const after = await evidenceSnapshot();
    expect(
      after.accessRules
        .filter((rule) => rule.ticket_type_id === fixture.ticketType.id)
        .map((rule) => rule.value),
    ).toEqual(expect.arrayContaining(['CASE-RULE', 'case-rule']));
    expectEventDelta(before, after, eventA, 2);
    expect(after.audits).toHaveLength(2);
  });

  it('rolls back access-rule creation when its required audit write fails', async () => {
    const fixture = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Access-rule audit rollback',
    );
    const before = await evidenceSnapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected access-rule audit failure'));
    try {
      const response = await invokeCreateAccessRule(fixture.ticketType.id, 'AUDIT-MUST-ROLL-BACK');
      expect(response.statusCode, response.body).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }
  });

  it('refuses to delete an access rule while its ticket type has an active checkout hold', async () => {
    const fixture = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Active-hold access rule',
    );
    await new InventoryService(db).reserveCart({
      checkoutSessionId: `cs_${ulid()}`,
      requiredAccessRules: [
        { accessRuleId: fixture.accessRule.id, ticketTypeId: fixture.ticketType.id },
      ],
      items: [
        {
          inventoryPoolId: poolA,
          ticketTypeId: fixture.ticketType.id,
          occurrenceId: occurrenceA,
          quantity: 1,
        },
      ],
    });
    const before = await evidenceSnapshot();

    const response = await invokeDeleteAccessRule(fixture.accessRule.id);

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
    expect(await new AccessRuleRepository(db).findByTicketType(fixture.ticketType.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.accessRule.id })]),
    );
  });

  it('fails a required-rule reservation after deletion without writing a hold or checkout-session reference', async () => {
    const fixture = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Deleted required access rule',
    );
    const sessionId = `cs_${ulid()}`;
    const deleted = await invokeDeleteAccessRule(fixture.accessRule.id);
    expect(deleted.statusCode, deleted.body).toBe(204);

    await expect(
      new InventoryService(db).reserveCart({
        checkoutSessionId: sessionId,
        requiredAccessRules: [
          { accessRuleId: fixture.accessRule.id, ticketTypeId: fixture.ticketType.id },
        ],
        items: [
          {
            inventoryPoolId: poolA,
            ticketTypeId: fixture.ticketType.id,
            occurrenceId: occurrenceA,
            quantity: 1,
          },
        ],
      }),
    ).rejects.toThrow('changed; refresh the cart and try again');
    await expect(
      db
        .selectFrom('checkout_holds')
        .select('id')
        .where('checkout_session_id', '=', sessionId)
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom('checkout_sessions').select('id').where('id', '=', sessionId).execute(),
    ).resolves.toEqual([]);
  });

  it('serializes concurrent access-rule deletion and required-rule reservation in either order', async () => {
    const reserve = (
      fixture: Awaited<ReturnType<typeof seedAccessRuleFixture>>,
      sessionId: string,
      checkpoint?: ConstructorParameters<typeof InventoryService>[1],
    ) =>
      new InventoryService(db, checkpoint).reserveCart({
        checkoutSessionId: sessionId,
        requiredAccessRules: [
          { accessRuleId: fixture.accessRule.id, ticketTypeId: fixture.ticketType.id },
        ],
        items: [
          {
            inventoryPoolId: poolA,
            ticketTypeId: fixture.ticketType.id,
            occurrenceId: occurrenceA,
            quantity: 1,
          },
        ],
      });

    const deleteFirst = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Delete-first access rule race',
    );
    const deletionLocked = deferred();
    const releaseDeletion = deferred();
    ticketConfigurationCheckpoint.mockImplementation(async (input) => {
      if (input.operation !== 'access_rule_delete' || input.stage !== 'after_lock') return;
      deletionLocked.resolve();
      await releaseDeletion.promise;
    });
    const deletion = invokeDeleteAccessRule(deleteFirst.accessRule.id);
    await deletionLocked.promise;
    const reservationStarted = deferred();
    const deleteFirstSessionId = `cs_${ulid()}`;
    const staleReservation = reserve(deleteFirst, deleteFirstSessionId, async (input) => {
      if (input.stage === 'before_pool_locks') reservationStarted.resolve();
    });
    await reservationStarted.promise;
    releaseDeletion.resolve();
    const deleted = await deletion;
    expect(deleted.statusCode, deleted.body).toBe(204);
    await expect(staleReservation).rejects.toThrow('changed; refresh the cart and try again');
    await expect(
      db
        .selectFrom('checkout_holds')
        .select('id')
        .where('checkout_session_id', '=', deleteFirstSessionId)
        .execute(),
    ).resolves.toEqual([]);

    ticketConfigurationCheckpoint.mockReset();
    const reservationFirst = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Reservation-first access rule race',
    );
    const reservationLocked = deferred();
    const releaseReservation = deferred();
    const reservationFirstSessionId = `cs_${ulid()}`;
    const winningReservation = reserve(
      reservationFirst,
      reservationFirstSessionId,
      async (input) => {
        if (input.stage !== 'after_ticket_type_locks') return;
        reservationLocked.resolve();
        await releaseReservation.promise;
      },
    );
    await reservationLocked.promise;
    const deletionStarted = deferred();
    ticketConfigurationCheckpoint.mockImplementation(async (input) => {
      if (input.operation === 'access_rule_delete' && input.stage === 'before_lock') {
        deletionStarted.resolve();
      }
    });
    const blockedDeletion = invokeDeleteAccessRule(reservationFirst.accessRule.id);
    await deletionStarted.promise;
    releaseReservation.resolve();
    await expect(winningReservation).resolves.toMatchObject({ primaryHoldId: expect.any(String) });
    const conflicted = await blockedDeletion;
    expect(conflicted.statusCode, conflicted.body).toBe(409);
    expect(conflicted.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(
      await new AccessRuleRepository(db).findByTicketType(reservationFirst.ticketType.id),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: reservationFirst.accessRule.id })]),
    );
  });

  it('rejects redeemed access-rule deletion with a conflict and preserves persistent state', async () => {
    const fixture = await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Redeemed access rule');
    const sessionId = `cs_${ulid()}`;
    const now = new Date();
    await db
      .insertInto('checkout_sessions')
      .values({
        id: sessionId,
        tenant_id: tenantA,
        event_id: eventA,
        brand_id: brandA,
        status: 'open',
        hold_id: `hld_${ulid()}`,
        currency: 'USD',
        cart: '{}',
        buyer: '{}',
        quote: '{}',
        payment_intent_id: null,
        order_id: null,
        success_url: null,
        cancel_url: null,
        expires_at: new Date(now.getTime() + 60_000),
        idempotency_key: `idem_${ulid()}`,
        client_token: `token_${ulid()}`,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('access_rule_redemptions')
      .values({
        id: `ared_${ulid()}`,
        access_rule_id: fixture.accessRule.id,
        ticket_type_id: fixture.ticketType.id,
        event_id: eventA,
        checkout_session_id: sessionId,
        order_id: null,
        tenant_id: tenantA,
        created_at: now,
      })
      .execute();
    const before = await evidenceSnapshot();

    const response = await invokeDeleteAccessRule(fixture.accessRule.id);

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
    await expect(
      db
        .selectFrom('access_rule_redemptions')
        .select('id')
        .where('access_rule_id', '=', fixture.accessRule.id)
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it('rolls back access-rule deletion when its required audit write fails, then permits a clean retry', async () => {
    const fixture = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Access-rule deletion audit rollback',
    );
    const before = await evidenceSnapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected access-rule deletion audit failure'));
    try {
      const failed = await invokeDeleteAccessRule(fixture.accessRule.id);
      expect(failed.statusCode, failed.body).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retried = await invokeDeleteAccessRule(fixture.accessRule.id);
    expect(retried.statusCode, retried.body).toBe(204);
    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 1);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]?.action).toBe('access_rule.deleted');
  });

  it('returns exact concealed TicketType and AccessRule bodies for scoped access-rule denials', async () => {
    const fixture = await seedAccessRuleFixture(
      eventAScoped,
      poolAScoped,
      occurrenceAScoped,
      'Concealed access rule',
    );
    activePrincipal = { ...basePrincipal, eventIds: [eventA] };
    const ticketTypeResponses = [
      await invokeListAccessRules(fixture.ticketType.id),
      await invokeCreateAccessRule(fixture.ticketType.id, 'CONCEALED-CODE'),
    ];
    for (const response of ticketTypeResponses) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          details: { id: fixture.ticketType.id, resource: 'TicketType' },
          message: `TicketType not found: ${fixture.ticketType.id}`,
          requestId: expect.any(String),
        },
      });
    }
    const ruleResponse = await invokeDeleteAccessRule(fixture.accessRule.id);
    expect(ruleResponse.statusCode, ruleResponse.body).toBe(404);
    expect(ruleResponse.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        details: { id: fixture.accessRule.id, resource: 'AccessRule' },
        message: `AccessRule not found: ${fixture.accessRule.id}`,
        requestId: expect.any(String),
      },
    });
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
        expect(response.json()).toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
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
        after: {
          ...redactBatchAccessRules(existingBatch),
          inventoryPool: null,
        },
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
        after: {
          ...redactBatchAccessRules(newPoolBatch),
          inventoryPool: serializedBatchPool,
        },
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

  it('updates every ticket-type field with scoped related records, one revision, and exact audit evidence', async () => {
    const ticket = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Complete ticket-type update',
    );
    const updatePool = await seedPool(eventA, 'Updated ticket pool');
    const updateOccurrence = await seedOccurrence(eventA, 'Updated ticket occurrence');
    const before = await evidenceSnapshot();
    const beforeTicket = serializeTicketType(
      before.ticketTypes.find((row) => row.id === ticket.ticketType.id) as Record<string, unknown>,
    );

    const response = await invokeTicketUpdate(ticket.ticketType.id, updatePool, updateOccurrence);
    expect(response.statusCode, response.body).toBe(200);
    const updated = response.json();
    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 1);
    expect(
      serializeTicketType(
        after.ticketTypes.find((row) => row.id === ticket.ticketType.id) as Record<string, unknown>,
      ),
    ).toEqual(updated);
    const { accessCodeHint: _accessCodeHint, ...expectedUpdated } = ticketUpdatePayload(
      updatePool,
      updateOccurrence,
    );
    expect(updated).toMatchObject(expectedUpdated);
    expect(
      after.ticketTypes.find((row) => row.id === ticket.ticketType.id)?.access_code_hint,
    ).toBeNull();
    expect(ticketConfigurationCheckpoint).toHaveBeenNthCalledWith(1, {
      stage: 'before_transaction',
      operation: 'ticket_type_update',
      eventId: eventA,
    });
    expect(ticketConfigurationCheckpoint).toHaveBeenNthCalledWith(2, {
      stage: 'before_lock',
      operation: 'ticket_type_update',
      eventId: eventA,
    });
    expect(ticketConfigurationCheckpoint).toHaveBeenNthCalledWith(3, {
      stage: 'after_lock',
      operation: 'ticket_type_update',
      eventId: eventA,
    });
    const audit = after.audits.find((row) => row.resource_id === ticket.ticketType.id)!;
    expect(audit).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_id: actorId,
      action: 'ticket_type.updated',
      resource_type: 'TicketType',
      resource_id: ticket.ticketType.id,
    });
    expect(auditDiff(audit.diff_summary)).toEqual({
      eventId: eventA,
      before: beforeTicket,
      after: updated,
    });
  });

  it('rejects foreign ticket-type pool and occurrence reassignment without partial persistence', async () => {
    const ticket = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Foreign ticket-type update',
    );
    const before = await evidenceSnapshot();
    const responses = [
      await invokeTicketUpdate(ticket.ticketType.id, poolAScoped, occurrenceA),
      await invokeTicketUpdate(ticket.ticketType.id, poolA, occurrenceAScoped),
    ];
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('rolls back ticket-type update and revision when its audit write fails, then permits a clean retry', async () => {
    const ticket = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Audit rollback ticket-type update',
    );
    const before = await evidenceSnapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected ticket-type update audit failure'));
    try {
      const failed = await invokeTicketUpdate(ticket.ticketType.id, poolA, occurrenceA);
      expect(failed.statusCode, failed.body).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeTicketUpdate(ticket.ticketType.id, poolA, occurrenceA);
    expect(retry.statusCode, retry.body).toBe(200);
    const after = await evidenceSnapshot();
    expectEventDelta(before, after, eventA, 1);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]?.action).toBe('ticket_type.updated');
  });

  it('serializes a reservation-first pool reassignment race without a stale mapping or deadlock', async () => {
    const ticket = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Reservation-first update',
    );
    const replacementPool = await seedPool(eventA, 'Reservation-first replacement pool');
    const checkoutSessionId = `cs_${ulid()}`;
    const reservationLocked = deferred();
    const releaseReservation = deferred();
    const updateAtBeforeLock = deferred();
    const releaseUpdateBeforeLock = deferred();
    let patchReachedAfterLock = false;
    ticketConfigurationCheckpoint.mockImplementation(async (input) => {
      if (input.stage === 'after_lock') {
        patchReachedAfterLock = true;
        return;
      }
      if (input.stage === 'before_lock') {
        expect(input).toEqual({
          stage: 'before_lock',
          operation: 'ticket_type_update',
          eventId: eventA,
        });
        updateAtBeforeLock.resolve();
        await releaseUpdateBeforeLock.promise;
      }
    });
    const inventory = new InventoryService(db, async (input) => {
      if (input.stage !== 'after_ticket_type_locks') return;
      expect(input).toEqual({
        stage: 'after_ticket_type_locks',
        checkoutSessionId,
      });
      reservationLocked.resolve();
      await releaseReservation.promise;
    });

    const reservation = inventory.reserveCart({
      items: [
        {
          inventoryPoolId: poolA,
          ticketTypeId: ticket.ticketType.id,
          occurrenceId: occurrenceA,
          quantity: 1,
        },
      ],
      checkoutSessionId,
    });
    await reservationLocked.promise;
    const update = invokeTicketUpdate(ticket.ticketType.id, replacementPool, occurrenceA);
    await updateAtBeforeLock.promise;
    await expectPoolWriteLocked(poolA);
    releaseUpdateBeforeLock.resolve();
    await expectOccurrenceWriteLocked(occurrenceA);
    expect(patchReachedAfterLock).toBe(false);
    releaseReservation.resolve();

    await expect(reservation).resolves.toMatchObject({
      primaryHoldId: expect.any(String),
    });
    const updateResponse = await update;
    expect(updateResponse.statusCode, updateResponse.body).toBe(400);
    expect(updateResponse.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    const current = await new TicketTypeRepository(db).findById(ticket.ticketType.id);
    expect(current?.inventory_pool_id).toBe(poolA);
    const holds = await db
      .selectFrom('checkout_holds')
      .select(['inventory_pool_id', 'ticket_type_id', 'event_occurrence_id'])
      .where('checkout_session_id', '=', checkoutSessionId)
      .execute();
    expect(holds).toEqual([
      {
        inventory_pool_id: poolA,
        ticket_type_id: ticket.ticketType.id,
        event_occurrence_id: occurrenceA,
      },
    ]);
  });

  it('rejects a stale reservation after a pool reassignment commits without creating a hold', async () => {
    const ticket = await seedAccessRuleFixture(eventA, poolA, occurrenceA, 'Patch-first update');
    const replacementPool = await seedPool(eventA, 'Patch-first replacement pool');
    const checkoutSessionId = `cs_${ulid()}`;
    const patchLocked = deferred();
    const releasePatch = deferred();
    ticketConfigurationCheckpoint.mockImplementation(async (input) => {
      if (input.stage !== 'after_lock') return;
      expect(input).toEqual({
        stage: 'after_lock',
        operation: 'ticket_type_update',
        eventId: eventA,
      });
      patchLocked.resolve();
      await releasePatch.promise;
    });

    const update = invokeTicketUpdate(ticket.ticketType.id, replacementPool, occurrenceA);
    await patchLocked.promise;
    const reservationAtBeforePoolLocks = deferred();
    const releaseReservationBeforePoolLocks = deferred();
    let reservationReachedTicketTypeLocks = false;
    const reservation = new InventoryService(db, async (input) => {
      if (input.stage === 'after_ticket_type_locks') {
        reservationReachedTicketTypeLocks = true;
        return;
      }
      expect(input).toEqual({
        stage: 'before_pool_locks',
        checkoutSessionId,
      });
      reservationAtBeforePoolLocks.resolve();
      await releaseReservationBeforePoolLocks.promise;
    }).reserveCart({
      items: [
        {
          inventoryPoolId: poolA,
          ticketTypeId: ticket.ticketType.id,
          occurrenceId: occurrenceA,
          quantity: 1,
        },
      ],
      checkoutSessionId,
    });
    await reservationAtBeforePoolLocks.promise;
    await expectPoolWriteLocked(replacementPool);
    expect(reservationReachedTicketTypeLocks).toBe(false);
    releaseReservationBeforePoolLocks.resolve();
    await expectOccurrenceWriteLocked(occurrenceA);
    expect(reservationReachedTicketTypeLocks).toBe(false);
    releasePatch.resolve();

    const updateResponse = await update;
    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    await expect(reservation).rejects.toThrow('inventory configuration changed');
    const current = await new TicketTypeRepository(db).findById(ticket.ticketType.id);
    expect(current?.inventory_pool_id).toBe(replacementPool);
    const holds = await db
      .selectFrom('checkout_holds')
      .select('id')
      .where('checkout_session_id', '=', checkoutSessionId)
      .execute();
    expect(holds).toEqual([]);
  });

  it('serializes same-pool and occurrence reservation/update contention without a timeout', async () => {
    const ticket = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Same mapping contention',
    );
    const checkoutSessionId = `cs_${ulid()}`;
    const reservationLocked = deferred();
    const releaseReservation = deferred();
    const inventory = new InventoryService(db, async (input) => {
      // The reservation hook runs twice; only the post-ticket lock stage is
      // used to establish contention with the PATCH route.
      if (input.stage !== 'after_ticket_type_locks') return;
      reservationLocked.resolve();
      await releaseReservation.promise;
    });
    const reservation = inventory.reserveCart({
      items: [
        {
          inventoryPoolId: poolA,
          ticketTypeId: ticket.ticketType.id,
          occurrenceId: occurrenceA,
          quantity: 1,
        },
      ],
      checkoutSessionId,
    });
    await reservationLocked.promise;
    const update = invokeTicketUpdate(ticket.ticketType.id, poolA, occurrenceA);
    releaseReservation.resolve();
    await expect(reservation).resolves.toMatchObject({
      primaryHoldId: expect.any(String),
    });
    const updateResponse = await update;
    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
  });

  it.each([
    [
      'tenant reparent',
      async (_ticketTypeId: string) => {
        await db
          .updateTable('events')
          .set({ tenant_id: tenantB })
          .where('id', '=', eventA)
          .execute();
      },
      async () => {
        await db
          .updateTable('events')
          .set({ tenant_id: tenantA })
          .where('id', '=', eventA)
          .execute();
      },
    ],
    [
      'ticket event reparent',
      async (ticketTypeId: string) => {
        await db
          .updateTable('ticket_types')
          .set({ event_id: eventAScoped })
          .where('id', '=', ticketTypeId)
          .execute();
      },
      async (ticketTypeId: string) => {
        await db
          .updateTable('ticket_types')
          .set({ event_id: eventA })
          .where('id', '=', ticketTypeId)
          .execute();
      },
    ],
  ] as const)('conceals a ticket type after a commit-time %s', async (_case, reparent, restore) => {
    const ticket = await seedAccessRuleFixture(eventA, poolA, occurrenceA, `Reparent ${_case}`);
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    ticketConfigurationCheckpoint.mockImplementationOnce(async (input) => {
      expect(input).toEqual({
        stage: 'before_transaction',
        operation: 'ticket_type_update',
        eventId: eventA,
      });
      await reparent(ticket.ticketType.id);
      checkpointSnapshot = await evidenceSnapshot();
    });

    try {
      const response = await invokeTicketUpdate(ticket.ticketType.id, poolA, occurrenceA);
      expectTicketTypeConcealed(response, ticket.ticketType.id);
      expect(checkpointSnapshot).toBeDefined();
      await expect(evidenceSnapshot()).resolves.toEqual(checkpointSnapshot);
    } finally {
      await restore(ticket.ticketType.id);
    }
  });

  it('rechecks ticket-type scope after a checkpoint reparent and conceals the ticket type', async () => {
    const ticket = await seedAccessRuleFixture(
      eventA,
      poolA,
      occurrenceA,
      'Reparent ticket-type update',
    );
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    ticketConfigurationCheckpoint.mockImplementationOnce(async (input) => {
      expect(input).toEqual({
        stage: 'before_transaction',
        operation: 'ticket_type_update',
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
      const response = await invokeTicketUpdate(ticket.ticketType.id, poolA, occurrenceA);
      expectTicketTypeConcealed(response, ticket.ticketType.id);
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
          .set({
            organization_id: organizationAScoped,
            brand_id: brandAScoped,
          })
          .where('id', '=', eventA)
          .execute();
        checkpointSnapshot = await evidenceSnapshot();
      });

      try {
        const response = await invoke(fixture);
        expect(response.statusCode, response.body).toBe(404);
        expect(response.json()).toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
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
    'denies the %s boundary for both reads and all four writes with exact snapshots',
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
      const targetTicket = await seedAccessRuleFixture(
        eventId,
        targetPool,
        targetOccurrence,
        `Forbidden ${_boundary} ticket-type update`,
      );
      const before = await evidenceSnapshot();
      const poolQuery = vi.spyOn(InventoryPoolRepository.prototype, 'findByEvent');
      const ticketQuery = vi.spyOn(TicketTypeRepository.prototype, 'findByEvent');

      try {
        const readResponses = [await invokePoolRead(eventId), await invokeTicketRead(eventId)];
        expect(poolQuery).not.toHaveBeenCalled();
        expect(ticketQuery).not.toHaveBeenCalled();
        for (const response of readResponses) {
          expect(response.json()).not.toHaveProperty('items');
        }
        const responses = [
          ...readResponses,
          await invokePool(eventId, 'Forbidden pool'),
          await invokeTicket(eventId, targetPool, targetOccurrence, 'Forbidden ticket'),
          await invokeBatchWithExistingPool(
            eventId,
            targetPool,
            targetOccurrence,
            'Forbidden batch ticket',
          ),
          await invokeTicketUpdate(targetTicket.ticketType.id, targetPool, targetOccurrence),
        ];
        for (const response of responses) {
          expect(response.statusCode, response.body).toBe(status);
          expect(response.json()).toMatchObject({ error: { code } });
          expect(response.body).not.toContain(targetPool);
          expect(response.body).not.toContain('Allowed ticket pool');
          expect(response.body).not.toContain('Scoped ticket pool');
          expect(response.body).not.toContain('Foreign ticket pool');
        }
        if (status === 404) {
          expectTicketTypeConcealed(responses.at(-1)!, targetTicket.ticketType.id);
        } else {
          expect(ticketConfigurationCheckpoint).not.toHaveBeenCalled();
        }
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      } finally {
        poolQuery.mockRestore();
        ticketQuery.mockRestore();
      }
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
          .set({
            organization_id: organizationAScoped,
            brand_id: brandAScoped,
          })
          .where('id', '=', eventA)
          .execute();
        checkpointSnapshot = await evidenceSnapshot();
      });

      try {
        const response = await invoke();
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({
          error: { code: 'NOT_FOUND' },
        });
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
        const redactedResponses = responseBodies.map((response) =>
          redactBatchAccessRules(response),
        );
        expect(auditedResponses).toEqual(expect.arrayContaining(redactedResponses));
        for (const response of responseBodies) {
          for (const rule of response.accessRules as Array<{
            value: string;
          }>) {
            expect(JSON.stringify(auditAfters)).not.toContain(rule.value);
          }
        }
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
