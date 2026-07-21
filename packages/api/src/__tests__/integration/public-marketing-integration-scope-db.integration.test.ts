import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, EventRepository, type Database } from '@tixkit/db';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { publicRoutes } from '../../routes/modules/public.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_pub_mkt_a_${suffix}`;
const tenantB = `tnt_pub_mkt_b_${suffix}`;
const organizationA = `org_pub_mkt_a_${suffix}`;
const organizationB = `org_pub_mkt_b_${suffix}`;
const brandA = `brd_pub_mkt_a_${suffix}`;
const brandB = `brd_pub_mkt_b_${suffix}`;
const allowedIntegration = `mkt_pub_allowed_${suffix}`;
const corruptIntegration = `mkt_pub_corrupt_${suffix}`;

let app: FastifyInstance;
let db: Database;
let eventId: string;
let previousDriver: string | undefined;

async function insertTenant(id: string, name: string): Promise<void> {
  const now = new Date('2026-07-21T01:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
    .execute();
}

async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
  const now = new Date('2026-07-21T01:00:00.000Z');
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
  const now = new Date('2026-07-21T01:00:00.000Z');
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

async function insertIntegration(input: {
  brandId: string;
  config: Record<string, string>;
  id: string;
  organizationId: string;
  provider: string;
  tenantId: string;
}): Promise<void> {
  const now = new Date('2026-07-21T01:30:00.000Z');
  await db
    .insertInto('marketing_integrations')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      brand_id: input.brandId,
      event_id: eventId,
      provider: input.provider,
      config: JSON.stringify(input.config),
      consent_required: true,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function marketingSnapshot() {
  return db
    .selectFrom('marketing_integrations')
    .selectAll()
    .where('id', 'in', [allowedIntegration, corruptIntegration])
    .orderBy('id')
    .execute();
}

describeWithIntegrationDatabase('public marketing integration scope isolation', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Public marketing tenant A');
    await insertTenant(tenantB, 'Public marketing tenant B');
    await insertOrganization(organizationA, tenantA, 'Public marketing organization A');
    await insertOrganization(organizationB, tenantB, 'Public marketing organization B');
    await insertBrand(brandA, tenantA, organizationA, 'Public marketing brand A');
    await insertBrand(brandB, tenantB, organizationB, 'Public marketing brand B');
    const event = await new EventRepository(db).create({
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      slug: `public-marketing-${suffix}`,
      title: 'Public marketing scope proof',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-09-01T18:00:00.000Z'),
      endsAt: new Date('2027-09-01T22:00:00.000Z'),
      venue: { name: 'Public marketing scope hall' },
    });
    eventId = event.id;
    await db.updateTable('events').set({ status: 'published' }).where('id', '=', eventId).execute();

    await insertIntegration({
      id: allowedIntegration,
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      provider: 'ga4',
      config: { measurementId: `G-ALLOWED-${suffix}` },
    });
    app = Fastify({ logger: false });
    app.decorate('context', { db, inventoryService: {} } as AppContext);
    registerErrorHandler(app);
    await app.register(publicRoutes);
    await app.ready();
  }, 120_000);

  beforeEach(async () => {
    await db.deleteFrom('marketing_integrations').where('id', '=', corruptIntegration).execute();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    if (app) await attempt(() => app.close());
    if (db) {
      await attempt(() =>
        db
          .deleteFrom('marketing_integrations')
          .where('id', 'in', [allowedIntegration, corruptIntegration])
          .execute(),
      );
      if (eventId) await attempt(() => db.deleteFrom('events').where('id', '=', eventId).execute());
      await attempt(() => db.deleteFrom('brands').where('id', 'in', [brandA, brandB]).execute());
      await attempt(() =>
        db.deleteFrom('organizations').where('id', 'in', [organizationA, organizationB]).execute(),
      );
      await attempt(() => db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute());
      await attempt(() => db.destroy());
    }
    try {
      restoreDatabaseDriver(previousDriver);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to clean up public marketing scope proof');
    }
  }, 120_000);

  it.each([
    ['tenant', tenantB, organizationA, brandA],
    ['organization', tenantA, organizationB, brandA],
    ['brand', tenantA, organizationA, brandB],
  ] as const)(
    'rejects a safe active integration that mismatches only the public event %s',
    async (boundary, mismatchedTenant, mismatchedOrganization, mismatchedBrand) => {
      const protectedPixelId = `PIXEL-${boundary.toUpperCase()}-${suffix}`;
      await insertIntegration({
        id: corruptIntegration,
        tenantId: mismatchedTenant,
        organizationId: mismatchedOrganization,
        brandId: mismatchedBrand,
        provider: 'meta_pixel',
        config: { pixelId: protectedPixelId },
      });
      const before = await marketingSnapshot();
      expect(before).toHaveLength(2);
      expect(before.find((row) => row.id === corruptIntegration)).toMatchObject({
        tenant_id: mismatchedTenant,
        organization_id: mismatchedOrganization,
        brand_id: mismatchedBrand,
        event_id: eventId,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/public/events/${eventId}/marketing-integrations`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            provider: 'ga4',
            config: { measurementId: `G-ALLOWED-${suffix}` },
            consentRequired: true,
            status: 'active',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
      expect(response.body).not.toContain(protectedPixelId);
      await expect(marketingSnapshot()).resolves.toEqual(before);
    },
  );
});
