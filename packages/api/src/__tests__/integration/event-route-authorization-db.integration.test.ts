import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLogRepository,
  createDb,
  EventReadinessAcknowledgementRepository,
  EventRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
  WebhookEventRepository,
  type Database,
} from '@tixkit/db';
import { ALL_PERMISSIONS, humanAcknowledgementStepVersions, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import { eventMediaRoutes } from '../../routes/modules/event-media.js';
import { eventRoutes } from '../../routes/modules/events.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';
import { questionRoutes } from '../../routes/modules/questions.js';
import { readinessRoutes } from '../../routes/modules/readiness.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import { waitlistRoutes } from '../../routes/modules/waitlist.js';
import { InventoryService } from '../../services/inventory.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import {
  EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ORGANIZATION_READINESS_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
} from './route-authorization-contracts.js';

const eventReadContracts = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.filter(
  (contract) =>
    contract.method === 'GET' && contract.operationId !== 'getEventsByEventIdOperationalHealth',
);
const operationalHealthContract = (() => {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'getEventsByEventIdOperationalHealth',
  );
  if (!contract) throw new Error('operational-health authorization contract is not registered');
  return contract;
})();
const eventMutationContracts = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.filter(
  (contract) =>
    contract.operationId === 'postEventsByEventIdCheckInLists' ||
    contract.operationId === 'postEventsByEventIdProductCategories' ||
    contract.operationId === 'postEventsByEventIdQuestions',
);
const lifecycleContracts = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.filter((contract) =>
  ['postEventsByEventIdPause', 'postEventsByEventIdArchive'].includes(contract.operationId),
);
const setupSectionContract = (() => {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'putEventsByEventIdSetupSection',
  );
  if (!contract) throw new Error('setup-section authorization contract is not registered');
  return contract;
})();
const publishContract = (() => {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'postEventsByEventIdPublish',
  );
  if (!contract) throw new Error('publish authorization contract is not registered');
  return contract;
})();
const eventUpdateContract = (() => {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'patchEventsByEventId',
  );
  if (!contract) throw new Error('event update authorization contract is not registered');
  return contract;
})();

type AuthorizationScenario = {
  name: string;
  principal: Principal;
  targetEventId: string;
};

