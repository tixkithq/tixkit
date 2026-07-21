import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { AuditLogRepository, createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { openApiSpec } from '@tixkit/openapi';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { serializeResalePolicy } from '../../http/contracts.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function resalePolicyContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) throw new Error(`resale policy authorization contract ${operationId} missing`);
  return contract;
}

const updateContract = resalePolicyContract('putEventsByEventIdResalePolicy');
const readContract = resalePolicyContract('getEventsByEventIdResalePolicy');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_rpol_auth_a_${suffix}`;
const tenantB = `tnt_rpol_auth_b_${suffix}`;
const organizationA = `org_rpol_auth_a_${suffix}`;
const organizationAScoped = `org_rpol_auth_scope_${suffix}`;
const organizationB = `org_rpol_auth_b_${suffix}`;
const brandA = `brd_rpol_auth_a_${suffix}`;
const brandAScoped = `brd_rpol_auth_scope_${suffix}`;
const brandB = `brd_rpol_auth_b_${suffix}`;
const actorId = `usr_rpol_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;

const resalePolicyCheckpoint = vi.fn(
  async (_input: { stage: 'before_transaction'; eventId: string }) => undefined,
);

type ResalePolicy = Readonly<{
  enabled: boolean;
  maxMultiplier: number;
  maxAbsoluteCents?: number | null;
}>;

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
    venue: { name: 'Resale policy authorization hall' },
  });
  return event.id;
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearResalePolicyEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', '=', 'event.resale_policy.updated')
    .execute();
  await db
    .updateTable('events')
    .set({
      resale_enabled: false,
      resale_max_multiplier: 1,
      resale_max_absolute_cents: null,
    })
    .where('id', 'in', [eventA, eventAScoped, eventB])
    .execute();
}

async function evidenceSnapshot() {
  const [events, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'brand_id',
        'resale_enabled',
        'resale_max_multiplier',
        'resale_max_absolute_cents',
        'version',
        'public_revision',
      ])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.resale_policy.updated')
      .orderBy('id')
      .execute(),
  ]);
  return { events, audits };
}

function policyPayload(kind: 'bounded' | 'unbounded'): ResalePolicy {
  return kind === 'bounded'
    ? { enabled: true, maxMultiplier: 1.75, maxAbsoluteCents: 25_000 }
    : { enabled: false, maxMultiplier: 0, maxAbsoluteCents: null };
}

function invokePolicy(targetEventId: string, payload: InjectOptions['payload']) {
  return app.inject({
    method: updateContract.method,
    url: updateContract.path.replace('{eventId}', targetEventId),
    payload,
  });
}

function invokePolicyRead(targetEventId: string) {
  return app.inject({
    method: readContract.method,
    url: readContract.path.replace('{eventId}', targetEventId),
  });
}

function eventFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return snapshot.events.find((event) => event.id === eventId)!;
}

function storedPolicy(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return serializeResalePolicy(eventFrom(snapshot, eventId) as Record<string, unknown>);
}

