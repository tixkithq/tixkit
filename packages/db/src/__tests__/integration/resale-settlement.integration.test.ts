import { createHash } from 'node:crypto';
import { Migrator } from 'kysely/migration';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, TixkitMigrationProvider, truncateAllData } from '../../migrate.js';
import {
  AttendeeRepository,
  BrandRepository,
  CheckoutSessionRepository,
  EventRepository,
  InventoryPoolRepository,
  OrderRepository,
  OrganizationRepository,
  ResaleSettlementConflictError,
  ResaleSettlementRepository,
  TenantRepository,
  TicketListingRepository,
  TicketRepository,
  TicketTypeRepository,
} from '../../repositories/index.js';

const TERMS_VERSION = '2026-07-16';
const TERMS_ACCEPTANCE = {
  accepted: true,
  termsVersion: TERMS_VERSION,
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
  it.skip('resale settlement integration (skipped: no PostgreSQL/MySQL URL)', () => {});
}

describe.sequential.each(driverCases)(
  'resale settlement integration: $driver',
  ({ driver, url }) => {
    let db: Database;

    beforeAll(async () => {
      process.env.DB_DRIVER = driver;
      await runMigrations(url);
      db = createDb(url);
    }, 120_000);

    beforeEach(async () => {
      await truncateAllData(db);
    }, 60_000);

    afterAll(async () => {
      await db?.destroy();
    }, 60_000);

    async function createFixture(suffix: string) {
      const tenant = await new TenantRepository(db).create({ name: `Settlement Tenant ${suffix}` });
      const organization = await new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: `Settlement Organization ${suffix}`,
        slug: `settlement-org-${driver}-${suffix}`,
      });
      const brand = await new BrandRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        name: `Settlement Brand ${suffix}`,
        slug: `settlement-brand-${driver}-${suffix}`,
      });
      const event = await new EventRepository(db).create({
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        slug: `settlement-event-${driver}-${suffix}`,
        title: `Settlement Event ${suffix}`,
        currency: 'USD',
        timezone: 'America/Chicago',
        startsAt: new Date('2027-01-01T18:00:00.000Z'),
      });
      const pool = await new InventoryPoolRepository(db).create({
        eventId: event.id,
        name: 'General admission',
        totalCapacity: 10,
      });
      const ticketType = await new TicketTypeRepository(db).create({
        eventId: event.id,
        inventoryPoolId: pool.id,
        name: 'GA',
        kind: 'paid',
        currency: 'USD',
        priceCents: 2_500,
      });

      async function createOrderWithTicket(role: 'seller' | 'buyer') {
        const email = `${role}-${driver}-${suffix}@example.test`;
        const checkout = await new CheckoutSessionRepository(db).create({
          tenantId: tenant.id,
          eventId: event.id,
          brandId: brand.id,
          currency: 'USD',
          cart: { items: [{ ticketTypeId: ticketType.id, quantity: 1 }] },
          buyer: { email },
          quote: { totalCents: 2_500 },
          expiresAt: new Date('2027-01-01T17:00:00.000Z'),
          idempotencyKey: `settlement-${driver}-${suffix}-${role}`,
        });
        const order = await new OrderRepository(db).create({
          tenantId: tenant.id,
          organizationId: organization.id,
          brandId: brand.id,
          eventId: event.id,
          checkoutSessionId: checkout.id,
          orderNumber: `SETTLEMENT-${driver}-${suffix}-${role}`,
          status: 'paid',
          currency: 'USD',
          subtotalCents: 2_500,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: 2_500,
          buyerEmail: email,
        });
        const attendee = await new AttendeeRepository(db).create({
          tenantId: tenant.id,
          orderId: order.id,
          eventId: event.id,
          ticketTypeId: ticketType.id,
          email,
        });
        const ticket = await new TicketRepository(db).create({
          tenantId: tenant.id,
          orderId: order.id,
          attendeeId: attendee.id,
          eventId: event.id,
          ticketTypeId: ticketType.id,
          code: `SETTLEMENT-${driver}-${suffix}-${role}`,
          qrPayload: `settlement-payload-${driver}-${suffix}-${role}`,
          qrHash: `settlement-hash-${driver}-${suffix}-${role}`,
        });
        return { order, ticket };
      }

      const seller = await createOrderWithTicket('seller');
      const buyer = await createOrderWithTicket('buyer');
      const listings = new TicketListingRepository(db);
      const listing = await listings.create({
        tenantId: tenant.id,
        eventId: event.id,
        ticketId: seller.ticket.id,
        sellerId: seller.order.id,
        priceCents: 2_400,
        currency: 'USD',
        faceValueCents: 2_500,
        termsAcceptance: TERMS_ACCEPTANCE,
      });
      await listings.markSold(listing.id, buyer.order.id);

      const scope = {
        tenantId: tenant.id,
        organizationId: organization.id,
        brandId: brand.id,
        eventId: event.id,
        listingId: listing.id,
      };
      const accrual = {
        ...scope,
        sellerOrderId: seller.order.id,
        buyerOrderId: buyer.order.id,
        sellerTicketId: seller.ticket.id,
        buyerTicketId: buyer.ticket.id,
        currency: 'USD',
        grossCents: 2_400,
        feeCents: 240,
        payableCents: 2_160,
        termsVersion: TERMS_VERSION,
        evidence: {
          idempotencyKey: `accrue-${driver}-${suffix}`,
          actorId: 'checkout-finalization',
          method: 'checkout_workflow',
        },
      };
      return { tenant, organization, brand, event, seller, buyer, listing, scope, accrual };
    }

    it('accrues once in the caller transaction and enforces optimistic idempotent transitions', async () => {
      const fixture = await createFixture('lifecycle');
      await expect(
        db.transaction().execute(async (trx) =>
          new ResaleSettlementRepository(trx).createAndAccrue({
            ...fixture.accrual,
            sellerTicketId: fixture.buyer.ticket.id,
          }),
        ),
      ).rejects.toMatchObject({ message: 'RESALE_SETTLEMENT_LISTING_NOT_ELIGIBLE' });
      await expect(
        db
          .selectFrom('resale_settlements')
          .select('id')
          .where('listing_id', '=', fixture.listing.id)
          .execute(),
      ).resolves.toEqual([]);
      const settlement = await db
        .transaction()
        .execute(async (trx) =>
          new ResaleSettlementRepository(trx).createAndAccrue(fixture.accrual),
        );

      expect(settlement).toMatchObject({
        listing_id: fixture.listing.id,
        tenant_id: fixture.tenant.id,
        organization_id: fixture.organization.id,
        brand_id: fixture.brand.id,
        event_id: fixture.event.id,
        seller_order_id: fixture.seller.order.id,
        buyer_order_id: fixture.buyer.order.id,
        seller_ticket_id: fixture.seller.ticket.id,
        buyer_ticket_id: fixture.buyer.ticket.id,
        currency: 'USD',
        state: 'pending',
        terms_version: TERMS_VERSION,
      });
      expect(Number(settlement.gross_cents)).toBe(2_400);
      expect(Number(settlement.fee_cents)).toBe(240);
      expect(Number(settlement.payable_cents)).toBe(2_160);
      expect(Number(settlement.version)).toBe(1);
      await expect(
        db
          .selectFrom('resale_settlements')
          .select('id')
          .where('listing_id', '=', fixture.listing.id)
          .where('state', '=', 'pending')
          .execute(),
      ).resolves.toEqual([{ id: settlement.id }]);

      const repository = new ResaleSettlementRepository(db);
      expect(await repository.listEntriesExact(fixture.scope)).toEqual([
        expect.objectContaining({
          settlement_id: settlement.id,
          tenant_id: fixture.tenant.id,
          kind: 'payable_accrued',
          currency: 'USD',
          idempotency_key: fixture.accrual.evidence.idempotencyKey,
          actor_id: 'checkout-finalization',
          method: 'checkout_workflow',
          external_reference_sha256: null,
        }),
      ]);

      const replay = await db
        .transaction()
        .execute(async (trx) =>
          new ResaleSettlementRepository(trx).createAndAccrue(fixture.accrual),
        );
      expect(replay.id).toBe(settlement.id);
      await expect(repository.listEntriesExact(fixture.scope)).resolves.toHaveLength(1);
      await expect(
        db.transaction().execute(async (trx) =>
          new ResaleSettlementRepository(trx).createAndAccrue({
            ...fixture.accrual,
            evidence: { ...fixture.accrual.evidence, reason: 'changed replay' },
          }),
        ),
      ).rejects.toMatchObject({ message: 'RESALE_SETTLEMENT_IDEMPOTENCY_CONFLICT' });

      const rawReference = 'provider-payout-reference-sensitive';
      const referenceHash = createHash('sha256').update(rawReference).digest('hex');
      const payoutInput = {
        ...fixture.scope,
        amountCents: 2_160,
        currency: 'USD',
        expectedVersion: 1,
        evidence: {
          idempotencyKey: `payout-${driver}`,
          actorId: 'usr_billing_admin',
          method: 'external_bank_transfer',
          externalReferenceSha256: referenceHash,
          reason: 'Organizer confirmed payout',
        },
      };
      await expect(
        db.transaction().execute(async (trx) =>
          new ResaleSettlementRepository(trx).recordPayout({
            ...payoutInput,
            evidence: { ...payoutInput.evidence, externalReferenceSha256: rawReference },
          }),
        ),
      ).rejects.toThrow('RESALE_SETTLEMENT_EXTERNAL_REFERENCE_MUST_BE_SHA256');

      const paid = await db
        .transaction()
        .execute(async (trx) => new ResaleSettlementRepository(trx).recordPayout(payoutInput));
      expect(paid).toMatchObject({ state: 'paid' });
      expect(Number(paid.paid_cents)).toBe(2_160);
      expect(Number(paid.version)).toBe(2);
      const payoutReplay = await db
        .transaction()
        .execute(async (trx) => new ResaleSettlementRepository(trx).recordPayout(payoutInput));
      expect(Number(payoutReplay.version)).toBe(2);
      await expect(
        db.transaction().execute(async (trx) =>
          new ResaleSettlementRepository(trx).recordReversal({
            ...fixture.scope,
            amountCents: 2_160,
            currency: 'USD',
            expectedVersion: 1,
            evidence: {
              idempotencyKey: `reversal-stale-${driver}`,
              actorId: 'usr_billing_admin',
              method: 'manual_resolution',
            },
          }),
        ),
      ).rejects.toMatchObject({ message: 'RESALE_SETTLEMENT_VERSION_CONFLICT' });
      await expect(
        db.transaction().execute(async (trx) =>
          new ResaleSettlementRepository(trx).recordPayout({
            ...payoutInput,
            expectedVersion: 2,
            evidence: { ...payoutInput.evidence, idempotencyKey: `payout-stale-${driver}` },
          }),
        ),
      ).rejects.toMatchObject({ message: 'RESALE_SETTLEMENT_INVALID_PAYOUT_TRANSITION' });

      const reversalInput = {
        ...fixture.scope,
        amountCents: 2_160,
        currency: 'USD',
        expectedVersion: 2,
        evidence: {
          idempotencyKey: `reversal-${driver}`,
          actorId: 'usr_billing_admin',
          method: 'manual_resolution',
          reason: 'Buyer refund requires seller recovery',
        },
      };
      const recovery = await db
        .transaction()
        .execute(async (trx) => new ResaleSettlementRepository(trx).recordReversal(reversalInput));
      expect(recovery).toMatchObject({ state: 'recovery_required' });
      expect(Number(recovery.reversed_cents)).toBe(2_160);
      expect(Number(recovery.recovery_cents)).toBe(2_160);
      expect(Number(recovery.version)).toBe(3);
      const reversalReplay = await db
        .transaction()
        .execute(async (trx) => new ResaleSettlementRepository(trx).recordReversal(reversalInput));
      expect(Number(reversalReplay.version)).toBe(3);

      const serialized = JSON.stringify(await repository.listEntriesExact(fixture.scope));
      expect(serialized).toContain(referenceHash);
      expect(serialized).not.toContain(rawReference);
      await expect(repository.listEntriesExact(fixture.scope)).resolves.toHaveLength(3);
    });

    it('fails closed across tenants and keeps ledger entries append-only', async () => {
      const fixture = await createFixture('isolation');
      const settlement = await db
        .transaction()
        .execute(async (trx) =>
          new ResaleSettlementRepository(trx).createAndAccrue(fixture.accrual),
        );
      const foreignTenant = await new TenantRepository(db).create({ name: 'Foreign Tenant' });
      const wrongScope = { ...fixture.scope, tenantId: foreignTenant.id };
      const repository = new ResaleSettlementRepository(db);

      await expect(repository.findExact(wrongScope)).resolves.toBeUndefined();
      await expect(repository.listEntriesExact(wrongScope)).resolves.toEqual([]);
      await expect(
        db.transaction().execute(async (trx) =>
          new ResaleSettlementRepository(trx).recordReversal({
            ...wrongScope,
            amountCents: 2_160,
            currency: 'USD',
            expectedVersion: 1,
            evidence: {
              idempotencyKey: `cross-tenant-${driver}`,
              actorId: 'usr_foreign',
              method: 'manual_resolution',
            },
          }),
        ),
      ).rejects.toBeInstanceOf(ResaleSettlementConflictError);

      const entry = (await repository.listEntriesExact(fixture.scope))[0]!;
      await expect(
        db
          .updateTable('resale_settlement_entries')
          .set({ reason: 'forbidden mutation' })
          .where('id', '=', entry.id)
          .execute(),
      ).rejects.toThrow();
      await expect(
        db.deleteFrom('resale_settlement_entries').where('id', '=', entry.id).execute(),
      ).rejects.toThrow();
      await expect(repository.listEntriesExact(fixture.scope)).resolves.toEqual([
        expect.objectContaining({
          id: entry.id,
          settlement_id: settlement.id,
          reason: null,
        }),
      ]);
    });

    it('rolls settlement and accrual back atomically with the caller transaction', async () => {
      const fixture = await createFixture('rollback');
      await expect(
        db.transaction().execute(async (trx) => {
          await new ResaleSettlementRepository(trx).createAndAccrue(fixture.accrual);
          throw new Error('FORCED_CALLER_ROLLBACK');
        }),
      ).rejects.toThrow('FORCED_CALLER_ROLLBACK');

      const repository = new ResaleSettlementRepository(db);
      await expect(repository.findExact(fixture.scope)).resolves.toBeUndefined();
      await expect(repository.listEntriesExact(fixture.scope)).resolves.toEqual([]);
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
    });

    it('rolls migration 0089 down and reapplies it cleanly', async () => {
      const legacy = await createFixture('legacy-backfill');
      const migrator = new Migrator({ db, provider: new TixkitMigrationProvider() });
      const down = await migrator.migrateDown();
      expect(down.error).toBeUndefined();
      expect(down.results?.at(-1)).toMatchObject({
        migrationName: '0089_resale_settlements',
        direction: 'Down',
        status: 'Success',
      });

      const up = await migrator.migrateUp();
      expect(up.error).toBeUndefined();
      expect(up.results?.at(-1)).toMatchObject({
        migrationName: '0089_resale_settlements',
        direction: 'Up',
        status: 'Success',
      });

      const backfilled = await db
        .selectFrom('resale_settlements')
        .selectAll()
        .where('listing_id', '=', legacy.listing.id)
        .executeTakeFirstOrThrow();
      expect(backfilled).toMatchObject({
        id: legacy.listing.id,
        listing_id: legacy.listing.id,
        state: 'review_required',
        currency: 'USD',
        terms_version: null,
        fee_cents: null,
        payable_cents: null,
        paid_cents: null,
        reversed_cents: null,
        recovery_cents: null,
      });
      expect(Number(backfilled.gross_cents)).toBe(2_400);
      await expect(
        db
          .selectFrom('resale_settlement_entries')
          .select('id')
          .where('settlement_id', '=', backfilled.id)
          .execute(),
      ).resolves.toEqual([]);

      const fixture = await createFixture('reapply');
      const settlement = await db
        .transaction()
        .execute(async (trx) =>
          new ResaleSettlementRepository(trx).createAndAccrue(fixture.accrual),
        );
      expect(settlement).toMatchObject({ state: 'pending', listing_id: fixture.listing.id });
    });
  },
);
