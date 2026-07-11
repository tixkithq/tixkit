import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createDb,
  EventOccurrenceRepository,
  EventRepository,
  InventoryPoolRepository,
  ProductRepository,
  TicketTypeRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { eventRoutes } from '../../routes/modules/events.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('transactional event duplication', () => {
  let db: Database;
  let app: FastifyInstance;
  let previousDriver: string | undefined;
  let principal: Principal;
  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_dup_${suffix}`;
  const organizationId = `org_dup_${suffix}`;
  const brandId = `brd_dup_${suffix}`;
  let sourceEventId: string;

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: 'Duplication tenant',
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
        name: 'Duplication org',
        slug: `dup-${suffix}`,
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
        name: 'Duplication brand',
        slug: `dup-${suffix}`,
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
    const source = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId,
      slug: `source-${suffix}`,
      title: 'Source event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T18:00:00Z'),
      endsAt: new Date('2027-01-01T22:00:00Z'),
      venue: { name: 'Hall' },
    });
    sourceEventId = source.id;
    const pool = await new InventoryPoolRepository(db).create({
      eventId: source.id,
      name: 'GA',
      totalCapacity: 100,
    });
    const ticket = await new TicketTypeRepository(db).create({
      eventId: source.id,
      inventoryPoolId: pool.id,
      name: 'GA',
      kind: 'paid',
      status: 'sold_out',
      currency: 'USD',
      priceCents: 2500,
    });
    await new EventOccurrenceRepository(db).create({
      eventId: source.id,
      title: 'Doors',
      startsAt: new Date('2027-01-01T18:00:00Z'),
      endsAt: new Date('2027-01-01T22:00:00Z'),
      timezone: 'UTC',
    });
    await new ProductRepository(db).create({
      eventId: source.id,
      name: 'Poster',
      priceCents: 1500,
      currency: 'USD',
      availableFrom: new Date('2026-12-01T00:00:00Z'),
      availableUntil: new Date('2027-01-01T22:00:00Z'),
    });
    await db
      .insertInto('fee_rules')
      .values({
        id: `fee_${suffix}`,
        event_id: source.id,
        name: 'Service fee',
        type: 'fixed',
        value: 200,
        applied_to: 'per_order',
        absorb_into_price: false,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await new EventRepository(db).update(source.id, {
      cover_image_url: `https://unsafe.example/${suffix}.jpg`,
      seo: JSON.stringify({
        title: 'Source SEO',
        imageUrl: `https://unsafe.example/${suffix}-social.jpg`,
      }),
    });
    await db
      .insertInto('questions')
      .values({
        id: `q_${suffix}`,
        event_id: source.id,
        ticket_type_id: ticket.id,
        type: 'text',
        label: 'Name',
        description: null,
        required: true,
        applies_to: 'attendee',
        options: null,
        placeholder: null,
        validation_pattern: null,
        conditional_visibility: null,
        hidden_at: null,
        deleted_at: null,
        sort_order: 0,
        is_consent_field: false,
        consent_text: null,
        consent_version: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    principal = {
      type: 'user',
      id: `usr_${suffix}`,
      tenantId,
      organizationIds: [organizationId],
      brandIds: [brandId],
      eventIds: [source.id],
      scopes: ['events.read', 'events.write'],
    };
    app = Fastify();
    app.decorate('context', { db } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(eventRoutes);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('copies selected configuration with new IDs, shifted dates, normalized state, and no operational rows', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/events/${sourceEventId}/duplicate`,
      payload: {
        startsAt: '2027-02-01T18:00:00.000Z',
        copy: {
          basicsVenue: true,
          ticketTypes: true,
          products: true,
          checkoutQuestions: true,
          feeResalePolicies: true,
          eventPageContent: false,
          lifecycleContent: false,
          marketingIntegrations: false,
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const duplicate = response.json() as {
      id: string;
      status: string;
      startsAt: string;
    };
    expect(duplicate).toMatchObject({
      status: 'draft',
      startsAt: '2027-02-01T18:00:00.000Z',
    });
    expect(duplicate.id).not.toBe(sourceEventId);
    expect(response.json()).toMatchObject({ seo: {} });
    const duplicatedEvent = await db
      .selectFrom('events')
      .select('cover_image_url')
      .where('id', '=', duplicate.id)
      .executeTakeFirstOrThrow();
    expect(duplicatedEvent.cover_image_url).toBeNull();
    const tickets = await db
      .selectFrom('ticket_types')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .execute();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ status: 'active' });
    const questions = await db
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .execute();
    expect(questions[0]?.ticket_type_id).toBe(tickets[0]?.id);
    const occurrences = await db
      .selectFrom('event_occurrences')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .execute();
    expect(occurrences).toHaveLength(1);
    expect(new Date(occurrences[0]!.starts_at).toISOString()).toBe('2027-02-01T18:00:00.000Z');
    const products = await db
      .selectFrom('products')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .execute();
    expect(products).toHaveLength(1);
    expect(new Date(products[0]!.available_from!).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    const fees = await db
      .selectFrom('fee_rules')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .execute();
    expect(fees).toHaveLength(1);
    for (const table of ['orders', 'attendees', 'tickets'] as const) {
      const rows = await db
        .selectFrom(table)
        .select('id')
        .where('event_id', '=', duplicate.id)
        .execute();
      expect(rows).toHaveLength(0);
    }
    const holds = await db
      .selectFrom('checkout_holds')
      .innerJoin('inventory_pools', 'inventory_pools.id', 'checkout_holds.inventory_pool_id')
      .select('checkout_holds.id')
      .where('inventory_pools.event_id', '=', duplicate.id)
      .execute();
    const scans = await db
      .selectFrom('scan_logs')
      .innerJoin('tickets', 'tickets.id', 'scan_logs.ticket_id')
      .select('scan_logs.id')
      .where('tickets.event_id', '=', duplicate.id)
      .execute();
    expect(holds).toHaveLength(0);
    expect(scans).toHaveLength(0);
  }, 120_000);

  it('rejects dependency-breaking copy selections', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/events/${sourceEventId}/duplicate`,
      payload: {
        startsAt: '2027-03-01T18:00:00.000Z',
        copy: {
          basicsVenue: true,
          ticketTypes: false,
          products: false,
          checkoutQuestions: true,
          feeResalePolicies: false,
          eventPageContent: false,
          lifecycleContent: false,
          marketingIntegrations: false,
        },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects cross-tenant duplication without creating a draft', async () => {
    const before = await db
      .selectFrom('events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    const authorizedPrincipal = principal;
    principal = { ...principal, tenantId: `tnt_other_${suffix}` };
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/events/${sourceEventId}/duplicate`,
        payload: {
          startsAt: '2027-04-01T18:00:00.000Z',
          copy: {
            basicsVenue: true,
            ticketTypes: true,
            products: true,
            checkoutQuestions: true,
            feeResalePolicies: true,
            eventPageContent: false,
            lifecycleContent: false,
            marketingIntegrations: false,
          },
        },
      });
      expect([403, 404]).toContain(response.statusCode);
    } finally {
      principal = authorizedPrincipal;
    }
    const after = await db
      .selectFrom('events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));
  });
});
