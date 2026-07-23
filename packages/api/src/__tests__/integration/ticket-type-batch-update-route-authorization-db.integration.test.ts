import Fastify, { type FastifyInstance } from 'fastify';
import {
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
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import { InventoryService } from '../../services/inventory.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_tt_batch_a_${suffix}`;
const tenantB = `tnt_tt_batch_b_${suffix}`;
const organizationA = `org_tt_batch_a_${suffix}`;
const organizationB = `org_tt_batch_b_${suffix}`;
const brandA = `brd_tt_batch_a_${suffix}`;
const brandB = `brd_tt_batch_b_${suffix}`;
const actorId = `usr_tt_batch_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let principal: Principal;
let ticketTypeA: string;
let ticketTypeB: string;
let eventA: string;
let eventB: string;
let poolA: string;
let poolB: string;
let occurrenceA: string;
let occurrenceB: string;
let beforeTransaction: (() => Promise<void>) | undefined;
let beforeLock: (() => Promise<void>) | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function seedScope(tenantId: string, organizationId: string, brandId: string, title: string) {
  const now = new Date('2026-07-22T00:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({
      id: tenantId,
      name: tenantId,
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
      name: organizationId,
      slug: `${organizationId}-slug`,
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: brandId,
      tenant_id: tenantId,
      organization_id: organizationId,
      name: brandId,
      slug: `${brandId}-slug`,
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
  const event = await new EventRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    slug: `${title.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
    title,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
  });
  const pool = await new InventoryPoolRepository(db).create({
    eventId: event.id,
    name: `${title} pool`,
    totalCapacity: 100,
  });
  const ticketType = await new TicketTypeRepository(db).create({
    eventId: event.id,
    name: `${title} ticket`,
    kind: 'paid',
    currency: 'USD',
    priceCents: 2500,
    inventoryPoolId: pool.id,
    minPerOrder: 1,
    maxPerOrder: 4,
  });
  const occurrence = await new EventOccurrenceRepository(db).create({
    eventId: event.id,
    title: `${title} occurrence`,
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
    endsAt: new Date('2027-01-01T20:00:00.000Z'),
    timezone: 'UTC',
    venue: { name: `${title} hall` },
    capacity: 100,
    sortOrder: 1,
    status: 'scheduled',
  });
  return {
    eventId: event.id,
    ticketTypeId: ticketType.id,
    poolId: pool.id,
    occurrenceId: occurrence.id,
  };
}

async function invoke(ticketTypeId: string, payload: unknown) {
  return app.inject({
    method: 'PATCH',
    url: `/ticket-types/${ticketTypeId}/batch`,
    payload: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
  });
}

