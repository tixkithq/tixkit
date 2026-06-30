import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '@tixkit/db';
import { runMigrations } from '@tixkit/db/migrate';
import {
  enforcePrivacyRetentionActivity,
  processPrivacyRequestActivity,
} from '../activities/privacy.js';

type DriverCase = {
  driver: 'postgres' | 'mysql';
  url: string;
};

type FixtureIds = ReturnType<typeof buildPrivacyRetentionIds>;

function parseJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function buildPrivacyRetentionIds(suffix: string) {
  return {
    tenantId: `tnt_priv_${suffix}`,
    organizationId: `org_priv_${suffix}`,
    brandId: `brd_priv_${suffix}`,
    eventId: `evt_priv_${suffix}`,
    poolId: `pool_priv_${suffix}`,
    ticketTypeId: `tt_priv_${suffix}`,
    checkoutSessionId: `cs_priv_${suffix}`,
    orderId: `ord_priv_${suffix}`,
    attendeeId: `att_priv_${suffix}`,
    secondAttendeeId: `att2_priv_${suffix}`,
    ticketId: `tkt_priv_${suffix}`,
    invoiceId: `inv_priv_${suffix}`,
    auditLogId: `aud_priv_${suffix}`,
    requestId: `prv_priv_${suffix}`,
    otherOrganizationId: `org_priv_other_${suffix}`,
    otherBrandId: `brd_priv_other_${suffix}`,
    otherEventId: `evt_priv_other_${suffix}`,
    otherPoolId: `pool_priv_other_${suffix}`,
    otherTicketTypeId: `tt_priv_other_${suffix}`,
    otherCheckoutSessionId: `cs_priv_other_${suffix}`,
    otherOrderId: `ord_priv_other_${suffix}`,
    otherAttendeeId: `att_priv_other_${suffix}`,
    otherTicketId: `tkt_priv_other_${suffix}`,
    otherInvoiceId: `inv_priv_other_${suffix}`,
  };
}

const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
];

const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver
    ? allDriverCases.filter((driverCase) => driverCase.driver === requestedDriver)
    : allDriverCases
).filter((driverCase) => driverCase.url.length > 0);

if (driverCases.length === 0) {
  it.skip('privacy retention activity integration (skipped: no database URL configured)', () => {});
}

