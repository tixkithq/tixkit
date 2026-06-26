import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  BrandRepository,
  EventRepository,
  InventoryPoolRepository,
  OrganizationRepository,
  TenantRepository,
  TicketTypeRepository,
} from '../../repositories/index.js';

type DriverCase = {
  driver: 'postgres' | 'mysql';
  url: string;
};

// When DATABASE_URL / DATABASE_URL_MYSQL are unset (no --env-file), the
// driver case is excluded so the suite skips gracefully instead of failing
// with an invalid URL. When set (via `bun --env-file=.env.local run
// test:integration`), the real connection string is used.
const allDriverCases: DriverCase[] = [
  {
    driver: 'postgres',
    url: process.env.DATABASE_URL ?? '',
  },
  {
    driver: 'mysql',
    url: process.env.DATABASE_URL_MYSQL ?? '',
  },
];

const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (requestedDriver
  ? allDriverCases.filter((driverCase) => driverCase.driver === requestedDriver)
  : allDriverCases
).filter((driverCase) => driverCase.url.length > 0);

async function createCatalog(db: Database) {
  const tenant = await new TenantRepository(db).create({ name: 'Integration Tenant' });
  const organization = await new OrganizationRepository(db).create({
    tenantId: tenant.id,
    name: 'Integration Org',
    slug: 'integration-org',
  });
  const brand = await new BrandRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    name: 'Integration Brand',
    slug: 'integration-brand',
  });
  const event = await new EventRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    brandId: brand.id,
    slug: 'integration-event',
    title: 'Integration Event',
    description: 'Repository parity test event',
    currency: 'USD',
    timezone: 'America/New_York',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
  });
  const pool = await new InventoryPoolRepository(db).create({
    eventId: event.id,
    name: 'General Admission',
    totalCapacity: 25,
  });
  const ticketType = await new TicketTypeRepository(db).create({
    eventId: event.id,
    inventoryPoolId: pool.id,
    name: 'GA',
    kind: 'paid',
    currency: 'USD',
    priceCents: 2500,
  });

  return { tenant, organization, brand, event, pool, ticketType };
}

// Guard: when no DATABASE_URL / DATABASE_URL_MYSQL is configured (no
// --env-file), vitest would fail with "no test suite found". Add a single
// skipped test so the suite reports a clean skip instead of an error.
if (driverCases.length === 0) {
  it.skip('database integration (skipped: no DATABASE_URL or DATABASE_URL_MYSQL configured)', () => {});
}

