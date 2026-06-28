import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import { ulid } from 'ulid';
import { processWaitlistOffersActivity } from '../activities/hold-expiration.js';

const RUN_ID = ulid().slice(-10);
const TENANT_ID = `tnt_wl_${RUN_ID}`;
const ORG_ID = `org_wl_${RUN_ID}`;
const BRAND_ID = `brd_wl_${RUN_ID}`;
const EVENT_ID = `evt_wl_${RUN_ID}`;
const POOL_ID = `pool_wl_${RUN_ID}`;
const TICKET_TYPE_ID = `tt_wl_${RUN_ID}`;
const SHARED_POOL_TICKET_TYPE_ID = `tt_wl_shared_${RUN_ID}`;

describe('processWaitlistOffersActivity', () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb();
    await seedBaseRows(db);
  });

  afterAll(async () => {
    await cleanupRows(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom('email_jobs').where('tenant_id', '=', TENANT_ID).execute();
    await db.deleteFrom('waitlist_entries').where('event_id', '=', EVENT_ID).execute();
    await db.deleteFrom('checkout_holds').where('inventory_pool_id', '=', POOL_ID).execute();
    await db
      .updateTable('events')
      .set({
        waitlist_auto_offer_enabled: true,
        waitlist_offer_ttl_minutes: 30,
        updated_at: new Date(),
      })
      .where('id', '=', EVENT_ID)
      .execute();
    await db
      .updateTable('inventory_pools')
      .set({ total_capacity: 1, sold_count: 0, updated_at: new Date() })
      .where('id', '=', POOL_ID)
      .execute();
  });

  it('expires stale offers and issues FIFO auto-offers without exceeding capacity', async () => {
    const expiredEntryId = await createWaitlistEntry(db, 'expired@example.com', {
      status: 'offered',
      offerExpiresAt: new Date(Date.now() - 60_000),
      claimTokenHash: 'stale_hash',
      createdAt: new Date(Date.now() - 120_000),
    });
    const firstEntryId = await createWaitlistEntry(db, 'first@example.com', {
      createdAt: new Date(Date.now() - 50_000),
    });
    const secondEntryId = await createWaitlistEntry(db, 'second@example.com', {
      createdAt: new Date(Date.now() - 40_000),
    });

    const result = await processWaitlistOffersActivity();

    expect(result).toMatchObject({
      ok: true,
      value: { expiredCount: 1, offeredCount: 1 },
    });
    const rows = await db
      .selectFrom('waitlist_entries')
      .select(['id', 'status', 'claim_token_hash', 'offer_expires_at'])
      .where('id', 'in', [expiredEntryId, firstEntryId, secondEntryId])
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(expiredEntryId)?.status).toBe('expired');
    expect(byId.get(firstEntryId)?.status).toBe('offered');
    expect(byId.get(firstEntryId)?.claim_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(byId.get(firstEntryId)?.offer_expires_at).toBeTruthy();
    expect(byId.get(secondEntryId)?.status).toBe('joined');
    expect(byId.get(secondEntryId)?.claim_token_hash).toBeNull();
  });

  it('does not auto-offer when event waitlist auto-offers are disabled', async () => {
    const entryId = await createWaitlistEntry(db, 'disabled@example.com');
    await db
      .updateTable('events')
      .set({ waitlist_auto_offer_enabled: false, updated_at: new Date() })
      .where('id', '=', EVENT_ID)
      .execute();

    const result = await processWaitlistOffersActivity();

    expect(result).toMatchObject({
      ok: true,
      value: { offeredCount: 0 },
    });
    const entry = await db
      .selectFrom('waitlist_entries')
      .select(['status', 'claim_token_hash'])
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();
    expect(entry.status).toBe('joined');
    expect(entry.claim_token_hash).toBeNull();
  });

  it('processes burst waitlist load in FIFO order without exceeding freed capacity', async () => {
    const baseTime = Date.now() - 10 * 60_000;
    await db
      .updateTable('inventory_pools')
      .set({ total_capacity: 25, sold_count: 0, updated_at: new Date() })
      .where('id', '=', POOL_ID)
      .execute();
    await db
      .insertInto('checkout_holds')
      .values({
        id: `hold_wl_${RUN_ID}`,
        inventory_pool_id: POOL_ID,
        checkout_session_id: `cs_wl_${RUN_ID}`,
        ticket_type_id: TICKET_TYPE_ID,
        quantity: 3,
        expires_at: new Date(Date.now() + 10 * 60_000),
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();

    const entryIds = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        createWaitlistEntry(db, `burst-${i}@example.com`, {
          createdAt: new Date(baseTime + i * 1000),
        }),
      ),
    );

    const result = await processWaitlistOffersActivity();

    expect(result).toMatchObject({
      ok: true,
      value: { expiredCount: 0, offeredCount: 22 },
    });
    const rows = await db
      .selectFrom('waitlist_entries')
      .select(['id', 'status', 'claim_token_hash'])
      .where('id', 'in', entryIds)
      .orderBy('created_at', 'asc')
      .execute();
    expect(rows).toHaveLength(60);
    expect(rows.slice(0, 22).every((row) => row.status === 'offered')).toBe(true);
    expect(rows.slice(0, 22).every((row) => /^[a-f0-9]{64}$/.test(row.claim_token_hash ?? ''))).toBe(
      true,
    );
    expect(rows.slice(22).every((row) => row.status === 'joined')).toBe(true);
    expect(rows.slice(22).every((row) => row.claim_token_hash === null)).toBe(true);

    const replayResult = await processWaitlistOffersActivity();

    expect(replayResult).toMatchObject({
      ok: true,
      value: { expiredCount: 0, offeredCount: 0 },
    });
    const replayRows = await db
      .selectFrom('waitlist_entries')
      .select(['id', 'status'])
      .where('id', 'in', entryIds)
      .orderBy('created_at', 'asc')
      .execute();
    expect(replayRows.filter((row) => row.status === 'offered')).toHaveLength(22);
    expect(replayRows.filter((row) => row.status === 'joined')).toHaveLength(38);
  });

  it('counts existing active offers across ticket types sharing an inventory pool', async () => {
    await createWaitlistEntry(db, 'shared-active@example.com', {
      status: 'offered',
      offerExpiresAt: new Date(Date.now() + 10 * 60_000),
      offeredAt: new Date(Date.now() - 60_000),
      claimTokenHash: 'shared_active_hash',
      ticketTypeId: SHARED_POOL_TICKET_TYPE_ID,
      createdAt: new Date(Date.now() - 120_000),
    });
    const candidateId = await createWaitlistEntry(db, 'shared-candidate@example.com', {
      createdAt: new Date(Date.now() - 30_000),
    });

    const result = await processWaitlistOffersActivity();

    expect(result).toMatchObject({
      ok: true,
      value: { expiredCount: 0, offeredCount: 0 },
    });
    const candidate = await db
      .selectFrom('waitlist_entries')
      .select(['status', 'claim_token_hash'])
      .where('id', '=', candidateId)
      .executeTakeFirstOrThrow();
    expect(candidate.status).toBe('joined');
    expect(candidate.claim_token_hash).toBeNull();
  });
});

