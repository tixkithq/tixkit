import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { CheckInListRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { OFFLINE_MANIFEST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

function requireContract(operationId: string) {
  const contract = OFFLINE_MANIFEST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!contract) throw new Error(`Missing offline manifest authorization contract ${operationId}`);
  return contract;
}

const manifestContract = requireContract('getEventsByEventIdCheckInListsByCheckInListIdManifest');
const keysContract = requireContract('getEventsByEventIdCheckInManifestKeys');

const runId = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_manifest_a_${runId}`;
const tenantB = `tnt_manifest_b_${runId}`;
const organizationA = `org_manifest_a_${runId}`;
const organizationOther = `org_manifest_other_${runId}`;
const organizationB = `org_manifest_b_${runId}`;
const brandA = `brd_manifest_a_${runId}`;
const brandOther = `brd_manifest_other_${runId}`;
const brandOrganizationOther = `brd_m_org_${runId}`;
const brandB = `brd_manifest_b_${runId}`;
const eventAuthorized = `evt_manifest_auth_${runId}`;
const eventTenantDenied = `evt_manifest_tenant_${runId}`;
const eventOrganizationDenied = `evt_manifest_org_${runId}`;
const eventBrandDenied = `evt_manifest_brand_${runId}`;
const eventScopeDenied = `evt_manifest_scope_${runId}`;
const principalId = `usr_manifest_auth_${runId}`;

let authorizedListId: string;
let eventScopeListId: string;
let db: Database;
let previousDriver: string | undefined;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: principalId,
    tenantId: tenantA,
    organizationIds: [organizationA],
    brandIds: [brandA],
    eventIds: [eventAuthorized],
    scopes: ['checkins.read'],
    ...overrides,
  };
}

async function buildApp(activePrincipal: Principal): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('context', { db } as AppContext);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(checkInRoutes);
  return app;
}

async function insertTenant(id: string, label: string): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({
      id,
      name: `Offline manifest ${label} ${runId}`,
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertOrganization(input: {
  id: string;
  tenantId: string;
  slug: string;
}): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
  await db
    .insertInto('organizations')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      name: `Offline manifest ${input.slug}`,
      slug: `${input.slug}-${runId}`,
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertBrand(input: {
  id: string;
  tenantId: string;
  organizationId: string;
  slug: string;
}): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
  await db
    .insertInto('brands')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      name: `Offline manifest ${input.slug}`,
      slug: `${input.slug}-${runId}`,
      status: 'active',
      theme: '{}',
      legal_urls: '{}',
      white_label: false,
      payment_account_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertEvent(input: {
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  slug: string;
}): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
  await db
    .insertInto('events')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      brand_id: input.brandId,
      slug: `${input.slug}-${runId}`,
      title: `Offline manifest ${input.slug}`,
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date('2027-01-01T18:00:00.000Z'),
      ends_at: null,
      venue: null,
      visibility: 'private',
      seo: '{}',
      capacity: null,
      cover_image_url: null,
      external_url: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function seedFixture(): Promise<void> {
  await insertTenant(tenantA, 'tenant A');
  await insertTenant(tenantB, 'tenant B');
  await insertOrganization({ id: organizationA, tenantId: tenantA, slug: 'organization-a' });
  await insertOrganization({
    id: organizationOther,
    tenantId: tenantA,
    slug: 'organization-other',
  });
  await insertOrganization({ id: organizationB, tenantId: tenantB, slug: 'organization-b' });
  await insertBrand({
    id: brandA,
    tenantId: tenantA,
    organizationId: organizationA,
    slug: 'brand-a',
  });
  await insertBrand({
    id: brandOther,
    tenantId: tenantA,
    organizationId: organizationA,
    slug: 'brand-other',
  });
  await insertBrand({
    id: brandOrganizationOther,
    tenantId: tenantA,
    organizationId: organizationOther,
    slug: 'brand-organization-other',
  });
  await insertBrand({
    id: brandB,
    tenantId: tenantB,
    organizationId: organizationB,
    slug: 'brand-b',
  });
  await insertEvent({
    id: eventAuthorized,
    tenantId: tenantA,
    organizationId: organizationA,
    brandId: brandA,
    slug: 'authorized',
  });
  await insertEvent({
    id: eventTenantDenied,
    tenantId: tenantB,
    organizationId: organizationB,
    brandId: brandB,
    slug: 'tenant-denied',
  });
  await insertEvent({
    id: eventOrganizationDenied,
    tenantId: tenantA,
    organizationId: organizationOther,
    brandId: brandOrganizationOther,
    slug: 'organization-denied',
  });
  await insertEvent({
    id: eventBrandDenied,
    tenantId: tenantA,
    organizationId: organizationA,
    brandId: brandOther,
    slug: 'brand-denied',
  });
  await insertEvent({
    id: eventScopeDenied,
    tenantId: tenantA,
    organizationId: organizationA,
    brandId: brandA,
    slug: 'event-denied',
  });
  const authorizedList = await new CheckInListRepository(db).create({
    eventId: eventAuthorized,
    name: `Authorized doors ${runId}`,
    ticketTypeIds: [],
  });
  const eventScopeList = await new CheckInListRepository(db).create({
    eventId: eventScopeDenied,
    name: `Other event doors ${runId}`,
    ticketTypeIds: [],
  });
  authorizedListId = authorizedList.id;
  eventScopeListId = eventScopeList.id;
}

async function cleanupFixture(): Promise<void> {
  await db
    .deleteFrom('check_in_lists')
    .where('event_id', 'in', [eventAuthorized, eventScopeDenied])
    .execute();
  await db
    .deleteFrom('events')
    .where('id', 'in', [
      eventAuthorized,
      eventTenantDenied,
      eventOrganizationDenied,
      eventBrandDenied,
      eventScopeDenied,
    ])
    .execute();
  await db
    .deleteFrom('brands')
    .where('id', 'in', [brandA, brandOther, brandOrganizationOther, brandB])
    .execute();
  await db
    .deleteFrom('organizations')
    .where('id', 'in', [organizationA, organizationOther, organizationB])
    .execute();
  await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
}

function manifestUrl(eventId: string, checkInListId: string): string {
  return manifestContract.path
    .replace('{eventId}', eventId)
    .replace('{checkInListId}', checkInListId);
}

function keysUrl(eventId: string): string {
  return keysContract.path.replace('{eventId}', eventId);
}

const deniedScenarios = {
  tenant: {
    principal: () =>
      principal({
        organizationIds: [organizationB],
        brandIds: [brandB],
        eventIds: [eventTenantDenied],
      }),
    eventId: eventTenantDenied,
  },
  organization: {
    principal: () =>
      principal({
        brandIds: [brandOrganizationOther],
        eventIds: [eventOrganizationDenied],
      }),
    eventId: eventOrganizationDenied,
  },
  brand: {
    principal: () => principal({ eventIds: [eventBrandDenied] }),
    eventId: eventBrandDenied,
  },
  event: {
    principal: () => principal(),
    eventId: eventScopeDenied,
  },
} as const;

describeWithIntegrationDatabase(
  `offline manifest route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
    }, 120_000);

    afterAll(async () => {
      try {
        if (db) {
          try {
            await cleanupFixture();
          } finally {
            await db.destroy();
          }
        }
      } finally {
        restoreDatabaseDriver(previousDriver);
      }
    }, 120_000);

    beforeEach(async () => {
      await cleanupFixture();
      await seedFixture();
    }, 120_000);

    it('binds both executable routes to immutable manifest authorization contracts', () => {
      expect(OFFLINE_MANIFEST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS).toHaveLength(2);
      expect(manifestContract).toMatchObject({
        method: 'GET',
        path: '/events/{eventId}/check-in-lists/{checkInListId}/manifest',
        resourceParameters: ['eventId', 'checkInListId'],
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      });
      expect(keysContract).toMatchObject({
        method: 'GET',
        path: '/events/{eventId}/check-in-manifest-keys',
        resourceParameters: ['eventId'],
        deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      });
    });

    it('returns the manifest and verification keys to the exact authorized principal', async () => {
      const app = await buildApp(principal());
      try {
        const manifestResponse = await app.inject({
          method: manifestContract.method,
          url: manifestUrl(eventAuthorized, authorizedListId),
        });
        expect(manifestResponse.statusCode, manifestResponse.body).toBe(
          manifestContract.authorizedControl.status,
        );
        expect(manifestResponse.json()).toMatchObject({
          eventId: eventAuthorized,
          checkInListId: authorizedListId,
          tickets: [],
        });

        const keysResponse = await app.inject({
          method: keysContract.method,
          url: keysUrl(eventAuthorized),
        });
        expect(keysResponse.statusCode, keysResponse.body).toBe(
          keysContract.authorizedControl.status,
        );
        expect(keysResponse.json()).toMatchObject({
          issuer: expect.any(String),
          keys: expect.any(Array),
        });
      } finally {
        await app.close();
      }
    });

    it.each([manifestContract, keysContract])(
      '$path denies missing checkins.read without resolving event or list scope',
      async (contract) => {
        const app = await buildApp(principal({ scopes: [] }));
        try {
          const response = await app.inject({
            method: contract.method,
            url:
              contract === manifestContract
                ? manifestUrl(eventAuthorized, authorizedListId)
                : keysUrl(eventAuthorized),
          });
          expect(response.statusCode).toBe(contract.permissionDenialResponse?.status);
          expect(response.json()).toMatchObject({
            error: { code: contract.permissionDenialResponse?.code },
          });
        } finally {
          await app.close();
        }
      },
    );

    it.each(Object.entries(deniedScenarios))(
      'conceals the %s boundary identically for manifest and key discovery',
      async (_boundary, scenario) => {
        const app = await buildApp(scenario.principal());
        try {
          const responses = await Promise.all([
            app.inject({
              method: manifestContract.method,
              url: manifestUrl(scenario.eventId, authorizedListId),
            }),
            app.inject({ method: keysContract.method, url: keysUrl(scenario.eventId) }),
          ]);
          for (const response of responses) {
            expect(response.statusCode).toBe(manifestContract.denialResponse.status);
            expect(response.json()).toMatchObject({
              error: { code: manifestContract.denialResponse.code },
            });
          }
        } finally {
          await app.close();
        }
      },
      120_000,
    );

    it('conceals a list bound to another event after exact event authorization succeeds', async () => {
      const app = await buildApp(principal());
      try {
        const response = await app.inject({
          method: manifestContract.method,
          url: manifestUrl(eventAuthorized, eventScopeListId),
        });
        expect(response.statusCode).toBe(manifestContract.denialResponse.status);
        expect(response.json()).toMatchObject({
          error: { code: manifestContract.denialResponse.code },
        });
      } finally {
        await app.close();
      }
    });

    it('allows an exact mobile scanner scope and conceals every other event', async () => {
      const scanner = principal({
        type: 'mobile_device',
        id: `dev_manifest_${runId}`,
        eventIds: [eventAuthorized],
      });
      const app = await buildApp(scanner);
      try {
        const authorized = await Promise.all([
          app.inject({
            method: manifestContract.method,
            url: manifestUrl(eventAuthorized, authorizedListId),
          }),
          app.inject({ method: keysContract.method, url: keysUrl(eventAuthorized) }),
        ]);
        expect(authorized.map((response) => response.statusCode)).toEqual([200, 200]);

        const denied = await Promise.all([
          app.inject({
            method: manifestContract.method,
            url: manifestUrl(eventScopeDenied, eventScopeListId),
          }),
          app.inject({ method: keysContract.method, url: keysUrl(eventScopeDenied) }),
        ]);
        for (const response of denied) {
          expect(response.statusCode).toBe(404);
          expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        }
      } finally {
        await app.close();
      }
    });
  },
);
