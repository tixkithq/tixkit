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
  let duplicationCheckpoint: AppContext['eventDuplicationCheckpoint'];
  let presetCheckpoint: AppContext['eventPresetCheckpoint'];
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
    app.decorate('context', {
      db,
      eventDuplicationCheckpoint: (
        input: Parameters<NonNullable<AppContext['eventDuplicationCheckpoint']>>[0],
      ) => duplicationCheckpoint?.(input),
      eventPresetCheckpoint: (
        input: Parameters<NonNullable<AppContext['eventPresetCheckpoint']>>[0],
      ) => presetCheckpoint?.(input),
    } as unknown as AppContext);
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
      headers: { 'Idempotency-Key': `duplicate-full-${suffix}` },
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
    const replay = await app.inject({
      method: 'POST',
      url: `/events/${sourceEventId}/duplicate`,
      headers: { 'Idempotency-Key': `duplicate-full-${suffix}` },
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
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { id: string }).id).toBe(duplicate.id);
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

  it('rolls back the new event when a selected child copy fails mid-transaction', async () => {
    const before = await db
      .selectFrom('events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    let attemptedEventId: string | undefined;
    duplicationCheckpoint = ({ duplicatedEventId }) => {
      attemptedEventId = duplicatedEventId;
      throw new Error('injected duplication child failure');
    };
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/events/${sourceEventId}/duplicate`,
        headers: { 'Idempotency-Key': `duplicate-rollback-${suffix}` },
        payload: {
          startsAt: '2027-05-01T18:00:00.000Z',
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
      expect(response.statusCode).toBe(500);
    } finally {
      duplicationCheckpoint = undefined;
    }
    const after = await db
      .selectFrom('events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(after.count)).toBe(Number(before.count));
    expect(attemptedEventId).toBeTruthy();
    for (const table of [
      'event_occurrences',
      'inventory_pools',
      'ticket_types',
      'product_categories',
      'products',
      'questions',
      'fee_rules',
      'marketing_integrations',
      'content_documents',
    ] as const) {
      const rows = await db
        .selectFrom(table)
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .where('event_id', '=', attemptedEventId!)
        .executeTakeFirstOrThrow();
      expect(Number(rows.count), `${table} must roll back`).toBe(0);
    }
  });

  it('atomically creates a free preset and replays a duplicate submission without duplicate children', async () => {
    const slug = `preset-free-${suffix}`;
    const payload = {
      organizationId,
      brandId,
      slug,
      title: 'Atomic free preset',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: '2027-06-01T18:00:00.000Z',
      startingPoint: 'free',
    };
    const headers = { 'Idempotency-Key': `preset-free-${suffix}` };
    const first = await app.inject({ method: 'POST', url: '/events', headers, payload });
    expect(first.statusCode).toBe(201);
    const eventId = (first.json() as { id: string }).id;
    const [pools, tickets] = await Promise.all([
      db.selectFrom('inventory_pools').selectAll().where('event_id', '=', eventId).execute(),
      db.selectFrom('ticket_types').selectAll().where('event_id', '=', eventId).execute(),
    ]);
    expect(pools).toHaveLength(1);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ kind: 'free', inventory_pool_id: pools[0]!.id });

    const duplicate = await app.inject({ method: 'POST', url: '/events', headers, payload });
    expect(duplicate.statusCode).toBe(201);
    expect((duplicate.json() as { id: string }).id).toBe(eventId);
    const conflict = await app.inject({
      method: 'POST',
      url: '/events',
      headers,
      payload: { ...payload, title: 'Different payload' },
    });
    expect(conflict.statusCode).toBe(409);
    const matching = await db
      .selectFrom('events')
      .select('id')
      .where('brand_id', '=', brandId)
      .where('slug', '=', slug)
      .execute();
    expect(matching).toHaveLength(1);
  });

  it('creates, edits, lists, and associates a tenant-scoped reusable venue', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/venues',
      payload: {
        organizationId,
        name: 'Saved Hall',
        address: {
          address: '100 Main St',
          city: 'Austin',
          region: 'TX',
          postalCode: '78701',
          country: 'US',
        },
        timezone: 'America/Chicago',
      },
    });
    expect(created.statusCode).toBe(201);
    const venueId = (created.json() as { id: string }).id;
    const edited = await app.inject({
      method: 'PATCH',
      url: `/venues/${venueId}`,
      payload: { name: 'Saved Hall Updated' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: 'Saved Hall Updated' });
    const listed = await app.inject({
      method: 'GET',
      url: `/venues?organizationId=${organizationId}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: venueId })]),
    );

    const eventResponse = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId,
        brandId,
        slug: `saved-venue-${suffix}`,
        title: 'Saved venue event',
        currency: 'USD',
        timezone: 'America/Chicago',
        startsAt: '2027-06-20T18:00:00.000Z',
        venueId,
      },
    });
    expect(eventResponse.statusCode).toBe(201);
    const row = await db
      .selectFrom('events')
      .select(['venue_id', 'venue'])
      .where('id', '=', (eventResponse.json() as { id: string }).id)
      .executeTakeFirstOrThrow();
    expect(row.venue_id).toBe(venueId);
    const venue = typeof row.venue === 'string' ? JSON.parse(row.venue) : row.venue;
    expect(venue).toMatchObject({ name: 'Saved Hall Updated', city: 'Austin' });
    const referencedDelete = await app.inject({ method: 'DELETE', url: `/venues/${venueId}` });
    expect(referencedDelete.statusCode).toBe(409);
    expect(referencedDelete.json()).toMatchObject({ error: { code: 'venue_in_use' } });
    const disposable = await app.inject({
      method: 'POST',
      url: '/venues',
      payload: { organizationId, name: 'Disposable venue', address: {}, timezone: 'UTC' },
    });
    const disposableVenueId = (disposable.json() as { id: string }).id;
    const deleted = await app.inject({ method: 'DELETE', url: `/venues/${disposableVenueId}` });
    expect(deleted.statusCode).toBe(204);
    expect(
      await db
        .selectFrom('venues')
        .select('id')
        .where('id', '=', disposableVenueId)
        .executeTakeFirst(),
    ).toBeUndefined();

    const otherOrganizationId = `org_other_${suffix}`;
    const otherVenueId = `ven_other_${suffix}`;
    const now = new Date();
    await db
      .insertInto('organizations')
      .values({
        id: otherOrganizationId,
        tenant_id: tenantId,
        name: 'Other organization',
        slug: `other-${suffix}`,
        clerk_organization_id: null,
        box_office_settings: '{}',
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('venues')
      .values({
        id: otherVenueId,
        tenant_id: tenantId,
        organization_id: otherOrganizationId,
        name: 'Other venue',
        address: '{}',
        timezone: 'UTC',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const crossOrgUpdate = await app.inject({
      method: 'PATCH',
      url: `/venues/${otherVenueId}`,
      payload: { name: 'Unauthorized edit' },
    });
    expect([403, 404]).toContain(crossOrgUpdate.statusCode);
    const crossOrgAssociation = await app.inject({
      method: 'POST',
      url: '/events',
      payload: {
        organizationId,
        brandId,
        slug: `cross-org-venue-${suffix}`,
        title: 'Cross organization venue',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: '2027-06-21T18:00:00.000Z',
        venueId: otherVenueId,
      },
    });
    expect(crossOrgAssociation.statusCode).toBe(404);
  });

  it.each([
    { startingPoint: 'donation' as const, expectedTickets: 1, expectedOccurrences: 0 },
    { startingPoint: 'multiple' as const, expectedTickets: 0, expectedOccurrences: 1 },
  ])(
    'atomically creates and idempotently replays the $startingPoint preset',
    async ({ startingPoint, expectedTickets, expectedOccurrences }) => {
      const slug = `preset-${startingPoint}-${suffix}`;
      const payload = {
        organizationId,
        brandId,
        slug,
        title: `Atomic ${startingPoint} preset`,
        currency: 'USD',
        timezone: 'UTC',
        startsAt: '2027-06-15T18:00:00.000Z',
        startingPoint,
      };
      const headers = { 'Idempotency-Key': `preset-${startingPoint}-${suffix}` };
      const first = await app.inject({ method: 'POST', url: '/events', headers, payload });
      expect(first.statusCode).toBe(201);
      const eventId = (first.json() as { id: string }).id;

      const duplicate = await app.inject({ method: 'POST', url: '/events', headers, payload });
      expect(duplicate.statusCode).toBe(201);
      expect((duplicate.json() as { id: string }).id).toBe(eventId);

      const [pools, tickets, occurrences] = await Promise.all([
        db.selectFrom('inventory_pools').selectAll().where('event_id', '=', eventId).execute(),
        db.selectFrom('ticket_types').selectAll().where('event_id', '=', eventId).execute(),
        db.selectFrom('event_occurrences').selectAll().where('event_id', '=', eventId).execute(),
      ]);
      expect(tickets).toHaveLength(expectedTickets);
      expect(occurrences).toHaveLength(expectedOccurrences);
      expect(pools).toHaveLength(expectedTickets);
      if (startingPoint === 'donation') {
        expect(tickets[0]).toMatchObject({
          kind: 'donation',
          inventory_pool_id: pools[0]!.id,
        });
        expect(Number(tickets[0]!.price_cents)).toBe(0);
        expect(Number(tickets[0]!.minimum_price_cents)).toBe(0);
      } else {
        expect(occurrences[0]).toMatchObject({
          title: payload.title,
          timezone: payload.timezone,
          status: 'scheduled',
        });
      }
      expect(
        await db
          .selectFrom('events')
          .select('id')
          .where('brand_id', '=', brandId)
          .where('slug', '=', slug)
          .execute(),
      ).toHaveLength(1);
    },
  );

  it('rolls back a failed preset completely and allows a clean retry', async () => {
    const slug = `preset-retry-${suffix}`;
    const payload = {
      organizationId,
      brandId,
      slug,
      title: 'Retryable paid preset',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: '2027-07-01T18:00:00.000Z',
      startingPoint: 'paid',
    };
    let attemptedEventId: string | undefined;
    presetCheckpoint = ({ eventId }) => {
      attemptedEventId = eventId;
      throw new Error('injected preset failure');
    };
    const headers = { 'Idempotency-Key': `preset-retry-${suffix}` };
    const failed = await app.inject({ method: 'POST', url: '/events', headers, payload });
    expect(failed.statusCode).toBe(500);
    expect(
      await db
        .selectFrom('events')
        .select('id')
        .where('brand_id', '=', brandId)
        .where('slug', '=', slug)
        .execute(),
    ).toHaveLength(0);
    expect(attemptedEventId).toBeTruthy();
    expect(
      await db
        .selectFrom('inventory_pools')
        .select('id')
        .where('event_id', '=', attemptedEventId!)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('ticket_types')
        .select('id')
        .where('event_id', '=', attemptedEventId!)
        .execute(),
    ).toHaveLength(0);

    presetCheckpoint = undefined;
    const retried = await app.inject({ method: 'POST', url: '/events', headers, payload });
    expect(retried.statusCode).toBe(201);
    const eventId = (retried.json() as { id: string }).id;
    expect(
      await db.selectFrom('inventory_pools').select('id').where('event_id', '=', eventId).execute(),
    ).toHaveLength(1);
    expect(
      await db.selectFrom('ticket_types').select('id').where('event_id', '=', eventId).execute(),
    ).toHaveLength(1);
  });
});
