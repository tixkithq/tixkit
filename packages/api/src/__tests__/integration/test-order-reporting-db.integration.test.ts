import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  BrandRepository,
  createDb,
  EventRepository,
  InventoryPoolRepository,
  OrganizationRepository,
  TenantRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { reportingRoutes } from '../../routes/modules/reporting.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('test-order reporting exclusion', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let eventId: string;

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const suffix = ulid().slice(-10).toLowerCase();
    const tenant = await new TenantRepository(db).create({ name: `Reporting ${suffix}` });
    const organization = await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: `Reporting ${suffix}`,
      slug: `reporting-${suffix}`,
    });
    const brand = await new BrandRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      name: `Reporting ${suffix}`,
      slug: `reporting-${suffix}`,
    });
    const event = await new EventRepository(db).create({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      slug: `reporting-${suffix}`,
      title: 'Reporting exclusion',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00.000Z'),
    });
    eventId = event.id;
    const pool = await new InventoryPoolRepository(db).create({
      eventId: event.id,
      name: 'Reporting inventory',
      totalCapacity: 10,
    });
    const ticketType = await new TicketTypeRepository(db).create({
      eventId: event.id,
      inventoryPoolId: pool.id,
      name: 'Reporting ticket',
      kind: 'paid',
      status: 'on_sale',
      currency: 'USD',
      priceCents: 10_000,
    });
    const now = new Date();
    for (const [index, isTest] of [false, true].entries()) {
      const sessionId = `cs_reporting_${suffix}_${index}`;
      const orderId = `ord_reporting_${suffix}_${index}`;
      await db
        .insertInto('checkout_sessions')
        .values({
          id: sessionId,
          tenant_id: tenant.id,
          event_id: event.id,
          brand_id: brand.id,
          status: 'completed',
          hold_id: null,
          currency: 'USD',
          cart: '{}',
          buyer: JSON.stringify({ email: `buyer-${index}@example.test` }),
          quote: JSON.stringify({ totalCents: isTest ? 90_000 : 10_000 }),
          payment_intent_id: null,
          order_id: orderId,
          success_url: null,
          cancel_url: null,
          expires_at: new Date(now.getTime() + 60_000),
          idempotency_key: `reporting-${suffix}-${index}`,
          client_token: `token-${suffix}-${index}`,
          is_test: isTest,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('orders')
        .values({
          id: orderId,
          tenant_id: tenant.id,
          organization_id: organization.id,
          brand_id: brand.id,
          event_id: event.id,
          checkout_session_id: sessionId,
          order_number: `TK-REPORT-${suffix}-${index}`,
          status: 'paid',
          currency: 'USD',
          subtotal_cents: isTest ? 90_000 : 10_000,
          discount_cents: 0,
          tax_cents: 0,
          fee_cents: 0,
          total_cents: isTest ? 90_000 : 10_000,
          refunded_cents: 0,
          buyer_email: `buyer-${index}@example.test`,
          buyer_first_name: null,
          buyer_last_name: null,
          buyer_phone: null,
          buyer_date_of_birth: null,
          payment_intent_id: null,
          payment_provider: null,
          sales_channel: 'online',
          operator_id: null,
          tender_type: null,
          is_test: isTest,
          paid_at: now,
          refunded_at: null,
          cancelled_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      const attendeeId = `att_reporting_${suffix}_${index}`;
      await db
        .insertInto('attendees')
        .values({
          id: attendeeId,
          tenant_id: tenant.id,
          order_id: orderId,
          event_id: event.id,
          event_occurrence_id: null,
          ticket_type_id: ticketType.id,
          ticket_id: null,
          first_name: 'Reporting',
          last_name: isTest ? 'Test' : 'Real',
          email: `buyer-${index}@example.test`,
          phone: null,
          status: 'checked_in',
          custom_answers: null,
          checked_in_at: now,
          check_in_device_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('tickets')
        .values({
          id: `tkt_reporting_${suffix}_${index}`,
          tenant_id: tenant.id,
          order_id: orderId,
          attendee_id: attendeeId,
          event_id: event.id,
          event_occurrence_id: null,
          ticket_type_id: ticketType.id,
          status: 'checked_in',
          code: `REPORT-${suffix}-${index}`,
          qr_payload: `report-payload-${suffix}-${index}`,
          qr_hash: `report-hash-${suffix}-${index}`,
          transferred_to_email: null,
          transferred_at: null,
          checked_in_at: now,
          checked_in_by_device_id: null,
          wallet_pass_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      if (isTest) {
        await db
          .insertInto('refunds')
          .values({
            id: `ref_reporting_${suffix}`,
            tenant_id: tenant.id,
            order_id: orderId,
            payment_intent_id: null,
            provider: 'test',
            provider_refund_id: `provider-refund-${suffix}`,
            request_idempotency_key: null,
            request_nonce: null,
            amount_cents: 50_000,
            currency: 'USD',
            status: 'succeeded',
            reason: 'test-order-refund',
            metadata: '{}',
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
    }

    const principal: Principal = {
      type: 'user',
      id: `usr_reporting_${suffix}`,
      tenantId: tenant.id,
      organizationIds: [organization.id],
      brandIds: [brand.id],
      eventIds: [event.id],
      scopes: ['events.read', 'reports.read'],
    };
    app = Fastify();
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(reportingRoutes);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('excludes a persisted test order from real sales aggregates', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/events/${eventId}/reports/sales`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      eventId,
      grossSalesCents: 10_000,
      netRevenueCents: 10_000,
      refundsCents: 0,
      ticketsSold: 1,
      checkIns: 1,
      ordersCount: 1,
      paidOrdersCount: 1,
    });
  });
});
