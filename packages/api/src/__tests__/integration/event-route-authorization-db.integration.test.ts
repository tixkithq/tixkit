import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, EventRepository, type Database } from '@tixkit/db';
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
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const eventReadContracts = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.filter(
  (contract) => contract.method === 'GET',
);
const eventMutationContracts = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.filter(
  (contract) =>
    contract.method === 'POST' &&
    contract.operationId !== 'postEventsByEventIdReadinessAcknowledgementsByStepId',
);

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
  const acknowledgementSubject = vi.fn(
    async (_input: {
      tenantId: string;
      organizationId: string;
      brandId: string;
      eventId: string;
      stepId: string;
    }) => readinessSubjectFingerprint,
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
        .where('action', '=', 'event.readiness_acknowledged')
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
      .where('action', '=', 'event.readiness_acknowledged')
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
          acknowledgementSubject,
        }) as never,
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
          await attemptCleanup(() =>
            db
              .deleteFrom('check_in_lists')
              .where('name', 'in', [authorizedCheckInListName, forbiddenCheckInListName])
              .execute(),
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
});
