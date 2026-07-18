import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { AuditLogRepository, createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { openApiSpec } from '@tixkit/openapi';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { waitlistRoutes } from '../../routes/modules/waitlist.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function waitlistSettingsContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) throw new Error(`waitlist settings authorization contract ${operationId} missing`);
  return contract;
}

const updateContract = waitlistSettingsContract('patchEventsByEventIdWaitlistSettings');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_wlst_auth_a_${suffix}`;
const tenantB = `tnt_wlst_auth_b_${suffix}`;
const organizationA = `org_wlst_auth_a_${suffix}`;
const organizationAScoped = `org_wlst_auth_scope_${suffix}`;
const organizationB = `org_wlst_auth_b_${suffix}`;
const brandA = `brd_wlst_auth_a_${suffix}`;
const brandAScoped = `brd_wlst_auth_scope_${suffix}`;
const brandB = `brd_wlst_auth_b_${suffix}`;
const actorId = `usr_wlst_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;

const waitlistSettingsCheckpoint = vi.fn(
  async (_input: { stage: 'before_transaction'; eventId: string }) => undefined,
);

type WaitlistSettings = Readonly<{
  autoOfferEnabled: boolean;
  offerTtlMinutes: number;
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
    venue: { name: 'Waitlist settings authorization hall' },
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

async function clearWaitlistSettingsEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', '=', 'event.waitlist.settings.updated')
    .execute();
  await db
    .updateTable('events')
    .set({
      waitlist_auto_offer_enabled: false,
      waitlist_offer_ttl_minutes: 1440,
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
        'waitlist_auto_offer_enabled',
        'waitlist_offer_ttl_minutes',
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
      .where('action', '=', 'event.waitlist.settings.updated')
      .orderBy('id')
      .execute(),
  ]);
  return { events, audits };
}

function settingsPayload(kind: 'minimum' | 'maximum'): WaitlistSettings {
  return kind === 'minimum'
    ? { autoOfferEnabled: true, offerTtlMinutes: 5 }
    : { autoOfferEnabled: false, offerTtlMinutes: 20_160 };
}

function invokeSettings(targetEventId: string, payload: InjectOptions['payload']) {
  return app.inject({
    method: updateContract.method,
    url: updateContract.path.replace('{eventId}', targetEventId),
    payload,
  });
}

function eventFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return snapshot.events.find((event) => event.id === eventId)!;
}

function storedSettings(
  snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>,
  eventId: string,
): WaitlistSettings {
  const event = eventFrom(snapshot, eventId);
  return {
    autoOfferEnabled: Boolean(event.waitlist_auto_offer_enabled),
    offerTtlMinutes: Number(event.waitlist_offer_ttl_minutes),
  };
}

