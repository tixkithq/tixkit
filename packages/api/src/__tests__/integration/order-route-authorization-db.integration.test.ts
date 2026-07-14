import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CheckoutSessionRepository,
  createDb,
  EventRepository,
  OrderRepository,
  type Database,
} from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { orderRoutes } from '../../routes/modules/orders.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const orderReadRoutes = [
  '/orders/:orderId',
  '/orders/:orderId/invoice',
  '/orders/:orderId/invoice/download',
] as const;

type OrderPair = {
  draftId: string;
  paidId: string;
};

type AuthorizationScenario = {
  authorizedPrincipal: Principal;
  name: string;
  orders: OrderPair;
  principal: Principal;
};

describeWithIntegrationDatabase('order route authorization matrix', () => {
  let app: FastifyInstance;
  let db: Database;
  let previousDriver: string | undefined;
  let basePrincipal: Principal;
  let principal: Principal;
  let allowRefundWorkflow = false;
  const refundWorkflowOrderIds: string[] = [];

  const suffix = ulid().slice(-10).toLowerCase();
  const tenantA = `tnt_order_auth_a_${suffix}`;
  const tenantB = `tnt_order_auth_b_${suffix}`;
  const organizationA = `org_order_auth_a_${suffix}`;
  const organizationAOther = `org_order_auth_other_${suffix}`;
  const organizationB = `org_order_auth_b_${suffix}`;
  const brandA = `brd_order_auth_a_${suffix}`;
  const brandAOther = `brd_order_auth_other_${suffix}`;
  const brandAOrganizationOther = `brd_order_auth_org_${suffix}`;
  const brandB = `brd_order_auth_b_${suffix}`;
  const createdEventIds: string[] = [];
  const createdCheckoutSessionIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const idempotencyKeys: string[] = [];
  let allowedEventId: string;
  let crossTenantEventId: string;
  let crossOrganizationEventId: string;
  let crossBrandEventId: string;
  let crossEventId: string;
  let crossTenantOrders: OrderPair;
  let crossOrganizationOrders: OrderPair;
  let crossBrandOrders: OrderPair;
  let crossEventOrders: OrderPair;

  async function insertTenant(id: string, name: string) {
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
      .execute();
  }

  async function insertOrganization(id: string, tenantId: string, name: string) {
    const now = new Date();
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

  async function insertBrand(id: string, tenantId: string, organizationId: string, name: string) {
    const now = new Date();
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

  async function createEvent(
    tenantId: string,
    organizationId: string,
    brandId: string,
    title: string,
  ): Promise<string> {
    const event = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId,
      slug: `${title.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
      title,
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-02-01T18:00:00.000Z'),
      endsAt: new Date('2027-02-01T22:00:00.000Z'),
      venue: { name: 'Order Authorization Test Hall' },
    });
    createdEventIds.push(event.id);
    return event.id;
  }

  async function createOrderPair(
    tenantId: string,
    organizationId: string,
    brandId: string,
    eventId: string,
    label: string,
  ): Promise<OrderPair> {
    const checkoutRepository = new CheckoutSessionRepository(db);
    const orderRepository = new OrderRepository(db);

    const createOrder = async (status: 'draft' | 'paid') => {
      const checkoutSession = await checkoutRepository.create({
        tenantId,
        eventId,
        brandId,
        currency: 'USD',
        cart: {},
        buyer: { email: `${label}-${status}-${suffix}@example.com` },
        quote: { totalCents: 1_000 },
        expiresAt: new Date('2027-02-01T17:00:00.000Z'),
        idempotencyKey: `checkout-${label}-${status}-${suffix}`,
      });
      createdCheckoutSessionIds.push(checkoutSession.id);
      const order = await orderRepository.create({
        tenantId,
        organizationId,
        brandId,
        eventId,
        checkoutSessionId: checkoutSession.id,
        orderNumber: `AUTH-${label}-${status}-${suffix}`.toUpperCase(),
        status,
        currency: 'USD',
        subtotalCents: 1_000,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 1_000,
        buyerEmail: `${label}-${status}-${suffix}@example.com`,
      });
      createdOrderIds.push(order.id);
      if (status === 'paid') {
        const invoiceId = `inv_${ulid()}`;
        const now = new Date();
        await db
          .insertInto('invoices')
          .values({
            id: invoiceId,
            order_id: order.id,
            tenant_id: tenantId,
            organization_id: organizationId,
            brand_id: brandId,
            event_id: eventId,
            invoice_number: `INV-${label}-${suffix}`.toUpperCase(),
            status: 'issued',
            currency: 'USD',
            subtotal_cents: 1_000,
            discount_cents: 0,
            tax_cents: 0,
            fee_cents: 0,
            total_cents: 1_000,
            refunded_cents: 0,
            buyer_email: `${label}-${status}-${suffix}@example.com`,
            buyer_name: 'Authorization Test Buyer',
            buyer_tax_id: null,
            seller_name: 'Authorization Test Seller',
            seller_tax_id: null,
            reverse_charge: false,
            issued_at: now,
            voided_at: null,
            metadata: '{}',
            created_at: now,
            updated_at: now,
          })
          .execute();
        createdInvoiceIds.push(invoiceId);
      }
      return order.id;
    };

    return { draftId: await createOrder('draft'), paidId: await createOrder('paid') };
  }

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Order authorization tenant A');
    await insertTenant(tenantB, 'Order authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Order authorization organization A');
    await insertOrganization(organizationAOther, tenantA, 'Order authorization other organization');
    await insertOrganization(organizationB, tenantB, 'Order authorization organization B');
    await insertBrand(brandA, tenantA, organizationA, 'Order authorization brand A');
    await insertBrand(brandAOther, tenantA, organizationA, 'Order authorization other brand');
    await insertBrand(
      brandAOrganizationOther,
      tenantA,
      organizationAOther,
      'Order authorization other organization brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Order authorization brand B');

    allowedEventId = await createEvent(tenantA, organizationA, brandA, 'Allowed Order Event');
    crossEventId = await createEvent(tenantA, organizationA, brandA, 'Out Of Scope Order Event');
    crossBrandEventId = await createEvent(
      tenantA,
      organizationA,
      brandAOther,
      'Other Brand Order Event',
    );
    crossOrganizationEventId = await createEvent(
      tenantA,
      organizationAOther,
      brandAOrganizationOther,
      'Other Organization Order Event',
    );
    crossTenantEventId = await createEvent(
      tenantB,
      organizationB,
      brandB,
      'Foreign Tenant Order Event',
    );

    crossEventOrders = await createOrderPair(tenantA, organizationA, brandA, crossEventId, 'event');
    crossBrandOrders = await createOrderPair(
      tenantA,
      organizationA,
      brandAOther,
      crossBrandEventId,
      'brand',
    );
    crossOrganizationOrders = await createOrderPair(
      tenantA,
      organizationAOther,
      brandAOrganizationOther,
      crossOrganizationEventId,
      'organization',
    );
    crossTenantOrders = await createOrderPair(
      tenantB,
      organizationB,
      brandB,
      crossTenantEventId,
      'tenant',
    );

    basePrincipal = {
      type: 'user',
      id: `usr_order_auth_${suffix}`,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    principal = basePrincipal;

    app = Fastify({ logger: false });
    app.decorate('context', {
      db,
      temporalClient: {
        startRefund: async (input: { orderId: string }) => {
          refundWorkflowOrderIds.push(input.orderId);
          if (!allowRefundWorkflow) {
            throw new Error('refund workflow must not run for a denied order');
          }
        },
      },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(orderRoutes);
    await app.ready();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    try {
      if (app) await attemptCleanup(() => app.close());
    } finally {
      try {
        if (db) {
          if (idempotencyKeys.length > 0) {
            await attemptCleanup(() =>
              db.deleteFrom('idempotency_records').where('key', 'in', idempotencyKeys).execute(),
            );
          }
          for (const invoiceId of createdInvoiceIds) {
            await attemptCleanup(() =>
              db.deleteFrom('invoices').where('id', '=', invoiceId).execute(),
            );
          }
          for (const orderId of createdOrderIds) {
            await attemptCleanup(() =>
              db.deleteFrom('audit_logs').where('resource_id', '=', orderId).execute(),
            );
            await attemptCleanup(() =>
              db.deleteFrom('order_timeline_events').where('order_id', '=', orderId).execute(),
            );
            await attemptCleanup(() => db.deleteFrom('orders').where('id', '=', orderId).execute());
          }
          for (const checkoutSessionId of createdCheckoutSessionIds) {
            await attemptCleanup(() =>
              db.deleteFrom('checkout_sessions').where('id', '=', checkoutSessionId).execute(),
            );
          }
          for (const eventId of createdEventIds) {
            await attemptCleanup(() => db.deleteFrom('events').where('id', '=', eventId).execute());
          }
          for (const brandId of [brandA, brandAOther, brandAOrganizationOther, brandB]) {
            await attemptCleanup(() => db.deleteFrom('brands').where('id', '=', brandId).execute());
          }
          for (const organizationId of [organizationA, organizationAOther, organizationB]) {
            await attemptCleanup(() =>
              db.deleteFrom('organizations').where('id', '=', organizationId).execute(),
            );
          }
          for (const tenantId of [tenantA, tenantB]) {
            await attemptCleanup(() =>
              db.deleteFrom('tenants').where('id', '=', tenantId).execute(),
            );
          }
        }
      } finally {
        try {
          if (db) await attemptCleanup(() => db.destroy());
        } finally {
          try {
            restoreDatabaseDriver(previousDriver);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up order authorization fixtures');
    }
  });

  function scenarios(): AuthorizationScenario[] {
    return [
      {
        authorizedPrincipal: {
          ...basePrincipal,
          tenantId: tenantB,
          organizationIds: [organizationB],
        },
        name: 'cross-tenant principal',
        orders: crossTenantOrders,
        principal: { ...basePrincipal, tenantId: tenantA, organizationIds: [organizationA] },
      },
      {
        authorizedPrincipal: {
          ...basePrincipal,
          organizationIds: [organizationAOther],
        },
        name: 'cross-organization principal',
        orders: crossOrganizationOrders,
        principal: { ...basePrincipal, organizationIds: [organizationA] },
      },
      {
        authorizedPrincipal: {
          ...basePrincipal,
          brandIds: [brandAOther],
          organizationIds: [organizationA],
        },
        name: 'brand-scoped principal',
        orders: crossBrandOrders,
        principal: { ...basePrincipal, brandIds: [brandA], organizationIds: [organizationA] },
      },
      {
        authorizedPrincipal: {
          ...basePrincipal,
          brandIds: [brandA],
          eventIds: [crossEventId],
          organizationIds: [organizationA],
        },
        name: 'event-scoped principal',
        orders: crossEventOrders,
        principal: {
          ...basePrincipal,
          brandIds: [brandA],
          eventIds: [allowedEventId],
          organizationIds: [organizationA],
        },
      },
    ];
  }

  describe('read denial', () => {
    it('returns each order and invoice to its matching authorized principal', async () => {
      for (const route of orderReadRoutes) {
        for (const scenario of scenarios()) {
          principal = scenario.authorizedPrincipal;
          const response = await app.inject({
            method: 'GET',
            url: route.replace(':orderId', scenario.orders.paidId),
          });
          expect(response.statusCode, `${scenario.name}: ${route}: ${response.body}`).toBe(200);
          const body = response.json() as { id?: string; order?: { id?: string } };
          expect(body.id ?? body.order?.id).toBe(scenario.orders.paidId);
        }
      }
    });

    for (const route of orderReadRoutes) {
      it(`${route} hides orders outside every resource boundary`, async () => {
        for (const scenario of scenarios()) {
          principal = scenario.principal;
          const response = await app.inject({
            method: 'GET',
            url: route.replace(':orderId', scenario.orders.paidId),
          });
          expect(response.statusCode, `${scenario.name}: ${response.body}`).toBe(404);
          expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        }
      });
    }
  });

  it('denies cancellation and refund without database or workflow side effects', async () => {
    const beforeSideEffects = {
      auditLogs: await db
        .selectFrom('audit_logs')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      idempotencyRecords: await db
        .selectFrom('idempotency_records')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      timelineEvents: await db
        .selectFrom('order_timeline_events')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
    };
    const beforeOrders = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', 'in', createdOrderIds)
      .orderBy('id')
      .execute();

    for (const [index, scenario] of scenarios().entries()) {
      principal = scenario.principal;
      const cancelKey = `forbidden-cancel-${index}-${suffix}`;
      const refundKey = `forbidden-refund-${index}-${suffix}`;
      idempotencyKeys.push(cancelKey, refundKey);
      const [cancelResponse, refundResponse] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/orders/${scenario.orders.draftId}/cancel`,
          headers: { 'idempotency-key': cancelKey },
        }),
        app.inject({
          method: 'POST',
          url: `/orders/${scenario.orders.paidId}/refunds`,
          headers: { 'idempotency-key': refundKey },
          payload: { amountCents: 500, reason: `Forbidden refund ${suffix}` },
        }),
      ]);
      for (const response of [cancelResponse, refundResponse]) {
        expect(response.statusCode, `${scenario.name}: ${response.body}`).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    }

    const afterSideEffects = {
      auditLogs: await db
        .selectFrom('audit_logs')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      idempotencyRecords: await db
        .selectFrom('idempotency_records')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
      timelineEvents: await db
        .selectFrom('order_timeline_events')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
    };
    const afterOrders = await db
      .selectFrom('orders')
      .selectAll()
      .where('id', 'in', createdOrderIds)
      .orderBy('id')
      .execute();
    const forbiddenIdempotencyRecords = await db
      .selectFrom('idempotency_records')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('key', 'in', idempotencyKeys)
      .executeTakeFirstOrThrow();

    expect(afterSideEffects).toEqual(beforeSideEffects);
    expect(afterOrders).toEqual(beforeOrders);
    expect(Number(forbiddenIdempotencyRecords.count)).toBe(0);
    expect(refundWorkflowOrderIds).toEqual([]);
  });

  it('allows matching principals to cancel and request refunds with durable evidence', async () => {
    allowRefundWorkflow = true;
    const authorizedKeys: string[] = [];

    for (const [index, scenario] of scenarios().entries()) {
      principal = scenario.authorizedPrincipal;
      const cancelKey = `authorized-cancel-${index}-${suffix}`;
      const refundKey = `authorized-refund-${index}-${suffix}`;
      authorizedKeys.push(cancelKey, refundKey);
      idempotencyKeys.push(cancelKey, refundKey);
      const [cancelResponse, refundResponse] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/orders/${scenario.orders.draftId}/cancel`,
          headers: { 'idempotency-key': cancelKey },
        }),
        app.inject({
          method: 'POST',
          url: `/orders/${scenario.orders.paidId}/refunds`,
          headers: { 'idempotency-key': refundKey },
          payload: { amountCents: 500, reason: `Authorized refund ${suffix}` },
        }),
      ]);
      expect(cancelResponse.statusCode, `${scenario.name}: ${cancelResponse.body}`).toBe(200);
      expect(refundResponse.statusCode, `${scenario.name}: ${refundResponse.body}`).toBe(202);
    }

    const draftOrderIds = scenarios().map((scenario) => scenario.orders.draftId);
    const paidOrderIds = scenarios().map((scenario) => scenario.orders.paidId);
    const cancelledOrders = await db
      .selectFrom('orders')
      .select(['id', 'status', 'cancelled_at'])
      .where('id', 'in', draftOrderIds)
      .orderBy('id')
      .execute();
    const auditEvidence = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('resource_id', 'in', [...draftOrderIds, ...paidOrderIds])
      .where('action', 'in', ['order.cancelled', 'order.refund.requested'])
      .executeTakeFirstOrThrow();
    const idempotencyEvidence = await db
      .selectFrom('idempotency_records')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('key', 'in', authorizedKeys)
      .executeTakeFirstOrThrow();
    const timelineEvidence = await db
      .selectFrom('order_timeline_events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('order_id', 'in', draftOrderIds)
      .executeTakeFirstOrThrow();

    expect(cancelledOrders).toHaveLength(4);
    expect(cancelledOrders.every((order) => order.status === 'cancelled')).toBe(true);
    expect(cancelledOrders.every((order) => order.cancelled_at instanceof Date)).toBe(true);
    expect(Number(auditEvidence.count)).toBe(8);
    expect(Number(idempotencyEvidence.count)).toBe(8);
    expect(Number(timelineEvidence.count)).toBe(4);
    expect([...refundWorkflowOrderIds].sort()).toEqual([...paidOrderIds].sort());
  });
});
