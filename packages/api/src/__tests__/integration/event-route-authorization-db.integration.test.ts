import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
    contract.method === 'POST' &&
    contract.operationId !== 'postEventsByEventIdReadinessAcknowledgementsByStepId',
);
const setupSectionContract = (() => {
  const contract = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === 'putEventsByEventIdSetupSection',
  );
  if (!contract) throw new Error('setup-section authorization contract is not registered');
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
      readinessServiceFactory: () =>
        ({
          getEventLaunchReadiness: async (input: { eventId: string }) => {
            if (input.eventId !== eventA) {
              throw new Error('readiness service must not run for a denied event');
            }
            return { launchable: false, requiredBlockers: [], steps: [] };
          },
          getWorkspaceReadiness,
          acknowledgementSubject,
        }) as never,
      dashboardActionServiceFactory: () => ({ getFeed: getDashboardActions }) as never,
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
});