describeWithIntegrationDatabase('waitlist settings write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Waitlist settings authorization tenant A');
    await insertTenant(tenantB, 'Waitlist settings authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Waitlist settings authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Waitlist settings authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Waitlist settings authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Waitlist settings authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Waitlist settings authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Waitlist settings authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed waitlist settings event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped waitlist settings event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign waitlist settings event');

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
      waitlistSettingsCheckpoint: (input: { stage: 'before_transaction'; eventId: string }) =>
        waitlistSettingsCheckpoint(input),
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
    waitlistSettingsCheckpoint.mockReset();
    waitlistSettingsCheckpoint.mockResolvedValue(undefined);
    await clearWaitlistSettingsEvidence();
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
      await cleanup(clearWaitlistSettingsEvidence);
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
      throw new AggregateError(cleanupErrors, 'Failed to clean up waitlist settings proof');
    }
  });

  it('binds the immutable route contract and public bounds to this executable proof', () => {
    expect(updateContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'waitlist-settings-route-authorization-db.integration.test.ts',
      source: 'waitlist-settings-route-authorization-db.integration.test.ts',
    });
    expect(
      openApiSpec.paths['/events/{eventId}/waitlist/settings'].patch.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/WaitlistSettings' });
    expect(openApiSpec.components.schemas.WaitlistSettings).toMatchObject({
      additionalProperties: false,
      required: ['autoOfferEnabled', 'offerTtlMinutes'],
      properties: {
        autoOfferEnabled: { type: 'boolean' },
        offerTtlMinutes: { type: 'integer', minimum: 5, maximum: 20_160 },
      },
    });
  });

  it('persists the exact settings with one monotonic revision and exact atomic audit', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const payload = settingsPayload('minimum');

    const response = await invokeSettings(eventA, payload);

    expect(response.statusCode, response.body).toBe(updateContract.authorizedControl.status);
    expect(response.json()).toEqual(payload);
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    expect(storedSettings(after, eventA)).toEqual(payload);
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
      action: 'event.waitlist.settings.updated',
      resource_type: 'Event',
      resource_id: eventA,
    });
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
      before: { autoOfferEnabled: false, offerTtlMinutes: 1440 },
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
    'denies the %s boundary without settings, revision, or audit mutation',
    async (_boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();

      const response = await invokeSettings(targetEvent(), settingsPayload('minimum'));

      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('revalidates authorization against the locked event after a real scope swap', async () => {
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    waitlistSettingsCheckpoint.mockImplementationOnce(async () => {
      await db
        .updateTable('events')
        .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
        .where('id', '=', eventA)
        .execute();
      checkpointSnapshot = await evidenceSnapshot();
    });

    try {
      const response = await invokeSettings(eventA, settingsPayload('minimum'));
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
    const eventBefore = eventFrom(before, eventA);
    const payload = settingsPayload('minimum');
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected waitlist settings audit failure'));
    try {
      const failed = await invokeSettings(eventA, payload);
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeSettings(eventA, payload);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(payload);
    const after = await evidenceSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(storedSettings(after, eventA)).toEqual(payload);
    expect(Number(eventFrom(after, eventA).version)).toBe(Number(eventBefore.version) + 1);
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
      before: { autoOfferEnabled: false, offerTtlMinutes: 1440 },
      after: payload,
      previousVersion: Number(eventBefore.version),
      newVersion: Number(eventBefore.version) + 1,
    });
  });

  describe('strict settings schema boundaries', () => {
    it.each([
      ['minimum TTL', settingsPayload('minimum')],
      ['maximum TTL', settingsPayload('maximum')],
    ] as const)('accepts %s', async (_name, payload) => {
      const before = await evidenceSnapshot();
      const response = await invokeSettings(eventA, payload);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(payload);
      const after = await evidenceSnapshot();
      expect(Number(eventFrom(after, eventA).version)).toBe(
        Number(eventFrom(before, eventA).version) + 1,
      );
      expect(storedSettings(after, eventA)).toEqual(payload);
      expect(after.audits).toHaveLength(1);
    });

    it.each([
      ['below-minimum TTL', { autoOfferEnabled: true, offerTtlMinutes: 4 }],
      ['above-maximum TTL', { autoOfferEnabled: true, offerTtlMinutes: 20_161 }],
      ['fractional TTL', { autoOfferEnabled: true, offerTtlMinutes: 5.5 }],
      ['missing auto-offer flag', { offerTtlMinutes: 60 }],
      ['missing TTL', { autoOfferEnabled: true }],
      ['unknown property', { autoOfferEnabled: true, offerTtlMinutes: 60, unexpected: true }],
    ] as const)('rejects %s without persistence', async (_name, payload) => {
      const before = await evidenceSnapshot();
      const response = await invokeSettings(eventA, payload);
      expect(response.statusCode, response.body).toBe(400);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    });
  });

  it('serializes concurrent distinct writes into an exact two-transition chain', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const minimum = settingsPayload('minimum');
    const maximum = settingsPayload('maximum');

    const responses = await Promise.all([
      invokeSettings(eventA, minimum),
      invokeSettings(eventA, maximum),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json()).toEqual(minimum);
    expect(responses[1]!.json()).toEqual(maximum);
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
    expect([first.after, second.after]).toEqual(expect.arrayContaining([minimum, maximum]));
    expect(second.before).toEqual(first.after);
    expect(storedSettings(after, eventA)).toEqual(second.after);
  });
});
