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
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { checkInRoutes } from '../../routes/modules/checkin.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { ATTENDEE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const attendeePatchContract = ATTENDEE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
  (contract) => contract.operationId === 'patchAttendeesByAttendeeId',
);
if (!attendeePatchContract) {
  throw new Error('Missing attendee PATCH authorization contract');
}

const runId = ulid().slice(-10).toLowerCase();
const tenantId = `tnt_att_auth_${runId}`;
const organizationId = `org_att_auth_${runId}`;
const brandId = `brd_att_auth_${runId}`;
const eventId = `evt_att_auth_${runId}`;
const poolId = `pool_att_auth_${runId}`;
const ticketTypeId = `tt_att_auth_${runId}`;
const ticketId = `tkt_att_auth_${runId}`;
const principalId = `usr_att_auth_${runId}`;

let db: Database;
let previousDriver: string | undefined;
let attendeeId: string;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: principalId,
    tenantId,
    organizationIds: [organizationId],
    brandIds: [brandId],
    eventIds: [eventId],
    scopes: ['attendees.write'],
    ...overrides,
  };
}

async function buildApp(activePrincipal: Principal): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('context', { db } as AppContext);
  app.addHook('preHandler', async (request) => {
    request.principal = activePrincipal;
  });
  registerErrorHandler(app);
  await app.register(checkInRoutes);
  return app;
}

