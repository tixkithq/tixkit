import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import {
  TenantRepository,
  OrganizationRepository,
  BrandRepository,
  EventRepository,
  InventoryPoolRepository,
  TicketTypeRepository,
  CheckoutSessionRepository,
  OrderRepository,
} from '../../repositories/index.js';
import { executeTableQuery } from '../../repositories/table-query.js';
import { col, defineTable } from '@tixkit/admin-table-core';
import { ValidationError } from '@tixkit/domain';

// ---------------------------------------------------------------------------
// Driver cases (same pattern as db.integration.test.ts)
// ---------------------------------------------------------------------------

type DriverCase = { driver: 'postgres' | 'mysql' | 'mssql'; url: string };

const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
  { driver: 'mssql', url: process.env.DATABASE_URL_MSSQL ?? '' },
];

const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver ? allDriverCases.filter((c) => c.driver === requestedDriver) : allDriverCases
).filter((c) => c.url.length > 0);

if (driverCases.length === 0) {
  it.skip('table-query integration (skipped: no DATABASE_URL configured)', () => {});
}

// ---------------------------------------------------------------------------
// Test schema (mirrors the orders table schema from the API route)
// ---------------------------------------------------------------------------

const ORDER_STATUS_PRESETS = [
  'pending',
  'paid',
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;

const SALES_CHANNEL_OPTIONS = ['online', 'box_office'] as const;

const testSchema = defineTable('orders', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id').serverField('id'),
    col.enum('eventId', []).serverField('event_id').facet(),
    col.status('status', ORDER_STATUS_PRESETS).serverField('status').sortable().facet(),
    col.enum('salesChannel', SALES_CHANNEL_OPTIONS).serverField('sales_channel').facet(),
    col.boolean('refundState').serverField('refunded_cents').facet(),
    col.money('totalCents').serverField('total_cents').filterable().facet(),
    col.dateTime('createdAt').serverField('created_at').sortable().filterable().facet(),
    col.text('buyerEmail').serverField('buyer_email').filterable().paramAlias('search'),
  ],
});

// ---------------------------------------------------------------------------
// Seeded data helpers
// ---------------------------------------------------------------------------

type Catalog = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
};

async function createCatalog(db: Database): Promise<Catalog> {
  const tenant = await new TenantRepository(db).create({ name: 'Table Query Tenant' });
  const organization = await new OrganizationRepository(db).create({
    tenantId: tenant.id,
    name: 'Table Query Org',
    slug: 'tq-org',
  });
  const brand = await new BrandRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    name: 'Table Query Brand',
    slug: 'tq-brand',
  });
  const event = await new EventRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    brandId: brand.id,
    slug: 'tq-event',
    title: 'Table Query Event',
    description: 'Test event',
    currency: 'USD',
    timezone: 'America/New_York',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
  });
  const pool = await new InventoryPoolRepository(db).create({
    eventId: event.id,
    name: 'GA',
    totalCapacity: 100,
  });
  await new TicketTypeRepository(db).create({
    eventId: event.id,
    inventoryPoolId: pool.id,
    name: 'GA',
    kind: 'paid',
    currency: 'USD',
    priceCents: 2500,
  });
  return {
    tenantId: tenant.id,
    organizationId: organization.id,
    brandId: brand.id,
    eventId: event.id,
  };
}

type SeedOrderInput = {
  db: Database;
  catalog: Catalog;
  id: string;
  orderNumber: string;
  status: string;
  totalCents: number;
  buyerEmail: string;
  salesChannel?: string;
  refundedCents?: number;
  createdAt?: Date;
};

