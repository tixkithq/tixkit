import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { AuditLogRepository, createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { openApiSpec } from '@tixkit/openapi';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { serializeMarketingIntegration } from '../../http/contracts.js';
import { eventRoutes } from '../../routes/modules/events.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function marketingIntegrationContract(operationId: string) {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) {
    throw new Error(`marketing integration authorization contract ${operationId} missing`);
  }
  return contract;
}

const updateContract = marketingIntegrationContract(
  'putEventsByEventIdMarketingIntegrationsByProvider',
);

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_mkt_auth_a_${suffix}`;
const tenantB = `tnt_mkt_auth_b_${suffix}`;
const organizationA = `org_mkt_auth_a_${suffix}`;
const organizationAScoped = `org_mkt_auth_scope_${suffix}`;
const organizationB = `org_mkt_auth_b_${suffix}`;
const brandA = `brd_mkt_auth_a_${suffix}`;
const brandAScoped = `brd_mkt_auth_scope_${suffix}`;
const brandB = `brd_mkt_auth_b_${suffix}`;
const actorId = `usr_mkt_auth_${suffix}`;

type MarketingProvider = 'ga4' | 'meta_pixel' | 'generic_tag';
type MarketingPayload = Readonly<{
  config: Record<string, string>;
  consentRequired?: boolean;
  status?: 'active' | 'disabled';
}>;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;

const marketingIntegrationCheckpoint = vi.fn(
  async (_input: { stage: 'before_transaction'; eventId: string; provider: MarketingProvider }) =>
    undefined,
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
    venue: { name: 'Marketing integration authorization hall' },
  });
  return event.id;
}

function providerPayload(provider: MarketingProvider, variant = 'one'): MarketingPayload {
  if (provider === 'ga4') {
    return {
      config: { measurementId: `G-${variant.toUpperCase()}-${suffix}` },
      consentRequired: false,
      status: 'active',
    };
  }
  if (provider === 'meta_pixel') {
    return {
      config: { pixelId: `pixel-${variant}-${suffix}` },
      consentRequired: true,
      status: variant === 'disabled' ? 'disabled' : 'active',
    };
  }
  return {
    config: { pixelUrl: `https://metrics.example.test/${suffix}/${variant}.gif` },
    consentRequired: true,
    status: 'active',
  };
}

function auditDiff(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

function serializedIntegration(row: Record<string, unknown>): Record<string, unknown> {
  return serializeMarketingIntegration(row) as Record<string, unknown>;
}

function revisionMillis(value: Date | string | null): number {
  expect(value).not.toBeNull();
  return value instanceof Date ? value.getTime() : new Date(value!).getTime();
}

async function clearMarketingEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', '=', 'event.marketing_integration.upserted')
    .execute();
  await db
    .deleteFrom('marketing_integrations')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
}

async function evidenceSnapshot() {
  const [events, integrations, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'version', 'public_revision'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.marketing_integration.upserted')
      .orderBy('id')
      .execute(),
  ]);
  return { events, integrations, audits };
}

function eventFrom(snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>, eventId: string) {
  return snapshot.events.find((event) => event.id === eventId)!;
}

function integrationsFor(
  snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>,
  eventId: string,
  provider?: MarketingProvider,
) {
  return snapshot.integrations.filter(
    (row) => row.event_id === eventId && (provider === undefined || row.provider === provider),
  );
}

