import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  AttendeeRepository,
  CheckoutSessionRepository,
  createDb,
  OrderRepository,
  TicketRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { tenantRoutes } from '../../routes/modules/tenant.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { ORGANIZATION_BILLING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const billingContract = ORGANIZATION_BILLING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS[0];
if (!billingContract) throw new Error('Missing organization billing authorization contract');

describeWithIntegrationDatabase(
  `organization billing authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    let app: FastifyInstance;
    let db: Database;
    let previousDriver: string | undefined;
    let activePrincipal: Principal;

    const suffix = ulid().slice(-8).toLowerCase();
    const tenantA = `tnt_bill_a_${suffix}`;
    const tenantB = `tnt_bill_b_${suffix}`;
    const organizationA = `org_bill_a_${suffix}`;
    const organizationOther = `org_bill_o_${suffix}`;
    const organizationB = `org_bill_b_${suffix}`;
    const brandA = `brd_bill_a_${suffix}`;
    const brandOther = `brd_bill_o_${suffix}`;
    const brandB = `brd_bill_b_${suffix}`;
    const eventA = `evt_bill_a_${suffix}`;
    const eventOther = `evt_bill_o_${suffix}`;
    const eventB = `evt_bill_b_${suffix}`;
    const userId = `usr_bill_${suffix}`;
    const grantId = `pgr_bill_${suffix}`;
    const poolIds = [`pool_bill_a_${suffix}`, `pool_bill_o_${suffix}`, `pool_bill_b_${suffix}`];
    const ticketTypeIds = [`tt_bill_a_${suffix}`, `tt_bill_o_${suffix}`, `tt_bill_b_${suffix}`];
    const checkoutIds: string[] = [];
    const orderIds: string[] = [];
    const attendeeIds: string[] = [];
    const ticketIds: string[] = [];

    function principal(overrides: Partial<Principal> = {}): Principal {
      return {
        type: 'user',
        id: userId,
        tenantId: tenantA,
        organizationIds: [organizationA],
        scopes: ['billing.write'],
        ...overrides,
      };
    }

    async function insertTenant(id: string, plan: string): Promise<void> {
      const now = new Date();
      await db
        .insertInto('tenants')
        .values({ id, name: id, status: 'active', plan, created_at: now, updated_at: now })
        .execute();
    }

    async function insertOrganization(id: string, tenantId: string): Promise<void> {
      const now = new Date();
      await db
        .insertInto('organizations')
        .values({
          id,
          tenant_id: tenantId,
          name: id,
          slug: `${id}-slug`,
          clerk_organization_id: null,
          box_office_settings: '{}',
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function insertCatalog(
      tenantId: string,
      organizationId: string,
      brandId: string,
      eventId: string,
      poolId: string,
      ticketTypeId: string,
    ): Promise<void> {
      const now = new Date();
      await db
        .insertInto('brands')
        .values({
          id: brandId,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: brandId,
          slug: `${brandId}-slug`,
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
      await db
        .insertInto('events')
        .values({
          id: eventId,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: brandId,
          slug: `${eventId}-slug`,
          title: eventId,
          description: null,
          status: 'published',
          currency: 'USD',
          timezone: 'UTC',
          starts_at: new Date('2027-01-01T18:00:00.000Z'),
          ends_at: null,
          venue: null,
          visibility: 'private',
          seo: '{}',
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
          id: poolId,
          event_id: eventId,
          name: poolId,
          total_capacity: 10,
          reserved_count: 0,
          sold_count: 0,
          hold_ttl_seconds: 300,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('ticket_types')
        .values({
          id: ticketTypeId,
          event_id: eventId,
          name: ticketTypeId,
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
          event_occurrence_id: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    async function createTicket(
      tenantId: string,
      organizationId: string,
      brandId: string,
      eventId: string,
      ticketTypeId: string,
      key: string,
      createdAt: Date,
    ): Promise<void> {
      const checkout = await new CheckoutSessionRepository(db).create({
        tenantId,
        eventId,
        brandId,
        currency: 'USD',
        cart: { items: [{ ticketTypeId, quantity: 1 }] },
        buyer: { email: `${key}@example.test` },
        quote: { totalCents: 1000 },
        expiresAt: new Date('2027-01-01T17:00:00.000Z'),
        idempotencyKey: `billing-${key}-${suffix}`,
      });
      checkoutIds.push(checkout.id);
      const order = await new OrderRepository(db).create({
        tenantId,
        organizationId,
        brandId,
        eventId,
        checkoutSessionId: checkout.id,
        orderNumber: `BILL-${key}-${suffix}`,
        status: 'paid',
        currency: 'USD',
        subtotalCents: 1000,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 1000,
        buyerEmail: `${key}@example.test`,
      });
      orderIds.push(order.id);
      const attendee = await new AttendeeRepository(db).create({
        tenantId,
        orderId: order.id,
        eventId,
        ticketTypeId,
        email: `${key}@example.test`,
      });
      attendeeIds.push(attendee.id);
      const ticketId = `tkt_bill_${key}_${suffix}`;
      await new TicketRepository(db).create({
        id: ticketId,
        tenantId,
        orderId: order.id,
        attendeeId: attendee.id,
        eventId,
        ticketTypeId,
        code: `BILL-${key}-${suffix}`,
        qrPayload: `billing-payload-${key}-${suffix}`,
        qrHash: `billing-hash-${key}-${suffix}`,
      });
      ticketIds.push(ticketId);
      await db
        .updateTable('tickets')
        .set({ created_at: createdAt, updated_at: createdAt })
        .where('id', '=', ticketId)
        .execute();
    }

    async function seedFixture(): Promise<void> {
      await insertTenant(tenantA, 'pro');
      await insertTenant(tenantB, 'enterprise');
      await insertOrganization(organizationA, tenantA);
      await insertOrganization(organizationOther, tenantA);
      await insertOrganization(organizationB, tenantB);
      await insertCatalog(tenantA, organizationA, brandA, eventA, poolIds[0]!, ticketTypeIds[0]!);
      await insertCatalog(
        tenantA,
        organizationOther,
        brandOther,
        eventOther,
        poolIds[1]!,
        ticketTypeIds[1]!,
      );
      await insertCatalog(tenantB, organizationB, brandB, eventB, poolIds[2]!, ticketTypeIds[2]!);

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const currentMonth = monthStart;
      // MySQL DATETIME columns are second-precision and may round a .999 boundary
      // into the next month. Keep the fixture one whole second before the boundary.
      const priorMonth = new Date(monthStart.getTime() - 1000);
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      await createTicket(
        tenantA,
        organizationA,
        brandA,
        eventA,
        ticketTypeIds[0]!,
        'current',
        currentMonth,
      );
      await createTicket(
        tenantA,
        organizationA,
        brandA,
        eventA,
        ticketTypeIds[0]!,
        'prior',
        priorMonth,
      );
      await createTicket(
        tenantA,
        organizationA,
        brandA,
        eventA,
        ticketTypeIds[0]!,
        'next',
        nextMonth,
      );
      await createTicket(
        tenantA,
        organizationOther,
        brandOther,
        eventOther,
        ticketTypeIds[1]!,
        'other-org',
        currentMonth,
      );
      await createTicket(
        tenantB,
        organizationB,
        brandB,
        eventB,
        ticketTypeIds[2]!,
        'foreign',
        currentMonth,
      );
      const grantNow = new Date();
      await db
        .insertInto('permission_grants')
        .values({
          id: grantId,
          tenant_id: tenantA,
          principal_type: 'user',
          principal_id: userId,
          permission: 'billing.write',
          scope_type: 'organization',
          scope_id: organizationA,
          created_at: grantNow,
          updated_at: grantNow,
        })
        .execute();
    }

    async function cleanupFixture(): Promise<void> {
      if (!db) return;
      await db.deleteFrom('permission_grants').where('id', '=', grantId).execute();
      await db.deleteFrom('tickets').where('id', 'in', ticketIds).execute();
      await db.deleteFrom('attendees').where('id', 'in', attendeeIds).execute();
      await db.deleteFrom('orders').where('id', 'in', orderIds).execute();
      await db.deleteFrom('checkout_sessions').where('id', 'in', checkoutIds).execute();
      await db.deleteFrom('ticket_types').where('id', 'in', ticketTypeIds).execute();
      await db.deleteFrom('inventory_pools').where('id', 'in', poolIds).execute();
      await db.deleteFrom('events').where('id', 'in', [eventA, eventOther, eventB]).execute();
      await db.deleteFrom('brands').where('id', 'in', [brandA, brandOther, brandB]).execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationA, organizationOther, organizationB])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
    }

    async function snapshot(): Promise<unknown> {
      const [tickets, grants] = await Promise.all([
        db.selectFrom('tickets').selectAll().where('id', 'in', ticketIds).orderBy('id').execute(),
        db.selectFrom('permission_grants').selectAll().where('id', '=', grantId).execute(),
      ]);
      return { tickets, grants };
    }

    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await seedFixture();
      activePrincipal = principal();
      app = Fastify({ logger: false });
      app.decorate('context', { db } as AppContext);
      app.addHook('preHandler', async (request) => {
        request.principal = activePrincipal;
      });
      registerErrorHandler(app);
      await app.register(tenantRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(() => {
      activePrincipal = principal();
    });

    afterAll(async () => {
      try {
        if (app) await app.close();
      } finally {
        try {
          if (db) await cleanupFixture();
        } finally {
          if (db) await db.destroy();
          restoreDatabaseDriver(previousDriver);
        }
      }
    }, 120_000);

    it('binds the executable matrix to the billing contract', () => {
      expect(billingContract).toMatchObject({
        method: 'GET',
        path: '/organizations/{organizationId}/billing',
        deniedBoundaries: ['tenant', 'organization'],
        sideEffectAssertions: [],
      });
    });

    it('returns only current UTC-month tickets for the exact tenant and organization', async () => {
      const before = await snapshot();
      const response = await app.inject({
        method: billingContract.method,
        url: `/organizations/${organizationA}/billing`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        organizationId: organizationA,
        plan: 'pro',
        status: 'active',
        ticketsThisMonth: 1,
      });
      expect(await snapshot()).toEqual(before);
    });

    it('accepts an explicitly granted scoped human principal', async () => {
      activePrincipal = principal({ brandIds: [brandA], eventIds: [eventA] });
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${organizationA}/billing`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().ticketsThisMonth).toBe(1);
    });

    it('accepts an explicitly scoped system principal', async () => {
      activePrincipal = principal({ type: 'system', id: `sys_bill_${suffix}` });
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${organizationA}/billing`,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().ticketsThisMonth).toBe(1);
    });

    it('denies missing billing.write before billing disclosure', async () => {
      activePrincipal = principal({ scopes: [] });
      const before = await snapshot();
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${organizationA}/billing`,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(response.body).not.toContain('pro');
      expect(await snapshot()).toEqual(before);
    });

    it('denies an out-of-scope organization before billing disclosure', async () => {
      activePrincipal = principal({ organizationIds: [organizationOther] });
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${organizationA}/billing`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(response.body).not.toContain('pro');
    });

    it.each(['api_key', 'mobile_device'] as const)(
      'denies a %s principal even when its token claims billing scope',
      async (type) => {
        activePrincipal = principal({ type });
        const response = await app.inject({
          method: 'GET',
          url: `/organizations/${organizationA}/billing`,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(response.body).not.toContain('pro');
      },
    );

    it.each([
      ['brand', 'brandIds', brandA],
      ['event', 'eventIds', eventA],
    ] as const)(
      'denies a %s-scoped human without an exact organization grant',
      async (_scope, scopeKey, scopeId) => {
        activePrincipal = principal({ [scopeKey]: [scopeId], id: `usr_ungranted_${suffix}` });
        const response = await app.inject({
          method: 'GET',
          url: `/organizations/${organizationA}/billing`,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
        expect(response.body).not.toContain('pro');
      },
    );

    it('makes unknown and foreign organizations indistinguishable', async () => {
      const before = await snapshot();
      activePrincipal = principal({ organizationIds: [`org_missing_${suffix}`] });
      const unknown = await app.inject({
        method: 'GET',
        url: `/organizations/org_missing_${suffix}/billing`,
      });
      activePrincipal = principal({ organizationIds: [organizationB] });
      const foreign = await app.inject({
        method: 'GET',
        url: `/organizations/${organizationB}/billing`,
      });
      expect(unknown.statusCode).toBe(404);
      expect(foreign.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(foreign.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(unknown.body).not.toContain('pro');
      expect(foreign.body).not.toContain('enterprise');
      expect(await snapshot()).toEqual(before);
    });
  },
);