async function seedBaseRows(db: Database) {
  await db
    .insertInto('tenants')
    .values({
      id: TENANT_ID,
      name: 'Waitlist Activity Tenant',
      status: 'active',
      plan: 'test',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: ORG_ID,
      tenant_id: TENANT_ID,
      name: 'Waitlist Activity Org',
      slug: `waitlist-${RUN_ID}`,
      clerk_organization_id: null,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: BRAND_ID,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      name: 'Waitlist Activity Brand',
      slug: `waitlist-${RUN_ID}`,
      status: 'active',
      theme: JSON.stringify({}),
      legal_urls: JSON.stringify({}),
      white_label: false,
      payment_account_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('events')
    .values({
      id: EVENT_ID,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      brand_id: BRAND_ID,
      slug: `waitlist-${RUN_ID}`,
      title: 'Waitlist Activity Event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date(Date.now() + 86_400_000),
      ends_at: null,
      venue: null,
      visibility: 'public',
      seo: JSON.stringify({}),
      capacity: null,
      cover_image_url: null,
      external_url: null,
      waitlist_auto_offer_enabled: true,
      waitlist_offer_ttl_minutes: 30,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('inventory_pools')
    .values({
      id: POOL_ID,
      event_id: EVENT_ID,
      name: 'Waitlist Pool',
      total_capacity: 1,
      reserved_count: 0,
      sold_count: 0,
      hold_ttl_seconds: 300,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await db
    .insertInto('ticket_types')
    .values([
      {
        id: TICKET_TYPE_ID,
        event_id: EVENT_ID,
        name: 'Waitlist Ticket',
        description: null,
        kind: 'paid',
        status: 'sold_out',
        visibility: 'public',
        currency: 'USD',
        price_cents: 1000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: POOL_ID,
        sort_order: 0,
        requires_access_code: false,
        access_code_hint: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: SHARED_POOL_TICKET_TYPE_ID,
        event_id: EVENT_ID,
        name: 'Shared Pool Waitlist Ticket',
        description: null,
        kind: 'paid',
        status: 'sold_out',
        visibility: 'public',
        currency: 'USD',
        price_cents: 1000,
        minimum_price_cents: null,
        sales_start_at: null,
        sales_end_at: null,
        min_per_order: 1,
        max_per_order: 10,
        inventory_pool_id: POOL_ID,
        sort_order: 1,
        requires_access_code: false,
        access_code_hint: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])
    .execute();
}

async function cleanupRows(db: Database) {
  await db.deleteFrom('email_jobs').where('tenant_id', '=', TENANT_ID).execute();
  await db.deleteFrom('waitlist_entries').where('event_id', '=', EVENT_ID).execute();
  await db.deleteFrom('checkout_holds').where('inventory_pool_id', '=', POOL_ID).execute();
  await db.deleteFrom('ticket_types').where('event_id', '=', EVENT_ID).execute();
  await db.deleteFrom('inventory_pools').where('event_id', '=', EVENT_ID).execute();
  await db.deleteFrom('events').where('id', '=', EVENT_ID).execute();
  await db.deleteFrom('brands').where('id', '=', BRAND_ID).execute();
  await db.deleteFrom('organizations').where('id', '=', ORG_ID).execute();
  await db.deleteFrom('tenants').where('id', '=', TENANT_ID).execute();
}

async function createWaitlistEntry(
  db: Database,
  email: string,
  options: {
    status?: string;
    offerExpiresAt?: Date;
    offeredAt?: Date;
    claimTokenHash?: string | null;
    createdAt?: Date;
    ticketTypeId?: string;
  } = {},
) {
  const now = new Date();
  const id = `wle_${ulid()}`;
  await db
    .insertInto('waitlist_entries')
    .values({
      id,
      tenant_id: TENANT_ID,
      organization_id: ORG_ID,
      brand_id: BRAND_ID,
      event_id: EVENT_ID,
      ticket_type_id: options.ticketTypeId ?? TICKET_TYPE_ID,
      buyer_email: email,
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
      quantity: 1,
      status: options.status ?? 'joined',
      offer_expires_at: options.offerExpiresAt ?? null,
      claim_token_hash: options.claimTokenHash ?? null,
      offered_at: options.offeredAt ?? (options.status === 'offered' ? now : null),
      claimed_at: null,
      cancelled_at: null,
      created_at: options.createdAt ?? now,
      updated_at: now,
    })
    .execute();
  return id;
}