async function seedIntegration(
  eventId: string,
  provider: MarketingProvider,
  payload: MarketingPayload,
): Promise<void> {
  const event = await db
    .selectFrom('events')
    .select(['tenant_id', 'organization_id', 'brand_id'])
    .where('id', '=', eventId)
    .executeTakeFirstOrThrow();
  const now = new Date('2026-07-17T12:30:00.000Z');
  await db
    .insertInto('marketing_integrations')
    .values({
      id: `mkt_${ulid()}`,
      tenant_id: event.tenant_id,
      organization_id: event.organization_id,
      brand_id: event.brand_id,
      event_id: eventId,
      provider,
      config: JSON.stringify(payload.config),
      consent_required: payload.consentRequired ?? true,
      status: payload.status ?? 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function invokeIntegration(
  targetEventId: string,
  provider: string,
  payload: InjectOptions['payload'],
) {
  const path = updateContract.path;
  return app.inject({
    method: updateContract.method,
    url: path.replace('{eventId}', targetEventId).replace('{provider}', provider),
    payload,
  });
}

function transitionChain(
  snapshot: Awaited<ReturnType<typeof evidenceSnapshot>>,
  startingVersion: number,
) {
  const transitions = snapshot.audits.map((audit) => auditDiff(audit.diff_summary));
  const first = transitions.find((transition) => transition.previousVersion === startingVersion)!;
  const second = transitions.find(
    (transition) => transition.previousVersion === startingVersion + 1,
  )!;
  expect(first.newVersion).toBe(startingVersion + 1);
  expect(second.newVersion).toBe(startingVersion + 2);
  return { first, second };
}

describeWithIntegrationDatabase('marketing integration write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Marketing integration authorization tenant A');
    await insertTenant(tenantB, 'Marketing integration authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Marketing integration authorization org A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Marketing integration authorization scoped org',
    );
    await insertOrganization(organizationB, tenantB, 'Marketing integration authorization org B');
    await insertBrand(
      brandA,
      tenantA,
      organizationA,
      'Marketing integration authorization brand A',
    );
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Marketing integration authorization scoped brand',
    );
    await insertBrand(
      brandB,
      tenantB,
      organizationB,
      'Marketing integration authorization brand B',
    );
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed marketing event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped marketing event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign marketing event');

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
      marketingIntegrationCheckpoint: (input: {
        stage: 'before_transaction';
        eventId: string;
        provider: MarketingProvider;
      }) => marketingIntegrationCheckpoint(input),
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
    marketingIntegrationCheckpoint.mockReset();
    marketingIntegrationCheckpoint.mockResolvedValue(undefined);
    await clearMarketingEvidence();
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
      await cleanup(clearMarketingEvidence);
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
      throw new AggregateError(cleanupErrors, 'Failed to clean up marketing integration proof');
    }
  });

  it('binds the immutable route contract to this executable proof', () => {
    expect(updateContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'marketing-integration-route-authorization-db.integration.test.ts',
      source: 'marketing-integration-route-authorization-db.integration.test.ts',
    });
    const publicSchema =
      openApiSpec.paths['/events/{eventId}/marketing-integrations/{provider}'].put.requestBody
        .content['application/json'].schema;
    expect(publicSchema.additionalProperties).toBe(false);
    expect(publicSchema.required).toEqual(['config']);
    expect(publicSchema.properties.config.oneOf).toEqual([
      { $ref: '#/components/schemas/Ga4MarketingIntegrationConfig' },
      { $ref: '#/components/schemas/MetaPixelMarketingIntegrationConfig' },
      { $ref: '#/components/schemas/GenericTagMarketingIntegrationConfig' },
    ]);
    expect(openApiSpec.components.schemas.GenericTagMarketingIntegrationConfig).toMatchObject({
      additionalProperties: false,
      properties: {
        pixelUrl: {
          pattern: '^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)[^?#]+$',
          description: expect.stringContaining('without credentials'),
        },
      },
    });
  });

  it('creates the exact integration with one monotonic revision and exact atomic audit', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const payload = providerPayload('ga4');

    const response = await invokeIntegration(eventA, 'ga4', payload);

    expect(response.statusCode, response.body).toBe(updateContract.authorizedControl.status);
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    const rows = integrationsFor(after, eventA, 'ga4');
    expect(rows).toHaveLength(1);
    const serialized = serializedIntegration(rows[0] as Record<string, unknown>);
    expect(response.json()).toEqual(serialized);
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
      action: 'event.marketing_integration.upserted',
      resource_type: 'MarketingIntegration',
      resource_id: rows[0]!.id,
    });
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
      eventId: eventA,
      provider: 'ga4',
      before: null,
      after: serialized,
      previousVersion: Number(eventBefore.version),
      newVersion: Number(eventBefore.version) + 1,
    });
  });

  it('updates the exact existing integration with one revision and exact before/after audit', async () => {
    await seedIntegration(eventA, 'meta_pixel', providerPayload('meta_pixel', 'before'));
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const integrationBefore = serializedIntegration(
      integrationsFor(before, eventA, 'meta_pixel')[0] as Record<string, unknown>,
    );
    const payload = providerPayload('meta_pixel', 'disabled');

    const response = await invokeIntegration(eventA, 'meta_pixel', payload);

    expect(response.statusCode, response.body).toBe(200);
    const after = await evidenceSnapshot();
    const eventAfter = eventFrom(after, eventA);
    const rows = integrationsFor(after, eventA, 'meta_pixel');
    expect(rows).toHaveLength(1);
    const integrationAfter = serializedIntegration(rows[0] as Record<string, unknown>);
    expect(response.json()).toEqual(integrationAfter);
    expect(integrationAfter).toMatchObject({
      id: integrationBefore.id,
      config: payload.config,
      consentRequired: payload.consentRequired,
      status: payload.status,
    });
    expect(Number(eventAfter.version)).toBe(Number(eventBefore.version) + 1);
    expect(revisionMillis(eventAfter.public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(1);
    expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
      eventId: eventA,
      provider: 'meta_pixel',
      before: integrationBefore,
      after: integrationAfter,
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
    'denies the %s boundary without integration, event revision, or audit mutation',
    async (_boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();

      const response = await invokeIntegration(targetEvent(), 'ga4', providerPayload('ga4'));

      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    },
  );

  it('revalidates authorization against the locked event after a real organization and brand swap', async () => {
    let checkpointSnapshot: Awaited<ReturnType<typeof evidenceSnapshot>> | undefined;
    marketingIntegrationCheckpoint.mockImplementationOnce(async () => {
      await db
        .updateTable('events')
        .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
        .where('id', '=', eventA)
        .execute();
      checkpointSnapshot = await evidenceSnapshot();
    });

    try {
      const response = await invokeIntegration(eventA, 'ga4', providerPayload('ga4'));
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

  it('rolls back a create audit failure and permits an exact clean retry', async () => {
    const before = await evidenceSnapshot();
    const payload = providerPayload('ga4');
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected marketing create audit failure'));
    try {
      const failed = await invokeIntegration(eventA, 'ga4', payload);
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeIntegration(eventA, 'ga4', payload);
    expect(retry.statusCode, retry.body).toBe(200);
    const after = await evidenceSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(integrationsFor(after, eventA, 'ga4')).toHaveLength(1);
    expect(retry.json()).toEqual(
      serializedIntegration(integrationsFor(after, eventA, 'ga4')[0] as Record<string, unknown>),
    );
  });

  it('rolls back an update audit failure and permits an exact clean retry', async () => {
    await seedIntegration(eventA, 'meta_pixel', providerPayload('meta_pixel', 'before'));
    const before = await evidenceSnapshot();
    const payload = providerPayload('meta_pixel', 'disabled');
    const failure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected marketing update audit failure'));
    try {
      const failed = await invokeIntegration(eventA, 'meta_pixel', payload);
      expect(failed.statusCode).toBe(500);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      failure.mockRestore();
    }

    const retry = await invokeIntegration(eventA, 'meta_pixel', payload);
    expect(retry.statusCode, retry.body).toBe(200);
    const after = await evidenceSnapshot();
    expect(after.audits).toHaveLength(1);
    expect(integrationsFor(after, eventA, 'meta_pixel')).toHaveLength(1);
    expect(retry.json()).toMatchObject({
      id: serializedIntegration(
        integrationsFor(before, eventA, 'meta_pixel')[0] as Record<string, unknown>,
      ).id,
      config: payload.config,
      consentRequired: payload.consentRequired,
      status: payload.status,
    });
  });

  describe('strict provider-specific schema boundaries', () => {
    it.each([
      ['GA4', 'ga4', providerPayload('ga4')],
      ['Meta Pixel', 'meta_pixel', providerPayload('meta_pixel')],
      ['generic tag', 'generic_tag', providerPayload('generic_tag')],
      ['GA4 defaults', 'ga4', { config: { measurementId: `G-DEFAULT-${suffix}` } }],
    ] as const)(
      'accepts %s and persists only its provider schema',
      async (_name, provider, payload) => {
        const before = await evidenceSnapshot();
        const response = await invokeIntegration(eventA, provider, payload);
        expect(response.statusCode, response.body).toBe(200);
        const after = await evidenceSnapshot();
        const rows = integrationsFor(after, eventA, provider);
        expect(rows).toHaveLength(1);
        expect(response.json()).toEqual(serializedIntegration(rows[0] as Record<string, unknown>));
        expect(Number(eventFrom(after, eventA).version)).toBe(
          Number(eventFrom(before, eventA).version) + 1,
        );
        expect(after.audits).toHaveLength(1);
      },
    );

    it.each([
      ['unsupported provider', 'unknown', { config: { measurementId: 'G-UNKNOWN' } }],
      [
        'GA4 secret field',
        'ga4',
        { config: { measurementId: 'G-SAFE', secret: 'must-not-persist' } },
      ],
      ['GA4 missing measurement ID', 'ga4', { config: {} }],
      ['GA4 Meta-shaped config', 'ga4', { config: { pixelId: 'pixel-wrong-provider' } }],
      ['Meta missing pixel ID', 'meta_pixel', { config: {} }],
      ['Meta GA4-shaped config', 'meta_pixel', { config: { measurementId: 'G-WRONG-PROVIDER' } }],
      [
        'generic tag HTTP URL',
        'generic_tag',
        { config: { pixelUrl: 'http://metrics.example.test/pixel.gif' } },
      ],
      [
        'generic tag credential-bearing URL',
        'generic_tag',
        { config: { pixelUrl: 'https://user:password@metrics.example.test/pixel.gif' } },
      ],
      [
        'generic tag query-bearing URL',
        'generic_tag',
        { config: { pixelUrl: 'https://metrics.example.test/pixel.gif?token=secret' } },
      ],
      [
        'generic tag fragment-bearing URL',
        'generic_tag',
        { config: { pixelUrl: 'https://metrics.example.test/pixel.gif#secret' } },
      ],
      ['generic tag malformed URL', 'generic_tag', { config: { pixelUrl: 'not-a-url' } }],
      [
        'unknown top-level property',
        'ga4',
        { config: { measurementId: 'G-SAFE' }, unexpected: true },
      ],
    ] as const)('rejects %s without persistence', async (_name, provider, payload) => {
      const before = await evidenceSnapshot();
      const response = await invokeIntegration(eventA, provider, payload);
      expect(response.statusCode, response.body).toBe(400);
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    });
  });

  it('serializes concurrent first creates into one row and an exact two-transition chain', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const firstPayload = providerPayload('ga4', 'concurrent-a');
    const secondPayload = providerPayload('ga4', 'concurrent-b');

    const responses = await Promise.all([
      invokeIntegration(eventA, 'ga4', firstPayload),
      invokeIntegration(eventA, 'ga4', secondPayload),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const after = await evidenceSnapshot();
    const rows = integrationsFor(after, eventA, 'ga4');
    expect(rows).toHaveLength(1);
    expect(Number(eventFrom(after, eventA).version)).toBe(Number(eventBefore.version) + 2);
    expect(revisionMillis(eventFrom(after, eventA).public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(2);
    const { first, second } = transitionChain(after, Number(eventBefore.version));
    expect(first.before).toBeNull();
    expect(second.before).toEqual(first.after);
    expect(rows[0]!.id).toBe((first.after as { id: string }).id);
    expect(rows[0]!.id).toBe((second.after as { id: string }).id);
    expect(serializedIntegration(rows[0] as Record<string, unknown>)).toEqual(second.after);
    expect([first.after, second.after]).toEqual(
      expect.arrayContaining(responses.map((response) => response.json())),
    );
  });

  it('serializes concurrent distinct updates into one row and an exact two-transition chain', async () => {
    await seedIntegration(eventA, 'meta_pixel', providerPayload('meta_pixel', 'seed'));
    const before = await evidenceSnapshot();
    const eventBefore = eventFrom(before, eventA);
    const seeded = serializedIntegration(
      integrationsFor(before, eventA, 'meta_pixel')[0] as Record<string, unknown>,
    );
    const firstPayload = providerPayload('meta_pixel', 'concurrent-a');
    const secondPayload = providerPayload('meta_pixel', 'disabled');

    const responses = await Promise.all([
      invokeIntegration(eventA, 'meta_pixel', firstPayload),
      invokeIntegration(eventA, 'meta_pixel', secondPayload),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const after = await evidenceSnapshot();
    const rows = integrationsFor(after, eventA, 'meta_pixel');
    expect(rows).toHaveLength(1);
    expect(Number(eventFrom(after, eventA).version)).toBe(Number(eventBefore.version) + 2);
    expect(revisionMillis(eventFrom(after, eventA).public_revision)).toBeGreaterThan(
      revisionMillis(eventBefore.public_revision),
    );
    expect(after.audits).toHaveLength(2);
    const { first, second } = transitionChain(after, Number(eventBefore.version));
    expect(first.before).toEqual(seeded);
    expect(second.before).toEqual(first.after);
    expect(serializedIntegration(rows[0] as Record<string, unknown>)).toEqual(second.after);
    expect([first.after, second.after]).toEqual(
      expect.arrayContaining(responses.map((response) => response.json())),
    );
  });
});