describeWithIntegrationDatabase('PATCH /ticket-types/:ticketTypeId/batch authorization', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const a = await seedScope(tenantA, organizationA, brandA, 'Batch authorization A');
    const b = await seedScope(tenantB, organizationB, brandB, 'Batch authorization B');
    ticketTypeA = a.ticketTypeId;
    ticketTypeB = b.ticketTypeId;
    eventA = a.eventId;
    eventB = b.eventId;
    poolA = a.poolId;
    poolB = b.poolId;
    occurrenceA = a.occurrenceId;
    occurrenceB = b.occurrenceId;
    principal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      ticketConfigurationCheckpoint: async (input) => {
        if (
          input.operation === 'ticket_type_batch_update' &&
          input.stage === 'before_transaction'
        ) {
          await beforeTransaction?.();
        }
        if (input.operation === 'ticket_type_batch_update' && input.stage === 'before_lock') {
          await beforeLock?.();
        }
      },
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(ticketingRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    principal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    beforeTransaction = undefined;
    beforeLock = undefined;
    await db.deleteFrom('audit_logs').where('actor_id', '=', actorId).execute();
    await db.deleteFrom('access_rules').where('ticket_type_id', '=', ticketTypeA).execute();
    await db
      .updateTable('ticket_types')
      .set({
        event_id: eventA,
        name: 'Batch authorization A ticket',
        min_per_order: 1,
        max_per_order: 4,
      })
      .where('id', '=', ticketTypeA)
      .execute();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('conceals missing and foreign ticket types before parsing malformed bodies', async () => {
    const missing = await invoke(`tt_${ulid()}`, { ticketType: { minPerOrder: 0 }, unknown: true });
    const foreign = await invoke(ticketTypeB, { ticketType: { minPerOrder: 0 }, unknown: true });
    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({
      code: 'NOT_FOUND',
      details: { resource: 'TicketType' },
    });
    expect(foreign.json().error).toMatchObject({
      code: 'NOT_FOUND',
      details: { resource: 'TicketType' },
    });
  });

  it('uses the TicketType concealment contract for tenant, organization, brand, and event scope denials', async () => {
    const malformedPayload = { ticketType: { minPerOrder: 0 }, unknown: true };
    const deniedPrincipals: Principal[] = [
      { ...principal, tenantId: tenantB },
      { ...principal, organizationIds: [`org_unrelated_${suffix}`] },
      { ...principal, brandIds: [`brd_unrelated_${suffix}`] },
      { ...principal, eventIds: [`evt_unrelated_${suffix}`] },
    ];

    for (const deniedPrincipal of deniedPrincipals) {
      principal = deniedPrincipal;
      const response = await invoke(ticketTypeA, malformedPayload);
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: 'NOT_FOUND', details: { resource: 'TicketType' } },
      });
    }
  });

  it('allows equivalent user, API-key, and system principals while enforcing narrowed event scope', async () => {
    const authorizedPrincipals: Principal[] = [
      principal,
      { ...principal, type: 'api_key', id: `key_tt_batch_${suffix}` },
      {
        ...principal,
        type: 'system',
        id: `sys_tt_batch_${suffix}`,
        organizationIds: [],
        brandIds: [],
        eventIds: [],
      },
    ];

    for (const authorizedPrincipal of authorizedPrincipals) {
      principal = authorizedPrincipal;
      const response = await invoke(ticketTypeA, { ticketType: {} });
      expect(response.statusCode, response.body).toBe(200);
    }

    principal = { ...principal, type: 'api_key', eventIds: [eventB] };
    const denied = await invoke(ticketTypeA, { ticketType: {} });
    expect(denied.statusCode, denied.body).toBe(404);
    expect(denied.json()).toMatchObject({
      error: { code: 'NOT_FOUND', details: { resource: 'TicketType' } },
    });
  });

  it('atomically updates, advances public revision, and audits without rule values', async () => {
    const before = await db
      .selectFrom('events')
      .select(['version', 'public_revision'])
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    const response = await invoke(ticketTypeA, {
      ticketType: { name: 'Updated batch ticket', minPerOrder: 2, maxPerOrder: 5 },
      accessRules: [{ type: 'code', value: 'DO-NOT-AUDIT-THIS', maxUses: 3 }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().ticketType.name).toBe('Updated batch ticket');
    expect(response.json().accessRules).toHaveLength(1);
    const after = await db
      .selectFrom('events')
      .select(['version', 'public_revision'])
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(Number(after.version)).toBe(Number(before.version) + 1);
    expect(new Date(after.public_revision!).getTime()).toBeGreaterThan(
      new Date(before.public_revision!).getTime(),
    );
    const audit = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_type', '=', 'TicketType')
      .where('resource_id', '=', ticketTypeA)
      .execute();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].diff_summary)).not.toContain('DO-NOT-AUDIT-THIS');
  });

  it('rejects invalid locked full order state and normalized duplicate rules without writes', async () => {
    const invalid = await invoke(ticketTypeA, { ticketType: { minPerOrder: 5 } });
    expect(invalid.statusCode).toBe(400);
    const first = await invoke(ticketTypeA, {
      ticketType: {},
      accessRules: [{ type: 'email_domain', value: ' @Example.COM ' }],
    });
    expect(first.statusCode, first.body).toBe(200);
    const duplicate = await invoke(ticketTypeA, {
      ticketType: {},
      accessRules: [{ type: 'email_domain', value: 'example.com' }],
    });
    expect(duplicate.statusCode).toBe(400);
    const rules = await db
      .selectFrom('access_rules')
      .selectAll()
      .where('ticket_type_id', '=', ticketTypeA)
      .execute();
    expect(rules).toHaveLength(1);
  });

  it('returns the locked current state without revision or audit changes for a true no-op', async () => {
    const beforeEvent = await db
      .selectFrom('events')
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select(['events.version', 'events.public_revision'])
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    const response = await invoke(ticketTypeA, { ticketType: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().ticketType.name).toBe('Batch authorization A ticket');
    const afterEvent = await db
      .selectFrom('events')
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select(['events.version', 'events.public_revision'])
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(afterEvent).toEqual(beforeEvent);
    const audits = await db
      .selectFrom('audit_logs')
      .select('id')
      .where('actor_id', '=', actorId)
      .execute();
    expect(audits).toHaveLength(0);
  });

  it('advances exactly one revision and creates a redacted audit entry for an access-rule-only update', async () => {
    const before = await db
      .selectFrom('events')
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select(['events.version', 'events.public_revision', 'ticket_types.name'])
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    const response = await invoke(ticketTypeA, {
      ticketType: {},
      accessRules: [{ type: 'code', value: 'RULE-ONLY-SECRET', maxUses: 2 }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().ticketType.name).toBe(before.name);
    expect(response.json().accessRules).toHaveLength(1);

    const after = await db
      .selectFrom('events')
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select(['events.version', 'events.public_revision', 'ticket_types.name'])
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(Number(after.version)).toBe(Number(before.version) + 1);
    expect(new Date(after.public_revision!).getTime()).toBeGreaterThan(
      new Date(before.public_revision!).getTime(),
    );
    expect(after.name).toBe(before.name);
    const audit = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_type', '=', 'TicketType')
      .where('resource_id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(audit.action).toBe('ticket_type.batch_updated');
    expect(JSON.stringify(audit.diff_summary)).not.toContain('RULE-ONLY-SECRET');
  });

  it('rejects request amplification and permission denial before body parsing', async () => {
    const oversized = await invoke(ticketTypeA, {
      ticketType: {},
      accessRules: Array.from({ length: 101 }, (_, index) => ({
        type: 'code',
        value: `CODE-${index}`,
      })),
    });
    expect(oversized.statusCode).toBe(400);
    principal = { ...principal, scopes: [] };
    const denied = await invoke(ticketTypeA, { ticketType: {}, unknown: true });
    expect(denied.statusCode).toBe(403);
  });

  it('accepts the exact per-request access-rule cap and rejects no-write foreign relation mappings', async () => {
    const capped = await invoke(ticketTypeA, {
      ticketType: {},
      accessRules: Array.from({ length: 100 }, (_, index) => ({
        type: 'code',
        value: `CAP-${index}`,
      })),
    });
    expect(capped.statusCode, capped.body).toBe(200);
    expect(capped.json().accessRules).toHaveLength(100);

    await db.deleteFrom('access_rules').where('ticket_type_id', '=', ticketTypeA).execute();
    const before = await db
      .selectFrom('ticket_types')
      .select(['inventory_pool_id', 'event_occurrence_id'])
      .where('id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    const responses = await Promise.all([
      invoke(ticketTypeA, { ticketType: { inventoryPoolId: poolB } }),
      invoke(ticketTypeA, { ticketType: { eventOccurrenceId: occurrenceB } }),
    ]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    const after = await db
      .selectFrom('ticket_types')
      .select(['inventory_pool_id', 'event_occurrence_id'])
      .where('id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('serializes concurrent normalized duplicate additions so exactly one request succeeds', async () => {
    const [first, second] = await Promise.all([
      invoke(ticketTypeA, {
        ticketType: {},
        accessRules: [{ type: 'email_domain', value: ' @Example.COM ' }],
      }),
      invoke(ticketTypeA, {
        ticketType: {},
        accessRules: [{ type: 'email_domain', value: 'example.com' }],
      }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
    const rules = await db
      .selectFrom('access_rules')
      .select(['type', 'value'])
      .where('ticket_type_id', '=', ticketTypeA)
      .execute();
    expect(rules).toEqual([{ type: 'email_domain', value: 'example.com' }]);
  });

  it('serializes a two-pool checkout-first race without deadlock or stale mappings', async () => {
    const secondPool = await new InventoryPoolRepository(db).create({
      eventId: eventA,
      name: `Batch race pool ${ulid()}`,
      totalCapacity: 100,
    });
    const secondTicket = await new TicketTypeRepository(db).create({
      eventId: eventA,
      name: `Batch race ticket ${ulid()}`,
      kind: 'paid',
      currency: 'USD',
      priceCents: 3000,
      inventoryPoolId: secondPool.id,
      eventOccurrenceId: occurrenceA,
      minPerOrder: 1,
      maxPerOrder: 4,
    });
    const checkoutSessionId = `cs_${ulid()}`;
    const reservationLocked = deferred();
    const releaseReservation = deferred();
    const batchAtBeforeLock = deferred();
    beforeLock = async () => batchAtBeforeLock.resolve();
    const reservation = new InventoryService(db, async (input) => {
      if (input.stage !== 'after_ticket_type_locks') return;
      reservationLocked.resolve();
      await releaseReservation.promise;
    }).reserveCart({
      items: [
        {
          inventoryPoolId: secondPool.id,
          ticketTypeId: secondTicket.id,
          occurrenceId: occurrenceA,
          quantity: 1,
        },
        {
          inventoryPoolId: poolA,
          ticketTypeId: ticketTypeA,
          quantity: 1,
        },
      ],
      checkoutSessionId,
    });
    await reservationLocked.promise;
    let updateSettled = false;
    const update = invoke(ticketTypeA, { ticketType: {} }).finally(() => {
      updateSettled = true;
    });
    await batchAtBeforeLock.promise;
    await Promise.resolve();
    expect(updateSettled).toBe(false);
    releaseReservation.resolve();

    await expect(reservation).resolves.toMatchObject({ holds: expect.any(Array) });
    const updateResponse = await update;
    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    const holds = await db
      .selectFrom('checkout_holds')
      .select(['inventory_pool_id', 'ticket_type_id'])
      .where('checkout_session_id', '=', checkoutSessionId)
      .orderBy('inventory_pool_id', 'asc')
      .execute();
    expect(holds).toHaveLength(2);
    expect(new Set(holds.map((hold) => hold.inventory_pool_id))).toEqual(
      new Set([poolA, secondPool.id]),
    );
  });

  it('rolls back the ticket, revision, rules, and audit atomically when audit persistence fails', async () => {
    const beforeEvent = await db
      .selectFrom('events')
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select(['events.version', 'events.public_revision', 'ticket_types.name'])
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected batch update audit failure'));
    try {
      const failed = await invoke(ticketTypeA, {
        ticketType: { name: 'must roll back' },
        accessRules: [{ type: 'code', value: 'MUST-ROLL-BACK' }],
      });
      expect(failed.statusCode, failed.body).toBe(500);
    } finally {
      failure.mockRestore();
    }
    const afterFailure = await db
      .selectFrom('events')
      .innerJoin('ticket_types', 'ticket_types.event_id', 'events.id')
      .select(['events.version', 'events.public_revision', 'ticket_types.name'])
      .where('ticket_types.id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(afterFailure).toEqual(beforeEvent);
    await expect(
      db
        .selectFrom('access_rules')
        .select('id')
        .where('ticket_type_id', '=', ticketTypeA)
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      db.selectFrom('audit_logs').select('id').where('resource_id', '=', ticketTypeA).execute(),
    ).resolves.toEqual([]);

    const retry = await invoke(ticketTypeA, {
      ticketType: { name: 'must roll back' },
      accessRules: [{ type: 'code', value: 'MUST-ROLL-BACK' }],
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().ticketType.name).toBe('must roll back');
    expect(retry.json().accessRules).toHaveLength(1);
  });

  it('fails closed when the ticket is reparented after preflight and before the event lock', async () => {
    beforeTransaction = async () => {
      await db
        .updateTable('ticket_types')
        .set({ event_id: eventB })
        .where('id', '=', ticketTypeA)
        .execute();
    };
    const response = await invoke(ticketTypeA, { ticketType: { name: 'must not persist' } });
    expect(response.statusCode).toBe(404);
    const moved = await db
      .selectFrom('ticket_types')
      .select(['event_id', 'name'])
      .where('id', '=', ticketTypeA)
      .executeTakeFirstOrThrow();
    expect(moved).toEqual({ event_id: eventB, name: 'Batch authorization A ticket' });
  });
});
