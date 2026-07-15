import { createDb, sql, type Database } from '@tixkit/db';

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`.slice(0, 32);
}

export const SAMPLE_TENANT_ID = 'tnt_sample_data';
export const SAMPLE_ORGANIZATION_ID = 'org_sample_data';
export const SAMPLE_BRAND_ID = 'brd_sample_data';
export const SAMPLE_EVENT_SLUG = 'sample-summer-showcase';
export const SAMPLE_EVENT_ID = 'evt_sample_data';

export const SAMPLE_POOL_ID = 'pool_sample_data';
export const SAMPLE_PUBLIC_TICKET_TYPE_ID = 'tt_pub_sample_data';
export const SAMPLE_PAID_TICKET_TYPE_ID = 'tt_paid_sample_data';
export const SAMPLE_PRODUCT_ID = 'prod_sample_data';
export const SAMPLE_DISCOUNT_CODE_ID = 'dc_sample_data';
export const SAMPLE_QUESTION_ID = 'q_sample_data';
export const SAMPLE_CHECK_IN_LIST_ID = 'cil_sample_data';

export type SeedResult = {
  ok: boolean;
  message: string;
  eventId?: string;
  orderId?: string;
};

export type SeedContext = {
  db: Database;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  publicTicketTypeId: string;
  paidTicketTypeId: string;
  inventoryPoolId: string;
  productId: string;
  discountCodeId: string;
  checkInListId: string;
  assumeEmpty?: boolean;
};

export async function seedSampleData(
  options: { now?: Date; assumeEmpty?: boolean } = {},
): Promise<SeedResult> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      ok: false,
      message: 'DATABASE_URL is not set. Create .env.local from .env.local.example.',
    };
  }

  const db = createDb(dbUrl);
  try {
    const now = options.now ?? new Date();

    await ensureTenant(db, now, options.assumeEmpty);
    await ensureOrganization(db, now, options.assumeEmpty);
    await ensureBrand(db, now, options.assumeEmpty);
    const eventId = await ensureSampleEvent(db, now);
    const ctx: SeedContext = {
      db,
      tenantId: SAMPLE_TENANT_ID,
      organizationId: SAMPLE_ORGANIZATION_ID,
      brandId: SAMPLE_BRAND_ID,
      eventId,
      publicTicketTypeId: SAMPLE_PUBLIC_TICKET_TYPE_ID,
      paidTicketTypeId: SAMPLE_PAID_TICKET_TYPE_ID,
      inventoryPoolId: SAMPLE_POOL_ID,
      productId: SAMPLE_PRODUCT_ID,
      discountCodeId: SAMPLE_DISCOUNT_CODE_ID,
      checkInListId: SAMPLE_CHECK_IN_LIST_ID,
      assumeEmpty: options.assumeEmpty,
    };

    await ensureInventoryPool(ctx, now);
    await ensureTicketTypes(ctx, now);
    await ensureProduct(ctx, now);
    await ensureDiscountCode(ctx, now);
    await ensureQuestions(ctx, now);
    await ensureCheckInList(ctx, now);
    await publishEventIfNeeded(ctx, now);
    const orderId = await ensureSampleOrder(ctx, now);

    return {
      ok: true,
      message: `Sample data seeded. Event slug: ${SAMPLE_EVENT_SLUG}, event id: ${eventId}, order id: ${orderId ?? 'none'}.`,
      eventId,
      orderId,
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, message: `Sample data seed failed: ${detail}` };
  } finally {
    await db.destroy();
  }
}

async function ensureTenant(db: Database, now: Date, assumeEmpty = false): Promise<void> {
  const insert = db.insertInto('tenants').values({
    id: SAMPLE_TENANT_ID,
    name: 'Sample Tenant',
    status: 'active',
    plan: 'free',
    created_at: now,
    updated_at: now,
  });
  await (assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())).execute();
}

async function ensureOrganization(db: Database, now: Date, assumeEmpty = false): Promise<void> {
  const insert = db.insertInto('organizations').values({
    id: SAMPLE_ORGANIZATION_ID,
    tenant_id: SAMPLE_TENANT_ID,
    name: 'Sample Organization',
    slug: 'sample-org',
    clerk_organization_id: null,
    box_office_settings: JSON.stringify({
      enabled: true,
      allowedTenderTypes: ['cash', 'manual_card', 'comp'],
      requireBuyerEmail: false,
      receiptMode: 'email',
    }),
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  await (assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())).execute();
}

async function ensureBrand(db: Database, now: Date, assumeEmpty = false): Promise<void> {
  const insert = db.insertInto('brands').values({
    id: SAMPLE_BRAND_ID,
    tenant_id: SAMPLE_TENANT_ID,
    organization_id: SAMPLE_ORGANIZATION_ID,
    name: 'Sample Brand',
    slug: 'sample-brand',
    status: 'active',
    theme: JSON.stringify({ color: '#3b82f6' }),
    email_identity_id: null,
    sms_identity_id: null,
    payment_account_id: null,
    support_url: null,
    legal_urls: JSON.stringify({}),
    white_label: false,
    created_at: now,
    updated_at: now,
  });
  await (assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())).execute();
}

async function ensureSampleEvent(db: Database, now: Date): Promise<string> {
  const existing = await db
    .selectFrom('events')
    .select('id')
    .where('tenant_id', '=', SAMPLE_TENANT_ID)
    .where('slug', '=', SAMPLE_EVENT_SLUG)
    .executeTakeFirst();

  if (existing) {
    return existing.id;
  }

  const eventId = SAMPLE_EVENT_ID;
  const startsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 4 * 60 * 60 * 1000);
  await db
    .insertInto('events')
    .values({
      id: eventId,
      tenant_id: SAMPLE_TENANT_ID,
      organization_id: SAMPLE_ORGANIZATION_ID,
      brand_id: SAMPLE_BRAND_ID,
      slug: SAMPLE_EVENT_SLUG,
      title: 'Sample Summer Showcase',
      description: 'A sample event created by `bun run seed:sample-data` for local exploration.',
      status: 'draft',
      currency: 'USD',
      timezone: 'America/New_York',
      starts_at: startsAt,
      ends_at: endsAt,
      venue: JSON.stringify({ name: 'Sample Venue', city: 'New York' }),
      visibility: 'public',
      seo: JSON.stringify({}),
      created_at: now,
      updated_at: now,
    })
    .execute();
  return eventId;
}

async function ensureInventoryPool(ctx: SeedContext, now: Date): Promise<void> {
  const insert = ctx.db.insertInto('inventory_pools').values({
    id: ctx.inventoryPoolId,
    event_id: ctx.eventId,
    name: 'General Admission',
    total_capacity: 100,
    reserved_count: 0,
    sold_count: 1,
    hold_ttl_seconds: 600,
    created_at: now,
    updated_at: now,
  });
  await (
    ctx.assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())
  ).execute();
}

async function ensureTicketTypes(ctx: SeedContext, now: Date): Promise<void> {
  const insert = ctx.db.insertInto('ticket_types').values([
    {
      id: ctx.publicTicketTypeId,
      event_id: ctx.eventId,
      name: 'Free General Admission',
      description: 'Free sample ticket.',
      kind: 'free',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 0,
      min_per_order: 1,
      max_per_order: 4,
      inventory_pool_id: ctx.inventoryPoolId,
      sort_order: 0,
      requires_access_code: false,
      created_at: now,
      updated_at: now,
    },
    {
      id: ctx.paidTicketTypeId,
      event_id: ctx.eventId,
      name: 'Paid General Admission',
      description: 'Paid sample ticket.',
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 2_500,
      min_per_order: 1,
      max_per_order: 4,
      inventory_pool_id: ctx.inventoryPoolId,
      sort_order: 1,
      requires_access_code: false,
      created_at: now,
      updated_at: now,
    },
  ]);
  await (
    ctx.assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())
  ).execute();
}

async function ensureProduct(ctx: SeedContext, now: Date): Promise<void> {
  const insert = ctx.db.insertInto('products').values({
    id: ctx.productId,
    event_id: ctx.eventId,
    name: 'Parking Add-on',
    description: 'Sample product add-on for checkout.',
    price_cents: 1_000,
    currency: 'USD',
    category_id: null,
    max_per_order: 2,
    status: 'active',
    sort_order: 0,
    created_at: now,
    updated_at: now,
  });
  await (
    ctx.assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())
  ).execute();
}

async function ensureDiscountCode(ctx: SeedContext, now: Date): Promise<void> {
  const validFrom = new Date(now.getTime() - 60_000);
  const validUntil = new Date(now.getTime() + 7 * 24 * 60 * 60_000);

  const insert = ctx.db.insertInto('discount_codes').values({
    id: ctx.discountCodeId,
    event_id: ctx.eventId,
    code: 'SAMPLE20',
    type: 'percentage',
    value: 2_000,
    currency: 'USD',
    max_uses: 100,
    uses_count: 0,
    valid_from: validFrom,
    valid_until: validUntil,
    min_order_cents: 1_000,
    max_discount_cents: null,
    ticket_type_ids: JSON.stringify([ctx.paidTicketTypeId]),
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  await (
    ctx.assumeEmpty
      ? insert
      : insert.onConflict((oc) => oc.columns(['event_id', 'code']).doNothing())
  ).execute();
}

async function ensureQuestions(ctx: SeedContext, now: Date): Promise<void> {
  const insert = ctx.db.insertInto('questions').values({
    id: SAMPLE_QUESTION_ID,
    event_id: ctx.eventId,
    ticket_type_id: null,
    type: 'text',
    label: 'Dietary Restrictions',
    description: 'Let us know if you have any dietary needs.',
    required: false,
    applies_to: 'attendee',
    options: null,
    placeholder: 'None',
    validation_pattern: null,
    conditional_visibility: null,
    status: 'active',
    is_hidden: false,
    sort_order: 0,
    is_consent_field: false,
    created_at: now,
    updated_at: now,
  });
  await (
    ctx.assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())
  ).execute();
}

async function ensureCheckInList(ctx: SeedContext, now: Date): Promise<void> {
  const insert = ctx.db.insertInto('check_in_lists').values({
    id: ctx.checkInListId,
    event_id: ctx.eventId,
    name: 'Main Entrance',
    ticket_type_ids: JSON.stringify([ctx.publicTicketTypeId, ctx.paidTicketTypeId]),
    status: 'active',
    created_at: now,
    updated_at: now,
  });
  await (
    ctx.assumeEmpty ? insert : insert.onConflict((oc) => oc.column('id').doNothing())
  ).execute();
}

async function publishEventIfNeeded(ctx: SeedContext, now: Date): Promise<void> {
  await ctx.db
    .updateTable('events')
    .set({ status: 'published', version: sql<number>`version + 1`, updated_at: now })
    .where('id', '=', ctx.eventId)
    .where('status', '!=', 'published')
    .execute();
}

async function ensureSampleOrder(ctx: SeedContext, now: Date): Promise<string | undefined> {
  const existing = await ctx.db
    .selectFrom('orders')
    .select('id')
    .where('tenant_id', '=', SAMPLE_TENANT_ID)
    .where('event_id', '=', ctx.eventId)
    .where('order_number', '=', 'SAMPLE-001')
    .executeTakeFirst();

  if (existing) {
    return existing.id;
  }

  const sessionId = 'cks_sample_data';
  const holdId = 'hld_sample_data';
  const orderId = 'ord_sample_data';
  const lineItemId = 'oli_sample_data';
  const attendeeId = 'att_sample_data';
  const ticketId = 'tkt_sample_data';
  const expiresAt = new Date(now.getTime() + 30 * 60_000);

  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto('checkout_sessions')
      .values({
        id: sessionId,
        tenant_id: SAMPLE_TENANT_ID,
        event_id: ctx.eventId,
        brand_id: SAMPLE_BRAND_ID,
        status: 'completed',
        hold_id: holdId,
        currency: 'USD',
        cart: JSON.stringify({
          items: [{ ticketTypeId: ctx.paidTicketTypeId, quantity: 1 }],
          buyerFields: {},
          attendeeFields: {},
        }),
        buyer: JSON.stringify({
          email: 'sample-buyer@example.com',
          firstName: 'Sample',
          lastName: 'Buyer',
        }),
        quote: JSON.stringify({
          subtotalCents: 2_500,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: 2_500,
          currency: 'USD',
        }),
        payment_intent_id: null,
        order_id: orderId,
        success_url: null,
        cancel_url: null,
        expires_at: expiresAt,
        idempotency_key: `seed-sample-${ctx.eventId}`,
        client_token: `seed-token-${ctx.eventId}`,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('checkout_holds')
      .values({
        id: holdId,
        inventory_pool_id: ctx.inventoryPoolId,
        checkout_session_id: sessionId,
        ticket_type_id: ctx.paidTicketTypeId,
        quantity: 1,
        expires_at: expiresAt,
        status: 'converted',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('orders')
      .values({
        id: orderId,
        tenant_id: SAMPLE_TENANT_ID,
        organization_id: SAMPLE_ORGANIZATION_ID,
        brand_id: SAMPLE_BRAND_ID,
        event_id: ctx.eventId,
        checkout_session_id: sessionId,
        order_number: 'SAMPLE-001',
        status: 'paid',
        currency: 'USD',
        subtotal_cents: 2_500,
        discount_cents: 0,
        tax_cents: 0,
        fee_cents: 0,
        total_cents: 2_500,
        refunded_cents: 0,
        buyer_email: 'sample-buyer@example.com',
        buyer_first_name: 'Sample',
        buyer_last_name: 'Buyer',
        buyer_phone: null,
        payment_intent_id: null,
        payment_provider: 'local',
        paid_at: now,
        refunded_at: null,
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('order_line_items')
      .values({
        id: lineItemId,
        order_id: orderId,
        ticket_type_id: ctx.paidTicketTypeId,
        product_id: null,
        resale_listing_id: null,
        attendee_id: null,
        description: 'Paid General Admission',
        quantity: 1,
        unit_price_cents: 2_500,
        subtotal_cents: 2_500,
        discount_cents: 0,
        tax_cents: 0,
        fee_cents: 0,
        total_cents: 2_500,
        currency: 'USD',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('attendees')
      .values({
        id: attendeeId,
        tenant_id: SAMPLE_TENANT_ID,
        order_id: orderId,
        event_id: ctx.eventId,
        ticket_type_id: ctx.paidTicketTypeId,
        ticket_id: null,
        first_name: 'Sample',
        last_name: 'Buyer',
        email: 'sample-buyer@example.com',
        phone: null,
        status: 'registered',
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .insertInto('tickets')
      .values({
        id: ticketId,
        tenant_id: SAMPLE_TENANT_ID,
        order_id: orderId,
        attendee_id: attendeeId,
        event_id: ctx.eventId,
        ticket_type_id: ctx.paidTicketTypeId,
        status: 'valid',
        code: 'SAMPLE-001-1',
        qr_payload: `tixkit:ticket:${ticketId}`,
        qr_hash: `hash-${ticketId}`,
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await trx
      .updateTable('attendees')
      .set({ ticket_id: ticketId, updated_at: now })
      .where('id', '=', attendeeId)
      .execute();

    await trx
      .updateTable('inventory_pools')
      .set({ sold_count: 1, updated_at: now })
      .where('id', '=', ctx.inventoryPoolId)
      .execute();
  });

  return orderId;
}