async function seedOrder(input: SeedOrderInput): Promise<Record<string, unknown>> {
  const { db, catalog } = input;
  const sessionRepo = new CheckoutSessionRepository(db);
  const session = await sessionRepo.create({
    tenantId: catalog.tenantId,
    eventId: catalog.eventId,
    brandId: catalog.brandId,
    currency: 'USD',
    cart: {},
    buyer: {},
    quote: {},
    expiresAt: new Date(Date.now() + 3600_000),
    idempotencyKey: `seed-${input.id}`,
  });
  const orderRepo = new OrderRepository(db);
  const order = await orderRepo.create({
    tenantId: catalog.tenantId,
    organizationId: catalog.organizationId,
    brandId: catalog.brandId,
    eventId: catalog.eventId,
    checkoutSessionId: session.id,
    orderNumber: input.orderNumber,
    status: input.status,
    currency: 'USD',
    subtotalCents: input.totalCents,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: input.totalCents,
    buyerEmail: input.buyerEmail,
    salesChannel: (input.salesChannel as 'online' | 'box_office') ?? 'online',
    operatorId: input.salesChannel === 'box_office' ? 'usr_table_query_box_office' : undefined,
    tenderType: input.salesChannel === 'box_office' ? 'cash' : undefined,
  });
  if (input.refundedCents && input.refundedCents > 0) {
    await orderRepo.update((order as Record<string, unknown>).id as string, {
      refunded_cents: input.refundedCents,
      status: input.refundedCents >= input.totalCents ? 'refunded' : 'partially_refunded',
    });
  }
  if (input.createdAt) {
    await db
      .updateTable('orders')
      .set({ created_at: input.createdAt })
      .where('id', '=', order.id as string)
      .execute();
  }
  return order as Record<string, unknown>;
}

