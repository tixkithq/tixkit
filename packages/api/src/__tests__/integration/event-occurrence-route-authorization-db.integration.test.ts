import Fastify, { type FastifyInstance } from 'fastify';
import {
  AuditLogRepository,
  createDb,
  EventOccurrenceRepository,
  EventRepository,
  type Database,
} from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { serializeEventOccurrence } from '../../http/contracts.js';
import { eventRoutes } from '../../routes/modules/events.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function occurrenceContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) throw new Error(`event occurrence authorization contract ${operationId} missing`);
  return contract;
}

const createContract = occurrenceContract('postEventsByEventIdOccurrences');
const updateContract = occurrenceContract('patchEventsByEventIdOccurrencesByOccurrenceId');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_occ_auth_a_${suffix}`;
const tenantB = `tnt_occ_auth_b_${suffix}`;
const organizationA = `org_occ_auth_a_${suffix}`;
const organizationAScoped = `org_occ_auth_scope_${suffix}`;
const organizationB = `org_occ_auth_b_${suffix}`;
const brandA = `brd_occ_auth_a_${suffix}`;
const brandAScoped = `brd_occ_auth_scope_${suffix}`;
const brandB = `brd_occ_auth_b_${suffix}`;
const actorId = `usr_occ_auth_${suffix}`;

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

const eventOccurrenceCheckpoint = vi.fn(
  async (_input: {
    stage: 'before_transaction';
    operation: 'create' | 'update';
    eventId: string;
    occurrenceId?: string;
  }) => undefined,
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
    venue: { name: 'Occurrence authorization hall' },
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
    capacity: 100,
    sortOrder: 1,
    status: 'scheduled',
  });
  return occurrence.id;
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearOccurrenceEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', 'in', ['event_occurrence.created', 'event_occurrence.updated'])
    .execute();
  await db
    .deleteFrom('event_occurrences')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
}

async function seedBaselineOccurrences(): Promise<void> {
  occurrenceA = await seedOccurrence(eventA, 'Allowed occurrence');
  occurrenceAScoped = await seedOccurrence(eventAScoped, 'Scoped occurrence');
  occurrenceB = await seedOccurrence(eventB, 'Foreign occurrence');
}

async function evidenceSnapshot() {
  const [events, occurrences, audits] = await Promise.all([
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
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', 'in', ['event_occurrence.created', 'event_occurrence.updated'])
      .orderBy('id')
      .execute(),
  ]);
  return { events, occurrences, audits };
}

function createPayload(title = 'Created occurrence') {
  return {
    title,
    startsAt: '2027-03-01T18:00:00.000Z',
    endsAt: '2027-03-01T21:00:00.000Z',
    timezone: 'America/Chicago',
    venue: { name: 'Created hall', city: 'Chicago' },
    capacity: 275,
    sortOrder: 4,
    status: 'scheduled',
  };
}

function updatePayload(title = 'Updated occurrence') {
  return {
    title,
    startsAt: '2027-04-01T19:00:00.000Z',
    endsAt: '2027-04-01T22:00:00.000Z',
    timezone: 'America/New_York',
    venue: { name: 'Updated hall', city: 'New York' },
    capacity: 325,
    sortOrder: 7,
    status: 'completed',
  };
}

function invokeCreate(targetEventId: string, title?: string) {
  return app.inject({
    method: createContract.method,
    url: createContract.path.replace('{eventId}', targetEventId),
    payload: createPayload(title),
  });
}

function invokeUpdate(targetEventId: string, targetOccurrenceId: string, title?: string) {
  return app.inject({
    method: updateContract.method,
    url: updateContract.path
      .replace('{eventId}', targetEventId)
      .replace('{occurrenceId}', targetOccurrenceId),
    payload: updatePayload(title),
  });
}

describeWithIntegrationDatabase('event occurrence write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Occurrence authorization tenant A');
    await insertTenant(tenantB, 'Occurrence authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Occurrence authorization org A');
    await insertOrganization(organizationAScoped, tenantA, 'Occurrence authorization scoped org');
    await insertOrganization(organizationB, tenantB, 'Occurrence authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Occurrence authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Occurrence authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Occurrence authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed occurrence event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped occurrence event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign occurrence event');

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
      eventOccurrenceCheckpoint: (input: {
        stage: 'before_transaction';
        operation: 'create' | 'update';
        eventId: string;
        occurrenceId?: string;
      }) => eventOccurrenceCheckpoint(input),
    } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(eventRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    activePrincipal = basePrincipal;
    eventOccurrenceCheckpoint.mockReset();
    eventOccurrenceCheckpoint.mockResolvedValue(undefined);
    await clearOccurrenceEvidence();
    await seedBaselineOccurrences();
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
      await cleanup(clearOccurrenceEvidence);
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
      throw new AggregateError(cleanupErrors, 'Failed to clean up occurrence authorization proof');
    }
  });

  it('binds both immutable route contracts to this executable proof', () => {
    expect(createContract).toMatchObject({
      authorizedControl: { status: 201 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      source: 'event-occurrence-route-authorization-db.integration.test.ts',
    });
    expect(updateContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      source: 'event-occurrence-route-authorization-db.integration.test.ts',
    });
  });

  it('creates and patches the exact occurrence with exact atomic audit evidence', async () => {
    const beforeCreate = await evidenceSnapshot();
    const eventBeforeCreate = beforeCreate.events.find((event) => event.id === eventA)!;
    const createResponse = await invokeCreate(eventA);
    expect(createResponse.statusCode, createResponse.body).toBe(201);
    expect(createResponse.json()).toMatchObject({ eventId: eventA, ...createPayload() });

    const created = createResponse.json();
    const afterCreate = await evidenceSnapshot();
    const eventAfterCreate = afterCreate.events.find((event) => event.id === eventA)!;
    expect(Number(eventAfterCreate.version)).toBe(Number(eventBeforeCreate.version) + 1);
    expect(revisionMillis(eventAfterCreate.public_revision)).toBeGreaterThan(
      revisionMillis(eventBeforeCreate.public_revision),
    );
    const createdRow = afterCreate.occurrences.find((row) => row.id === created.id);
    expect(serializeEventOccurrence(createdRow as Record<string, unknown>)).toEqual(created);
    expect(afterCreate.audits).toHaveLength(1);
    expect(afterCreate.audits[0]).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_id: actorId,
      action: 'event_occurrence.created',
      resource_type: 'EventOccurrence',
      resource_id: created.id,
    });
    expect(auditDiff(afterCreate.audits[0]!.diff_summary)).toEqual({
      eventId: eventA,
      after: created,
    });

    const updateResponse = await invokeUpdate(eventA, created.id);
    expect(updateResponse.statusCode, updateResponse.body).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      eventId: eventA,
      ...updatePayload(),
    });
    const updated = updateResponse.json();
    const afterUpdate = await evidenceSnapshot();
    const eventAfterUpdate = afterUpdate.events.find((event) => event.id === eventA)!;
    expect(Number(eventAfterUpdate.version)).toBe(Number(eventAfterCreate.version) + 1);
    expect(revisionMillis(eventAfterUpdate.public_revision)).toBeGreaterThan(
      revisionMillis(eventAfterCreate.public_revision),
    );
    expect(
      serializeEventOccurrence(
        afterUpdate.occurrences.find((row) => row.id === created.id) as Record<string, unknown>,
      ),
    ).toEqual(updated);
    expect(afterUpdate.audits).toHaveLength(2);
    const updateAudit = afterUpdate.audits.find(
      (audit) => audit.action === 'event_occurrence.updated',
    );
    expect(updateAudit).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_id: actorId,
      resource_type: 'EventOccurrence',
      resource_id: created.id,
    });
    expect(auditDiff(updateAudit!.diff_summary)).toEqual({
      eventId: eventA,
      before: created,
      after: updated,
    });
  });

  describe.each([
    ['create', () => invokeCreate(eventA)],
    ['update', () => invokeUpdate(eventA, occurrenceA)],
  ] as const)('%s audit transaction', (_operation, invoke) => {
    it('rolls back on audit failure and permits an exact clean retry', async () => {
      const before = await evidenceSnapshot();
      const failure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('injected occurrence audit failure'));
      try {
        const failed = await invoke();
        expect(failed.statusCode).toBe(500);
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      } finally {
        failure.mockRestore();
      }

      const retry = await invoke();
      expect(retry.statusCode, retry.body).toBe(_operation === 'create' ? 201 : 200);
      const afterRetry = await evidenceSnapshot();
      expect(afterRetry.audits).toHaveLength(1);
      expect(afterRetry.audits[0]?.action).toBe(
        _operation === 'create' ? 'event_occurrence.created' : 'event_occurrence.updated',
      );
    });
  });

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
    'denies the %s boundary for create and patch with exact occurrence and audit snapshots',
    async (_boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const eventId = targetEvent();
      const targetOccurrence =
        eventId === eventA
          ? occurrenceA
          : eventId === eventAScoped
            ? occurrenceAScoped
            : occurrenceB;
      const before = await evidenceSnapshot();

      const responses = [
        await invokeCreate(eventId, 'Forbidden create'),
        await invokeUpdate(eventId, targetOccurrence, 'Forbidden update'),
      ];
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('returns 404 for a foreign occurrence id under an authorized event without mutation', async () => {
    const before = await evidenceSnapshot();
    const response = await invokeUpdate(eventA, occurrenceAScoped, 'Cross-event update');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  describe.each([
    ['create', () => invokeCreate(eventA, 'Scope-race create')],
    ['update', () => invokeUpdate(eventA, occurrenceA, 'Scope-race update')],
  ] as const)('%s locked scope revalidation', (_operation, invoke) => {
    it('fails closed after a real organization and brand scope swap', async () => {
      let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
      eventOccurrenceCheckpoint.mockImplementationOnce(async () => {
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
    });
  });

  it('serializes concurrent patches into one exact before/after audit chain', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = before.events.find((event) => event.id === eventA)!;
    const original = serializeEventOccurrence(
      before.occurrences.find((row) => row.id === occurrenceA) as Record<string, unknown>,
    );
    const responses = await Promise.all([
      invokeUpdate(eventA, occurrenceA, 'Concurrent occurrence alpha'),
      invokeUpdate(eventA, occurrenceA, 'Concurrent occurrence beta'),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toMatchObject({ title: 'Concurrent occurrence alpha' });
    expect(responses[1]!.json()).toMatchObject({ title: 'Concurrent occurrence beta' });

    const after = await evidenceSnapshot();
    const eventAfter = after.events.find((event) => event.id === eventA)!;
    expect(Number(eventAfter.version)).toBe(Number(eventBefore.version) + 2);
    expect(revisionMillis(eventAfter.public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    const updateAudits = after.audits.filter(
      (audit) => audit.action === 'event_occurrence.updated',
    );
    expect(updateAudits).toHaveLength(2);
    const diffs = updateAudits.map((audit) => auditDiff(audit.diff_summary));
    const first = diffs.find((diff) =>
      Object.is((diff.before as Record<string, unknown>).title, original.title),
    );
    const second = diffs.find((diff) => diff !== first);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.before).toEqual(first!.after);
    expect([first!.after, second!.after]).toEqual(
      expect.arrayContaining([responses[0]!.json(), responses[1]!.json()]),
    );
    const persisted = serializeEventOccurrence(
      after.occurrences.find((row) => row.id === occurrenceA) as Record<string, unknown>,
    );
    expect(persisted).toEqual(second!.after);
  });

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
