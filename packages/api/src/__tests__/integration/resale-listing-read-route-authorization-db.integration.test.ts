import Fastify, { type FastifyInstance } from 'fastify';
import { createDb, EventRepository, TicketListingRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { ticketingRoutes } from '../../routes/modules/ticketing.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const operationId = 'getEventsByEventIdResaleListings';
const contract = (() => {
  const found = EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (!found) {
    throw new Error(`resale listing read authorization contract ${operationId} missing`);
  }
  return found;
})();

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_rsl_read_a_${suffix}`;
const tenantB = `tnt_rsl_read_b_${suffix}`;
const organizationA = `org_rsl_read_a_${suffix}`;
const organizationAScoped = `org_rsl_read_scope_${suffix}`;
const organizationB = `org_rsl_read_b_${suffix}`;
const brandA = `brd_rsl_read_a_${suffix}`;
const brandAScoped = `brd_rsl_read_scope_${suffix}`;
const brandB = `brd_rsl_read_b_${suffix}`;
const actorId = `usr_rsl_read_${suffix}`;

const allowedListingA = `lst_rsl_read_a_1_${suffix}`;
const allowedListingB = `lst_rsl_read_a_2_${suffix}`;
const scopedListing = `lst_rsl_read_scope_${suffix}`;
const foreignListing = `lst_rsl_read_foreign_${suffix}`;
const tenantMismatchListing = `lst_rsl_read_mismatch_${suffix}`;

const allowedTicketA = `tkt_rsl_read_a_1_${suffix}`;
const allowedTicketB = `tkt_rsl_read_a_2_${suffix}`;
const scopedTicket = `tkt_rsl_read_scope_${suffix}`;
const foreignTicket = `tkt_rsl_read_foreign_${suffix}`;
const ticketIds = [allowedTicketA, allowedTicketB, scopedTicket, foreignTicket] as const;
const fixtureLabels = ['allowed_a_1', 'allowed_a_2', 'scoped', 'foreign'] as const;
const attendeeIds = fixtureLabels.map((label) => `att_${label}_${suffix}`);
const checkoutSessionIds = fixtureLabels.map((label) => `chk_${label}_${suffix}`);
const inventoryPoolIds = fixtureLabels.map((label) => `pool_${label}_${suffix}`);
const orderIds = fixtureLabels.map((label) => `ord_${label}_${suffix}`);
const ticketTypeIds = fixtureLabels.map((label) => `tt_${label}_${suffix}`);
const listingIds = [
  allowedListingA,
  allowedListingB,
  scopedListing,
  foreignListing,
  tenantMismatchListing,
] as const;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;

async function insertTenant(id: string, name: string): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
    .execute();
}

async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
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

async function insertBrand(
  id: string,
  tenantId: string,
  organizationId: string,
  name: string,
): Promise<void> {
  const now = new Date('2026-07-20T12:00:00.000Z');
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
    startsAt: new Date('2027-08-01T18:00:00.000Z'),
    endsAt: new Date('2027-08-01T22:00:00.000Z'),
    venue: { name: 'Resale listing read authorization hall' },
  });
  return event.id;
}

type TicketFixture = Readonly<{
  brandId: string;
  eventId: string;
  label: string;
  organizationId: string;
  tenantId: string;
  ticketId: string;
}>;

async function seedTicket(fixture: TicketFixture): Promise<void> {
  const now = new Date('2026-07-20T12:30:00.000Z');
  const poolId = `pool_${fixture.label}_${suffix}`;
  const ticketTypeId = `tt_${fixture.label}_${suffix}`;
  const checkoutSessionId = `chk_${fixture.label}_${suffix}`;
  const orderId = `ord_${fixture.label}_${suffix}`;
  const attendeeId = `att_${fixture.label}_${suffix}`;

  await db
    .insertInto('inventory_pools')
    .values({
      id: poolId,
      event_id: fixture.eventId,
      name: `${fixture.label} pool`,
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
      event_id: fixture.eventId,
      name: `${fixture.label} ticket type`,
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 5000,
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
  await db
    .insertInto('checkout_sessions')
    .values({
      id: checkoutSessionId,
      tenant_id: fixture.tenantId,
      event_id: fixture.eventId,
      brand_id: fixture.brandId,
      status: 'completed',
      hold_id: null,
      currency: 'USD',
      cart: JSON.stringify({ items: [{ ticketTypeId, quantity: 1 }] }),
      buyer: JSON.stringify({ email: `${fixture.label}@example.com` }),
      quote: JSON.stringify({ totalCents: 5000 }),
      payment_intent_id: null,
      order_id: null,
      success_url: null,
      cancel_url: null,
      expires_at: new Date('2027-08-01T17:00:00.000Z'),
      idempotency_key: `idem_${fixture.label}_${suffix}`,
      client_token: `client_${fixture.label}_${suffix}`,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('orders')
    .values({
      id: orderId,
      tenant_id: fixture.tenantId,
      organization_id: fixture.organizationId,
      brand_id: fixture.brandId,
      event_id: fixture.eventId,
      checkout_session_id: checkoutSessionId,
      order_number: `TK-${fixture.label}-${suffix}`,
      status: 'paid',
      currency: 'USD',
      subtotal_cents: 5000,
      discount_cents: 0,
      tax_cents: 0,
      fee_cents: 0,
      total_cents: 5000,
      buyer_email: `${fixture.label}@example.com`,
      buyer_first_name: 'Resale',
      buyer_last_name: fixture.label,
      buyer_phone: null,
      buyer_date_of_birth: null,
      payment_intent_id: null,
      payment_provider: null,
      operator_id: null,
      tender_type: null,
      paid_at: now,
      refunded_at: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .updateTable('checkout_sessions')
    .set({ order_id: orderId })
    .where('id', '=', checkoutSessionId)
    .execute();
  await db
    .insertInto('attendees')
    .values({
      id: attendeeId,
      tenant_id: fixture.tenantId,
      order_id: orderId,
      event_id: fixture.eventId,
      event_occurrence_id: null,
      ticket_type_id: ticketTypeId,
      ticket_id: null,
      first_name: 'Resale',
      last_name: fixture.label,
      email: `${fixture.label}@example.com`,
      phone: null,
      date_of_birth: null,
      status: 'confirmed',
      custom_answers: null,
      checked_in_at: null,
      check_in_device_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('tickets')
    .values({
      id: fixture.ticketId,
      tenant_id: fixture.tenantId,
      order_id: orderId,
      attendee_id: attendeeId,
      event_id: fixture.eventId,
      event_occurrence_id: null,
      ticket_type_id: ticketTypeId,
      status: 'valid',
      code: `CODE-${fixture.label}-${suffix}`,
      qr_payload: `payload-${fixture.label}-${suffix}`,
      qr_hash: `hash-${fixture.label}-${suffix}`,
      transferred_to_email: null,
      transferred_at: null,
      checked_in_at: null,
      checked_in_by_device_id: null,
      wallet_pass_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .updateTable('attendees')
    .set({ ticket_id: fixture.ticketId })
    .where('id', '=', attendeeId)
    .execute();
}

async function insertListing(input: {
  eventId: string;
  id: string;
  status: 'listed' | 'delisted';
  tenantId: string;
  ticketId: string;
}): Promise<void> {
  const createdAt = new Date(
    input.id === allowedListingA ? '2026-07-20T13:00:00.000Z' : '2026-07-20T13:01:00.000Z',
  );
  await db
    .insertInto('ticket_listings')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      event_id: input.eventId,
      ticket_id: input.ticketId,
      seller_id: `seller_${input.id}`,
      status: input.status,
      price_cents: input.id === allowedListingA ? 5250 : 5500,
      currency: 'USD',
      face_value_cents: 5000,
      sold_to_id: null,
      active_listing_key: input.status === 'listed' ? input.ticketId : input.id,
      reserved_checkout_session_id: null,
      reserved_until: null,
      expires_at: null,
      sold_at: null,
      seller_terms_version: '2026-07-16',
      settlement_model: 'organizer_managed',
      refund_model: 'manual_coordinated_resolution',
      created_at: createdAt,
      updated_at: createdAt,
    })
    .execute();
}

async function seedListings(): Promise<void> {
  await insertListing({
    id: allowedListingA,
    tenantId: tenantA,
    eventId: eventA,
    ticketId: allowedTicketA,
    status: 'listed',
  });
  await insertListing({
    id: allowedListingB,
    tenantId: tenantA,
    eventId: eventA,
    ticketId: allowedTicketB,
    status: 'delisted',
  });
  await insertListing({
    id: scopedListing,
    tenantId: tenantA,
    eventId: eventAScoped,
    ticketId: scopedTicket,
    status: 'listed',
  });
  await insertListing({
    id: foreignListing,
    tenantId: tenantB,
    eventId: eventB,
    ticketId: foreignTicket,
    status: 'listed',
  });
  await insertListing({
    id: tenantMismatchListing,
    tenantId: tenantB,
    eventId: eventA,
    ticketId: foreignTicket,
    status: 'delisted',
  });
}

async function evidenceSnapshot() {
  const [events, tickets, listings, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'version', 'public_revision'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db.selectFrom('tickets').selectAll().where('id', 'in', ticketIds).orderBy('id').execute(),
    db
      .selectFrom('ticket_listings')
      .selectAll()
      .where('id', 'in', listingIds)
      .orderBy('id')
      .execute(),
    db.selectFrom('audit_logs').selectAll().where('actor_id', '=', actorId).orderBy('id').execute(),
  ]);
  return { events, tickets, listings, audits };
}

function invoke(targetEventId: string, cursor?: string) {
  const query = new URLSearchParams({ limit: '1' });
  if (cursor) query.set('cursor', cursor);
  return app.inject({
    method: contract.method,
    url: `${contract.path.replace('{eventId}', targetEventId)}?${query.toString()}`,
  });
}

async function cleanup(): Promise<void> {
  await db.deleteFrom('ticket_listings').where('id', 'in', listingIds).execute();
  await db.deleteFrom('tickets').where('id', 'in', ticketIds).execute();
  await db.deleteFrom('attendees').where('id', 'in', attendeeIds).execute();
  await db.deleteFrom('orders').where('id', 'in', orderIds).execute();
  await db.deleteFrom('checkout_sessions').where('id', 'in', checkoutSessionIds).execute();
  await db.deleteFrom('ticket_types').where('id', 'in', ticketTypeIds).execute();
  await db.deleteFrom('inventory_pools').where('id', 'in', inventoryPoolIds).execute();
  for (const eventId of [eventA, eventAScoped, eventB]) {
    await db.deleteFrom('events').where('id', '=', eventId).execute();
  }
  await db.deleteFrom('brands').where('id', 'in', [brandA, brandAScoped, brandB]).execute();
  await db
    .deleteFrom('organizations')
    .where('id', 'in', [organizationA, organizationAScoped, organizationB])
    .execute();
  await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
}

describeWithIntegrationDatabase('resale listing read route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Resale listing read tenant A');
    await insertTenant(tenantB, 'Resale listing read tenant B');
    await insertOrganization(organizationA, tenantA, 'Resale listing read organization A');
    await insertOrganization(
      organizationAScoped,
      tenantA,
      'Resale listing read scoped organization',
    );
    await insertOrganization(organizationB, tenantB, 'Resale listing read organization B');
    await insertBrand(brandA, tenantA, organizationA, 'Resale listing read brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Resale listing read scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Resale listing read brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed resale listing event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped resale listing event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign resale listing event');

    await seedTicket({
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      eventId: eventA,
      ticketId: allowedTicketA,
      label: 'allowed_a_1',
    });
    await seedTicket({
      tenantId: tenantA,
      organizationId: organizationA,
      brandId: brandA,
      eventId: eventA,
      ticketId: allowedTicketB,
      label: 'allowed_a_2',
    });
    await seedTicket({
      tenantId: tenantA,
      organizationId: organizationAScoped,
      brandId: brandAScoped,
      eventId: eventAScoped,
      ticketId: scopedTicket,
      label: 'scoped',
    });
    await seedTicket({
      tenantId: tenantB,
      organizationId: organizationB,
      brandId: brandB,
      eventId: eventB,
      ticketId: foreignTicket,
      label: 'foreign',
    });
    await seedListings();

    basePrincipal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    activePrincipal = basePrincipal;

    app = Fastify({ logger: false });
    app.decorate('context', { db, inventoryService: {} } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(ticketingRoutes);
    await app.ready();
  }, 120_000);

  beforeEach(() => {
    activePrincipal = basePrincipal;
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (app) await attempt(() => app.close());
    if (db) {
      await attempt(cleanup);
      await attempt(() => db.destroy());
    }
    try {
      restoreDatabaseDriver(previousDriver);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up resale listing read proof');
    }
  }, 120_000);

  it('binds the immutable route contract to this executable persistence proof', () => {
    expect(contract).toMatchObject({
      authorizedControl: { required: true, status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'GET',
      operationId,
      path: '/events/{eventId}/resale-listings',
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'resale-listing-read-route-authorization-db.integration.test.ts',
      source: 'resale-listing-read-route-authorization-db.integration.test.ts',
    });
  });

  it('returns exactly two tenant-scoped pages without mutating persistence', async () => {
    const before = await evidenceSnapshot();
    const allowedRows = before.listings.filter(
      (listing) => listing.id === allowedListingA || listing.id === allowedListingB,
    );
    expect(allowedRows.map((listing) => listing.status)).toEqual(['listed', 'delisted']);
    expect(before.listings.find((listing) => listing.id === tenantMismatchListing)).toMatchObject({
      tenant_id: tenantB,
      event_id: eventA,
      ticket_id: foreignTicket,
    });
    const query = vi.spyOn(TicketListingRepository.prototype, 'findByEvent');

    try {
      const first = await invoke(eventA);
      const second = await invoke(eventA, allowedListingA);

      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({
        items: [
          {
            id: allowedListingA,
            tenantId: tenantA,
            eventId: eventA,
            ticketId: allowedTicketA,
            sellerId: `seller_${allowedListingA}`,
            status: 'listed',
            priceCents: 5250,
            currency: 'USD',
            faceValueCents: 5000,
            createdAt: '2026-07-20T13:00:00.000Z',
            updatedAt: '2026-07-20T13:00:00.000Z',
          },
        ],
        nextCursor: allowedListingA,
        hasMore: true,
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({
        items: [
          {
            id: allowedListingB,
            tenantId: tenantA,
            eventId: eventA,
            ticketId: allowedTicketB,
            sellerId: `seller_${allowedListingB}`,
            status: 'delisted',
            priceCents: 5500,
            currency: 'USD',
            faceValueCents: 5000,
            createdAt: '2026-07-20T13:01:00.000Z',
            updatedAt: '2026-07-20T13:01:00.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
      expect(query.mock.calls).toEqual([
        [tenantA, eventA, 2, undefined],
        [tenantA, eventA, 2, allowedListingA],
      ]);
      for (const protectedId of [
        scopedListing,
        foreignListing,
        tenantMismatchListing,
        scopedTicket,
        foreignTicket,
      ]) {
        expect(first.body).not.toContain(protectedId);
        expect(second.body).not.toContain(protectedId);
      }
      await expect(evidenceSnapshot()).resolves.toEqual(before);
    } finally {
      query.mockRestore();
    }
  });

  it.each([
    ['permission', () => ({ ...basePrincipal, scopes: [] }), () => eventA, 403, 'FORBIDDEN'],
    ['tenant', () => basePrincipal, () => eventB, 404, 'NOT_FOUND'],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'event',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA, brandAScoped],
        eventIds: [eventA],
      }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
  ] as const)(
    'denies the %s boundary before listing persistence access',
    async (boundary, makePrincipal, targetEvent, status, code) => {
      activePrincipal = makePrincipal();
      const eventId = targetEvent();
      const before = await evidenceSnapshot();
      const listingQuery = vi.spyOn(TicketListingRepository.prototype, 'findByEvent');
      const eventQuery = vi.spyOn(EventRepository.prototype, 'findById');

      try {
        const response = await invoke(eventId);

        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        expect(response.json()).not.toHaveProperty('items');
        expect(listingQuery).not.toHaveBeenCalled();
        if (boundary === 'permission') {
          expect(eventQuery).not.toHaveBeenCalled();
        } else {
          expect(eventQuery.mock.calls).toEqual([[eventId]]);
        }
        for (const protectedId of [...listingIds, ...ticketIds]) {
          expect(response.body).not.toContain(protectedId);
        }
        await expect(evidenceSnapshot()).resolves.toEqual(before);
      } finally {
        listingQuery.mockRestore();
        eventQuery.mockRestore();
      }
    },
  );
});
