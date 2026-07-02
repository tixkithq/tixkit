import { expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import { InventoryService } from '../../services/inventory.js';
import { HoldExpiredError, InventoryExhaustedError } from '@tixkit/domain';
import { ulid } from 'ulid';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

/**
 * Real database concurrency tests for inventory reserve/finalize/refund.
 * These tests require a running database (bun run infra:up).
 * They prove that sold_count never exceeds capacity under concurrent load.
 */

let db: Database;
let inventoryService: InventoryService;
let previousDbDriver: string | undefined;

const TENANT_ID = `tnt_conc_${ulid().slice(-10)}`;
const ORG_ID = `org_conc_${ulid().slice(-10)}`;
const BRAND_ID = `brd_conc_${ulid().slice(-10)}`;
const EVENT_ID = `evt_conc_${ulid().slice(-10)}`;

async function seedEvent(trx: Database): Promise<void> {
  await trx
    .insertInto('tenants')
    .values({
      id: TENANT_ID,
      name: 'Concurrency Test Tenant',
      status: 'active',
      plan: 'test',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await trx
    .insertInto('organizations')
    .values({
      id: ORG_ID,
      tenant_id: TENANT_ID,
      name: 'Concurrency Test Org',
      slug: `conc-${Date.now()}`,
      clerk_organization_id: null,
      box_office_settings: JSON.stringify({
        enabled: true,
        allowedTenderTypes: ['cash', 'manual_card', 'comp'],
        requireBuyerEmail: false,
        receiptMode: 'email',
      }),
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await trx
    .insertInto('brands')
    .values({
      id: BRAND_ID,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      name: 'Concurrency Test Brand',
      slug: `conc-${Date.now()}`,
      status: 'active',
      theme: JSON.stringify({}),
      legal_urls: JSON.stringify({}),
      white_label: false,
      payment_account_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await trx
    .insertInto('events')
    .values({
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      brand_id: BRAND_ID,
      slug: `conc-${Date.now()}`,
      title: 'Concurrency Test Event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date(Date.now() + 86400000),
      ends_at: null,
      visibility: 'public',
      seo: JSON.stringify({}),
      capacity: null,
      cover_image_url: null,
      external_url: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
}

async function cleanupEvent(database: Database): Promise<void> {
  // Clean up in reverse FK order
  await database
    .deleteFrom('checkout_holds')
    .where('checkout_session_id', 'like', 'cs_conc_%')
    .execute();
  await database.deleteFrom('checkout_sessions').where('id', 'like', 'cs_conc_%').execute();
  await database.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('event_occurrences').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await database.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await database.deleteFrom('brands').where('id', '=', BRAND_ID).execute();
  await database.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await database.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function createPool(database: Database, capacity: number, ttl = 300): Promise<string> {
  const poolId = `pool_conc_${ulid().slice(-10)}`;
  await database
    .insertInto('inventory_pools')
    .values({
      id: poolId,
      event_id: EVENT_ID,
      name: `Concurrency Pool ${poolId}`,
      total_capacity: capacity,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: ttl,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return poolId;
}

async function createOccurrence(database: Database, capacity: number | null): Promise<string> {
  const occurrenceId = `occ_conc_${ulid().slice(-10)}`;
  await database
    .insertInto('event_occurrences')
    .values({
      id: occurrenceId,
      event_id: EVENT_ID,
      title: `Occurrence ${occurrenceId}`,
      starts_at: new Date(Date.now() + 86400000),
      ends_at: new Date(Date.now() + 90000000),
      timezone: 'UTC',
      venue: null,
      capacity,
      sort_order: 0,
      status: 'scheduled',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return occurrenceId;
}

async function createTicketType(
  database: Database,
  poolId: string,
  occurrenceId?: string,
): Promise<string> {
  const ticketTypeId = `tt_conc_${ulid().slice(-10)}`;
  await database
    .insertInto('ticket_types')
    .values({
      id: ticketTypeId,
      event_id: EVENT_ID,
      name: `Concurrency Ticket ${ticketTypeId}`,
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 1000,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      event_occurrence_id: occurrenceId ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return ticketTypeId;
}

async function createCheckoutSession(
  database: Database,
  _poolId: string,
  ticketTypeId: string,
  occurrenceId?: string,
): Promise<string> {
  const sessionId = `cs_conc_${ulid().slice(-10)}`;
  await database
    .insertInto('checkout_sessions')
    .values({
      id: sessionId,
      tenant_id: TENANT_ID,
      event_id: EVENT_ID,
      brand_id: BRAND_ID,
      status: 'open',
      hold_id: `hld_${ulid()}`,
      currency: 'USD',
      cart: JSON.stringify({
        items: [{ ticketTypeId, ...(occurrenceId ? { occurrenceId } : {}), quantity: 1 }],
      }),
      buyer: JSON.stringify({ email: 'test@example.com' }),
      quote: JSON.stringify({
        totalCents: 1000,
        feeCents: 0,
        subtotalCents: 1000,
        discountCents: 0,
        taxCents: 0,
      }),
      expires_at: new Date(Date.now() + 300000),
      idempotency_key: `ik_${ulid()}`,
      success_url: null,
      cancel_url: null,
      order_id: null,
      client_token: ulid(),
      payment_intent_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return sessionId;
}

describeWithIntegrationDatabase('InventoryService concurrency', () => {
  beforeAll(async () => {
    previousDbDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    inventoryService = new InventoryService(db);
    await seedEvent(db);
  });

  afterAll(async () => {
    await cleanupEvent(db);
    await db.destroy();
    restoreDatabaseDriver(previousDbDriver);
  });

  beforeEach(async () => {
    // Clean up any leftover pools/sessions from previous tests
    await db
      .deleteFrom('checkout_holds')
      .where('checkout_session_id', 'like', 'cs_conc_%')
      .execute();
    await db.deleteFrom('checkout_sessions').where('id', 'like', 'cs_conc_%').execute();
    await db.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('event_occurrences').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  });

  it('prevents oversell when concurrent carts reserve more than capacity', async () => {
    const CAPACITY = 10;
    const CONCURRENT_CLIENTS = 20;
    const QUANTITY_PER_CLIENT = 1;

    const poolId = await createPool(db, CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId);

    // Create checkout sessions for each client
    const sessionIds: string[] = [];
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
      // eslint-disable-next-line no-await-in-loop -- setup creates distinct persisted sessions before the concurrent reservation phase begins.
      sessionIds.push(await createCheckoutSession(db, poolId, ticketTypeId));
    }

    // All clients try to reserve concurrently
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) =>
        inventoryService.reserveCart({
          items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: QUANTITY_PER_CLIENT }],
          checkoutSessionId: sessionId,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    // Exactly CAPACITY reservations should succeed
    expect(succeeded).toBe(CAPACITY);
    expect(failed).toBe(CONCURRENT_CLIENTS - CAPACITY);

    // Verify sold_count + active_holds never exceeds capacity
    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();

    const activeHolds = await db
      .selectFrom('checkout_holds')
      .select(db.fn.sum('quantity').as('total'))
      .where('inventory_pool_id', '=', poolId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    const held = Number(activeHolds?.total ?? 0);
    expect(Number(pool.sold_count)).toBe(0);
    expect(held).toBe(CAPACITY);
    expect(Number(pool.sold_count) + held).toBeLessThanOrEqual(CAPACITY);
  });

  it('prevents oversell when concurrent carts exceed occurrence capacity before pool capacity', async () => {
    const OCCURRENCE_CAPACITY = 2;
    const CONCURRENT_CLIENTS = 6;
    const poolId = await createPool(db, 20);
    const occurrenceId = await createOccurrence(db, OCCURRENCE_CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId, occurrenceId);

    const sessionIds: string[] = [];
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
      // eslint-disable-next-line no-await-in-loop -- setup creates distinct persisted sessions before concurrent occurrence reservations start.
      sessionIds.push(await createCheckoutSession(db, poolId, ticketTypeId, occurrenceId));
    }

    const results = await Promise.allSettled(
      sessionIds.map((sessionId) =>
        inventoryService.reserveCart({
          items: [{ inventoryPoolId: poolId, ticketTypeId, occurrenceId, quantity: 1 }],
          checkoutSessionId: sessionId,
        }),
      ),
    );

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.filter((result) => result.status === 'rejected');

    expect(succeeded).toBe(OCCURRENCE_CAPACITY);
    expect(failed).toHaveLength(CONCURRENT_CLIENTS - OCCURRENCE_CAPACITY);
    for (const result of failed) {
      expect(result.reason).toBeInstanceOf(InventoryExhaustedError);
    }

    const occurrenceHolds = await db
      .selectFrom('checkout_holds')
      .select(db.fn.sum('quantity').as('total'))
      .where('event_occurrence_id', '=', occurrenceId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    const poolHolds = await db
      .selectFrom('checkout_holds')
      .select(db.fn.sum('quantity').as('total'))
      .where('inventory_pool_id', '=', poolId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    expect(Number(occurrenceHolds?.total ?? 0)).toBe(OCCURRENCE_CAPACITY);
    expect(Number(poolHolds?.total ?? 0)).toBe(OCCURRENCE_CAPACITY);
  });

  it('prevents oversell when concurrent finalizations convert holds', async () => {
    const CAPACITY = 5;
    const CONCURRENT_CLIENTS = 5;

    const poolId = await createPool(db, CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId);

    // Create sessions and reserve inventory sequentially (to ensure all get holds)
    const sessionIds: string[] = [];
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
      // eslint-disable-next-line no-await-in-loop -- each setup session must exist before reserving its hold.
      const sessionId = await createCheckoutSession(db, poolId, ticketTypeId);
      // eslint-disable-next-line no-await-in-loop -- this precondition intentionally reserves all holds before concurrent finalization starts.
      await inventoryService.reserveCart({
        items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
        checkoutSessionId: sessionId,
      });
      sessionIds.push(sessionId);
    }

    // All clients try to convert holds concurrently
    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => inventoryService.convertHoldsForSession(sessionId)),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    // All 5 should succeed (they all have valid holds)
    expect(succeeded).toBe(CONCURRENT_CLIENTS);
    expect(failed).toBe(0);

    // Verify sold_count never exceeds capacity
    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();

    expect(Number(pool.sold_count)).toBe(CAPACITY);
    expect(Number(pool.sold_count)).toBeLessThanOrEqual(CAPACITY);
  });

  it('expired holds cannot be converted and do not increment sold_count', async () => {
    const CAPACITY = 3;
    const poolId = await createPool(db, CAPACITY, 1); // 1 second TTL
    const ticketTypeId = await createTicketType(db, poolId);

    const sessionId = await createCheckoutSession(db, poolId, ticketTypeId);
    await inventoryService.reserveCart({
      items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
      checkoutSessionId: sessionId,
    });

    // Wait for hold to expire
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Attempt to convert expired hold
    await expect(inventoryService.convertHoldsForSession(sessionId)).rejects.toThrow(
      HoldExpiredError,
    );

    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();

    expect(Number(pool.sold_count)).toBe(0);
  });

  it('concurrent reserve and finalize do not oversell a shared pool', async () => {
    const CAPACITY = 10;
    const poolId = await createPool(db, CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId);

    // Pre-reserve 5 holds
    const preReservedSessions: string[] = [];
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- setup creates one session and active hold at a time before the mixed concurrency phase.
      const sessionId = await createCheckoutSession(db, poolId, ticketTypeId);
      // eslint-disable-next-line no-await-in-loop -- pre-reserved holds are the deterministic baseline for the later concurrent finalize/reserve race.
      await inventoryService.reserveCart({
        items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
        checkoutSessionId: sessionId,
      });
      preReservedSessions.push(sessionId);
    }

    // Now concurrently: finalize the 5 pre-reserved + 10 new reserve attempts
    const newSessions: string[] = [];
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- setup creates independent sessions before the concurrent reserve attempts are launched.
      newSessions.push(await createCheckoutSession(db, poolId, ticketTypeId));
    }

    const finalizePromises = preReservedSessions.map((sessionId) =>
      inventoryService.convertHoldsForSession(sessionId),
    );
    const reservePromises = newSessions.map((sessionId) =>
      inventoryService.reserveCart({
        items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
        checkoutSessionId: sessionId,
      }),
    );

    const [finalizeResults, reserveResults] = await Promise.all([
      Promise.allSettled(finalizePromises),
      Promise.allSettled(reservePromises),
    ]);

    const finalizeSucceeded = finalizeResults.filter((r) => r.status === 'fulfilled').length;
    const reserveSucceeded = reserveResults.filter((r) => r.status === 'fulfilled').length;

    // All 5 finalizations should succeed
    expect(finalizeSucceeded).toBe(5);
    // Only 5 of 10 new reservations should succeed (capacity 10 - 5 sold = 5 available)
    expect(reserveSucceeded).toBe(5);

    const pool = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();

    const activeHolds = await db
      .selectFrom('checkout_holds')
      .select(db.fn.sum('quantity').as('total'))
      .where('inventory_pool_id', '=', poolId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    const held = Number(activeHolds?.total ?? 0);
    expect(Number(pool.sold_count)).toBe(5);
    expect(held).toBe(5);
    expect(Number(pool.sold_count) + held).toBeLessThanOrEqual(CAPACITY);
  });

  it('refund restore decrements sold_count correctly', async () => {
    const CAPACITY = 3;
    const poolId = await createPool(db, CAPACITY);
    const ticketTypeId = await createTicketType(db, poolId);

    // Reserve and convert 3 holds
    const sessionIds: string[] = [];
    for (let i = 0; i < CAPACITY; i++) {
      // eslint-disable-next-line no-await-in-loop -- refund setup intentionally creates, reserves, and converts each session before assertions.
      const sessionId = await createCheckoutSession(db, poolId, ticketTypeId);
      // eslint-disable-next-line no-await-in-loop -- each hold must be active before it is converted for the refund-restore fixture.
      await inventoryService.reserveCart({
        items: [{ inventoryPoolId: poolId, ticketTypeId, quantity: 1 }],
        checkoutSessionId: sessionId,
      });
      // eslint-disable-next-line no-await-in-loop -- converted sold inventory is the required starting state for the restore check.
      await inventoryService.convertHoldsForSession(sessionId);
      sessionIds.push(sessionId);
    }

    const poolAfterSold = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    expect(Number(poolAfterSold.sold_count)).toBe(CAPACITY);

    // Restore inventory for one hold
    const holds = await db
      .selectFrom('checkout_holds')
      .selectAll()
      .where('checkout_session_id', '=', sessionIds[0])
      .execute();

    await inventoryService.restoreInventory(holds[0].id, 1);

    const poolAfterRestore = await db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', poolId)
      .executeTakeFirstOrThrow();
    expect(Number(poolAfterRestore.sold_count)).toBe(CAPACITY - 1);
  });
});