describeWithIntegrationDatabase('event route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let basePrincipal: Principal;
  let principal: Principal;

  const suffix = ulid().slice(-10).toLowerCase();
  const authorizedCheckInListName = `Authorized list ${suffix}`;
  const authorizedProductCategoryName = `Authorized category ${suffix}`;
  const authorizedQuestionLabel = `Authorized question ${suffix}`;
  const forbiddenCheckInListName = `Forbidden list ${suffix}`;
  const forbiddenProductCategoryName = `Forbidden category ${suffix}`;
  const forbiddenQuestionLabel = `Forbidden question ${suffix}`;
  const readinessStepId = 'preview_review';
  const readinessSubjectFingerprint = 'a'.repeat(64);
  const tenantA = `tnt_auth_a_${suffix}`;
  const tenantB = `tnt_auth_b_${suffix}`;
  const organizationA = `org_auth_a_${suffix}`;
  const organizationAScoped = `org_auth_scope_${suffix}`;
  const organizationB = `org_auth_b_${suffix}`;
  const brandA = `brd_auth_a_${suffix}`;
  const brandAScoped = `brd_auth_scope_${suffix}`;
  const brandB = `brd_auth_b_${suffix}`;
  let eventA: string;
  let eventAScoped: string;
  let eventB: string;
  const createdEventIds: string[] = [];
  const operationalEndpointIds: string[] = [];
  const operationalWebhookEventIds: string[] = [];
  const operationalExportIds: string[] = [];
  const acknowledgementSubject = vi.fn(
    async (_input: {
      tenantId: string;
      organizationId: string;
      brandId: string;
      eventId: string;
      stepId: string;
    }) => readinessSubjectFingerprint,
  );
  const getWorkspaceReadiness = vi.fn(async () => ({
    complete: false,
    steps: [{ id: 'workspace-proof', status: 'incomplete' }],
  }));
  const getDashboardActions = vi.fn(async () => ({
    actions: [{ id: 'dashboard-proof' }],
    nextCursor: null,
  }));
  let publishReadinessLaunchable = false;
  const recordLaunchReadiness = vi.fn(
    (_input: { tenantId: string; organizationId: string; brandId: string; eventId: string }) =>
      undefined,
  );
  const eventUpdateCheckpoint = vi.fn(
    async (_input: { stage: 'before_transaction'; eventId: string }) => undefined,
  );

  async function readinessAcknowledgementSnapshot() {
    const [acknowledgements, audits] = await Promise.all([
      db
        .selectFrom('event_readiness_acknowledgements')
        .selectAll()
        .where('event_id', 'in', createdEventIds)
        .where('step_id', '=', readinessStepId)
        .orderBy('event_id', 'asc')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select([
          'id',
          'tenant_id',
          'organization_id',
          'brand_id',
          'actor_type',
          'actor_id',
          'action',
          'resource_type',
          'resource_id',
          'diff_summary',
        ])
        .where('actor_id', '=', basePrincipal.id)
        .where('action', 'in', [
          'event.readiness_acknowledged',
          'event.readiness_acknowledgement_removed',
        ])
        .where('resource_id', 'in', createdEventIds)
        .orderBy('id', 'asc')
        .execute(),
    ]);
    return { acknowledgements, audits };
  }

  async function clearReadinessAcknowledgementEvidence(): Promise<void> {
    if (createdEventIds.length === 0) return;
    await db
      .deleteFrom('event_readiness_acknowledgements')
      .where('event_id', 'in', createdEventIds)
      .where('step_id', '=', readinessStepId)
      .execute();
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', basePrincipal.id)
      .where('action', 'in', [
        'event.readiness_acknowledged',
        'event.readiness_acknowledgement_removed',
      ])
      .where('resource_id', 'in', createdEventIds)
      .execute();
  }

  async function setupSectionSnapshot() {
    const [events, audits] = await Promise.all([
      db
        .selectFrom('events')
        .select(['id', 'last_setup_section'])
        .where('id', 'in', createdEventIds)
        .orderBy('id', 'asc')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select([
          'id',
          'tenant_id',
          'organization_id',
          'brand_id',
          'actor_type',
          'actor_id',
          'action',
          'resource_type',
          'resource_id',
          'diff_summary',
        ])
        .where('actor_id', '=', basePrincipal.id)
        .where('action', '=', 'event.setup_section.update')
        .where('resource_id', 'in', createdEventIds)
        .orderBy('id', 'asc')
        .execute(),
    ]);
    return { events, audits };
  }

  async function clearSetupSectionEvidence(): Promise<void> {
    if (createdEventIds.length === 0) return;
    await db
      .updateTable('events')
      .set({ last_setup_section: null })
      .where('id', 'in', createdEventIds)
      .execute();
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', basePrincipal.id)
      .where('action', '=', 'event.setup_section.update')
      .where('resource_id', 'in', createdEventIds)
      .execute();
  }

  async function lifecycleSnapshot() {
    const [events, audits] = await Promise.all([
      db
        .selectFrom('events')
        .select(['id', 'status', 'version', 'public_revision'])
        .where('id', 'in', createdEventIds)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .selectAll()
        .where('actor_id', '=', basePrincipal.id)
        .where('action', 'in', ['event.paused', 'event.archived'])
        .where('resource_id', 'in', createdEventIds)
        .orderBy('id')
        .execute(),
    ]);
    return { events, audits };
  }

  async function clearLifecycleEvidence(): Promise<void> {
    if (createdEventIds.length === 0) return;
    await db
      .updateTable('events')
      .set({ status: 'published', public_revision: new Date('2020-01-01T00:00:00.000Z') })
      .where('id', 'in', createdEventIds)
      .execute();
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', basePrincipal.id)
      .where('action', 'in', ['event.paused', 'event.archived'])
      .where('resource_id', 'in', createdEventIds)
      .execute();
  }

  async function publishSnapshot() {
    const [events, audits] = await Promise.all([
      db
        .selectFrom('events')
        .select(['id', 'status', 'version', 'public_revision'])
        .where('id', 'in', createdEventIds)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .selectAll()
        .where('actor_id', '=', basePrincipal.id)
        .where('action', 'in', ['event.published', 'event.archived'])
        .where('resource_id', 'in', createdEventIds)
        .orderBy('id')
        .execute(),
    ]);
    return { events, audits };
  }

  async function clearPublishEvidence(): Promise<void> {
    if (createdEventIds.length === 0) return;
    await db
      .updateTable('events')
      .set({ status: 'draft', public_revision: new Date('2020-01-01T00:00:00.000Z') })
      .where('id', 'in', createdEventIds)
      .execute();
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', basePrincipal.id)
      .where('action', 'in', ['event.published', 'event.archived'])
      .where('resource_id', 'in', createdEventIds)
      .execute();
    publishReadinessLaunchable = false;
    recordLaunchReadiness.mockClear();
  }

  async function eventUpdateSnapshot() {
    const [events, audits] = await Promise.all([
      db
        .selectFrom('events')
        .select([
          'id',
          'organization_id',
          'brand_id',
          'title',
          'description',
          'starts_at',
          'version',
          'public_revision',
        ])
        .where('id', 'in', createdEventIds)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .selectAll()
        .where('actor_id', '=', basePrincipal.id)
        .where('action', '=', 'event.updated')
        .where('resource_id', 'in', createdEventIds)
        .orderBy('id')
        .execute(),
    ]);
    return { events, audits };
  }

  async function clearEventUpdateEvidence(): Promise<void> {
    if (createdEventIds.length === 0) return;
    await Promise.all([
      db
        .updateTable('events')
        .set({
          title: 'Allowed Event',
          description: null,
          starts_at: new Date('2027-01-01T18:00:00.000Z'),
        })
        .where('id', '=', eventA)
        .execute(),
      db
        .updateTable('events')
        .set({
          title: 'Scoped Event',
          description: null,
          starts_at: new Date('2027-01-01T18:00:00.000Z'),
        })
        .where('id', '=', eventAScoped)
        .execute(),
      db
        .updateTable('events')
        .set({
          title: 'Foreign Event',
          description: null,
          starts_at: new Date('2027-01-01T18:00:00.000Z'),
        })
        .where('id', '=', eventB)
        .execute(),
    ]);
    await db
      .deleteFrom('audit_logs')
      .where('actor_id', '=', basePrincipal.id)
      .where('action', '=', 'event.updated')
      .where('resource_id', 'in', createdEventIds)
      .execute();
  }

  async function insertTenant(id: string, name: string) {
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function insertOrganization(id: string, tenantId: string, name: string) {
    const now = new Date();
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

  async function insertBrand(id: string, tenantId: string, organizationId: string, name: string) {
    const now = new Date();
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
  ) {
    return new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId,
      slug: `${title.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
      title,
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00.000Z'),
      endsAt: new Date('2027-01-01T22:00:00.000Z'),
      venue: { name: 'Authorization Test Hall' },
    });
  }

  async function seedOperationalHealthEvidence(): Promise<void> {
    const endpointRepository = new WebhookEndpointRepository(db);
    const eventRepository = new WebhookEventRepository(db);
    const deliveryRepository = new WebhookDeliveryRepository(db);
    const scopes = [
      { tenantId: tenantA, organizationId: organizationA, label: 'authorized' },
      { tenantId: tenantA, organizationId: organizationAScoped, label: 'scoped' },
      { tenantId: tenantB, organizationId: organizationB, label: 'foreign' },
    ] as const;
    for (const scope of scopes) {
      const endpoint = await endpointRepository.create({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        url: `https://${scope.label}-${suffix}.example.test/webhooks`,
        events: ['operational.health.test'],
      });
      const webhookEvent = await eventRepository.create({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        type: 'operational.health.test',
        payload: { label: scope.label },
      });
      operationalEndpointIds.push(endpoint.id);
      operationalWebhookEventIds.push(webhookEvent.id);
      const statuses =
        scope.label === 'authorized' ? ['failed', 'dead_lettered', 'delivered'] : ['failed'];
      for (const [index, status] of statuses.entries()) {
        await deliveryRepository.create({
          endpointId: endpoint.id,
          eventId: webhookEvent.id,
          attempt: index + 1,
          status,
          nextRetryAt: null,
        });
      }
    }

    const now = new Date('2026-07-17T12:00:00.000Z');
    const exports = [
      { eventId: eventA, tenantId: tenantA, status: 'failed' },
      { eventId: eventA, tenantId: tenantA, status: 'completed' },
      { eventId: eventAScoped, tenantId: tenantA, status: 'failed' },
      { eventId: eventB, tenantId: tenantB, status: 'failed' },
    ] as const;
    await db
      .insertInto('export_jobs')
      .values(
        exports.map((entry, index) => {
          const id = `exp_auth_${index}_${suffix}`;
          operationalExportIds.push(id);
          return {
            id,
            tenant_id: entry.tenantId,
            event_id: entry.eventId,
            type: 'attendees',
            format: 'csv',
            status: entry.status,
            file_url: null,
            requested_by: basePrincipal.id,
            filters: JSON.stringify({}),
            created_at: now,
            completed_at: entry.status === 'completed' ? now : null,
          };
        }),
      )
      .execute();
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Authorization tenant A');
    await insertTenant(tenantB, 'Authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Authorization org A');
    await insertOrganization(organizationAScoped, tenantA, 'Authorization scoped org');
    await insertOrganization(organizationB, tenantB, 'Authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Authorization brand A');
    await insertBrand(brandAScoped, tenantA, organizationAScoped, 'Authorization scoped brand');
    await insertBrand(brandB, tenantB, organizationB, 'Authorization brand B');

    eventA = (await createEvent(tenantA, organizationA, brandA, 'Allowed Event')).id;
    createdEventIds.push(eventA);
    eventAScoped = (await createEvent(tenantA, organizationAScoped, brandAScoped, 'Scoped Event'))
      .id;
    createdEventIds.push(eventAScoped);
    eventB = (await createEvent(tenantB, organizationB, brandB, 'Foreign Event')).id;
    createdEventIds.push(eventB);

    basePrincipal = {
      type: 'user',
      id: `usr_auth_${suffix}`,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    principal = basePrincipal;
    await seedOperationalHealthEvidence();

    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      inventoryService: new InventoryService(db),
      readinessServiceFactory: (database: Database) =>
        ({
          getEventLaunchReadiness: async (input: { eventId: string }) => {
            if (input.eventId !== eventA) {
              throw new Error('readiness service must not run for a denied event');
            }
            recordLaunchReadiness(input as never);
            const event = await database
              .selectFrom('events')
              .select('version')
              .where('id', '=', input.eventId)
              .executeTakeFirstOrThrow();
            return {
              launchable: publishReadinessLaunchable,
              eventVersion: Number(event.version),
              requiredBlockers: [],
              recommendedWarnings: [],
              steps: [],
            };
          },
          getWorkspaceReadiness,
          acknowledgementSubject,
        }) as never,
      dashboardActionServiceFactory: () => ({ getFeed: getDashboardActions }) as never,
      eventUpdateCheckpoint: (input: { stage: 'before_transaction'; eventId: string }) =>
        eventUpdateCheckpoint(input),
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(eventRoutes);
    await app.register(eventMediaRoutes);
    await app.register(ticketingRoutes);
    await app.register(checkInRoutes);
    await app.register(messagingRoutes);
    await app.register(reportingRoutes);
    await app.register(questionRoutes);
    await app.register(waitlistRoutes);
    await app.register(readinessRoutes);
    await app.ready();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    try {
      if (app) await attemptCleanup(() => app.close());
    } finally {
      try {
        if (db) {
          await attemptCleanup(clearReadinessAcknowledgementEvidence);
          await attemptCleanup(clearSetupSectionEvidence);
          await attemptCleanup(clearPublishEvidence);
          await attemptCleanup(() =>
            db
              .deleteFrom('check_in_lists')
              .where('name', 'in', [authorizedCheckInListName, forbiddenCheckInListName])
              .execute(),
          );
          await attemptCleanup(() =>
            db.deleteFrom('export_jobs').where('id', 'in', operationalExportIds).execute(),
          );
          await attemptCleanup(() =>
            db
              .deleteFrom('webhook_deliveries')
              .where('event_id', 'in', operationalWebhookEventIds)
              .execute(),
          );
          await attemptCleanup(() =>
            db.deleteFrom('webhook_events').where('id', 'in', operationalWebhookEventIds).execute(),
          );
          await attemptCleanup(() =>
            db.deleteFrom('webhook_endpoints').where('id', 'in', operationalEndpointIds).execute(),
          );
          await attemptCleanup(() =>
            db
              .deleteFrom('product_categories')
              .where('name', 'in', [authorizedProductCategoryName, forbiddenProductCategoryName])
              .execute(),
          );
          await attemptCleanup(() =>
            db
              .deleteFrom('questions')
              .where('label', 'in', [authorizedQuestionLabel, forbiddenQuestionLabel])
              .execute(),
          );
          for (const id of createdEventIds) {
            await attemptCleanup(() => db.deleteFrom('events').where('id', '=', id).execute());
          }
          for (const id of [brandA, brandAScoped, brandB]) {
            await attemptCleanup(() => db.deleteFrom('brands').where('id', '=', id).execute());
          }
          for (const id of [organizationA, organizationAScoped, organizationB]) {
            await attemptCleanup(() =>
              db.deleteFrom('organizations').where('id', '=', id).execute(),
            );
          }
          for (const id of [tenantA, tenantB]) {
            await attemptCleanup(() => db.deleteFrom('tenants').where('id', '=', id).execute());
          }
        }
      } finally {
        try {
          if (db) await attemptCleanup(() => db.destroy());
        } finally {
          try {
            restoreDatabaseDriver(previousDriver);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up event authorization fixtures');
    }
  });

  function scenarios(): AuthorizationScenario[] {
    return [
      {
        name: 'cross-tenant principal',
        principal: {
          ...basePrincipal,
          organizationIds: [organizationA],
          tenantId: tenantA,
        },
        targetEventId: eventB,
      },
      {
        name: 'event-scoped principal',
        principal: {
          ...basePrincipal,
          eventIds: [eventA],
          organizationIds: [organizationA, organizationAScoped],
        },
        targetEventId: eventAScoped,
      },
    ];
  }

  describe('read denial', () => {
    it('returns every covered event read to its matching authorized principal', async () => {
      principal = basePrincipal;
      for (const contract of eventReadContracts) {
        const response = await app.inject({
          method: contract.method,
          url: contract.path.replace('{eventId}', eventA),
        });
        expect(response.statusCode, `${contract.path}: ${response.body}`).toBe(
          contract.authorizedControl.status,
        );
      }
    });

    for (const contract of eventReadContracts) {
      it(`${contract.path} hides cross-tenant and out-of-scope events`, async () => {
        for (const scenario of scenarios()) {
          principal = scenario.principal;
          const response = await app.inject({
            method: contract.method,
            url: contract.path.replace('{eventId}', scenario.targetEventId),
          });
          expect(response.statusCode, `${scenario.name}: ${response.body}`).toBe(
            contract.denialResponse.status,
          );
          expect(response.json()).toMatchObject({
            error: { code: contract.denialResponse.code },
          });
        }
      });
    }
  });

  describe('operational-health authorization', () => {
    function invokeOperationalHealth(targetEventId: string) {
      return app.inject({
        method: operationalHealthContract.method,
        url: operationalHealthContract.path.replace('{eventId}', targetEventId),
      });
    }

    it('allows the exact event principal to read only the scoped operational summary', async () => {
      principal = basePrincipal;

      const response = await invokeOperationalHealth(eventA);

      expect(response.statusCode, response.body).toBe(
        operationalHealthContract.authorizedControl.status,
      );
      const body = response.json();
      expect(Object.keys(body).sort()).toEqual(
        ['checkedAt', 'eventId', 'failedExports', 'organizationFailedWebhookDeliveries'].sort(),
      );
      const { checkedAt, ...summary } = body;
      expect(summary).toEqual({
        eventId: eventA,
        organizationFailedWebhookDeliveries: 2,
        failedExports: 1,
      });
      expect(Number.isNaN(Date.parse(checkedAt as string))).toBe(false);
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
      'denies the %s boundary without returning operational data',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();

        const response = await invokeOperationalHealth(targetEvent());

        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        expect(response.body).not.toContain('organizationFailedWebhookDeliveries');
        expect(response.body).not.toContain('failedExports');
      },
    );
  });

  describe('organization readiness authorization', () => {
    const endpoints = ORGANIZATION_READINESS_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map(
      (contract) => ({
        contract,
        invoke: (organizationId: string, brandId: string) =>
          app.inject({
            method: contract.method,
            url: `${contract.path.replace('{organizationId}', organizationId)}?brandId=${brandId}`,
          }),
        service:
          contract.operationId === 'getOrganizationsByOrganizationIdReadiness'
            ? getWorkspaceReadiness
            : getDashboardActions,
        expectedResponse:
          contract.operationId === 'getOrganizationsByOrganizationIdReadiness'
            ? {
                complete: false,
                steps: [{ id: 'workspace-proof', status: 'incomplete' }],
              }
            : {
                actions: [{ id: 'dashboard-proof' }],
                nextCursor: null,
              },
      }),
    );

    beforeEach(() => {
      getWorkspaceReadiness.mockClear();
      getDashboardActions.mockClear();
    });

    it.each(endpoints)(
      'authorizes $contract.path for the exact organization and brand',
      async ({ contract, invoke, service, expectedResponse }) => {
        principal = basePrincipal;

        const response = await invoke(organizationA, brandA);

        expect(response.statusCode, response.body).toBe(contract.authorizedControl.status);
        expect(service).toHaveBeenCalledOnce();
        expect(service).toHaveBeenCalledWith({
          tenantId: tenantA,
          organizationId: organizationA,
          brandId: brandA,
          permissions: new Set(ALL_PERMISSIONS),
        });
        expect(response.json()).toEqual(expectedResponse);
      },
    );

    it.each(endpoints)(
      'denies every $contract.path boundary before evaluating protected data',
      async ({ invoke, service }) => {
        const cases: Array<{
          principal: Principal;
          organizationId: string;
          brandId: string;
          status: 403 | 404;
          code: 'FORBIDDEN' | 'NOT_FOUND';
        }> = [
          {
            principal: { ...basePrincipal, scopes: [] },
            organizationId: organizationA,
            brandId: brandA,
            status: 403,
            code: 'FORBIDDEN',
          },
          {
            principal: {
              ...basePrincipal,
              organizationIds: [organizationB],
              brandIds: [brandB],
            },
            organizationId: organizationB,
            brandId: brandB,
            status: 404,
            code: 'NOT_FOUND',
          },
          {
            principal: {
              ...basePrincipal,
              organizationIds: [organizationA],
              brandIds: [brandAScoped],
            },
            organizationId: organizationAScoped,
            brandId: brandAScoped,
            status: 404,
            code: 'NOT_FOUND',
          },
          {
            principal: {
              ...basePrincipal,
              organizationIds: [organizationA],
              brandIds: [brandAScoped],
            },
            organizationId: organizationA,
            brandId: brandAScoped,
            status: 404,
            code: 'NOT_FOUND',
          },
          {
            principal: {
              ...basePrincipal,
              organizationIds: [organizationA],
              brandIds: [brandAScoped],
            },
            organizationId: organizationA,
            brandId: brandA,
            status: 404,
            code: 'NOT_FOUND',
          },
        ];

        for (const denial of cases) {
          principal = denial.principal;
          service.mockClear();

          const response = await invoke(denial.organizationId, denial.brandId);

          expect(response.statusCode, response.body).toBe(denial.status);
          expect(response.json()).toMatchObject({ error: { code: denial.code } });
          expect(response.body).not.toContain('workspace-proof');
          expect(response.body).not.toContain('dashboard-proof');
          expect(service).not.toHaveBeenCalled();
        }
      },
    );
  });

  it('allows matching principals to create covered resources with persistent evidence', async () => {
    principal = basePrincipal;
    const payloads: Readonly<Record<string, object>> = {
      postEventsByEventIdCheckInLists: { name: authorizedCheckInListName },
      postEventsByEventIdProductCategories: {
        name: authorizedProductCategoryName,
        sortOrder: 0,
      },
      postEventsByEventIdQuestions: {
        label: authorizedQuestionLabel,
        required: false,
        sortOrder: 0,
        type: 'text',
      },
    };

    for (const contract of eventMutationContracts) {
      const response = await app.inject({
        method: contract.method,
        url: contract.path.replace('{eventId}', eventA),
        payload: payloads[contract.operationId],
      });
      expect(response.statusCode, `${contract.path}: ${response.body}`).toBe(
        contract.authorizedControl.status,
      );
      expect(contract.sideEffectAssertions).toContain('persistence');
    }

    const evidence = await Promise.all([
      db
        .selectFrom('check_in_lists')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('name', '=', authorizedCheckInListName)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('product_categories')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('name', '=', authorizedProductCategoryName)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('questions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('label', '=', authorizedQuestionLabel)
        .executeTakeFirstOrThrow(),
    ]);
    expect(evidence.map((result) => Number(result.count))).toEqual([1, 1, 1]);
  });

  it('denies cross-tenant and out-of-event-scope mutations without persistence', async () => {
    const before = {
      checkInLists: await db
        .selectFrom('check_in_lists')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      forbiddenCheckInLists: await db
        .selectFrom('check_in_lists')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('name', '=', forbiddenCheckInListName)
        .executeTakeFirstOrThrow(),
      productCategories: await db
        .selectFrom('product_categories')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      forbiddenProductCategories: await db
        .selectFrom('product_categories')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('name', '=', forbiddenProductCategoryName)
        .executeTakeFirstOrThrow(),
      questions: await db
        .selectFrom('questions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      forbiddenQuestions: await db
        .selectFrom('questions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('label', '=', forbiddenQuestionLabel)
        .executeTakeFirstOrThrow(),
    };

    for (const scenario of scenarios()) {
      principal = scenario.principal;
      const payloads: Readonly<Record<string, object>> = {
        postEventsByEventIdCheckInLists: { name: forbiddenCheckInListName },
        postEventsByEventIdProductCategories: {
          name: forbiddenProductCategoryName,
          sortOrder: 0,
        },
        postEventsByEventIdQuestions: {
          label: forbiddenQuestionLabel,
          required: false,
          sortOrder: 0,
          type: 'text',
        },
      };
      const attempts = await Promise.all(
        eventMutationContracts.map((contract) =>
          app.inject({
            method: contract.method,
            url: contract.path.replace('{eventId}', scenario.targetEventId),
            payload: payloads[contract.operationId],
          }),
        ),
      );
      expect(
        attempts.map((response) => response.statusCode),
        scenario.name,
      ).toEqual(eventMutationContracts.map((contract) => contract.denialResponse.status));
      for (const [index, response] of attempts.entries()) {
        expect(response.json()).toMatchObject({
          error: { code: eventMutationContracts[index]!.denialResponse.code },
        });
      }
    }

    const after = {
      checkInLists: await db
        .selectFrom('check_in_lists')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      forbiddenCheckInLists: await db
        .selectFrom('check_in_lists')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('name', '=', forbiddenCheckInListName)
        .executeTakeFirstOrThrow(),
      productCategories: await db
        .selectFrom('product_categories')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      forbiddenProductCategories: await db
        .selectFrom('product_categories')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('name', '=', forbiddenProductCategoryName)
        .executeTakeFirstOrThrow(),
      questions: await db
        .selectFrom('questions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      forbiddenQuestions: await db
        .selectFrom('questions')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('label', '=', forbiddenQuestionLabel)
        .executeTakeFirstOrThrow(),
    };
    expect(after).toEqual(before);
  });

  describe('setup-section authorization', () => {
    beforeEach(async () => {
      principal = basePrincipal;
      await clearSetupSectionEvidence();
    });

    afterEach(clearSetupSectionEvidence);

    function invokeSetupSection(targetEventId: string, section = 'media') {
      return app.inject({
        method: setupSectionContract.method,
        url: setupSectionContract.path.replace('{eventId}', targetEventId),
        payload: { section },
      });
    }

    it('allows the exact event principal to persist one bounded section and audit', async () => {
      const response = await invokeSetupSection(eventA);

      expect(response.statusCode, response.body).toBe(
        setupSectionContract.authorizedControl.status,
      );
      expect(response.json()).toEqual({ eventId: eventA, section: 'media' });
      const snapshot = await setupSectionSnapshot();
      expect(snapshot.events).toEqual(
        [...createdEventIds]
          .sort()
          .map((id) => ({ id, last_setup_section: id === eventA ? 'media' : null })),
      );
      expect(snapshot.audits).toHaveLength(1);
      expect(snapshot.audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: basePrincipal.id,
        action: 'event.setup_section.update',
        resource_type: 'event',
        resource_id: eventA,
      });
      const storedDiff = snapshot.audits[0]!.diff_summary;
      if (storedDiff === null) throw new Error('setup-section audit omitted diff');
      const diff =
        typeof storedDiff === 'string'
          ? (JSON.parse(storedDiff) as Record<string, unknown>)
          : (storedDiff as Record<string, unknown>);
      expect(diff).toEqual({ section: 'media' });
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
      'denies the %s boundary without changing any section or audit',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();
        const before = await setupSectionSnapshot();

        const response = await invokeSetupSection(targetEvent(), 'marketing-fields');

        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expect(setupSectionSnapshot()).resolves.toEqual(before);
      },
    );
  });

  describe('launch-readiness acknowledgement authorization', () => {
    beforeEach(async () => {
      principal = basePrincipal;
      acknowledgementSubject.mockClear();
      await clearReadinessAcknowledgementEvidence();
    });

    afterEach(clearReadinessAcknowledgementEvidence);

    function invokeAcknowledgement(targetEventId: string) {
      return app.inject({
        method: 'POST',
        url: `/events/${targetEventId}/readiness-acknowledgements/${readinessStepId}`,
      });
    }

    it('allows the exact event principal and persists one bounded acknowledgement and audit', async () => {
      const response = await invokeAcknowledgement(eventA);

      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()).toMatchObject({
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        eventId: eventA,
        stepId: readinessStepId,
        stepVersion: humanAcknowledgementStepVersions.preview_review,
        subjectFingerprint: readinessSubjectFingerprint,
        actorId: basePrincipal.id,
      });
      expect(acknowledgementSubject).toHaveBeenCalledTimes(1);
      expect(acknowledgementSubject).toHaveBeenCalledWith({
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        eventId: eventA,
        stepId: readinessStepId,
      });

      const snapshot = await readinessAcknowledgementSnapshot();
      expect(snapshot.acknowledgements).toHaveLength(1);
      expect(snapshot.acknowledgements[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        event_id: eventA,
        step_id: readinessStepId,
        step_version: humanAcknowledgementStepVersions.preview_review,
        subject_fingerprint: readinessSubjectFingerprint,
        actor_id: basePrincipal.id,
      });
      expect(snapshot.audits).toHaveLength(1);
      expect(snapshot.audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: basePrincipal.id,
        action: 'event.readiness_acknowledged',
        resource_type: 'Event',
        resource_id: eventA,
      });
      const storedDiff = snapshot.audits[0]!.diff_summary;
      if (storedDiff === null) throw new Error('readiness acknowledgement audit omitted diff');
      const diff =
        typeof storedDiff === 'string'
          ? (JSON.parse(storedDiff) as Record<string, unknown>)
          : (storedDiff as Record<string, unknown>);
      expect(diff).toEqual({
        stepId: readinessStepId,
        stepVersion: humanAcknowledgementStepVersions.preview_review,
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
      'denies the %s boundary before subject evaluation or persistence',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();
        const before = await readinessAcknowledgementSnapshot();

        const response = await invokeAcknowledgement(targetEvent());

        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expect(readinessAcknowledgementSnapshot()).resolves.toEqual(before);
        expect(acknowledgementSubject).not.toHaveBeenCalled();
      },
    );
  });

  describe('launch-readiness acknowledgement removal authorization', () => {
    async function seedAcknowledgements(): Promise<void> {
      const repository = new EventReadinessAcknowledgementRepository(db);
      for (const scope of [
        {
          tenantId: tenantA,
          organizationId: organizationA,
          brandId: brandA,
          eventId: eventA,
        },
        {
          tenantId: tenantA,
          organizationId: organizationAScoped,
          brandId: brandAScoped,
          eventId: eventAScoped,
        },
        {
          tenantId: tenantB,
          organizationId: organizationB,
          brandId: brandB,
          eventId: eventB,
        },
      ]) {
        await repository.acknowledge(scope, {
          stepId: readinessStepId,
          stepVersion: humanAcknowledgementStepVersions.preview_review,
          subjectFingerprint: readinessSubjectFingerprint,
          actorId: basePrincipal.id,
        });
      }
    }

    beforeEach(async () => {
      principal = basePrincipal;
      acknowledgementSubject.mockClear();
      await clearReadinessAcknowledgementEvidence();
      await seedAcknowledgements();
    });

    afterEach(clearReadinessAcknowledgementEvidence);

    function invokeRemoval(targetEventId: string) {
      return app.inject({
        method: 'DELETE',
        url: `/events/${targetEventId}/readiness-acknowledgements/${readinessStepId}`,
      });
    }

    it('allows the exact event principal to remove one acknowledgement and records one audit', async () => {
      const before = await readinessAcknowledgementSnapshot();
      expect(before.acknowledgements).toHaveLength(3);

      const response = await invokeRemoval(eventA);

      expect(response.statusCode, response.body).toBe(204);
      expect(response.body).toBe('');
      expect(acknowledgementSubject).not.toHaveBeenCalled();
      const after = await readinessAcknowledgementSnapshot();
      expect(after.acknowledgements).toEqual(
        before.acknowledgements.filter((row) => row.event_id !== eventA),
      );
      expect(after.audits).toHaveLength(1);
      expect(after.audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: basePrincipal.id,
        action: 'event.readiness_acknowledgement_removed',
        resource_type: 'Event',
        resource_id: eventA,
      });
      const storedDiff = after.audits[0]!.diff_summary;
      if (storedDiff === null) throw new Error('readiness removal audit omitted diff');
      const diff =
        typeof storedDiff === 'string'
          ? (JSON.parse(storedDiff) as Record<string, unknown>)
          : (storedDiff as Record<string, unknown>);
      expect(diff).toEqual({ stepId: readinessStepId });
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
      'denies the %s boundary without deleting any protected acknowledgement',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();
        const before = await readinessAcknowledgementSnapshot();
        expect(before.acknowledgements).toHaveLength(3);

        const response = await invokeRemoval(targetEvent());

        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expect(readinessAcknowledgementSnapshot()).resolves.toEqual(before);
        expect(acknowledgementSubject).not.toHaveBeenCalled();
      },
    );
  });

  describe('event update authorization and optimistic concurrency', () => {
    beforeEach(async () => {
      principal = basePrincipal;
      eventUpdateCheckpoint.mockReset();
      eventUpdateCheckpoint.mockResolvedValue(undefined);
      await clearEventUpdateEvidence();
    });
    afterEach(clearEventUpdateEvidence);

    async function versionOf(targetEventId: string): Promise<number> {
      const event = await db
        .selectFrom('events')
        .select('version')
        .where('id', '=', targetEventId)
        .executeTakeFirstOrThrow();
      return Number(event.version);
    }

    function invokeUpdate(
      targetEventId: string,
      expectedVersion: number,
      title: string,
      patch: Record<string, unknown> = {},
    ) {
      return app.inject({
        method: eventUpdateContract.method,
        url: eventUpdateContract.path.replace('{eventId}', targetEventId),
        payload: { expectedVersion, title, description: `${title} description`, ...patch },
      });
    }

    function auditDiff(value: unknown): Record<string, unknown> {
      return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
    }

    it('updates the exact event with one monotonic revision and one exact atomic audit', async () => {
      const before = await eventUpdateSnapshot();
      const eventBefore = before.events.find((event) => event.id === eventA)!;
      const response = await invokeUpdate(eventA, Number(eventBefore.version), 'Updated Event', {
        startsAt: '2027-02-02T18:00:00.987Z',
      });

      expect(response.statusCode, response.body).toBe(eventUpdateContract.authorizedControl.status);
      expect(response.json()).toMatchObject({
        id: eventA,
        title: 'Updated Event',
        description: 'Updated Event description',
        version: Number(eventBefore.version) + 1,
      });
      const after = await eventUpdateSnapshot();
      const eventAfter = after.events.find((event) => event.id === eventA)!;
      expect(eventAfter.starts_at.toISOString()).toBe(response.json().startsAt);
      expect(eventAfter.public_revision?.getTime() ?? 0).toBeGreaterThan(
        eventBefore.public_revision?.getTime() ?? 0,
      );
      expect(after.audits).toHaveLength(1);
      expect(after.audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_id: basePrincipal.id,
        action: 'event.updated',
        resource_type: 'Event',
        resource_id: eventA,
      });
      expect(auditDiff(after.audits[0]!.diff_summary)).toEqual({
        fields: ['description', 'startsAt', 'title'],
        before: {
          description: null,
          startsAt: '2027-01-01T18:00:00.000Z',
          title: 'Allowed Event',
        },
        after: {
          description: 'Updated Event description',
          startsAt: response.json().startsAt,
          title: 'Updated Event',
        },
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
      'denies the %s boundary without event, revision, or audit mutation',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();
        const targetEventId = targetEvent();
        const before = await eventUpdateSnapshot();
        const response = await invokeUpdate(
          targetEventId,
          await versionOf(targetEventId),
          'Forbidden Update',
        );
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expect(eventUpdateSnapshot()).resolves.toEqual(before);
      },
    );

    it('rejects stale updates without event, revision, or audit mutation', async () => {
      const before = await eventUpdateSnapshot();
      const version = await versionOf(eventA);
      const response = await invokeUpdate(eventA, version - 1, 'Stale Update');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'stale_event_version',
          details: { expectedVersion: version - 1, currentVersion: version },
        },
      });
      await expect(eventUpdateSnapshot()).resolves.toEqual(before);
    });

    it('revalidates organization and brand scope against the locked mutation row', async () => {
      let checkpointSnapshot: Awaited<ReturnType<typeof eventUpdateSnapshot>> | undefined;
      eventUpdateCheckpoint.mockImplementationOnce(async () => {
        await db
          .updateTable('events')
          .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
          .where('id', '=', eventA)
          .execute();
        checkpointSnapshot = await eventUpdateSnapshot();
      });

      try {
        const response = await invokeUpdate(eventA, await versionOf(eventA), 'Scope Race');
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        expect(checkpointSnapshot).toBeDefined();
        await expect(eventUpdateSnapshot()).resolves.toEqual(checkpointSnapshot);
      } finally {
        await db
          .updateTable('events')
          .set({ organization_id: organizationA, brand_id: brandA })
          .where('id', '=', eventA)
          .execute();
      }
    });

    it('rolls the event update back when its required audit cannot persist', async () => {
      const before = await eventUpdateSnapshot();
      const failure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('injected event update audit failure'));
      const response = await invokeUpdate(eventA, await versionOf(eventA), 'Rolled Back');
      expect(response.statusCode).toBe(500);
      await expect(eventUpdateSnapshot()).resolves.toEqual(before);
      failure.mockRestore();
    });

    it('allows exactly one winner for concurrent updates at the same version', async () => {
      const before = await eventUpdateSnapshot();
      const eventBefore = before.events.find((event) => event.id === eventA)!;
      const version = Number(eventBefore.version);
      const responses = await Promise.all([
        invokeUpdate(eventA, version, 'Concurrent Alpha'),
        invokeUpdate(eventA, version, 'Concurrent Beta'),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const after = await eventUpdateSnapshot();
      const eventAfter = after.events.find((event) => event.id === eventA)!;
      expect(['Concurrent Alpha', 'Concurrent Beta']).toContain(eventAfter.title);
      expect(Number(eventAfter.version)).toBe(version + 1);
      expect(eventAfter.public_revision?.getTime() ?? 0).toBeGreaterThan(
        eventBefore.public_revision?.getTime() ?? 0,
      );
      expect(after.audits).toHaveLength(1);
      expect(auditDiff(after.audits[0]!.diff_summary)).toMatchObject({
        fields: ['description', 'title'],
        previousVersion: version,
        newVersion: version + 1,
        before: { title: 'Allowed Event', description: null },
        after: { title: eventAfter.title, description: `${eventAfter.title} description` },
      });
    });
  });

  describe('publish authorization and terminal-state safety', () => {
    beforeEach(async () => {
      principal = basePrincipal;
      await clearPublishEvidence();
    });

    afterEach(clearPublishEvidence);

    function invokePublish(targetEventId: string) {
      return app.inject({
        method: publishContract.method,
        url: publishContract.path.replace('{eventId}', targetEventId),
      });
    }

    function storedAuditDiff(value: unknown): Record<string, unknown> {
      return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
    }

    it('publishes the exact ready event atomically and replays without a second mutation or audit', async () => {
      publishReadinessLaunchable = true;
      const before = await publishSnapshot();
      const eventBefore = before.events.find((event) => event.id === eventA);

      const response = await invokePublish(eventA);

      expect(response.statusCode, response.body).toBe(publishContract.authorizedControl.status);
      expect(response.json()).toMatchObject({ id: eventA, status: 'published' });
      expect(recordLaunchReadiness).toHaveBeenCalledOnce();
      const published = await publishSnapshot();
      const publishedEvent = published.events.find((event) => event.id === eventA);
      expect(publishedEvent?.status).toBe('published');
      expect(publishedEvent?.version).toBeGreaterThan(eventBefore?.version ?? 0);
      expect(publishedEvent?.public_revision?.getTime()).toBeGreaterThan(
        eventBefore?.public_revision?.getTime() ?? 0,
      );
      expect(published.audits).toHaveLength(1);
      expect(published.audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: basePrincipal.id,
        action: 'event.published',
        resource_type: 'Event',
        resource_id: eventA,
      });
      expect(storedAuditDiff(published.audits[0]!.diff_summary)).toEqual({
        previousStatus: 'draft',
        newStatus: 'published',
        previousVersion: eventBefore?.version,
        newVersion: publishedEvent?.version,
      });

      const replay = await invokePublish(eventA);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({ id: eventA, status: 'published' });
      expect(recordLaunchReadiness).toHaveBeenCalledOnce();
      await expect(publishSnapshot()).resolves.toEqual(published);
    });

    it('keeps a readiness-blocked draft unchanged and unaudited', async () => {
      const before = await publishSnapshot();

      const response = await invokePublish(eventA);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'launch_readiness_failed' } });
      expect(recordLaunchReadiness).toHaveBeenCalledOnce();
      await expect(publishSnapshot()).resolves.toEqual(before);
    });

    it('keeps archived events terminal without evaluating readiness', async () => {
      await db.updateTable('events').set({ status: 'archived' }).where('id', '=', eventA).execute();
      const before = await publishSnapshot();

      const response = await invokePublish(eventA);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'event_archived' } });
      expect(recordLaunchReadiness).not.toHaveBeenCalled();
      await expect(publishSnapshot()).resolves.toEqual(before);
    });

    it('rolls publication back when its required audit cannot persist', async () => {
      publishReadinessLaunchable = true;
      const before = await publishSnapshot();
      const auditFailure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('injected publish audit failure'));

      const response = await invokePublish(eventA);

      expect(response.statusCode).toBe(500);
      expect(recordLaunchReadiness).toHaveBeenCalledOnce();
      await expect(publishSnapshot()).resolves.toEqual(before);
      auditFailure.mockRestore();
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
      'denies the %s boundary before readiness, publication, revision, or audit mutation',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();
        const before = await publishSnapshot();

        const response = await invokePublish(targetEvent());

        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        expect(recordLaunchReadiness).not.toHaveBeenCalled();
        await expect(publishSnapshot()).resolves.toEqual(before);
      },
    );

    it('serializes publish/archive races with archive terminal and truthful audit/revision evidence', async () => {
      publishReadinessLaunchable = true;
      const revisionQuantum = integrationDatabaseDriver() === 'mysql' ? 1_000 : 1;
      const futureRevision = new Date(
        Math.ceil((Date.now() + 60_000) / revisionQuantum) * revisionQuantum,
      );
      await db
        .updateTable('events')
        .set({ public_revision: futureRevision })
        .where('id', '=', eventA)
        .execute();
      const before = await publishSnapshot();
      const eventBefore = before.events.find((event) => event.id === eventA);

      const [publishResponse, archiveResponse] = await Promise.all([
        invokePublish(eventA),
        app.inject({ method: 'POST', url: `/events/${eventA}/archive` }),
      ]);

      expect([200, 409]).toContain(publishResponse.statusCode);
      expect(archiveResponse.statusCode).toBe(200);
      const after = await publishSnapshot();
      const finalEvent = after.events.find((event) => event.id === eventA);
      const publishCommitted = publishResponse.statusCode === 200;
      const committedTransitions = publishCommitted ? 2 : 1;
      expect(finalEvent?.status).toBe('archived');
      expect(Number(finalEvent?.version)).toBe(Number(eventBefore?.version) + committedTransitions);
      expect(finalEvent?.public_revision?.getTime()).toBe(
        (eventBefore?.public_revision?.getTime() ?? 0) + committedTransitions * revisionQuantum,
      );
      expect(after.audits).toHaveLength(committedTransitions);
      if (publishCommitted) {
        expect(after.audits.map((audit) => audit.action)).toEqual([
          'event.published',
          'event.archived',
        ]);
        expect(storedAuditDiff(after.audits[0]!.diff_summary)).toMatchObject({
          previousStatus: 'draft',
          newStatus: 'published',
        });
        expect(storedAuditDiff(after.audits[1]!.diff_summary)).toMatchObject({
          previousStatus: 'published',
          newStatus: 'archived',
        });
      } else {
        expect(after.audits[0]).toMatchObject({ action: 'event.archived' });
        expect(storedAuditDiff(after.audits[0]!.diff_summary)).toEqual({
          previousStatus: 'draft',
          newStatus: 'archived',
        });
      }
    });
  });

  describe('pause and archive authorization', () => {
    beforeEach(async () => {
      principal = basePrincipal;
      await clearLifecycleEvidence();
    });

    afterEach(clearLifecycleEvidence);

    function auditDiff(value: unknown): unknown {
      return typeof value === 'string' ? JSON.parse(value) : value;
    }

    function invokeLifecycle(operationId: string, targetEventId: string) {
      const contract = lifecycleContracts.find(
        (candidate) => candidate.operationId === operationId,
      );
      if (!contract) throw new Error(`Missing lifecycle contract: ${operationId}`);
      return app.inject({
        method: contract.method,
        url: contract.path.replace('{eventId}', targetEventId),
      });
    }

    it('pauses then archives the exact event with monotonic public revisions and atomic audits', async () => {
      expect(lifecycleContracts).toHaveLength(2);
      const before = await lifecycleSnapshot();
      const eventBefore = before.events.find((event) => event.id === eventA);

      const pausedResponse = await invokeLifecycle('postEventsByEventIdPause', eventA);
      expect(pausedResponse.statusCode, pausedResponse.body).toBe(200);
      expect(pausedResponse.json()).toMatchObject({ id: eventA, status: 'paused' });
      const paused = await lifecycleSnapshot();
      const pausedEvent = paused.events.find((event) => event.id === eventA);
      expect(pausedEvent?.status).toBe('paused');
      expect(pausedEvent?.version).toBeGreaterThan(eventBefore?.version ?? 0);
      expect(pausedEvent?.public_revision?.getTime()).toBeGreaterThan(
        eventBefore?.public_revision?.getTime() ?? 0,
      );
      expect(paused.audits).toHaveLength(1);
      expect(paused.audits[0]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: basePrincipal.id,
        action: 'event.paused',
        resource_type: 'Event',
        resource_id: eventA,
      });
      expect(auditDiff(paused.audits[0]!.diff_summary)).toEqual({
        previousStatus: 'published',
        newStatus: 'paused',
      });
      const repeatedPause = await invokeLifecycle('postEventsByEventIdPause', eventA);
      expect(repeatedPause.statusCode, repeatedPause.body).toBe(200);
      await expect(lifecycleSnapshot()).resolves.toEqual(paused);

      const archivedResponse = await invokeLifecycle('postEventsByEventIdArchive', eventA);
      expect(archivedResponse.statusCode, archivedResponse.body).toBe(200);
      expect(archivedResponse.json()).toMatchObject({ id: eventA, status: 'archived' });
      const archived = await lifecycleSnapshot();
      const archivedEvent = archived.events.find((event) => event.id === eventA);
      expect(archivedEvent?.status).toBe('archived');
      expect(archivedEvent?.version).toBeGreaterThan(pausedEvent?.version ?? 0);
      expect(archivedEvent?.public_revision?.getTime()).toBeGreaterThan(
        pausedEvent?.public_revision?.getTime() ?? 0,
      );
      expect(archived.audits.map((audit) => audit.action)).toEqual([
        'event.paused',
        'event.archived',
      ]);
      expect(archived.audits[1]).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: basePrincipal.id,
        action: 'event.archived',
        resource_type: 'Event',
        resource_id: eventA,
      });
      expect(auditDiff(archived.audits[1]!.diff_summary)).toEqual({
        previousStatus: 'paused',
        newStatus: 'archived',
      });
      const repeatedArchive = await invokeLifecycle('postEventsByEventIdArchive', eventA);
      expect(repeatedArchive.statusCode, repeatedArchive.body).toBe(200);
      await expect(lifecycleSnapshot()).resolves.toEqual(archived);
      const forbiddenResume = await invokeLifecycle('postEventsByEventIdPause', eventA);
      expect(forbiddenResume.statusCode).toBe(409);
      expect(forbiddenResume.json()).toMatchObject({
        error: {
          code: 'CONFLICT',
          details: { currentStatus: 'archived', requestedStatus: 'paused' },
        },
      });
      await expect(lifecycleSnapshot()).resolves.toEqual(archived);
    });

    it('rejects pausing a draft event without state, revision, or audit changes', async () => {
      await db.updateTable('events').set({ status: 'draft' }).where('id', '=', eventA).execute();
      const before = await lifecycleSnapshot();

      const response = await invokeLifecycle('postEventsByEventIdPause', eventA);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'CONFLICT',
          details: { currentStatus: 'draft', requestedStatus: 'paused' },
        },
      });
      await expect(lifecycleSnapshot()).resolves.toEqual(before);
    });

    it.each(lifecycleContracts)(
      'rolls back $operationId when its required audit cannot persist',
      async (contract) => {
        const before = await lifecycleSnapshot();
        const auditFailure = vi
          .spyOn(AuditLogRepository.prototype, 'create')
          .mockRejectedValueOnce(new Error('injected lifecycle audit failure'));

        const response = await invokeLifecycle(contract.operationId, eventA);

        expect(response.statusCode).toBe(500);
        await expect(lifecycleSnapshot()).resolves.toEqual(before);
        auditFailure.mockRestore();
      },
    );

    it('advances every event repository update path monotonically at database precision', async () => {
      const repo = new EventRepository(db);
      const revisions: number[] = [];
      const versions: number[] = [];
      const record = async () => {
        const event = await repo.findById(eventA);
        if (!event?.public_revision) throw new Error('event public revision is missing');
        revisions.push(event.public_revision.getTime());
        versions.push(Number(event.version));
        return event;
      };

      let event = await record();
      await repo.update(eventA, { title: event.title });
      event = await record();
      await repo.updateIfVersion(eventA, Number(event.version), { title: event.title });
      event = await record();
      await repo.publishIfVersion(eventA, Number(event.version));
      await record();
      await repo.updateStatus(eventA, 'paused');
      await record();

      expect(revisions).toHaveLength(5);
      expect(
        revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!),
      ).toBe(true);
      expect(versions).toEqual(versions.map((_version, index) => versions[0]! + index));
    });

    it('serializes concurrent repository revisions into two exact dialect quanta', async () => {
      const repo = new EventRepository(db);
      const revisionQuantum = integrationDatabaseDriver() === 'mysql' ? 1_000 : 1;
      const futureRevision = new Date(
        Math.ceil((Date.now() + 60_000) / revisionQuantum) * revisionQuantum,
      );
      await db
        .updateTable('events')
        .set({ public_revision: futureRevision })
        .where('id', '=', eventA)
        .execute();
      const before = await repo.findById(eventA);
      if (!before?.public_revision) throw new Error('event public revision is missing');

      await Promise.all([
        repo.updateStatus(eventA, 'paused'),
        repo.updateStatus(eventA, 'archived'),
      ]);
      const finalEvent = await repo.findById(eventA);
      expect(Number(finalEvent?.version)).toBe(Number(before.version) + 2);
      expect(finalEvent?.public_revision?.getTime()).toBe(
        before.public_revision.getTime() + 2 * revisionQuantum,
      );
      expect(['paused', 'archived']).toContain(finalEvent?.status);
    });

    it('serializes concurrent lifecycle routes without leaving the archived terminal state', async () => {
      const repo = new EventRepository(db);
      const revisionQuantum = integrationDatabaseDriver() === 'mysql' ? 1_000 : 1;
      const futureRevision = new Date(
        Math.ceil((Date.now() + 60_000) / revisionQuantum) * revisionQuantum,
      );
      await db
        .updateTable('events')
        .set({ public_revision: futureRevision })
        .where('id', '=', eventA)
        .execute();
      const before = await repo.findById(eventA);
      if (!before?.public_revision) throw new Error('event public revision is missing');

      const [pauseResponse, archiveResponse] = await Promise.all([
        invokeLifecycle('postEventsByEventIdPause', eventA),
        invokeLifecycle('postEventsByEventIdArchive', eventA),
      ]);
      expect([200, 409]).toContain(pauseResponse.statusCode);
      expect(archiveResponse.statusCode).toBe(200);

      const after = await lifecycleSnapshot();
      const finalEvent = after.events.find((event) => event.id === eventA);
      const committedTransitions = pauseResponse.statusCode === 200 ? 2 : 1;
      expect(finalEvent?.status).toBe('archived');
      expect(Number(finalEvent?.version)).toBe(Number(before.version) + committedTransitions);
      expect(finalEvent?.public_revision?.getTime()).toBe(
        before.public_revision.getTime() + committedTransitions * revisionQuantum,
      );
      expect(after.audits).toHaveLength(committedTransitions);
      const transitions = after.audits.map(
        (audit) => auditDiff(audit.diff_summary) as { previousStatus: string; newStatus: string },
      );
      const first = transitions.find((transition) => transition.previousStatus === 'published');
      if (!first) throw new Error('concurrent lifecycle audit chain has no published transition');
      if (transitions.length === 1) {
        expect(first).toEqual({ previousStatus: 'published', newStatus: 'archived' });
      } else {
        const second = transitions.find((transition) => transition !== first);
        expect(first).toEqual({ previousStatus: 'published', newStatus: 'paused' });
        expect(second).toEqual({ previousStatus: 'paused', newStatus: 'archived' });
      }
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
      'denies the %s boundary before pause/archive state or audit mutation',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        principal = makePrincipal();
        const before = await lifecycleSnapshot();

        for (const contract of lifecycleContracts) {
          const response = await invokeLifecycle(contract.operationId, targetEvent());
          expect(response.statusCode, response.body).toBe(status);
          expect(response.json()).toMatchObject({ error: { code } });
        }

        await expect(lifecycleSnapshot()).resolves.toEqual(before);
      },
    );
  });
});