async function seedFixture(): Promise<void> {
  const now = new Date('2026-07-16T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({
      id: tenantId,
      name: `Attendee authorization ${runId}`,
      status: 'active',
      plan: 'test',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('organizations')
    .values({
      id: organizationId,
      tenant_id: tenantId,
      name: `Attendee authorization ${runId}`,
      slug: `att-auth-${runId}`,
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('brands')
    .values({
      id: brandId,
      tenant_id: tenantId,
      organization_id: organizationId,
      name: `Attendee authorization ${runId}`,
      slug: `att-auth-${runId}`,
      status: 'active',
      theme: '{}',
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
      slug: `att-auth-${runId}`,
      title: 'Attendee authorization',
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
      name: 'Attendee authorization inventory',
      total_capacity: 10,
      reserved_count: 0,
      sold_count: 1,
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
      name: 'General admission',
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 2_500,
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

  const checkout = await new CheckoutSessionRepository(db).create({
    tenantId,
    eventId,
    brandId,
    currency: 'USD',
    cart: { items: [{ ticketTypeId, quantity: 1 }] },
    buyer: { email: 'ada@example.test' },
    quote: { totalCents: 2_500 },
    expiresAt: new Date('2027-01-01T17:00:00.000Z'),
    idempotencyKey: `attendee-authorization-${runId}`,
  });
  const order = await new OrderRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    eventId,
    checkoutSessionId: checkout.id,
    orderNumber: `ATT-AUTH-${runId}`,
    status: 'paid',
    currency: 'USD',
    subtotalCents: 2_500,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 2_500,
    buyerEmail: 'ada@example.test',
  });
  const attendee = await new AttendeeRepository(db).create({
    tenantId,
    orderId: order.id,
    eventId,
    ticketTypeId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
  });
  attendeeId = attendee.id;
  await new TicketRepository(db).create({
    id: ticketId,
    tenantId,
    orderId: order.id,
    attendeeId,
    eventId,
    ticketTypeId,
    code: `ATT-AUTH-${runId}`,
    qrPayload: `att-auth-payload-${runId}`,
    qrHash: `att-auth-hash-${runId}`,
  });
  await db
    .updateTable('attendees')
    .set({ ticket_id: ticketId, status: 'confirmed', updated_at: now })
    .where('id', '=', attendeeId)
    .execute();
}

async function cleanupFixture(): Promise<void> {
  await db.deleteFrom('scan_logs').where('ticket_id', '=', ticketId).execute();
  await db
    .updateTable('attendees')
    .set({ ticket_id: null })
    .where('event_id', '=', eventId)
    .execute();
  await db.deleteFrom('tickets').where('id', '=', ticketId).execute();
  await db.deleteFrom('attendees').where('event_id', '=', eventId).execute();
  await db.deleteFrom('orders').where('event_id', '=', eventId).execute();
  await db.deleteFrom('checkout_sessions').where('event_id', '=', eventId).execute();
  await db.deleteFrom('ticket_types').where('id', '=', ticketTypeId).execute();
  await db.deleteFrom('inventory_pools').where('id', '=', poolId).execute();
  await db.deleteFrom('events').where('id', '=', eventId).execute();
  await db.deleteFrom('brands').where('id', '=', brandId).execute();
  await db.deleteFrom('organizations').where('id', '=', organizationId).execute();
  await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
}

async function persistedState() {
  const [attendee, ticket, scanLogs] = await Promise.all([
    db.selectFrom('attendees').selectAll().where('id', '=', attendeeId).executeTakeFirstOrThrow(),
    db.selectFrom('tickets').selectAll().where('id', '=', ticketId).executeTakeFirstOrThrow(),
    db
      .selectFrom('scan_logs')
      .selectAll()
      .where('ticket_id', '=', ticketId)
      .orderBy('id')
      .execute(),
  ]);
  return { attendee, ticket, scanLogs };
}

const deniedPrincipals = {
  tenant: () => principal({ tenantId: `tnt_att_denied_${runId}` }),
  organization: () => principal({ organizationIds: [`org_att_denied_${runId}`] }),
  brand: () => principal({ brandIds: [`brd_att_denied_${runId}`] }),
  event: () => principal({ eventIds: [`evt_att_denied_${runId}`] }),
} as const;
type AttendeeDeniedBoundary = keyof typeof deniedPrincipals;
const attendeeDeniedBoundaries = attendeePatchContract.deniedBoundaries.map((boundary) => {
  if (!(boundary in deniedPrincipals)) {
    throw new Error(`Unsupported attendee PATCH denial boundary: ${boundary}`);
  }
  return boundary as AttendeeDeniedBoundary;
});

describeWithIntegrationDatabase(
  `attendee route authorization DB parity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
    }, 120_000);

    afterAll(async () => {
      try {
        if (db) {
          try {
            await cleanupFixture();
          } finally {
            await db.destroy();
          }
        }
      } finally {
        restoreDatabaseDriver(previousDriver);
      }
    }, 120_000);

    beforeEach(async () => {
      await cleanupFixture();
      await seedFixture();
    }, 120_000);

    it('updates only attendee profile fields for the authorized control', async () => {
      const app = await buildApp(principal());
      try {
        const response = await app.inject({
          method: attendeePatchContract.method,
          url: attendeePatchContract.path.replace('{attendeeId}', attendeeId),
          payload: {
            firstName: 'Augusta Ada',
            lastName: null,
            email: 'augusta@example.test',
            phone: '+15555550101',
          },
        });
        expect(response.statusCode, response.body).toBe(
          attendeePatchContract.authorizedControl.status,
        );
        expect(response.json()).toMatchObject({
          id: attendeeId,
          firstName: 'Augusta Ada',
          email: 'augusta@example.test',
          phone: '+15555550101',
          status: 'confirmed',
        });
        expect(response.json()).not.toHaveProperty('lastName');
        const state = await persistedState();
        expect(state.attendee).toMatchObject({
          first_name: 'Augusta Ada',
          last_name: null,
          email: 'augusta@example.test',
          phone: '+15555550101',
          status: 'confirmed',
          checked_in_at: null,
          check_in_device_id: null,
        });
        expect(state.ticket).toMatchObject({ status: 'valid', checked_in_at: null });
        expect(state.scanLogs).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('binds the executable matrix to the formal attendee PATCH contract', () => {
      expect(attendeePatchContract).toMatchObject({
        method: 'PATCH',
        operationId: 'patchAttendeesByAttendeeId',
        path: '/attendees/{attendeeId}',
        sideEffectAssertions: ['persistence'],
      });
      expect(attendeeDeniedBoundaries).toEqual(Object.keys(deniedPrincipals));
    });

    it('denies missing permission without attendee, ticket, or scan-log mutation', async () => {
      const before = await persistedState();
      const app = await buildApp(principal({ scopes: [] }));
      try {
        const response = await app.inject({
          method: attendeePatchContract.method,
          url: attendeePatchContract.path.replace('{attendeeId}', attendeeId),
          payload: { firstName: 'Unauthorized' },
        });
        expect(response.statusCode).toBe(attendeePatchContract.permissionDenialResponse?.status);
        expect(response.json()).toMatchObject({
          error: { code: attendeePatchContract.permissionDenialResponse?.code },
        });
        expect(await persistedState()).toEqual(before);
      } finally {
        await app.close();
      }
    });

    it.each(
      attendeeDeniedBoundaries.map((boundary) => [boundary, deniedPrincipals[boundary]()] as const),
    )(
      'denies the %s boundary without attendee, ticket, or scan-log mutation',
      async (_boundary, deniedPrincipal) => {
        const before = await persistedState();
        const app = await buildApp(deniedPrincipal);
        try {
          const response = await app.inject({
            method: attendeePatchContract.method,
            url: attendeePatchContract.path.replace('{attendeeId}', attendeeId),
            payload: { firstName: 'Unauthorized' },
          });
          expect(response.statusCode).toBe(attendeePatchContract.denialResponse.status);
          expect(response.json()).toMatchObject({
            error: { code: attendeePatchContract.denialResponse.code },
          });
          expect(await persistedState()).toEqual(before);
        } finally {
          await app.close();
        }
      },
      120_000,
    );
  },
);