async function seedPrivacyRetentionFixture(db: Database, ids: FixtureIds, suffix: string) {
  const now = new Date('2026-06-28T12:00:00.000Z');

  await db
    .insertInto('tenants')
    .values({
      id: ids.tenantId,
      name: 'Privacy Retention Tenant',
      status: 'active',
      plan: 'free',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: ids.organizationId,
      tenant_id: ids.tenantId,
      name: 'Privacy Retention Org',
      slug: `privacy-retention-${suffix}`,
      clerk_organization_id: null,
      status: 'active',
      box_office_settings: JSON.stringify({
        enabled: false,
        allowedTenderTypes: ['cash', 'card', 'comp'],
        requireBuyerEmail: false,
        receiptMode: 'email',
      }),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: ids.otherOrganizationId,
      tenant_id: ids.tenantId,
      name: 'Privacy Retention Other Org',
      slug: `privacy-retention-other-${suffix}`,
      clerk_organization_id: null,
      status: 'active',
      box_office_settings: JSON.stringify({
        enabled: false,
        allowedTenderTypes: ['cash', 'card', 'comp'],
        requireBuyerEmail: false,
        receiptMode: 'email',
      }),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: ids.brandId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      name: 'Privacy Retention Brand',
      slug: `privacy-retention-${suffix}`,
      status: 'active',
      theme: JSON.stringify({}),
      email_identity_id: null,
      sms_identity_id: null,
      payment_account_id: null,
      support_url: null,
      legal_urls: JSON.stringify({}),
      white_label: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: ids.otherBrandId,
      tenant_id: ids.tenantId,
      organization_id: ids.otherOrganizationId,
      name: 'Privacy Retention Other Brand',
      slug: `privacy-retention-other-${suffix}`,
      status: 'active',
      theme: JSON.stringify({}),
      email_identity_id: null,
      sms_identity_id: null,
      payment_account_id: null,
      support_url: null,
      legal_urls: JSON.stringify({}),
      white_label: false,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('events')
    .values({
      id: ids.eventId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      brand_id: ids.brandId,
      slug: `privacy-retention-${suffix}`,
      title: 'Privacy Retention Event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date('2027-01-01T12:00:00.000Z'),
      ends_at: null,
      venue: null,
      visibility: 'public',
      seo: JSON.stringify({}),
      capacity: null,
      cover_image_url: null,
      external_url: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('events')
    .values({
      id: ids.otherEventId,
      tenant_id: ids.tenantId,
      organization_id: ids.otherOrganizationId,
      brand_id: ids.otherBrandId,
      slug: `privacy-retention-other-${suffix}`,
      title: 'Privacy Retention Other Event',
      description: null,
      status: 'published',
      currency: 'USD',
      timezone: 'UTC',
      starts_at: new Date('2027-01-01T12:00:00.000Z'),
      ends_at: null,
      venue: null,
      visibility: 'public',
      seo: JSON.stringify({}),
      capacity: null,
      cover_image_url: null,
      external_url: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('inventory_pools')
    .values({
      id: ids.poolId,
      event_id: ids.eventId,
      name: 'General Admission',
      total_capacity: 10,
      reserved_count: 0,
      sold_count: 1,
      hold_ttl_seconds: 600,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('inventory_pools')
    .values({
      id: ids.otherPoolId,
      event_id: ids.otherEventId,
      name: 'Other General Admission',
      total_capacity: 10,
      reserved_count: 0,
      sold_count: 1,
      hold_ttl_seconds: 600,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('ticket_types')
    .values({
      id: ids.ticketTypeId,
      event_id: ids.eventId,
      name: 'GA',
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 12500,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: ids.poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('ticket_types')
    .values({
      id: ids.otherTicketTypeId,
      event_id: ids.otherEventId,
      name: 'Other GA',
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 8800,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: ids.otherPoolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('checkout_sessions')
    .values({
      id: ids.checkoutSessionId,
      tenant_id: ids.tenantId,
      event_id: ids.eventId,
      brand_id: ids.brandId,
      status: 'completed',
      hold_id: `hold_priv_${suffix}`,
      currency: 'USD',
      cart: JSON.stringify({ items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }] }),
      buyer: JSON.stringify({
        email: 'buyer@test.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+15550000001',
      }),
      quote: JSON.stringify({ totalCents: 12500 }),
      payment_intent_id: null,
      order_id: null,
      success_url: null,
      cancel_url: null,
      expires_at: new Date('2027-01-01T11:00:00.000Z'),
      idempotency_key: `privacy-retention-${suffix}`,
      client_token: `tok_priv_${suffix}`,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('checkout_sessions')
    .values({
      id: ids.otherCheckoutSessionId,
      tenant_id: ids.tenantId,
      event_id: ids.otherEventId,
      brand_id: ids.otherBrandId,
      status: 'completed',
      hold_id: `hold_priv_other_${suffix}`,
      currency: 'USD',
      cart: JSON.stringify({ items: [{ ticketTypeId: ids.otherTicketTypeId, quantity: 1 }] }),
      buyer: JSON.stringify({ email: 'buyer@test.com', firstName: 'Other' }),
      quote: JSON.stringify({ totalCents: 8800 }),
      payment_intent_id: null,
      order_id: null,
      success_url: null,
      cancel_url: null,
      expires_at: new Date('2027-01-01T11:00:00.000Z'),
      idempotency_key: `privacy-retention-other-${suffix}`,
      client_token: `tok_priv_other_${suffix}`,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      id: ids.orderId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      brand_id: ids.brandId,
      event_id: ids.eventId,
      checkout_session_id: ids.checkoutSessionId,
      order_number: `TK-PRIV-${suffix}`,
      status: 'paid',
      currency: 'USD',
      subtotal_cents: 11600,
      discount_cents: 0,
      tax_cents: 700,
      fee_cents: 200,
      total_cents: 12500,
      refunded_cents: 2500,
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Ada',
      buyer_last_name: 'Lovelace',
      buyer_phone: '+15550000001',
      payment_intent_id: null,
      payment_provider: 'stripe',
      paid_at: now,
      refunded_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      id: ids.otherOrderId,
      tenant_id: ids.tenantId,
      organization_id: ids.otherOrganizationId,
      brand_id: ids.otherBrandId,
      event_id: ids.otherEventId,
      checkout_session_id: ids.otherCheckoutSessionId,
      order_number: `TK-PRIV-OTHER-${suffix}`,
      status: 'paid',
      currency: 'USD',
      subtotal_cents: 8300,
      discount_cents: 0,
      tax_cents: 300,
      fee_cents: 200,
      total_cents: 8800,
      refunded_cents: 0,
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Other',
      buyer_last_name: 'Scope',
      buyer_phone: '+15550000009',
      payment_intent_id: null,
      payment_provider: 'stripe',
      paid_at: now,
      refunded_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .updateTable('checkout_sessions')
    .set({ order_id: ids.orderId })
    .where('id', '=', ids.checkoutSessionId)
    .execute();
  await db
    .updateTable('checkout_sessions')
    .set({ order_id: ids.otherOrderId })
    .where('id', '=', ids.otherCheckoutSessionId)
    .execute();
  await db
    .insertInto('attendees')
    .values({
      id: ids.attendeeId,
      tenant_id: ids.tenantId,
      order_id: ids.orderId,
      event_id: ids.eventId,
      ticket_type_id: ids.ticketTypeId,
      ticket_id: ids.ticketId,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'buyer@test.com',
      phone: '+15550000001',
      status: 'registered',
      custom_answers: JSON.stringify({ company: '<script>alert(1)</script>' }),
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('attendees')
    .values({
      id: ids.secondAttendeeId,
      tenant_id: ids.tenantId,
      order_id: ids.orderId,
      event_id: ids.eventId,
      ticket_type_id: ids.ticketTypeId,
      ticket_id: null,
      first_name: 'Grace',
      last_name: 'Hopper',
      email: 'buyer@test.com',
      phone: '+15550000002',
      status: 'registered',
      custom_answers: JSON.stringify({ dietary: 'vegan' }),
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('attendees')
    .values({
      id: ids.otherAttendeeId,
      tenant_id: ids.tenantId,
      order_id: ids.otherOrderId,
      event_id: ids.otherEventId,
      ticket_type_id: ids.otherTicketTypeId,
      ticket_id: ids.otherTicketId,
      first_name: 'Other',
      last_name: 'Scope',
      email: 'buyer@test.com',
      phone: '+15550000009',
      status: 'registered',
      custom_answers: JSON.stringify({ shouldStay: true }),
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('tickets')
    .values({
      id: ids.ticketId,
      tenant_id: ids.tenantId,
      order_id: ids.orderId,
      attendee_id: ids.attendeeId,
      event_id: ids.eventId,
      ticket_type_id: ids.ticketTypeId,
      status: 'issued',
      code: `PRIV-${suffix}`,
      qr_payload: `payload-${suffix}`,
      qr_hash: `hash-${suffix}`,
      transferred_to_email: 'buyer@test.com',
      transferred_at: null,
      checked_in_at: null,
      checked_in_by_device_id: null,
      wallet_pass_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('tickets')
    .values({
      id: ids.otherTicketId,
      tenant_id: ids.tenantId,
      order_id: ids.otherOrderId,
      attendee_id: ids.otherAttendeeId,
      event_id: ids.otherEventId,
      ticket_type_id: ids.otherTicketTypeId,
      status: 'issued',
      code: `PRIV-OTHER-${suffix}`,
      qr_payload: `payload-other-${suffix}`,
      qr_hash: `hash-other-${suffix}`,
      transferred_to_email: 'buyer@test.com',
      transferred_at: null,
      checked_in_at: null,
      checked_in_by_device_id: null,
      wallet_pass_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('invoices')
    .values({
      id: ids.invoiceId,
      order_id: ids.orderId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      brand_id: ids.brandId,
      event_id: ids.eventId,
      invoice_number: `INV-PRIV-${suffix}`,
      status: 'issued',
      currency: 'USD',
      subtotal_cents: 11600,
      discount_cents: 0,
      tax_cents: 700,
      fee_cents: 200,
      total_cents: 12500,
      refunded_cents: 2500,
      buyer_email: 'buyer@test.com',
      buyer_name: 'Ada Lovelace',
      buyer_tax_id: 'US-123',
      seller_name: 'Privacy Retention Brand',
      seller_tax_id: null,
      reverse_charge: false,
      issued_at: now,
      voided_at: null,
      metadata: JSON.stringify({}),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('invoices')
    .values({
      id: ids.otherInvoiceId,
      order_id: ids.otherOrderId,
      tenant_id: ids.tenantId,
      organization_id: ids.otherOrganizationId,
      brand_id: ids.otherBrandId,
      event_id: ids.otherEventId,
      invoice_number: `INV-PRIV-OTHER-${suffix}`,
      status: 'issued',
      currency: 'USD',
      subtotal_cents: 8300,
      discount_cents: 0,
      tax_cents: 300,
      fee_cents: 200,
      total_cents: 8800,
      refunded_cents: 0,
      buyer_email: 'buyer@test.com',
      buyer_name: 'Other Scope',
      buyer_tax_id: 'US-999',
      seller_name: 'Privacy Retention Other Brand',
      seller_tax_id: null,
      reverse_charge: false,
      issued_at: now,
      voided_at: null,
      metadata: JSON.stringify({}),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('audit_logs')
    .values({
      id: ids.auditLogId,
      tenant_id: ids.tenantId,
      actor_type: 'user',
      actor_id: 'usr_privacy',
      action: 'privacy.erasure.requested',
      resource_type: 'privacy_request',
      resource_id: ids.requestId,
      diff_summary: JSON.stringify({ subjectEmail: 'buyer@test.com' }),
      ip: '127.0.0.1',
      user_agent: 'vitest',
      created_at: now,
    })
    .execute();
  await db
    .insertInto('privacy_requests')
    .values({
      id: ids.requestId,
      tenant_id: ids.tenantId,
      organization_id: ids.organizationId,
      brand_id: ids.brandId,
      request_type: 'erasure',
      subject_type: 'buyer',
      subject_id: null,
      subject_email: 'buyer@test.com',
      status: 'pending',
      requested_by: 'usr_privacy',
      result: null,
      error: null,
      created_at: now,
      completed_at: null,
    })
    .execute();
}

async function cleanupPrivacyRetentionFixture(db: Database, ids: FixtureIds) {
  await db.deleteFrom('audit_logs').where('id', '=', ids.auditLogId).execute();
  await db.deleteFrom('privacy_requests').where('id', '=', ids.requestId).execute();
  await db.deleteFrom('tickets').where('id', 'in', [ids.ticketId, ids.otherTicketId]).execute();
  await db
    .deleteFrom('attendees')
    .where('id', 'in', [ids.attendeeId, ids.secondAttendeeId, ids.otherAttendeeId])
    .execute();
  await db.deleteFrom('invoices').where('id', 'in', [ids.invoiceId, ids.otherInvoiceId]).execute();
  await db.deleteFrom('orders').where('id', 'in', [ids.orderId, ids.otherOrderId]).execute();
  await db
    .deleteFrom('checkout_sessions')
    .where('id', 'in', [ids.checkoutSessionId, ids.otherCheckoutSessionId])
    .execute();
  await db
    .deleteFrom('ticket_types')
    .where('id', 'in', [ids.ticketTypeId, ids.otherTicketTypeId])
    .execute();
  await db.deleteFrom('inventory_pools').where('id', 'in', [ids.poolId, ids.otherPoolId]).execute();
  await db.deleteFrom('events').where('id', 'in', [ids.eventId, ids.otherEventId]).execute();
  await db.deleteFrom('brands').where('id', 'in', [ids.brandId, ids.otherBrandId]).execute();
  await db
    .deleteFrom('organizations')
    .where('id', 'in', [ids.organizationId, ids.otherOrganizationId])
    .execute();
  await db.deleteFrom('tenants').where('id', '=', ids.tenantId).execute();
}

describe.each(driverCases)('privacy retention activity integration: $driver', ({ driver, url }) => {
  let db: Database;
  const seededFixtures = new Set<FixtureIds>();
  const previousDriver = process.env.DB_DRIVER;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    process.env.DATABASE_URL = url;
    await runMigrations(url);
    db = createDb(url);
  }, 120_000);

  afterEach(async () => {
    await Promise.all([...seededFixtures].map((ids) => cleanupPrivacyRetentionFixture(db, ids)));
    seededFixtures.clear();
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    if (previousDriver === undefined) {
      delete process.env.DB_DRIVER;
    } else {
      process.env.DB_DRIVER = previousDriver;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }, 60_000);

  it('redacts direct PII while retaining financial, ticket, audit, and privacy ledgers', async () => {
    const suffix = `${driver}_${randomUUID().replaceAll('-', '').slice(0, 6)}`;
    const ids = buildPrivacyRetentionIds(suffix);
    seededFixtures.add(ids);
    await cleanupPrivacyRetentionFixture(db, ids);
    await seedPrivacyRetentionFixture(db, ids, suffix);

    const result = await processPrivacyRequestActivity({ requestId: ids.requestId });

    expect(result).toMatchObject({
      ok: true,
      value: { requestId: ids.requestId, status: 'completed' },
    });

    const [
      order,
      attendee,
      secondAttendee,
      ticket,
      invoice,
      checkoutSession,
      auditLog,
      privacyRequest,
      otherOrder,
      otherAttendee,
      otherTicket,
      otherInvoice,
      otherCheckoutSession,
    ] = await Promise.all([
      db.selectFrom('orders').selectAll().where('id', '=', ids.orderId).executeTakeFirstOrThrow(),
      db
        .selectFrom('attendees')
        .selectAll()
        .where('id', '=', ids.attendeeId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('attendees')
        .selectAll()
        .where('id', '=', ids.secondAttendeeId)
        .executeTakeFirstOrThrow(),
      db.selectFrom('tickets').selectAll().where('id', '=', ids.ticketId).executeTakeFirstOrThrow(),
      db
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', ids.invoiceId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('checkout_sessions')
        .selectAll()
        .where('id', '=', ids.checkoutSessionId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('audit_logs')
        .selectAll()
        .where('id', '=', ids.auditLogId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('privacy_requests')
        .selectAll()
        .where('id', '=', ids.requestId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', ids.otherOrderId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('attendees')
        .selectAll()
        .where('id', '=', ids.otherAttendeeId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('tickets')
        .selectAll()
        .where('id', '=', ids.otherTicketId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', ids.otherInvoiceId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('checkout_sessions')
        .selectAll()
        .where('id', '=', ids.otherCheckoutSessionId)
        .executeTakeFirstOrThrow(),
    ]);

    expect(order).toMatchObject({
      id: ids.orderId,
      status: 'paid',
      currency: 'USD',
      total_cents: expect.anything(),
      refunded_cents: expect.anything(),
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
    });
    expect(Number(order.total_cents)).toBe(12500);
    expect(Number(order.refunded_cents)).toBe(2500);
    expect(String(order.buyer_email)).toMatch(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/);

    expect(attendee).toMatchObject({
      id: ids.attendeeId,
      first_name: null,
      last_name: null,
      phone: null,
      custom_answers: null,
      status: 'registered',
    });
    expect(String(attendee.email)).toMatch(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/);
    expect(secondAttendee).toMatchObject({
      id: ids.secondAttendeeId,
      first_name: null,
      last_name: null,
      phone: null,
      custom_answers: null,
      status: 'registered',
    });
    expect(String(secondAttendee.email)).toMatch(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/);

    expect(ticket).toMatchObject({
      id: ids.ticketId,
      status: 'issued',
      transferred_to_email: null,
    });
    expect(invoice).toMatchObject({
      id: ids.invoiceId,
      total_cents: 12500,
      tax_cents: 700,
      buyer_name: null,
      buyer_tax_id: null,
    });
    expect(String(invoice.buyer_email)).toMatch(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/);
    const checkoutBuyer = parseJsonColumn(checkoutSession.buyer);
    expect(checkoutBuyer).toMatchObject({
      email: expect.stringMatching(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/),
      firstName: null,
      lastName: null,
      phone: null,
    });
    expect(auditLog).toMatchObject({
      id: ids.auditLogId,
      action: 'privacy.erasure.requested',
      resource_id: ids.requestId,
    });
    const auditSummary = parseJsonColumn(auditLog.diff_summary);
    expect(auditSummary).toMatchObject({
      subjectEmail: expect.stringMatching(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/),
    });

    expect(privacyRequest).toMatchObject({
      id: ids.requestId,
      status: 'completed',
      error: null,
    });
    expect(String(privacyRequest.subject_email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    const resultPayload = parseJsonColumn(privacyRequest.result);
    expect(resultPayload).toMatchObject({
      ordersRedacted: 1,
      attendeesRedacted: 2,
      ticketsTouched: 1,
    });

    expect(otherOrder).toMatchObject({
      id: ids.otherOrderId,
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Other',
      buyer_phone: '+15550000009',
    });
    expect(otherAttendee).toMatchObject({
      id: ids.otherAttendeeId,
      email: 'buyer@test.com',
      first_name: 'Other',
    });
    expect(parseJsonColumn(otherAttendee.custom_answers)).toEqual({ shouldStay: true });
    expect(otherTicket).toMatchObject({
      id: ids.otherTicketId,
      transferred_to_email: 'buyer@test.com',
    });
    expect(otherInvoice).toMatchObject({
      id: ids.otherInvoiceId,
      buyer_email: 'buyer@test.com',
      buyer_name: 'Other Scope',
      buyer_tax_id: 'US-999',
    });
    expect(parseJsonColumn(otherCheckoutSession.buyer)).toMatchObject({
      email: 'buyer@test.com',
      firstName: 'Other',
    });
  });

  it('repairs legacy completed erasures from the scheduled retention activity', async () => {
    const suffix = `${driver}_${randomUUID().replaceAll('-', '').slice(0, 6)}`;
    const ids = buildPrivacyRetentionIds(suffix);
    seededFixtures.add(ids);
    await cleanupPrivacyRetentionFixture(db, ids);
    await seedPrivacyRetentionFixture(db, ids, suffix);
    await db
      .updateTable('privacy_requests')
      .set({
        status: 'completed',
        brand_id: null,
        subject_id: ids.orderId,
        result: JSON.stringify({ legacy: true }),
        completed_at: new Date('2026-06-20T12:00:00.000Z'),
        created_at: new Date('2000-01-01T00:00:00.000Z'),
      })
      .where('id', '=', ids.requestId)
      .execute();
    await db
      .updateTable('orders')
      .set({
        buyer_email: 'erased+aaaaaaaaaaaaaaaa@privacy.tixkit.invalid',
        buyer_first_name: null,
        buyer_last_name: null,
        buyer_phone: null,
      })
      .where('id', '=', ids.orderId)
      .execute();
    await db
      .updateTable('attendees')
      .set({
        email: 'erased+bbbbbbbbbbbbbbbb@privacy.tixkit.invalid',
        first_name: null,
        last_name: null,
        phone: null,
        custom_answers: null,
      })
      .where('id', 'in', [ids.attendeeId, ids.secondAttendeeId])
      .execute();
    await db
      .updateTable('tickets')
      .set({ transferred_to_email: null })
      .where('id', '=', ids.ticketId)
      .execute();
    await db
      .updateTable('invoices')
      .set({
        buyer_email: 'erased+cccccccccccccccc@privacy.tixkit.invalid',
        buyer_name: 'Ada Lovelace',
        buyer_tax_id: 'US-123',
      })
      .where('id', '=', ids.invoiceId)
      .execute();
    await db
      .updateTable('checkout_sessions')
      .set({
        buyer: JSON.stringify({
          email: 'erased+dddddddddddddddd@privacy.tixkit.invalid',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '+15550000001',
        }),
      })
      .where('id', '=', ids.checkoutSessionId)
      .execute();

    const result = await enforcePrivacyRetentionActivity({
      batchSize: 1,
      requestId: ids.requestId,
    });

    expect(result).toMatchObject({
      ok: true,
      value: { inspectedCount: 1, repairedCount: 1, skippedCount: 0 },
    });

    const [
      order,
      attendee,
      ticket,
      invoice,
      checkoutSession,
      auditLog,
      privacyRequest,
      otherOrder,
    ] = await Promise.all([
      db.selectFrom('orders').selectAll().where('id', '=', ids.orderId).executeTakeFirstOrThrow(),
      db
        .selectFrom('attendees')
        .selectAll()
        .where('id', '=', ids.attendeeId)
        .executeTakeFirstOrThrow(),
      db.selectFrom('tickets').selectAll().where('id', '=', ids.ticketId).executeTakeFirstOrThrow(),
      db
        .selectFrom('invoices')
        .selectAll()
        .where('id', '=', ids.invoiceId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('checkout_sessions')
        .selectAll()
        .where('id', '=', ids.checkoutSessionId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('audit_logs')
        .selectAll()
        .where('id', '=', ids.auditLogId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('privacy_requests')
        .selectAll()
        .where('id', '=', ids.requestId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('orders')
        .selectAll()
        .where('id', '=', ids.otherOrderId)
        .executeTakeFirstOrThrow(),
    ]);

    expect(order).toMatchObject({
      id: ids.orderId,
      buyer_email: 'erased+aaaaaaaaaaaaaaaa@privacy.tixkit.invalid',
      buyer_first_name: null,
      buyer_last_name: null,
      buyer_phone: null,
    });
    expect(attendee).toMatchObject({
      id: ids.attendeeId,
      email: 'erased+bbbbbbbbbbbbbbbb@privacy.tixkit.invalid',
      first_name: null,
      last_name: null,
      phone: null,
      custom_answers: null,
    });
    expect(ticket).toMatchObject({ id: ids.ticketId, transferred_to_email: null });
    expect(invoice).toMatchObject({
      id: ids.invoiceId,
      buyer_name: null,
      buyer_tax_id: null,
    });
    expect(String(invoice.buyer_email)).toMatch(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/);
    expect(parseJsonColumn(checkoutSession.buyer)).toMatchObject({
      email: expect.stringMatching(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/),
      firstName: null,
      lastName: null,
      phone: null,
    });
    expect(parseJsonColumn(auditLog.diff_summary)).toMatchObject({
      subjectEmail: expect.stringMatching(/^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/),
    });
    expect(privacyRequest).toMatchObject({ id: ids.requestId, status: 'completed', error: null });
    expect(String(privacyRequest.subject_email)).toMatch(
      /^erased\+[a-f0-9]{16}@privacy\.tixkit\.invalid$/,
    );
    expect(parseJsonColumn(privacyRequest.result)).toMatchObject({
      ordersRedacted: 0,
      attendeesRedacted: 0,
      ticketsTouched: 0,
    });
    expect(otherOrder).toMatchObject({
      id: ids.otherOrderId,
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Other',
    });
  });
});
