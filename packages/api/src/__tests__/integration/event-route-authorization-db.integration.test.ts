import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
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

const eventReadRoutes = [
  '/events/:eventId',
  '/events/:eventId/attendees',
  '/events/:eventId/availability',
  '/events/:eventId/check-in-lists',
  '/events/:eventId/launch-readiness',
  '/events/:eventId/media',
  '/events/:eventId/messages',
  '/events/:eventId/questions',
  '/events/:eventId/reports/sales',
  '/events/:eventId/waitlist',
] as const;

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
  const forbiddenCheckInListName = `Forbidden list ${suffix}`;
  const forbiddenProductCategoryName = `Forbidden category ${suffix}`;
  const forbiddenQuestionLabel = `Forbidden question ${suffix}`;
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
          getEventLaunchReadiness: async () => {
            throw new Error('readiness service must not run for a denied event');
          },
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
          await attemptCleanup(() =>
            db.deleteFrom('check_in_lists').where('name', '=', forbiddenCheckInListName).execute(),
          );
          await attemptCleanup(() =>
            db
              .deleteFrom('product_categories')
              .where('name', '=', forbiddenProductCategoryName)
              .execute(),
          );
          await attemptCleanup(() =>
            db.deleteFrom('questions').where('label', '=', forbiddenQuestionLabel).execute(),
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
    for (const route of eventReadRoutes) {
      it(`${route} hides cross-tenant and out-of-scope events`, async () => {
        for (const scenario of scenarios()) {
          principal = scenario.principal;
          const response = await app.inject({
            method: 'GET',
            url: route.replace(':eventId', scenario.targetEventId),
          });
          expect(response.statusCode, `${scenario.name}: ${response.body}`).toBe(404);
          expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        }
      });
    }
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
      const attempts = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/events/${scenario.targetEventId}/check-in-lists`,
          payload: { name: forbiddenCheckInListName },
        }),
        app.inject({
          method: 'POST',
          url: `/events/${scenario.targetEventId}/product-categories`,
          payload: { name: forbiddenProductCategoryName, sortOrder: 0 },
        }),
        app.inject({
          method: 'POST',
          url: `/events/${scenario.targetEventId}/questions`,
          payload: {
            label: forbiddenQuestionLabel,
            required: false,
            sortOrder: 0,
            type: 'text',
          },
        }),
      ]);
      expect(
        attempts.map((response) => response.statusCode),
        scenario.name,
      ).toEqual([404, 404, 404]);
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
});
