import { afterEach, beforeEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { createDb } from '../../client.js';
import { runMigrations, truncateAllData } from '../../migrate.js';
import { RolePermissionGrantsSeedMigration } from '../../migrations/0051_role_permission_grants_seed.js';
import { permissionsForRole } from '@tixkit/domain';
import {
  BrandRepository,
  ContentRepository,
  EventRepository,
  InventoryPoolRepository,
  OrganizationRepository,
  OrganizationMemberRepository,
  PermissionGrantRepository,
  CheckoutSessionRepository,
  OrderRepository,
  AttendeeRepository,
  CheckInListRepository,
  ScanLogRepository,
  TicketRepository,
  TicketListingRepository,
  TenantRepository,
  TicketTypeRepository,
} from '../../repositories/index.js';

type DriverCase = {
  driver: 'postgres' | 'mysql' | 'mssql';
  url: string;
};

// When DATABASE_URL / DATABASE_URL_MYSQL are unset (no --env-file), the
// driver case is excluded so the suite skips gracefully instead of failing
// with an invalid URL. When set (via `bun --env-file=.env.local run
// test:integration`), the real connection string is used.
const allDriverCases: DriverCase[] = [
  {
    driver: 'postgres',
    url: process.env.DATABASE_URL ?? '',
  },
  {
    driver: 'mysql',
    url: process.env.DATABASE_URL_MYSQL ?? '',
  },
  {
    driver: 'mssql',
    url: process.env.DATABASE_URL_MSSQL ?? '',
  },
];

const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const driverCases = (
  requestedDriver
    ? allDriverCases.filter((driverCase) => driverCase.driver === requestedDriver)
    : allDriverCases
).filter((driverCase) => driverCase.url.length > 0);

async function createCatalog(db: Database) {
  const tenant = await new TenantRepository(db).create({ name: 'Integration Tenant' });
  const organization = await new OrganizationRepository(db).create({
    tenantId: tenant.id,
    name: 'Integration Org',
    slug: 'integration-org',
  });
  const brand = await new BrandRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    name: 'Integration Brand',
    slug: 'integration-brand',
  });
  const event = await new EventRepository(db).create({
    tenantId: tenant.id,
    organizationId: organization.id,
    brandId: brand.id,
    slug: 'integration-event',
    title: 'Integration Event',
    description: 'Repository parity test event',
    currency: 'USD',
    timezone: 'America/New_York',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
  });
  const pool = await new InventoryPoolRepository(db).create({
    eventId: event.id,
    name: 'General Admission',
    totalCapacity: 25,
  });
  const ticketType = await new TicketTypeRepository(db).create({
    eventId: event.id,
    inventoryPoolId: pool.id,
    name: 'GA',
    kind: 'paid',
    currency: 'USD',
    priceCents: 2500,
  });

  return { tenant, organization, brand, event, pool, ticketType };
}

// Guard: when no DATABASE_URL / DATABASE_URL_MYSQL is configured (no
// --env-file), vitest would fail with "no test suite found". Add a single
// skipped test so the suite reports a clean skip instead of an error.
if (driverCases.length === 0) {
  it.skip('database integration (skipped: no DATABASE_URL or DATABASE_URL_MYSQL configured)', () => {});
}

