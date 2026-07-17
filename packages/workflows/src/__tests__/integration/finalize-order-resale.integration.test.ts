import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AttendeeRepository,
  BrandRepository,
  CheckoutSessionRepository,
  createDb,
  EventRepository,
  InventoryPoolRepository,
  OrderRepository,
  OrganizationRepository,
  runMigrations,
  sql,
  TenantRepository,
  TicketListingRepository,
  TicketRepository,
  TicketTypeRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import { ulid } from 'ulid';
import { closeActivityClients } from '../../activities/activity-clients.js';
import { finalizeOrderActivity } from '../../activities/checkout.js';

const CURRENT_TERMS = {
  accepted: true,
  termsVersion: '2026-07-16',
  settlementModel: 'organizer_managed',
  refundModel: 'manual_coordinated_resolution',
} as const;

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const allDriverCases: DriverCase[] = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
];
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver
    ? allDriverCases.filter((entry) => entry.driver === requestedDriver)
    : allDriverCases
).filter((entry) => entry.url.length > 0);

if (driverCases.length === 0) {
  it.skip('resale finalization integration (skipped: no PostgreSQL/MySQL URL)', () => {});
}

describe.sequential.each(driverCases)(
  'finalizeOrderActivity resale integration: $driver',
  ({ driver, url }) => {
    let db: Database;

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await closeActivityClients();
      await runMigrations(url);
      db = createDb(url);
    }, 120_000);

    beforeEach(async () => {
      await closeActivityClients();
      process.env.DB_DRIVER = driver;
      await truncateAllData(db);
    }, 60_000);

    afterAll(async () => {
      await closeActivityClients();
      await db?.destroy();
    }, 60_000);

    async function createFixture(input: {
      buyerTermsVersion?: string;
      sellerTermsVersion?: string;
      suffix: string;
    }) {
      const unique = `${driver}-${input.suffix}-${ulid().slice(-8).toLowerCase()}`;
      const tenant = await new TenantRepository(db).create({ name: `Resale ${unique}` });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Resale ${unique}`,
        slug: `resale-org-${unique}`,
      });
      const brand = await new BrandRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        name: `Resale ${unique}`,
        slug: `resale-brand-${unique}`,
      });
      const event = await new EventRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `resale-event-${unique}`,
        title: `Resale ${unique}`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: new Date(Date.now() + 86_400_000),
      });
      await db
        .updateTable('events')
        .set({ status: 'published', resale_enabled: true, updated_at: new Date() })
        .where('id', '=', event.id)
        .execute();
      const pool = await new InventoryPoolRepository(db).create({
        eventId: event.id,
        name: 'General admission',
        totalCapacity: 10,
      });
      const ticketType = await new TicketTypeRepository(db).create({
        eventId: event.id,
        inventoryPoolId: pool.id,
        name: 'General admission',
        kind: 'paid',
        currency: 'USD',
        priceCents: 5_000,
      });

      const sellerCheckout = await new CheckoutSessionRepository(db).create({
        tenantId: tenant.id,
        eventId: event.id,
        brandId: brand.id,
        currency: 'USD',
        cart: { items: [{ ticketTypeId: ticketType.id, quantity: 1 }] },
        buyer: { email: `seller-${unique}@example.test` },
        quote: { totalCents: 5_000 },
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `seller-${unique}`,
      });
      const sellerOrder = await new OrderRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        eventId: event.id,
        checkoutSessionId: sellerCheckout.id,
        orderNumber: `SELLER-${unique}`,
        status: 'paid',
        currency: 'USD',
        subtotalCents: 5_000,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5_000,
        buyerEmail: `seller-${unique}@example.test`,
      });
      const sellerAttendee = await new AttendeeRepository(db).create({
        tenantId: tenant.id,
        orderId: sellerOrder.id,
        eventId: event.id,
        ticketTypeId: ticketType.id,
        email: `seller-${unique}@example.test`,
      });
      const sellerTicket = await new TicketRepository(db).create({
        tenantId: tenant.id,
        orderId: sellerOrder.id,
        attendeeId: sellerAttendee.id,
        eventId: event.id,
        ticketTypeId: ticketType.id,
        code: `SELLER-${unique}`,
        qrPayload: `seller-payload-${unique}`,
        qrHash: `seller-hash-${unique}`,
      });
      const listing = await new TicketListingRepository(db).create({
        tenantId: tenant.id,
        eventId: event.id,
        ticketId: sellerTicket.id,
        sellerId: sellerOrder.id,
        priceCents: 5_500,
        currency: 'USD',
        faceValueCents: 5_000,
        termsAcceptance: CURRENT_TERMS,
      });
      if (input.sellerTermsVersion) {
        await db
          .updateTable('ticket_listings')
          .set({ seller_terms_version: input.sellerTermsVersion, updated_at: new Date() })
          .where('id', '=', listing.id)
          .execute();
      }

      const buyerCheckout = await new CheckoutSessionRepository(db).create({
        tenantId: tenant.id,
        eventId: event.id,
        brandId: brand.id,
        currency: 'USD',
        cart: {
          items: [{ resaleListingId: listing.id, quantity: 1 }],
          buyerFields: {},
          attendeeFields: {},
          resaleTermsAcceptance: {
            ...CURRENT_TERMS,
            termsVersion: input.buyerTermsVersion ?? CURRENT_TERMS.termsVersion,
          },
        },
        buyer: {
          email: `buyer-${unique}@example.test`,
          firstName: 'Resale',
          lastName: 'Buyer',
        },
        quote: {
          subtotalCents: 5_500,
          discountCents: 0,
          taxCents: 0,
          feeCents: 500,
          totalCents: 6_000,
          lineItems: [
            {
              type: 'resale',
              ticketTypeId: ticketType.id,
              resaleListingId: listing.id,
              name: 'Resale ticket - General admission',
              quantity: 1,
              unitPriceCents: 5_500,
              subtotalCents: 5_500,
              discountCents: 0,
              taxCents: 0,
              feeCents: 500,
              totalCents: 6_000,
            },
          ],
        },
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: `buyer-${unique}`,
      });
      await new TicketListingRepository(db).reserveForCheckout({
        tenantId: tenant.id,
        listingId: listing.id,
        checkoutSessionId: buyerCheckout.id,
        reservedUntil: new Date(Date.now() + 60_000),
      });

      return {
        tenant,
        sellerOrder,
        sellerTicket,
        listing,
        buyerCheckout,
      };
    }

    async function finalize(checkoutSessionId: string, tenantId: string) {
      return finalizeOrderActivity({
        checkoutSessionId,
        tenantId,
        paymentMode: 'offline',
        salesChannel: 'box_office',
        operatorId: 'usr_resale_integration',
        tenderType: 'cash',
      });
    }

    it('atomically fulfills resale, accrues one payable, and replays without duplicates', async () => {
      const fixture = await createFixture({ suffix: 'success' });

      const result = await finalize(fixture.buyerCheckout.id, fixture.tenant.id);
      expect(result).toMatchObject({ ok: true });
      const buyerOrderId = result.ok ? result.value.orderId : '';
      await expect(finalize(fixture.buyerCheckout.id, fixture.tenant.id)).resolves.toEqual(result);

      const buyerTickets = await db
        .selectFrom('tickets')
        .selectAll()
        .where('order_id', '=', buyerOrderId)
        .execute();
      expect(buyerTickets).toHaveLength(1);
      await expect(
        db.selectFrom('orders').select('id').where('id', '=', buyerOrderId).execute(),
      ).resolves.toEqual([{ id: buyerOrderId }]);
      await expect(
        db.selectFrom('attendees').select('id').where('order_id', '=', buyerOrderId).execute(),
      ).resolves.toHaveLength(1);
      await expect(
        db.selectFrom('tickets').select('id').where('order_id', '=', buyerOrderId).execute(),
      ).resolves.toHaveLength(1);
      await expect(
        db
          .selectFrom('order_line_items')
          .select('id')
          .where('order_id', '=', buyerOrderId)
          .execute(),
      ).resolves.toHaveLength(1);

      expect(
        await db
          .selectFrom('tickets')
          .select(['status', 'transferred_to_email'])
          .where('id', '=', fixture.sellerTicket.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'transferred', transferred_to_email: expect.stringContaining('buyer-') });
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['status', 'sold_to_id', 'reserved_checkout_session_id', 'reserved_until'])
          .where('id', '=', fixture.listing.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status: 'sold',
        sold_to_id: buyerOrderId,
        reserved_checkout_session_id: null,
        reserved_until: null,
      });

      const settlements = await db
        .selectFrom('resale_settlements')
        .selectAll()
        .where('listing_id', '=', fixture.listing.id)
        .execute();
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toMatchObject({
        seller_order_id: fixture.sellerOrder.id,
        buyer_order_id: buyerOrderId,
        seller_ticket_id: fixture.sellerTicket.id,
        buyer_ticket_id: buyerTickets[0]?.id,
        currency: 'USD',
        state: 'pending',
        terms_version: CURRENT_TERMS.termsVersion,
      });
      expect(Number(settlements[0]?.gross_cents)).toBe(5_500);
      expect(Number(settlements[0]?.fee_cents)).toBe(500);
      expect(Number(settlements[0]?.payable_cents)).toBe(5_000);
      await expect(
        db
          .selectFrom('resale_settlement_entries')
          .select(['kind', 'amount_cents', 'currency', 'idempotency_key'])
          .where('settlement_id', '=', settlements[0]!.id)
          .execute(),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: 'payable_accrued',
          amount_cents: expect.anything(),
          currency: 'USD',
          idempotency_key: `checkout:${fixture.buyerCheckout.id}:resale:${fixture.listing.id}:accrual`,
        }),
      ]);
    });

    it('rolls the complete resale finalization back when accrual entry insertion fails', async () => {
      const fixture = await createFixture({ suffix: 'rollback' });
      if (driver === 'postgres') {
        await sql`drop trigger if exists tixkit_test_reject_resale_entry on resale_settlement_entries`.execute(
          db,
        );
        await sql`drop function if exists tixkit_test_reject_resale_entry()`.execute(db);
        await sql`create function tixkit_test_reject_resale_entry() returns trigger language plpgsql as $$
          begin raise exception 'forced settlement entry failure'; end $$`.execute(db);
        await sql`create trigger tixkit_test_reject_resale_entry before insert on resale_settlement_entries
          for each row execute function tixkit_test_reject_resale_entry()`.execute(db);
      } else {
        await sql`drop trigger if exists tixkit_test_reject_resale_entry`.execute(db);
        await sql`create trigger tixkit_test_reject_resale_entry before insert on resale_settlement_entries
          for each row signal sqlstate '45000' set message_text = 'forced settlement entry failure'`.execute(
          db,
        );
      }

      try {
        await expect(finalize(fixture.buyerCheckout.id, fixture.tenant.id)).resolves.toMatchObject({
          ok: false,
          errorCode: 'ORDER_FINALIZE_FAILED',
          retryable: false,
        });
      } finally {
        if (driver === 'postgres') {
          await sql`drop trigger tixkit_test_reject_resale_entry on resale_settlement_entries`.execute(
            db,
          );
          await sql`drop function tixkit_test_reject_resale_entry()`.execute(db);
        } else {
          await sql`drop trigger tixkit_test_reject_resale_entry`.execute(db);
        }
      }

      await expect(
        db
          .selectFrom('orders')
          .select('id')
          .where('checkout_session_id', '=', fixture.buyerCheckout.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom('tickets')
          .select('id')
          .where('order_id', '!=', fixture.sellerOrder.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom('resale_settlements')
          .select('id')
          .where('listing_id', '=', fixture.listing.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db.selectFrom('resale_settlement_entries').select('id').execute(),
      ).resolves.toEqual([]);
      expect(
        await db
          .selectFrom('tickets')
          .select(['status', 'transferred_to_email'])
          .where('id', '=', fixture.sellerTicket.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'valid', transferred_to_email: null });
      expect(
        await db
          .selectFrom('ticket_listings')
          .select(['status', 'sold_to_id', 'reserved_checkout_session_id'])
          .where('id', '=', fixture.listing.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        status: 'listed',
        sold_to_id: null,
        reserved_checkout_session_id: fixture.buyerCheckout.id,
      });
    });

    it('fails closed before mutation when buyer terms are stale', async () => {
      const fixture = await createFixture({
        suffix: 'stale-buyer',
        buyerTermsVersion: '2026-01-01',
      });

      await expect(finalize(fixture.buyerCheckout.id, fixture.tenant.id)).resolves.toMatchObject({
        ok: false,
        errorCode: 'RESALE_TERMS_NOT_ACCEPTED',
        retryable: false,
      });
      await expect(
        db
          .selectFrom('orders')
          .select('id')
          .where('checkout_session_id', '=', fixture.buyerCheckout.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom('resale_settlements')
          .select('id')
          .where('listing_id', '=', fixture.listing.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom('tickets')
          .select('status')
          .where('id', '=', fixture.sellerTicket.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: 'valid' });
    });

    it('fails closed transactionally when seller terms are stale', async () => {
      const fixture = await createFixture({
        suffix: 'stale-seller',
        sellerTermsVersion: '2026-01-01',
      });

      await expect(finalize(fixture.buyerCheckout.id, fixture.tenant.id)).resolves.toMatchObject({
        ok: false,
        errorCode: 'RESALE_SELLER_TERMS_NOT_ACCEPTED',
        retryable: false,
      });
      await expect(
        db
          .selectFrom('orders')
          .select('id')
          .where('checkout_session_id', '=', fixture.buyerCheckout.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom('resale_settlements')
          .select('id')
          .where('listing_id', '=', fixture.listing.id)
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom('tickets')
          .select('status')
          .where('id', '=', fixture.sellerTicket.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ status: 'valid' });
    });
  },
);