describeWithIntegrationDatabase('resale policy route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Resale policy authorization tenant A');
    await insertTenant(tenantB, 'Resale policy authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Resale policy authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Resale policy authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Resale policy authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Resale policy authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Resale policy authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Resale policy authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed resale policy event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped resale policy event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign resale policy event');

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
      resalePolicyCheckpoint: (input: { stage: 'before_transaction'; eventId: string }) =>
        resalePolicyCheckpoint(input),
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
    resalePolicyCheckpoint.mockReset();
    resalePolicyCheckpoint.mockResolvedValue(undefined);
    await clearResalePolicyEvidence();
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
      await cleanup(clearResalePolicyEvidence);
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
      throw new AggregateError(cleanupErrors, 'Failed to clean up resale policy proof');
    }
  });

  it('binds both immutable route contracts to this executable proof', () => {
    for (const contract of [readContract, updateContract]) {
      expect(contract).toMatchObject({
        authorizedControl: { status: 200 },
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
        permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
        persistenceSource: 'resale-policy-route-authorization-db.integration.test.ts',
        source: 'resale-policy-route-authorization-db.integration.test.ts',
      });
    }
    const publicSchema = openApiSpec.components.schemas.ResalePolicy;
    expect(
      openApiSpec.paths['/events/{eventId}/resale-policy'].put.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/ResalePolicy' });
    expect(publicSchema).toMatchObject({
      additionalProperties: false,
      required: ['enabled', 'maxMultiplier'],
      properties: {
        maxAbsoluteCents: { type: ['integer', 'null'], minimum: 0 },
      },
    });
  });

  it('returns the exact authorized persisted policy without mutation', async () => {
    const payload = policyPayload('bounded');
    await db
      .updateTable('events')
      .set({
        resale_enabled: payload.enabled,
        resale_max_multiplier: payload.maxMultiplier,
        resale_max_absolute_cents: payload.maxAbsoluteCents,
      })
      .where('id', '=', eventA)
      .execute();
    const before = await evidenceSnapshot();

    const response = await invokePolicyRead(eventA);

    expect(response.statusCode, response.body).toBe(readContract.authorizedControl.status);
    expect(response.json()).toEqual(storedPolicy(before, eventA));
    expect(response.body).not.toContain(eventAScoped);
    expect(response.body).not.toContain(eventB);
    await expect(evidenceSnapshot()).resolves.toEqual(before);
  });

  it('persists the exact policy with one monotonic revision and exact atomic audit', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const payload = policyPayload('bounded');

    const response = await invokePolicy(eventA, payload);

    expect(response.statusCode, response.body).toBe(updateContract.authorizedControl.status);
    expect(response.json()).toEqual(payload);
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    expect(storedPolicy(after, eventA)).toEqual(payload);
    expect(Number(eventAfter.version)).toBe(Number(eventBefore.version) + 1);
    expect(revisionMillis(eventAfter.public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      actor_type: 'user',
      actor_id: actorId,
      action: 'event.resale_policy.updated',
      resource_type: 'Event',
      resource_id: eventA,
    });
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
      before: { enabled: false, maxMultiplier: 1 },
      after: payload,
      previousVersion: Number(eventBefore.version),
      newVersion: Number(eventBefore.version) + 1,
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
    'denies the %s boundary for read and update without event, revision, or audit mutation',
    async (boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();
      const targetEventId = targetEvent();
      const eventQuery = vi.spyOn(EventRepository.prototype, 'findById');

      try {
        const responses = [
          await invokePolicyRead(targetEventId),
          await invokePolicy(targetEventId, policyPayload('bounded')),
        ];
        for (const response of responses) {
          expect(response.statusCode, response.body).toBe(status);
          expect(response.json()).toMatchObject({ error: { code } });
          expect(response.json()).not.toHaveProperty('enabled');
          expect(response.json()).not.toHaveProperty('maxMultiplier');
          expect(response.json()).not.toHaveProperty('maxAbsoluteCents');
          for (const protectedEventId of [eventA, eventAScoped, eventB]) {
            if (protectedEventId !== targetEventId) {
              expect(response.body).not.toContain(protectedEventId);
            }
          }
        }
        expect(eventQuery.mock.calls).toEqual(
          boundary === 'permission' ? [] : [[targetEventId], [targetEventId]],
        );
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      } finally {
        eventQuery.mockRestore();
      }
    },
  );

  it('revalidates authorization against the locked event after a real scope swap', async () => {
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    resalePolicyCheckpoint.mockImplementationOnce(async () => {
      await db
        .updateTable('events')
        .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
        .where('id', '=', eventA)
        .execute();
      checkpointSnapshot = await evidenceSnapshot();
    });

    try {
      const response = await invokePolicy(eventA, policyPayload('bounded'));
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

  it('rolls back an audit failure and permits an exact clean retry', async () => {
    const before = await evidenceSnapshot();
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected resale policy audit failure'));
    try {
      const failed = await invokePolicy(eventA, policyPayload('bounded'));
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokePolicy(eventA, policyPayload('bounded'));
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(policyPayload('bounded'));
    const after = await evidenceSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(storedPolicy(after, eventA)).toEqual(policyPayload('bounded'));
  });

  describe('strict policy schema boundaries', () => {
    it.each([
      [
        'zero multiplier and zero absolute cap',
        { enabled: true, maxMultiplier: 0, maxAbsoluteCents: 0 },
      ],
      ['explicit nullable absolute cap', policyPayload('unbounded')],
    ] as const)('accepts %s', async (_name, payload) => {
      const before = await evidenceSnapshot();
      const response = await invokePolicy(eventA, payload);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(
        payload.maxAbsoluteCents === null
          ? { enabled: payload.enabled, maxMultiplier: payload.maxMultiplier }
          : payload,
      );
      const after = await evidenceSnapshot();
      expect(Number(eventFrom(after, eventA).version)).toBe(
        Number(eventFrom(before, eventA).version) + 1,
      );
      expect(storedPolicy(after, eventA)).toEqual(response.json());
      expect(after.audits).toHaveLength(1);
    });

    it.each([
      ['negative multiplier', { enabled: true, maxMultiplier: -0.01 }],
      ['non-finite multiplier', { enabled: true, maxMultiplier: 'Infinity' }],
      ['negative absolute cap', { enabled: true, maxMultiplier: 1, maxAbsoluteCents: -1 }],
      ['fractional absolute cap', { enabled: true, maxMultiplier: 1, maxAbsoluteCents: 1.5 }],
      ['missing enabled', { maxMultiplier: 1 }],
      ['missing multiplier', { enabled: true }],
      ['unknown property', { enabled: true, maxMultiplier: 1, unexpected: true }],
    ] as const)('rejects %s without persistence', async (_name, payload) => {
      const before = await evidenceSnapshot();
      const response = await invokePolicy(eventA, payload);
      expect(response.statusCode, response.body).toBe(400);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    });
  });

  it('serializes concurrent distinct writes into an exact two-transition chain', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const bounded = policyPayload('bounded');
    const unbounded = policyPayload('unbounded');

    const responses = await Promise.all([
      invokePolicy(eventA, bounded),
      invokePolicy(eventA, unbounded),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(bounded);
    expect(responses[1]!.json()).toEqual({ enabled: false, maxMultiplier: 0 });
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    expect(Number(eventAfter.version)).toBe(Number(eventBefore.version) + 2);
    expect(revisionMillis(eventAfter.public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(2);

    const transitions = after.audits.map((audit) => auditDiff(audit.diff_summary));
    const first = transitions.find(
      (transition) => transition.previousVersion === Number(eventBefore.version),
    )!;
    const second = transitions.find(
      (transition) => transition.previousVersion === Number(eventBefore.version) + 1,
    )!;
    expect(first.newVersion).toBe(Number(eventBefore.version) + 1);
    expect(second.newVersion).toBe(Number(eventBefore.version) + 2);
    expect([first.after, second.after]).toEqual(
      expect.arrayContaining([bounded, { enabled: false, maxMultiplier: 0 }]),
    );
    expect(second.before).toEqual(first.after);
    expect(storedPolicy(after, eventA)).toEqual(second.after);
  });
});