describe.sequential.each(driverCases)('database integration: $driver', ({ driver, url }) => {
  let db: Database;

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    // Ensure the schema is migrated once before all tests in this driver
    // case. This replaces the old per-test `resetSchema` which dropped and
    // recreated the entire schema, causing conflicts with concurrent API
    // integration tests sharing the same database.
    await runMigrations(url);
    db = createDb(url);
  }, 120_000);

  beforeEach(async () => {
    // Non-destructive: remove all rows but keep the schema intact so
    // concurrent test suites are not affected.
    await truncateAllData(db);
  }, 60_000);

  afterEach(async () => {
    // Keep the connection alive between tests; destroyed in afterAll.
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
  }, 60_000);

  it('runs the initial migration and persists core catalog records through repositories', async () => {
    const { tenant, organization, brand, event, pool, ticketType } = await createCatalog(db);

    await expect(new TenantRepository(db).findById(tenant.id)).resolves.toMatchObject({
      id: tenant.id,
      name: 'Integration Tenant',
    });
    await expect(new OrganizationRepository(db).findByTenant(tenant.id)).resolves.toHaveLength(1);
    await expect(new BrandRepository(db).findByOrganization(organization.id)).resolves.toHaveLength(
      1,
    );
    await expect(new EventRepository(db).findByTenant(tenant.id)).resolves.toHaveLength(1);
    await expect(new InventoryPoolRepository(db).findByEvent(event.id)).resolves.toMatchObject([
      {
        id: pool.id,
        total_capacity: 25,
      },
    ]);
    const ticketTypes = await new TicketTypeRepository(db).findByEvent(event.id);
    expect(ticketTypes).toHaveLength(1);
    expect(ticketTypes[0]?.id).toBe(ticketType.id);
    expect(Number(ticketTypes[0]?.price_cents)).toBe(2500);
    await expect(new BrandRepository(db).findById(brand.id)).resolves.toMatchObject({
      tenant_id: tenant.id,
      organization_id: organization.id,
    });
  });

  it('coalesces concurrent invitations into one user and one organization membership', async () => {
    const { tenant, organization } = await createCatalog(db);
    const repo = new OrganizationMemberRepository(db);
    const email = `concurrent-${driver}@example.test`;

    const invitations = await Promise.all([
      repo.invite({ tenantId: tenant.id, organizationId: organization.id, email, role: 'viewer' }),
      repo.invite({ tenantId: tenant.id, organizationId: organization.id, email, role: 'viewer' }),
    ]);

    expect(new Set(invitations.map((invitation) => invitation.id)).size).toBe(1);
    await expect(
      db
        .selectFrom('user_profiles')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .where('email', '=', email)
        .execute(),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .selectFrom('organization_members')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .where('organization_id', '=', organization.id)
        .execute(),
    ).resolves.toHaveLength(1);
  });

  it('serializes concurrent invitation role and scope replacement', async () => {
    const { tenant, organization, brand, event } = await createCatalog(db);
    const invited = await new OrganizationMemberRepository(db).invite({
      tenantId: tenant.id,
      organizationId: organization.id,
      email: `scope-race-${driver}@example.test`,
      role: 'viewer',
    });

    const applyInvitation = async (input: {
      role: 'admin' | 'viewer';
      brandIds?: string[];
      eventIds?: string[];
    }) =>
      db.transaction().execute(async (trx) => {
        const members = new OrganizationMemberRepository(trx);
        const locked = await members.findByIdForUpdate(tenant.id, organization.id, invited.id);
        if (!locked) throw new Error('Expected locked invitation member');
        await members.updateRole(invited.id, input.role);
        await new PermissionGrantRepository(trx).replaceRoleGrants({
          tenantId: tenant.id,
          organizationId: organization.id,
          principalId: invited.user_id,
          permissions: permissionsForRole(input.role),
          brandIds: input.brandIds,
          eventIds: input.eventIds,
        });
      });

    await Promise.all([
      applyInvitation({ role: 'admin', brandIds: [brand.id] }),
      applyInvitation({ role: 'viewer', eventIds: [event.id] }),
    ]);

    const finalMember = await db
      .selectFrom('organization_members')
      .select(['role'])
      .where('id', '=', invited.id)
      .executeTakeFirstOrThrow();
    const grants = await db
      .selectFrom('permission_grants')
      .select(['permission', 'scope_type', 'scope_id'])
      .where('principal_id', '=', invited.user_id)
      .execute();
    const expectedPermissions = new Set(permissionsForRole(finalMember.role));
    expect(new Set(grants.map((grant) => grant.permission))).toEqual(expectedPermissions);
    expect(grants.length).toBe(expectedPermissions.size);
    if (finalMember.role === 'admin') {
      expect(
        grants.every((grant) => grant.scope_type === 'brand' && grant.scope_id === brand.id),
      ).toBe(true);
    } else {
      expect(
        grants.every((grant) => grant.scope_type === 'event' && grant.scope_id === event.id),
      ).toBe(true);
    }
  });

  it('rolls back a pending invitation role change with its grant replacement', async () => {
    const { tenant, organization, event } = await createCatalog(db);
    const invited = await new OrganizationMemberRepository(db).invite({
      tenantId: tenant.id,
      organizationId: organization.id,
      email: `rollback-${driver}@example.test`,
      role: 'viewer',
    });
    await new PermissionGrantRepository(db).replaceRoleGrants({
      tenantId: tenant.id,
      organizationId: organization.id,
      principalId: invited.user_id,
      permissions: permissionsForRole('viewer'),
      eventIds: [event.id],
    });

    await expect(
      db.transaction().execute(async (trx) => {
        const members = new OrganizationMemberRepository(trx);
        const locked = await members.findByIdForUpdate(tenant.id, organization.id, invited.id);
        if (!locked) throw new Error('Expected locked invitation member');
        await members.updateRole(invited.id, 'admin');
        await new PermissionGrantRepository(trx).replaceRoleGrants({
          tenantId: tenant.id,
          organizationId: organization.id,
          principalId: invited.user_id,
          permissions: permissionsForRole('admin'),
        });
        throw new Error('simulated invitation delivery queue failure');
      }),
    ).rejects.toThrow('simulated invitation delivery queue failure');

    await expect(
      db
        .selectFrom('organization_members')
        .select('role')
        .where('id', '=', invited.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ role: 'viewer' });
    const grants = await db
      .selectFrom('permission_grants')
      .select(['permission', 'scope_type', 'scope_id'])
      .where('principal_id', '=', invited.user_id)
      .execute();
    expect(new Set(grants.map((grant) => grant.permission))).toEqual(
      new Set(permissionsForRole('viewer')),
    );
    expect(
      grants.every((grant) => grant.scope_type === 'event' && grant.scope_id === event.id),
    ).toBe(true);
  });

  it('does not broaden brand/event-scoped grants during the legacy role backfill', async () => {
    const first = await createCatalog(db);
    const secondOrganization = await new OrganizationRepository(db).create({
      tenantId: first.tenant.id,
      name: 'Second Integration Org',
      slug: 'second-integration-org',
    });
    const secondBrand = await new BrandRepository(db).create({
      tenantId: first.tenant.id,
      organizationId: secondOrganization.id,
      name: 'Second Integration Brand',
      slug: 'second-integration-brand',
    });
    const secondEvent = await new EventRepository(db).create({
      tenantId: first.tenant.id,
      organizationId: secondOrganization.id,
      brandId: secondBrand.id,
      slug: 'second-integration-event',
      title: 'Second Integration Event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2028-01-01T18:00:00.000Z'),
    });
    const now = new Date();
    await db
      .insertInto('user_profiles')
      .values([
        {
          id: 'usr_scoped_migration',
          tenant_id: first.tenant.id,
          clerk_user_id: 'clerk_scoped_migration',
          email: 'scoped-migration@example.test',
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'usr_custom_role',
          tenant_id: first.tenant.id,
          clerk_user_id: 'clerk_custom_role',
          email: 'custom-role@example.test',
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('organization_members')
      .values([
        {
          id: 'mem_scoped_brand',
          tenant_id: first.tenant.id,
          organization_id: first.organization.id,
          user_id: 'usr_scoped_migration',
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'mem_scoped_event',
          tenant_id: first.tenant.id,
          organization_id: secondOrganization.id,
          user_id: 'usr_scoped_migration',
          role: 'admin',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'mem_custom_role',
          tenant_id: first.tenant.id,
          organization_id: first.organization.id,
          user_id: 'usr_custom_role',
          role: 'custom_finance_observer',
          invited_at: now,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('permission_grants')
      .values([
        {
          id: 'pg_scoped_brand',
          tenant_id: first.tenant.id,
          principal_type: 'user',
          principal_id: 'usr_scoped_migration',
          permission: 'settings.write',
          scope_type: 'brand',
          scope_id: first.brand.id,
          created_at: now,
          updated_at: now,
        },
        {
          id: 'pg_scoped_event',
          tenant_id: first.tenant.id,
          principal_type: 'user',
          principal_id: 'usr_scoped_migration',
          permission: 'events.write',
          scope_type: 'event',
          scope_id: secondEvent.id,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();

    await RolePermissionGrantsSeedMigration.up(db);

    const grants = await db
      .selectFrom('permission_grants')
      .select(['scope_type', 'scope_id'])
      .where('principal_id', '=', 'usr_scoped_migration')
      .execute();
    expect(grants).toHaveLength(2);
    expect(grants.some((grant) => grant.scope_type === 'organization')).toBe(false);
    await expect(
      db
        .selectFrom('permission_grants')
        .select('id')
        .where('principal_id', '=', 'usr_custom_role')
        .execute(),
    ).resolves.toHaveLength(0);
  });

  it('persists resale listings and enforces one active listing per ticket', async () => {
    const { tenant, brand, event, ticketType } = await createCatalog(db);
    const checkoutSession = await new CheckoutSessionRepository(db).create({
      tenantId: tenant.id,
      eventId: event.id,
      brandId: brand.id,
      currency: 'USD',
      cart: { items: [{ ticketTypeId: ticketType.id, quantity: 1 }] },
      buyer: { email: 'seller@example.com' },
      quote: { totalCents: 2500 },
      expiresAt: new Date(Date.now() + 900_000),
      idempotencyKey: `resale-session-${driver}`,
    });
    const order = await new OrderRepository(db).create({
      tenantId: tenant.id,
      organizationId: event.organization_id,
      brandId: brand.id,
      eventId: event.id,
      checkoutSessionId: checkoutSession.id,
      orderNumber: `RESALE-${driver}`,
      status: 'paid',
      currency: 'USD',
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
      buyerEmail: 'seller@example.com',
    });
    const attendee = await new AttendeeRepository(db).create({
      tenantId: tenant.id,
      orderId: order.id,
      eventId: event.id,
      ticketTypeId: ticketType.id,
      email: 'seller@example.com',
    });
    const ticket = await new TicketRepository(db).create({
      tenantId: tenant.id,
      orderId: order.id,
      attendeeId: attendee.id,
      eventId: event.id,
      ticketTypeId: ticketType.id,
      code: `RESALE-${driver}`,
      qrPayload: `resale-payload-${driver}`,
      qrHash: `resale-hash-${driver}`,
    });

    const repo = new TicketListingRepository(db);
    const listing = await repo.create({
      tenantId: tenant.id,
      eventId: event.id,
      ticketId: ticket.id,
      sellerId: 'usr_seller',
      priceCents: 2400,
      currency: 'USD',
      faceValueCents: 2500,
    });

    expect(listing).toMatchObject({
      tenant_id: tenant.id,
      ticket_id: ticket.id,
      status: 'listed',
      active_listing_key: ticket.id,
    });
    expect(Number(listing.price_cents)).toBe(2400);
    await expect(repo.findActiveByTicket(tenant.id, ticket.id)).resolves.toMatchObject({
      id: listing.id,
    });
    await expect(
      repo.create({
        tenantId: tenant.id,
        eventId: event.id,
        ticketId: ticket.id,
        sellerId: 'usr_seller',
        priceCents: 2300,
        currency: 'USD',
        faceValueCents: 2500,
      }),
    ).rejects.toThrow();

    const delisted = await repo.delist(listing.id);
    expect(delisted).toMatchObject({
      status: 'delisted',
      active_listing_key: listing.id,
    });
    await expect(repo.markSold(listing.id, 'usr_late_buyer')).rejects.toThrow(
      `Ticket listing ${listing.id} is not listed`,
    );
    await expect(repo.findActiveByTicket(tenant.id, ticket.id)).resolves.toBeUndefined();

    const secondListing = await repo.create({
      tenantId: tenant.id,
      eventId: event.id,
      ticketId: ticket.id,
      sellerId: 'usr_seller',
      priceCents: 2200,
      currency: 'USD',
      faceValueCents: 2500,
    });
    const sold = await repo.markSold(secondListing.id, 'usr_buyer');
    expect(sold).toMatchObject({
      status: 'sold',
      sold_to_id: 'usr_buyer',
      active_listing_key: secondListing.id,
    });
    expect(sold.sold_at).toBeTruthy();
    await expect(
      repo.relist(secondListing.id, {
        priceCents: 2100,
        faceValueCents: 2500,
      }),
    ).rejects.toThrow(`Ticket listing ${secondListing.id} is not delisted`);
  });

  it('duplicates content documents as unpublished draft copies with fresh version identity', async () => {
    const { tenant, organization, brand, event } = await createCatalog(db);
    const repo = new ContentRepository(db);
    const document = await repo.createDocument({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      eventId: event.id,
      channel: 'email',
      key: 'order-confirmed',
      name: 'Order confirmed',
      locale: 'en',
    });
    const version = await repo.createVersion({
      documentId: document.id,
      subject: 'Hi {{recipient.name}}',
      previewText: 'Tickets ready',
      contentJson: { blocks: [{ type: 'text', text: 'Hi {{recipient.name}}' }] },
      renderedHtml: '<p>Hi {{recipient.name}}</p>',
      renderedText: 'Hi {{recipient.name}}',
      variables: [],
      validation: { valid: true, severity: 'warning', issues: [] },
      createdBy: 'usr_integration',
    });
    await repo.publishVersion({ documentId: document.id, versionId: version.id });

    const duplicate = await repo.duplicateDocument({
      documentId: document.id,
      tenantId: tenant.id,
      key: 'order-confirmed-copy',
      name: 'Order confirmed copy',
      createdBy: 'usr_copy',
    });

    expect(duplicate.document).toMatchObject({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      eventId: event.id,
      channel: 'email',
      key: 'order-confirmed-copy',
      name: 'Order confirmed copy',
      status: 'draft',
    });
    expect(duplicate.document.id).not.toBe(document.id);
    expect(duplicate.document.publishedVersionId).toBeUndefined();
    expect(duplicate.versions).toHaveLength(1);
    expect(duplicate.versions[0]).toMatchObject({
      documentId: duplicate.document.id,
      versionNumber: 1,
      status: 'draft',
      subject: 'Hi {{recipient.name}}',
      renderedText: 'Hi {{recipient.name}}',
      createdBy: 'usr_copy',
    });
    expect(duplicate.versions[0]?.id).not.toBe(version.id);
    expect(duplicate.versions[0]?.publishedAt).toBeUndefined();
    await expect(repo.listVersions(duplicate.document.id)).resolves.toMatchObject([
      { id: duplicate.versions[0]?.id, status: 'draft' },
    ]);

    const testSend = await repo.recordTestSend({
      tenantId: tenant.id,
      documentId: document.id,
      versionId: version.id,
      channel: 'email',
      recipient: 'ada@example.com',
      status: 'captured',
      renderedSubject: 'Hi Ada',
      renderedHtml: '<p>Hi Ada</p>',
      renderedText: 'Hi Ada',
    });

    expect(testSend).toMatchObject({
      tenantId: tenant.id,
      documentId: document.id,
      versionId: version.id,
      channel: 'email',
      recipient: 'ada@example.com',
      status: 'captured',
      renderedSubject: 'Hi Ada',
      renderedText: 'Hi Ada',
    });
    expect(testSend.id).toMatch(/^cts_/);
    expect(testSend.id.length).toBeLessThanOrEqual(32);

    const artifact = await repo.recordRenderArtifact({
      tenantId: tenant.id,
      documentId: document.id,
      versionId: version.id,
      channel: 'email',
      outputType: 'preview',
      artifactRef: `content-preview:${document.id}:${version.id}:integration`,
      checksum: 'b'.repeat(64),
    });

    expect(artifact).toMatchObject({
      tenantId: tenant.id,
      documentId: document.id,
      versionId: version.id,
      channel: 'email',
      outputType: 'preview',
      checksum: 'b'.repeat(64),
    });
    expect(artifact.artifactRef).toBe(`content-preview:${document.id}:${version.id}:integration`);
  });

  it('persists and resolves published event-page content with scoped render artifacts', async () => {
    const { tenant, organization, brand, event } = await createCatalog(db);
    const repo = new ContentRepository(db);
    const eventPageJson = {
      schemaVersion: 1,
      editor: {
        provider: '@tixkit/event-page-tiptap',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Welcome to {{event.title}}' }],
            },
          ],
        },
      },
      settings: {
        eventId: event.id,
        locale: 'en',
        publicUrl: `https://events.example.test/e/${event.slug}`,
        checkoutUrl: `https://checkout.example.test/e/${event.id}`,
      },
      blocks: [
        {
          type: 'hero',
          id: 'hero',
          headline: '{{event.title}}',
          body: 'Repository parity proof',
          ctaLabel: 'Get tickets',
          ctaUrl: '{{event.checkoutUrl}}',
        },
        {
          type: 'tickets',
          id: 'tickets',
          title: 'Tickets',
          body: 'Choose your ticket.',
          ctaLabel: 'Get tickets',
        },
      ],
    };

    const document = await repo.createDocument({
      tenantId: tenant.id,
      organizationId: organization.id,
      brandId: brand.id,
      eventId: event.id,
      channel: 'event_page',
      key: 'event-page',
      name: 'Event page',
      locale: 'en',
    });
    const version = await repo.createVersion({
      documentId: document.id,
      contentJson: eventPageJson,
      renderedHtml: '<div class="tixkit-event-page">Welcome to Integration Event</div>',
      renderedText: 'Welcome to Integration Event',
      variables: [],
      validation: { valid: true, severity: 'warning', issues: [] },
      createdBy: 'usr_integration',
    });

    await expect(
      repo.findPublishedEventPage({ tenantId: tenant.id, eventId: event.id }),
    ).resolves.toBeUndefined();

    await repo.publishVersion({ documentId: document.id, versionId: version.id });
    const published = await repo.findPublishedEventPage({
      tenantId: tenant.id,
      eventId: event.id,
      locale: 'en',
    });

    expect(published?.document).toMatchObject({
      id: document.id,
      tenantId: tenant.id,
      brandId: brand.id,
      eventId: event.id,
      channel: 'event_page',
      status: 'published',
    });
    expect(published?.version).toMatchObject({
      id: version.id,
      documentId: document.id,
      status: 'published',
      renderedText: 'Welcome to Integration Event',
    });
    expect(published?.version.contentJson).toMatchObject(eventPageJson);
    await expect(
      repo.findPublishedEventPage({ tenantId: 'tnt_other', eventId: event.id }),
    ).resolves.toBeUndefined();
    await expect(
      repo.findPublishedEventPage({ tenantId: tenant.id, eventId: event.id, locale: 'fr' }),
    ).resolves.toBeUndefined();

    const artifact = await repo.recordRenderArtifact({
      tenantId: tenant.id,
      documentId: document.id,
      versionId: version.id,
      channel: 'event_page',
      outputType: 'preview',
      artifactRef: `content-preview:${document.id}:${version.id}:event-page`,
      checksum: 'c'.repeat(64),
    });
    expect(artifact).toMatchObject({
      tenantId: tenant.id,
      documentId: document.id,
      versionId: version.id,
      channel: 'event_page',
      outputType: 'preview',
      checksum: 'c'.repeat(64),
    });
  });

  it('enforces tenant-scoped unique slugs', async () => {
    const { tenant } = await createCatalog(db);

    await expect(
      new OrganizationRepository(db).create({
        tenantId: tenant.id,
        name: 'Duplicate Org',
        slug: 'integration-org',
      }),
    ).rejects.toThrow();
  });

  it('enforces globally unique non-null Clerk organization IDs', async () => {
    const { tenant } = await createCatalog(db);
    const otherTenant = await new TenantRepository(db).create({
      name: 'Other Tenant',
      plan: 'pro',
    });

    await new OrganizationRepository(db).create({
      tenantId: tenant.id,
      name: 'Clerk Org One',
      slug: 'clerk-org-one',
      clerkOrganizationId: 'clerk_org_shared',
    });
    await new OrganizationRepository(db).create({
      tenantId: otherTenant.id,
      name: 'Nullable Clerk Org',
      slug: 'nullable-clerk-org',
    });

    await expect(
      new OrganizationRepository(db).create({
        tenantId: otherTenant.id,
        name: 'Duplicate Clerk Org',
        slug: 'duplicate-clerk-org',
        clerkOrganizationId: 'clerk_org_shared',
      }),
    ).rejects.toThrow();
  });

  it('rejects orphaned checkout sessions through foreign keys', async () => {
    await expect(
      db
        .insertInto('checkout_sessions')
        .values({
          id: 'cs_orphan',
          tenant_id: 'tnt_missing',
          event_id: 'evt_missing',
          brand_id: 'brd_missing',
          status: 'open',
          hold_id: 'hld_missing',
          currency: 'USD',
          cart: JSON.stringify({ items: [] }),
          buyer: JSON.stringify({}),
          quote: JSON.stringify({ totalCents: 0 }),
          payment_intent_id: null,
          order_id: null,
          success_url: null,
          cancel_url: null,
          expires_at: new Date('2027-01-01T19:00:00.000Z'),
          idempotency_key: 'idem_orphan',
          client_token: 'client_orphan',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects orphaned ticket types through foreign keys', async () => {
    await expect(
      db
        .insertInto('ticket_types')
        .values({
          id: 'tt_orphan',
          event_id: 'evt_missing',
          name: 'Orphan',
          description: null,
          kind: 'paid',
          status: 'active',
          visibility: 'public',
          currency: 'USD',
          price_cents: 2500,
          minimum_price_cents: null,
          sales_start_at: null,
          sales_end_at: null,
          min_per_order: 1,
          max_per_order: 10,
          inventory_pool_id: 'pool_missing',
          sort_order: 0,
          requires_access_code: false,
          access_code_hint: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('lists public ticket types by default and explicitly requested hidden ticket types by direct-link id', async () => {
    const { event, ticketType } = await createCatalog(db);
    const hiddenPool = await new InventoryPoolRepository(db).create({
      eventId: event.id,
      name: 'Invite Pool',
      totalCapacity: 10,
    });
    const hiddenTicketType = await new TicketTypeRepository(db).create({
      eventId: event.id,
      inventoryPoolId: hiddenPool.id,
      name: 'Invite Only',
      kind: 'paid',
      currency: 'USD',
      priceCents: 7500,
      visibility: 'hidden',
    });
    const ttRepo = new TicketTypeRepository(db);

    await expect(ttRepo.findPublicOrRequestedByEvent(event.id, [])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ticketType.id, visibility: 'public' }),
      ]),
    );
    await expect(ttRepo.findPublicOrRequestedByEvent(event.id, [])).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: hiddenTicketType.id })]),
    );
    await expect(
      ttRepo.findPublicOrRequestedByEvent(event.id, [hiddenTicketType.id]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ticketType.id, visibility: 'public' }),
        expect.objectContaining({ id: hiddenTicketType.id, visibility: 'hidden' }),
      ]),
    );
  });

  it('rejects invalid inventory pool counts through check constraints', async () => {
    const { event } = await createCatalog(db);

    await expect(
      db
        .insertInto('inventory_pools')
        .values({
          id: 'pool_invalid_counts',
          event_id: event.id,
          name: 'Invalid',
          total_capacity: -1,
          reserved_count: 0,
          sold_count: 0,
          hold_ttl_seconds: 900,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      db
        .insertInto('inventory_pools')
        .values({
          id: 'pool_oversold_counts',
          event_id: event.id,
          name: 'Oversold',
          total_capacity: 1,
          reserved_count: 0,
          sold_count: 2,
          hold_ttl_seconds: 900,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects orphaned commercial configuration through foreign keys', async () => {
    const { event } = await createCatalog(db);

    await expect(
      db
        .insertInto('discount_codes')
        .values({
          id: 'disc_orphan_event',
          event_id: 'evt_missing',
          code: 'MISSING',
          type: 'fixed',
          value: 100,
          currency: 'USD',
          max_uses: 10,
          uses_count: 0,
          valid_from: null,
          valid_until: null,
          min_order_cents: null,
          max_discount_cents: null,
          ticket_type_ids: null,
          status: 'active',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();

    await expect(
      db
        .insertInto('products')
        .values({
          id: 'prod_missing_category',
          event_id: event.id,
          name: 'VIP Parking',
          description: null,
          price_cents: 500,
          currency: 'USD',
          category_id: 'pc_missing',
          max_per_order: 1,
          available_from: null,
          available_until: null,
          status: 'active',
          sort_order: 0,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('rejects invalid commercial configuration through check constraints', async () => {
    const { ticketType } = await createCatalog(db);

    await expect(
      db
        .insertInto('access_rules')
        .values({
          id: 'access_invalid_usage',
          ticket_type_id: ticketType.id,
          type: 'code',
          value: 'INVITE',
          max_uses: 1,
          uses_count: 2,
          expires_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('allocates monotonic check-in activity sequences under concurrent scans', async () => {
    const { tenant, event } = await createCatalog(db);
    const checkInList = await new CheckInListRepository(db).create({
      eventId: event.id,
      name: 'Main entrance',
      ticketTypeIds: [],
    });
    const scanLogs = new ScanLogRepository(db);

    const created = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        scanLogs.create({
          tenantId: tenant.id,
          checkInListId: checkInList.id,
          deviceId: `device_${index % 3}`,
          qrHash: `hash_${index}`,
          outcome: 'accepted',
          scannedAt: new Date(`2027-01-01T18:00:${String(index).padStart(2, '0')}.000Z`),
          offline: false,
        }),
      ),
    );
    const allocatedSequences = created.map((entry) => Number(entry.activity_sequence));
    expect(new Set(allocatedSequences).size).toBe(20);
    for (let expected = 1; expected <= 20; expected += 1) {
      expect(allocatedSequences).toContain(expected);
    }
    const cursor = created.find((entry) => Number(entry.activity_sequence) === 10);
    expect(cursor).toBeDefined();

    const replay = await scanLogs.findByListSince({
      tenantId: tenant.id,
      listId: checkInList.id,
      afterId: cursor?.id,
      limit: 20,
    });
    expect(replay.map((entry) => Number(entry.activity_sequence))).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 11),
    );
  });

  it('persists export job events for replay', async () => {
    const { tenant, event } = await createCatalog(db);
    await db
      .insertInto('export_jobs')
      .values({
        id: 'exp_integration',
        tenant_id: tenant.id,
        event_id: event.id,
        type: 'attendees',
        format: 'csv',
        status: 'pending',
        file_url: null,
        requested_by: 'usr_integration',
        filters: JSON.stringify({ status: 'active' }),
        created_at: new Date(),
        completed_at: null,
      })
      .execute();

    await db
      .insertInto('export_job_events')
      .values({
        id: 'eev_00000000000000000000000001',
        tenant_id: tenant.id,
        export_job_id: 'exp_integration',
        status: 'pending',
        payload: JSON.stringify({ exportId: 'exp_integration', status: 'pending' }),
        created_at: new Date(),
      })
      .execute();

    await expect(
      db
        .selectFrom('export_job_events')
        .selectAll()
        .where('tenant_id', '=', tenant.id)
        .where('export_job_id', '=', 'exp_integration')
        .where('id', '>', 'eev_00000000000000000000000000')
        .execute(),
    ).resolves.toMatchObject([
      {
        id: 'eev_00000000000000000000000001',
        status: 'pending',
      },
    ]);
  });
});