describe.each(driverCases)('database integration: $driver', ({ driver, url }) => {
  let db: Database;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    // Ensure the schema is migrated once before all tests in this driver
    // case. This replaces the old per-test `resetSchema` which dropped and
    // recreated the entire schema, causing conflicts with concurrent API
    // integration tests sharing the same database.
    await runMigrations(url);
    db = createDb(url);
  }, 120_000);

  beforeEach(async () => {
    // Non-destructive: remove all rows but keep the schema intact so
    // concurrent test suites are not affected.
    await truncateAllData(db);
  }, 60_000);

  afterEach(async () => {
    // Keep the connection alive between tests; destroyed in afterAll.
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  }, 60_000);

  it('runs the initial migration and persists core catalog records through repositories', async () => {
    const { tenant, organization, brand, event, pool, ticketType } = await createCatalog(db);

    await expect(new TenantRepository(db).findById(tenant.id)).resolves.toMatchObject({
      id: tenant.id,
      name: 'Integration Tenant',
    });
    await expect(new OrganizationRepository(db).findByTenant(tenant.id)).resolves.toHaveLength(1);
    await expect(new BrandRepository(db).findByOrganization(organization.id)).resolves.toHaveLength(1);
    await expect(new EventRepository(db).findByTenant(tenant.id)).resolves.toHaveLength(1);
    await expect(new InventoryPoolRepository(db).findByEvent(event.id)).resolves.toMatchObject([
      {
        id: pool.id,
        total_capacity: 25,
      },
    ]);
    const ticketTypes = await new TicketTypeRepository(db).findByEvent(event.id);
    expect(ticketTypes).toHaveLength(1);
    expect(ticketTypes[0]?.id).toBe(ticketType.id);
    expect(Number(ticketTypes[0]?.price_cents)).toBe(2500);
    await expect(new BrandRepository(db).findById(brand.id)).resolves.toMatchObject({
      tenant_id: tenant.id,
      organization_id: organization.id,
    });
  });

  it('enforces tenant-scoped unique slugs', async () => {
    const { tenant } = await createCatalog(db);

    await expect(
      new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: 'Duplicate Org',
        slug: 'integration-org',
      }),
    ).rejects.toThrow();
  });

  it('rejects orphaned checkout sessions through foreign keys', async () => {
    await expect(
      db
        .insertInto('checkout_sessions')
        .values({
          id: 'cs_orphan',
          tenant_id: 'tnt_missing',
          event_id: 'evt_missing',
          brand_id: 'brd_missing',
          status: 'open',
          hold_id: 'hld_missing',
          currency: 'USD',
          cart: JSON.stringify({ items: [] }),
          buyer: JSON.stringify({}),
          quote: JSON.stringify({ totalCents: 0 }),
          payment_intent_id: null,
          order_id: null,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2027-01-01T19:00:00.000Z'),
          idempotency_key: 'idem_orphan',
          client_token: 'client_orphan',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects orphaned ticket types through foreign keys', async () => {
    await expect(
      db
        .insertInto('ticket_types')
        .values({
          id: 'tt_orphan',
          event_id: 'evt_missing',
          name: 'Orphan',
          description: null,
          kind: 'paid',
          status: 'active',
          visibility: 'public',
          currency: 'USD',
          price_cents: 2500,
          minimum_price_cents: null,
          sales_start_at: null,
          sales_end_at: null,
          min_per_order: 1,
          max_per_order: 10,
          inventory_pool_id: 'pool_missing',
          sort_order: 0,
          requires_access_code: false,
          access_code_hint: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('lists public ticket types by default and explicitly requested hidden ticket types by direct-link id', async () => {
    const { event, ticketType } = await createCatalog(db);
    const hiddenPool = await new InventoryPoolRepository(db).create({
      eventId: event.id,
      name: 'Invite Pool',
      totalCapacity: 10,
    });
    const hiddenTicketType = await new TicketTypeRepository(db).create({
      eventId: event.id,
      inventoryPoolId: hiddenPool.id,
      name: 'Invite Only',
      kind: 'paid',
      currency: 'USD',
      priceCents: 7500,
      visibility: 'hidden',
    });
    const ttRepo = new TicketTypeRepository(db);

    await expect(ttRepo.findPublicOrRequestedByEvent(event.id, [])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ticketType.id, visibility: 'public' }),
      ]),
    );
    await expect(ttRepo.findPublicOrRequestedByEvent(event.id, [])).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hiddenTicketType.id }),
      ]),
    );
    await expect(ttRepo.findPublicOrRequestedByEvent(event.id, [hiddenTicketType.id])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ticketType.id, visibility: 'public' }),
        expect.objectContaining({ id: hiddenTicketType.id, visibility: 'hidden' }),
      ]),
    );
  });

  it('rejects invalid inventory pool counts through check constraints', async () => {
    const { event } = await createCatalog(db);

    await expect(
      db
        .insertInto('inventory_pools')
        .values({
          id: 'pool_invalid_counts',
          event_id: event.id,
          name: 'Invalid',
          total_capacity: -1,
          reserved_count: 0,
          sold_count: 0,
          hold_ttl_seconds: 900,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      db
        .insertInto('inventory_pools')
        .values({
          id: 'pool_oversold_counts',
          event_id: event.id,
          name: 'Oversold',
          total_capacity: 1,
          reserved_count: 0,
          sold_count: 2,
          hold_ttl_seconds: 900,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects orphaned commercial configuration through foreign keys', async () => {
    const { event } = await createCatalog(db);

    await expect(
      db
        .insertInto('discount_codes')
        .values({
          id: 'disc_orphan_event',
          event_id: 'evt_missing',
          code: 'MISSING',
          type: 'fixed',
          value: 100,
          currency: 'USD',
          max_uses: 10,
          uses_count: 0,
          valid_from: null,
          valid_until: null,
          min_order_cents: null,
          max_discount_cents: null,
          ticket_type_ids: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      db
        .insertInto('products')
        .values({
          id: 'prod_missing_category',
          event_id: event.id,
          name: 'VIP Parking',
          description: null,
          price_cents: 500,
          currency: 'USD',
          category_id: 'pc_missing',
          max_per_order: 1,
          available_from: null,
          available_until: null,
          status: 'active',
          sort_order: 0,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects invalid commercial configuration through check constraints', async () => {
    const { ticketType } = await createCatalog(db);

    await expect(
      db
        .insertInto('access_rules')
        .values({
          id: 'access_invalid_usage',
          ticket_type_id: ticketType.id,
          type: 'code',
          value: 'INVITE',
          max_uses: 1,
          uses_count: 2,
          expires_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
      .execute(),
    ).rejects.toThrow();
  });

  it('persists export job events for replay', async () => {
    const { tenant, event } = await createCatalog(db);
    await db
      .insertInto('export_jobs')
      .values({
        id: 'exp_integration',
        tenant_id: tenant.id,
        event_id: event.id,
        type: 'attendees',
        format: 'csv',
        status: 'pending',
        file_url: null,
        requested_by: 'usr_integration',
        filters: JSON.stringify({ status: 'active' }),
        created_at: new Date(),
        completed_at: null,
      })
      .execute();

    await db
      .insertInto('export_job_events')
      .values({
        id: 'eev_00000000000000000000000001',
        tenant_id: tenant.id,
        export_job_id: 'exp_integration',
        status: 'pending',
        payload: JSON.stringify({ exportId: 'exp_integration', status: 'pending' }),
        created_at: new Date(),
      })
      .execute();

    await expect(
      db
        .selectFrom('export_job_events')
        .selectAll()
        .where('tenant_id', '=', tenant.id)
        .where('export_job_id', '=', 'exp_integration')
        .where('id', '>', 'eev_00000000000000000000000000')
        .execute(),
    ).resolves.toMatchObject([
      {
        id: 'eev_00000000000000000000000001',
        status: 'pending',
      },
    ]);
  });
});