function serializeOrder(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    salesChannel: row.sales_channel,
    totalCents: Number(row.total_cents),
    refundedCents: Number(row.refunded_cents),
    buyerEmail: row.buyer_email,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential.each(driverCases)('table-query integration: $driver', ({ driver, url }) => {
  let db: Database;
  let catalog: Catalog;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
  }, 120_000);

  beforeEach(async () => {
    await truncateAllData(db);
    catalog = await createCatalog(db);
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  }, 60_000);

  // -----------------------------------------------------------------------
  // Filter contract tests
  // -----------------------------------------------------------------------

  describe('filters', () => {
    beforeEach(async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_1',
        orderNumber: 'TK-001',
        status: 'paid',
        totalCents: 10_000,
        buyerEmail: 'alice@test.com',
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_2',
        orderNumber: 'TK-002',
        status: 'paid',
        totalCents: 5_000,
        buyerEmail: 'bob@test.com',
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_3',
        orderNumber: 'TK-003',
        status: 'failed',
        totalCents: 3_000,
        buyerEmail: 'carol@test.com',
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_4',
        orderNumber: 'TK-004',
        status: 'cancelled',
        totalCents: 7_500,
        buyerEmail: 'dave@test.com',
        salesChannel: 'box_office',
      });
    });

    it('text filter: case-insensitive partial match on buyerEmail', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { search: 'ALICE', limit: 50 },
      );

      expect(result.items).toHaveLength(1);
      expect((result.items[0] as Record<string, unknown>).buyerEmail).toBe('alice@test.com');
    });

    it('text filter: partial match on substring', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { search: '@test.com', limit: 50 },
      );

      expect(result.items).toHaveLength(4);
    });

    it('select filter: IN semantics for status', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          filters: { status: { type: 'select', values: ['paid', 'failed'] } },
        },
      );

      expect(result.items).toHaveLength(3);
      const statuses = result.items.map((i) => (i as Record<string, unknown>).status);
      expect(statuses.every((s) => s === 'paid' || s === 'failed')).toBe(true);
    });

    it('select filter: multi-value for salesChannel', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          filters: { salesChannel: { type: 'select', values: ['box_office'] } },
        },
      );

      expect(result.items).toHaveLength(1);
      expect((result.items[0] as Record<string, unknown>).salesChannel).toBe('box_office');
    });

    it('number_range filter: min only', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          filters: { totalCents: { type: 'number_range', min: 6_000 } },
        },
      );

      expect(result.items).toHaveLength(2);
      const totals = result.items.map((i) => Number((i as Record<string, unknown>).totalCents));
      expect(totals.every((t) => t >= 6_000)).toBe(true);
    });

    it('number_range filter: max only', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          filters: { totalCents: { type: 'number_range', max: 5_000 } },
        },
      );

      expect(result.items).toHaveLength(2);
      const totals = result.items.map((i) => Number((i as Record<string, unknown>).totalCents));
      expect(totals.every((t) => t <= 5_000)).toBe(true);
    });

    it('number_range filter: min and max inclusive', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          filters: { totalCents: { type: 'number_range', min: 3_000, max: 7_500 } },
        },
      );

      expect(result.items).toHaveLength(3);
    });

    it('custom boolean filter: refundState true', async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_refunded',
        orderNumber: 'TK-REF',
        status: 'refunded',
        totalCents: 10_000,
        buyerEmail: 'ref@test.com',
        refundedCents: 10_000,
      });

      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
          customFilters: {
            refundState: (q, value) => {
              if (value.type === 'boolean') {
                return value.value
                  ? q.where('refunded_cents', '>', 0)
                  : q.where('refunded_cents', '=', 0);
              }
              return q;
            },
          },
        },
        {
          limit: 50,
          filters: { refundState: { type: 'boolean', value: true } },
        },
      );

      expect(result.items).toHaveLength(1);
      expect((result.items[0] as Record<string, unknown>).buyerEmail).toBe('ref@test.com');
    });

    it('custom boolean filter: refundState false', async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_refunded',
        orderNumber: 'TK-REF',
        status: 'refunded',
        totalCents: 10_000,
        buyerEmail: 'ref@test.com',
        refundedCents: 10_000,
      });

      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
          customFilters: {
            refundState: (q, value) => {
              if (value.type === 'boolean') {
                return value.value
                  ? q.where('refunded_cents', '>', 0)
                  : q.where('refunded_cents', '=', 0);
              }
              return q;
            },
          },
        },
        {
          limit: 50,
          filters: { refundState: { type: 'boolean', value: false } },
        },
      );

      expect(result.items).toHaveLength(4);
    });
  });

  // -----------------------------------------------------------------------
  // Facet contract tests
  // -----------------------------------------------------------------------

  describe('facets', () => {
    beforeEach(async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_1',
        orderNumber: 'TK-001',
        status: 'paid',
        totalCents: 10_000,
        buyerEmail: 'alice@test.com',
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_2',
        orderNumber: 'TK-002',
        status: 'paid',
        totalCents: 5_000,
        buyerEmail: 'bob@test.com',
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_3',
        orderNumber: 'TK-003',
        status: 'failed',
        totalCents: 3_000,
        buyerEmail: 'carol@test.com',
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_4',
        orderNumber: 'TK-004',
        status: 'cancelled',
        totalCents: 7_500,
        buyerEmail: 'dave@test.com',
        salesChannel: 'box_office',
        refundedCents: 7_500,
      });
    });

    it('select facet: correct group-by counts for status', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 50, includeFacets: true },
      );

      const statusFacet = result.facets?.status;
      expect(statusFacet?.rows).toBeDefined();
      const paidRow = statusFacet!.rows!.find((r) => r.value === 'paid');
      const failedRow = statusFacet!.rows!.find((r) => r.value === 'failed');
      const refundedRow = statusFacet!.rows!.find((r) => r.value === 'refunded');
      expect(paidRow?.total).toBe(2);
      expect(failedRow?.total).toBe(1);
      expect(refundedRow?.total).toBe(1);
    });

    it('range facet: min and max for totalCents', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 50, includeFacets: true },
      );

      const totalFacet = result.facets?.totalCents;
      expect(totalFacet?.min).toBe(3_000);
      expect(totalFacet?.max).toBe(10_000);
    });

    it('custom facet: refundState computed boolean counts', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
          customFacets: {
            refundState: async (q) => {
              const rows = (await q
                .select([
                  sql`case when refunded_cents > 0 then true else false end`.as('is_refunded'),
                  sql`count(*)`.as('total'),
                ])
                .groupBy('is_refunded')
                .execute()) as Array<{ is_refunded: boolean | number; total: number }>;
              return {
                rows: rows.map((r) => ({
                  value: r.is_refunded === true || r.is_refunded === 1,
                  total: Number(r.total),
                })),
              };
            },
          },
        },
        { limit: 50, includeFacets: true },
      );

      const refundFacet = result.facets?.refundState;
      expect(refundFacet?.rows).toBeDefined();
      const trueRow = refundFacet!.rows!.find((r) => r.value === true);
      const falseRow = refundFacet!.rows!.find((r) => r.value === false);
      expect(trueRow?.total).toBe(1);
      expect(falseRow?.total).toBe(3);
    });

    it('three-pass: facet excludes own field filter but includes other filters', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          includeFacets: true,
          filters: { status: { type: 'select', values: ['paid'] } },
        },
      );

      // status facet should show ALL statuses (not just paid) because the
      // three-pass strategy excludes the active status filter from the status facet query
      const statusFacet = result.facets?.status;
      expect(statusFacet?.rows).toBeDefined();
      const paidRow = statusFacet!.rows!.find((r) => r.value === 'paid');
      const failedRow = statusFacet!.rows!.find((r) => r.value === 'failed');
      const refundedRow = statusFacet!.rows!.find((r) => r.value === 'refunded');
      expect(paidRow?.total).toBe(2);
      expect(failedRow?.total).toBe(1);
      expect(refundedRow?.total).toBe(1);

      // But the data items should only include paid orders
      expect(result.items.every((i) => (i as Record<string, unknown>).status === 'paid')).toBe(
        true,
      );
    });

    it('facet includes other active filters', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          includeFacets: true,
          filters: { salesChannel: { type: 'select', values: ['online'] } },
        },
      );

      // status facet should only count online orders (3 out of 4)
      const statusFacet = result.facets?.status;
      expect(statusFacet?.rows).toBeDefined();
      const paidRow = statusFacet!.rows!.find((r) => r.value === 'paid');
      const failedRow = statusFacet!.rows!.find((r) => r.value === 'failed');
      expect(paidRow?.total).toBe(2);
      expect(failedRow?.total).toBe(1);
      // cancelled was box_office, should not appear
      const cancelledRow = statusFacet!.rows!.find((r) => r.value === 'cancelled');
      expect(cancelledRow).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Cursor pagination contract tests
  // -----------------------------------------------------------------------

  describe('cursor pagination', () => {
    beforeEach(async () => {
      // Create 5 orders with distinct created_at timestamps
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- deterministic seed order keeps cursor expectations readable.
        await seedOrder({
          db,
          catalog,
          id: `ord_${i + 1}`,
          orderNumber: `TK-${String(i + 1).padStart(3, '0')}`,
          status: 'paid',
          totalCents: (i + 1) * 1000,
          buyerEmail: `user${i + 1}@test.com`,
          createdAt: new Date(2026, 0, i + 1),
        });
      }
    });

    it('returns first page with nextCursor when more data exists', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 2 },
      );

      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeDefined();
      expect(result.prevCursor).toBeUndefined();
      // Descending order by createdAt
      expect((result.items[0] as Record<string, unknown>).buyerEmail).toBe('user5@test.com');
      expect((result.items[1] as Record<string, unknown>).buyerEmail).toBe('user4@test.com');
    });

    it('nextCursor produces the next page with no overlap', async () => {
      const page1 = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 2 },
      );

      expect(page1.nextCursor).toBeDefined();

      const page2 = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 2, cursor: page1.nextCursor },
      );

      expect(page2.items).toHaveLength(2);
      const page1Ids = page1.items.map((i) => (i as Record<string, unknown>).id);
      const page2Ids = new Set(page2.items.map((i) => (i as Record<string, unknown>).id));
      expect(page1Ids.some((id) => page2Ids.has(id))).toBe(false);
      expect((page2.items[0] as Record<string, unknown>).buyerEmail).toBe('user3@test.com');
      expect((page2.items[1] as Record<string, unknown>).buyerEmail).toBe('user2@test.com');
    });

    it('prevCursor produces the previous page with no overlap', async () => {
      const page1 = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 2 },
      );

      const page2 = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 2, cursor: page1.nextCursor },
      );

      expect(page2.prevCursor).toBeDefined();

      const page1Again = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        { limit: 2, cursor: page2.prevCursor, direction: 'prev' },
      );

      const page2Ids = page2.items.map((i) => (i as Record<string, unknown>).id);
      const prevIds = page1Again.items.map((i) => (i as Record<string, unknown>).id);
      expect(page2Ids.some((id) => prevIds.includes(id))).toBe(false);
      // prev direction should return the items that come before page2
      expect(prevIds).toContain((page1.items[0] as Record<string, unknown>).id);
      expect(prevIds).toContain((page1.items[1] as Record<string, unknown>).id);
    });

    it('keyset pagination maintains sort order across pages', async () => {
      const allItems: Record<string, unknown>[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < 3; page++) {
        // eslint-disable-next-line no-await-in-loop -- each page depends on the previous cursor.
        const result = await executeTableQuery(
          db,
          {
            tableName: 'orders',
            schema: testSchema,
            tenantId: catalog.tenantId,
            serialize: serializeOrder,
          },
          { limit: 2, cursor },
        );

        allItems.push(...result.items.map((i) => i as Record<string, unknown>));
        cursor = result.nextCursor;
        if (!cursor) break;
      }

      expect(allItems).toHaveLength(5);
      // Verify descending order is maintained
      for (let i = 1; i < allItems.length; i++) {
        const prev = allItems[i - 1];
        const curr = allItems[i];
        expect(new Date(curr.createdAt as string).getTime()).toBeLessThanOrEqual(
          new Date(prev.createdAt as string).getTime(),
        );
      }
    });

    it('ascending sort produces reversed order', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          sort: [{ field: 'createdAt', direction: 'asc' }],
        },
      );

      expect((result.items[0] as Record<string, unknown>).buyerEmail).toBe('user1@test.com');
      expect((result.items[4] as Record<string, unknown>).buyerEmail).toBe('user5@test.com');
    });
  });

  // -----------------------------------------------------------------------
  // Combined interaction tests
  // -----------------------------------------------------------------------

  describe('combined interactions', () => {
    beforeEach(async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_1',
        orderNumber: 'TK-001',
        status: 'paid',
        totalCents: 10_000,
        buyerEmail: 'alice@test.com',
        createdAt: new Date(2026, 0, 1),
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_2',
        orderNumber: 'TK-002',
        status: 'paid',
        totalCents: 5_000,
        buyerEmail: 'bob@test.com',
        createdAt: new Date(2026, 0, 2),
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_3',
        orderNumber: 'TK-003',
        status: 'failed',
        totalCents: 3_000,
        buyerEmail: 'carol@test.com',
        createdAt: new Date(2026, 0, 3),
      });
      await seedOrder({
        db,
        catalog,
        id: 'ord_4',
        orderNumber: 'TK-004',
        status: 'paid',
        totalCents: 15_000,
        buyerEmail: 'dave@test.com',
        salesChannel: 'box_office',
        createdAt: new Date(2026, 0, 4),
      });
    });

    it('search + select filter + sort + cursor together', async () => {
      const page1 = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 1,
          search: '@test.com',
          sort: [{ field: 'createdAt', direction: 'asc' }],
          filters: { status: { type: 'select', values: ['paid'] } },
        },
      );

      expect(page1.items).toHaveLength(1);
      expect((page1.items[0] as Record<string, unknown>).buyerEmail).toBe('alice@test.com');
      expect(page1.nextCursor).toBeDefined();

      const page2 = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 1,
          search: '@test.com',
          sort: [{ field: 'createdAt', direction: 'asc' }],
          filters: { status: { type: 'select', values: ['paid'] } },
          cursor: page1.nextCursor,
        },
      );

      expect(page2.items).toHaveLength(1);
      expect((page2.items[0] as Record<string, unknown>).buyerEmail).toBe('bob@test.com');
    });

    it('multiple filters of different types intersect correctly', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          filters: {
            status: { type: 'select', values: ['paid'] },
            totalCents: { type: 'number_range', min: 8_000 },
          },
        },
      );

      expect(result.items).toHaveLength(2);
      // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh mapped array keeps the assertion deterministic.
      const emails = result.items.map((i) => (i as Record<string, unknown>).buyerEmail).sort();
      expect(emails).toEqual(['alice@test.com', 'dave@test.com']);
    });

    it('facet + filter on a different field', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          includeFacets: true,
          filters: { status: { type: 'select', values: ['paid'] } },
        },
      );

      // salesChannel facet should reflect only paid orders
      const channelFacet = result.facets?.salesChannel;
      expect(channelFacet?.rows).toBeDefined();
      const onlineRow = channelFacet!.rows!.find((r) => r.value === 'online');
      const boxOfficeRow = channelFacet!.rows!.find((r) => r.value === 'box_office');
      expect(onlineRow?.total).toBe(2);
      expect(boxOfficeRow?.total).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Validation tests
  // -----------------------------------------------------------------------

  describe('strict validation', () => {
    beforeEach(async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_1',
        orderNumber: 'TK-001',
        status: 'paid',
        totalCents: 10_000,
        buyerEmail: 'alice@test.com',
      });
    });

    it('rejects unknown filter field with 400', async () => {
      await expect(
        executeTableQuery(
          db,
          {
            tableName: 'orders',
            schema: testSchema,
            tenantId: catalog.tenantId,
            serialize: serializeOrder,
            strictValidation: true,
          },
          {
            limit: 50,
            filters: { unknownField: { type: 'text', value: 'test' } },
          },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects filter type mismatch with 400', async () => {
      await expect(
        executeTableQuery(
          db,
          {
            tableName: 'orders',
            schema: testSchema,
            tenantId: catalog.tenantId,
            serialize: serializeOrder,
            strictValidation: true,
          },
          {
            limit: 50,
            // status is a 'select' filter, not 'text'
            filters: { status: { type: 'text', value: 'paid' } },
          },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects unknown sort field with 400', async () => {
      await expect(
        executeTableQuery(
          db,
          {
            tableName: 'orders',
            schema: testSchema,
            tenantId: catalog.tenantId,
            serialize: serializeOrder,
            strictValidation: true,
          },
          {
            limit: 50,
            sort: [{ field: 'unknownField', direction: 'asc' }],
          },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it('silently drops unknown filter in lenient mode and surfaces in applied.rejectedFilters', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
          // strictValidation defaults to false
        },
        {
          limit: 50,
          filters: { unknownField: { type: 'text', value: 'test' } },
        },
      );

      expect(result.items).toHaveLength(1);
      expect(result.applied?.rejectedFilters).toEqual(['unknownField']);
      expect(result.applied?.filters).toEqual({});
    });

    it('silently drops unknown sort in lenient mode and surfaces in applied.rejectedSort', async () => {
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: catalog.tenantId,
          serialize: serializeOrder,
        },
        {
          limit: 50,
          sort: [{ field: 'unknownField', direction: 'asc' }],
        },
      );

      // Falls back to default sort
      expect(result.applied?.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
      expect(result.applied?.rejectedSort).toEqual(['unknownField']);
    });
  });

  // -----------------------------------------------------------------------
  // Scope isolation tests
  // -----------------------------------------------------------------------

  describe('scope isolation', () => {
    it('scope filters are applied before user filters', async () => {
      await seedOrder({
        db,
        catalog,
        id: 'ord_1',
        orderNumber: 'TK-001',
        status: 'paid',
        totalCents: 10_000,
        buyerEmail: 'alice@test.com',
      });

      // Use a wrong tenant_id in scope to get zero results
      const result = await executeTableQuery(
        db,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: 'wrong_tenant',
          serialize: serializeOrder,
        },
        { limit: 50, includeTotal: true },
      );

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });
});
