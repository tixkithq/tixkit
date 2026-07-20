import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  AuditLogRepository,
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
  const scopeSwapBrandId = `brd_dup_scope_${suffix}`;
  const eventPageDocumentId = `cdoc_dup_page_${suffix}`;
  const eventPageVersionId = `cver_dup_page_${suffix}`;
  const lifecycleDocumentId = `cdoc_dup_lifecycle_${suffix}`;
  const lifecycleVersionId = `cver_dup_lifecycle_${suffix}`;
  let sourceEventId: string;
  let scopeSourceEventId: string;

  const boundaryPayload = {
    startsAt: '2027-04-15T18:00:00.000Z',
    copy: {
      basicsVenue: false,
      ticketTypes: false,
      products: false,
      checkoutQuestions: false,
      feeResalePolicies: false,
      eventPageContent: false,
      lifecycleContent: false,
      marketingIntegrations: false,
      mediaAssets: false,
    },
  };

  async function duplicationBoundarySnapshot() {
    const [events, audits, idempotencyRecords] = await Promise.all([
      db
        .selectFrom('events')
        .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'title', 'status'])
        .where('tenant_id', '=', tenantId)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('audit_logs')
        .select(['id', 'action', 'resource_id', 'diff_summary'])
        .where('actor_id', '=', `usr_${suffix}`)
        .where('action', '=', 'event.duplicated')
        .orderBy('id')
        .execute(),
      db
        .selectFrom('idempotency_records')
        .select(['id', 'key', 'tenant_id', 'request_hash', 'response_status', 'status'])
        .where('key', 'like', `duplicate-%-${suffix}`)
        .orderBy('key')
        .execute(),
    ]);
    return { events, audits, idempotencyRecords };
  }

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
    await db
      .insertInto('brands')
      .values({
        id: scopeSwapBrandId,
        tenant_id: tenantId,
        organization_id: organizationId,
        name: 'Duplication scope-swap brand',
        slug: `dup-scope-${suffix}`,
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
    const scopeSource = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId,
      slug: `scope-source-${suffix}`,
      title: 'Scope source event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-02T18:00:00Z'),
    });
    scopeSourceEventId = scopeSource.id;
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
    const mediaUploadId = `upl_dup_${suffix}`;
    const mediaAssetId = `ema_dup_${suffix}`;
    await db
      .insertInto('upload_artifacts')
      .values({
        id: mediaUploadId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        event_id: source.id,
        created_by_user_id: null,
        purpose: 'event_cover',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: 'clean',
        bucket: 'media',
        object_key: `event-media/${source.id}/original.jpg`,
        file_name: 'original.jpg',
        content_type: 'image/jpeg',
        size_bytes: 100,
        checksum_sha256: 'a'.repeat(64),
        client_token_hash: null,
        metadata: JSON.stringify({ image: { width: 10, height: 10, format: 'jpeg' } }),
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        completion_owner_token: null,
        completion_started_at: null,
        expires_at: new Date('2028-01-01T00:00:00Z'),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_assets')
      .values({
        id: mediaAssetId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        event_id: source.id,
        upload_artifact_id: mediaUploadId,
        role: 'cover',
        width: 10,
        height: 10,
        format: 'jpeg',
        checksum_sha256: 'a'.repeat(64),
        size_bytes: 100,
        focal_x: '0.5',
        focal_y: '0.5',
        alt_text: 'Source cover',
        created_by: 'usr_dup',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_renditions')
      .values({
        id: `emr_dup_${suffix}`,
        asset_id: mediaAssetId,
        variant: 'page',
        width: 1600,
        height: 900,
        format: 'webp',
        content_type: 'image/webp',
        bucket: 'media',
        object_key: `event-media/${source.id}/page.webp`,
        checksum_sha256: 'b'.repeat(64),
        size_bytes: 80,
        created_at: now,
      })
      .execute();
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
    await db
      .insertInto('content_documents')
      .values([
        {
          id: eventPageDocumentId,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: brandId,
          event_id: source.id,
          channel: 'event_page',
          key: 'event-page',
          name: 'Event page',
          status: 'published',
          locale: 'en',
          current_draft_version_id: null,
          published_version_id: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: lifecycleDocumentId,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: brandId,
          event_id: source.id,
          channel: 'email',
          key: 'event-reminder',
          name: 'Event reminder',
          status: 'published',
          locale: 'en',
          current_draft_version_id: null,
          published_version_id: null,
          created_at: now,
          updated_at: now,
        },
      ])
      .execute();
    await db
      .insertInto('content_document_versions')
      .values([
        {
          id: eventPageVersionId,
          document_id: eventPageDocumentId,
          version_number: 3,
          status: 'published',
          schema_version: 1,
          subject: null,
          preview_text: null,
          content_json: JSON.stringify({ heading: 'Source event' }),
          rendered_html: '<h1>Source event</h1>',
          rendered_text: 'Source event',
          variables: '[]',
          validation: '{}',
          created_by: `usr_${suffix}`,
          created_at: now,
          published_at: now,
        },
        {
          id: lifecycleVersionId,
          document_id: lifecycleDocumentId,
          version_number: 4,
          status: 'published',
          schema_version: 1,
          subject: 'Event reminder',
          preview_text: 'Soon',
          content_json: JSON.stringify({ body: 'Your event starts soon' }),
          rendered_html: '<p>Your event starts soon</p>',
          rendered_text: 'Your event starts soon',
          variables: '[]',
          validation: '{}',
          created_by: `usr_${suffix}`,
          created_at: now,
          published_at: now,
        },
      ])
      .execute();
    await db
      .updateTable('content_documents')
      .set({
        current_draft_version_id: eventPageVersionId,
        published_version_id: eventPageVersionId,
      })
      .where('id', '=', eventPageDocumentId)
      .execute();
    await db
      .updateTable('content_documents')
      .set({
        current_draft_version_id: lifecycleVersionId,
        published_version_id: lifecycleVersionId,
      })
      .where('id', '=', lifecycleDocumentId)
      .execute();
    await db
      .insertInto('marketing_integrations')
      .values({
        id: `mkt_dup_${suffix}`,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        event_id: source.id,
        provider: 'ga4',
        config: JSON.stringify({
          measurementId: 'G-DUPLICATE',
          apiSecret: 'must-not-copy',
        }),
        consent_required: true,
        status: 'active',
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
      eventIds: [source.id, scopeSource.id],
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
          eventPageContent: true,
          lifecycleContent: true,
          marketingIntegrations: true,
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
          eventPageContent: true,
          lifecycleContent: true,
          marketingIntegrations: true,
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
    const duplicatedMedia = await db
      .selectFrom('event_media_assets')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .executeTakeFirstOrThrow();
    expect(duplicatedMedia).toMatchObject({
      role: 'cover',
      alt_text: 'Source cover',
      event_id: duplicate.id,
    });
    expect(duplicatedMedia.id).not.toBe(`ema_dup_${suffix}`);
    const duplicatedUpload = await db
      .selectFrom('upload_artifacts')
      .selectAll()
      .where('id', '=', duplicatedMedia.upload_artifact_id)
      .executeTakeFirstOrThrow();
    expect(duplicatedUpload).toMatchObject({
      event_id: duplicate.id,
      object_key: expect.any(String),
    });
    expect(duplicatedUpload.id).not.toBe(`upl_dup_${suffix}`);
    await expect(
      db
        .selectFrom('event_media_renditions')
        .selectAll()
        .where('asset_id', '=', duplicatedMedia.id)
        .execute(),
    ).resolves.toMatchObject([{ object_key: `event-media/${sourceEventId}/page.webp` }]);
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
    const duplicatedDocuments = await db
      .selectFrom('content_documents')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .orderBy('channel')
      .execute();
    expect(duplicatedDocuments).toHaveLength(2);
    expect(duplicatedDocuments.map((document) => document.channel)).toEqual([
      'email',
      'event_page',
    ]);
    for (const document of duplicatedDocuments) {
      expect(document).toMatchObject({
        event_id: duplicate.id,
        status: 'draft',
        published_version_id: null,
      });
      expect(document.id).not.toBe(
        document.channel === 'event_page' ? eventPageDocumentId : lifecycleDocumentId,
      );
      expect(document.current_draft_version_id).toBeTruthy();
      const versions = await db
        .selectFrom('content_document_versions')
        .selectAll()
        .where('document_id', '=', document.id)
        .execute();
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        id: document.current_draft_version_id,
        document_id: document.id,
        version_number: 1,
        status: 'draft',
        created_by: principal.id,
        published_at: null,
      });
    }
    const duplicatedIntegrations = await db
      .selectFrom('marketing_integrations')
      .selectAll()
      .where('event_id', '=', duplicate.id)
      .execute();
    expect(duplicatedIntegrations).toHaveLength(1);
    expect(duplicatedIntegrations[0]).toMatchObject({
      event_id: duplicate.id,
      provider: 'ga4',
      status: 'active',
    });
    expect(Boolean(duplicatedIntegrations[0]!.consent_required)).toBe(true);
    const duplicatedIntegrationConfig = duplicatedIntegrations[0]!.config;
    expect(
      typeof duplicatedIntegrationConfig === 'string'
        ? JSON.parse(duplicatedIntegrationConfig)
        : duplicatedIntegrationConfig,
    ).toEqual({
      measurementId: 'G-DUPLICATE',
    });
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

  it('omits every unselected content, integration, media, and ticketing branch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/events/${sourceEventId}/duplicate`,
      headers: { 'Idempotency-Key': `duplicate-unselected-${suffix}` },
      payload: boundaryPayload,
    });
    expect(response.statusCode, response.body).toBe(201);
    const duplicateId = (response.json() as { id: string }).id;
    const [documents, integrations, media, pools, tickets] = await Promise.all([
      db.selectFrom('content_documents').select('id').where('event_id', '=', duplicateId).execute(),
      db
        .selectFrom('marketing_integrations')
        .select('id')
        .where('event_id', '=', duplicateId)
        .execute(),
      db
        .selectFrom('event_media_assets')
        .select('id')
        .where('event_id', '=', duplicateId)
        .execute(),
      db.selectFrom('inventory_pools').select('id').where('event_id', '=', duplicateId).execute(),
      db.selectFrom('ticket_types').select('id').where('event_id', '=', duplicateId).execute(),
    ]);
    expect({ documents, integrations, media, pools, tickets }).toEqual({
      documents: [],
      integrations: [],
      media: [],
      pools: [],
      tickets: [],
    });
  });

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

  it('fails closed at every declared duplication authorization boundary without persistence', async () => {
    const cases: Array<{
      boundary: string;
      expectedCode: 'FORBIDDEN' | 'NOT_FOUND';
      expectedStatus: 403 | 404;
      principal: Principal;
    }> = [
      {
        boundary: 'permission',
        expectedCode: 'FORBIDDEN',
        expectedStatus: 403,
        principal: { ...principal, scopes: ['events.read'] },
      },
      {
        boundary: 'tenant',
        expectedCode: 'NOT_FOUND',
        expectedStatus: 404,
        principal: { ...principal, tenantId: `tnt_denied_${suffix}` },
      },
      {
        boundary: 'organization',
        expectedCode: 'NOT_FOUND',
        expectedStatus: 404,
        principal: { ...principal, organizationIds: [] },
      },
      {
        boundary: 'brand',
        expectedCode: 'NOT_FOUND',
        expectedStatus: 404,
        principal: { ...principal, brandIds: [`brd_denied_${suffix}`] },
      },
      {
        boundary: 'event',
        expectedCode: 'NOT_FOUND',
        expectedStatus: 404,
        principal: { ...principal, eventIds: [`evt_denied_${suffix}`] },
      },
    ];

    for (const boundaryCase of cases) {
      const authorizedPrincipal = principal;
      const before = await duplicationBoundarySnapshot();
      principal = boundaryCase.principal;
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/events/${sourceEventId}/duplicate`,
          headers: {
            'Idempotency-Key': `duplicate-boundary-${boundaryCase.boundary}-${suffix}`,
          },
          payload: boundaryPayload,
        });
        expect(response.statusCode, `${boundaryCase.boundary}: ${response.body}`).toBe(
          boundaryCase.expectedStatus,
        );
        expect(response.json()).toMatchObject({
          error: { code: boundaryCase.expectedCode },
        });
      } finally {
        principal = authorizedPrincipal;
      }
      await expect(duplicationBoundarySnapshot()).resolves.toEqual(before);
    }
  });

  it('locks and rechecks the current source scope inside the duplication transaction', async () => {
    const before = await duplicationBoundarySnapshot();
    duplicationCheckpoint = async (input) => {
      if (input.stage === 'after_authorization') {
        await db
          .updateTable('events')
          .set({ brand_id: scopeSwapBrandId })
          .where('id', '=', scopeSourceEventId)
          .execute();
      }
    };
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/events/${scopeSourceEventId}/duplicate`,
        headers: { 'Idempotency-Key': `duplicate-boundary-scope-swap-${suffix}` },
        payload: boundaryPayload,
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    } finally {
      duplicationCheckpoint = undefined;
      await db
        .updateTable('events')
        .set({ brand_id: brandId })
        .where('id', '=', scopeSourceEventId)
        .execute();
    }
    await expect(duplicationBoundarySnapshot()).resolves.toEqual(before);
  });

  it('rolls back the new event when a selected child copy fails mid-transaction', async () => {
    const before = await db
      .selectFrom('events')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('tenant_id', '=', tenantId)
      .executeTakeFirstOrThrow();
    let attemptedEventId: string | undefined;
    duplicationCheckpoint = (input) => {
      if (input.stage !== 'after_children_copied') return;
      attemptedEventId = input.duplicatedEventId;
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

  it('rolls back event, children, audit, and idempotency on audit failure and cleanly retries', async () => {
    const key = `duplicate-audit-failure-${suffix}`;
    const before = await duplicationBoundarySnapshot();
    const auditFailure = vi
      .spyOn(AuditLogRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('injected duplication audit failure'));
    try {
      const failed = await app.inject({
        method: 'POST',
        url: `/events/${sourceEventId}/duplicate`,
        headers: { 'Idempotency-Key': key },
        payload: boundaryPayload,
      });
      expect(failed.statusCode, failed.body).toBe(500);
    } finally {
      auditFailure.mockRestore();
    }
    await expect(duplicationBoundarySnapshot()).resolves.toEqual(before);

    const retried = await app.inject({
      method: 'POST',
      url: `/events/${sourceEventId}/duplicate`,
      headers: { 'Idempotency-Key': key },
      payload: boundaryPayload,
    });
    expect(retried.statusCode, retried.body).toBe(201);
    const duplicatedEventId = (retried.json() as { id: string }).id;
    await expect(
      db
        .selectFrom('audit_logs')
        .select(['action', 'resource_id'])
        .where('actor_id', '=', principal.id)
        .where('action', '=', 'event.duplicated')
        .where('resource_id', '=', duplicatedEventId)
        .execute(),
    ).resolves.toEqual([{ action: 'event.duplicated', resource_id: duplicatedEventId }]);
    await expect(
      db
        .selectFrom('idempotency_records')
        .select(['key', 'status', 'response_status'])
        .where('tenant_id', '=', tenantId)
        .where('key', '=', key)
        .execute(),
    ).resolves.toEqual([{ key, status: 'completed', response_status: 201 }]);
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
    const createHeaders = { 'Idempotency-Key': `saved-venue-${suffix}` };
    const createPayload = {
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
    };
    const created = await app.inject({
      method: 'POST',
      url: '/venues',
      headers: createHeaders,
      payload: createPayload,
    });
    expect(created.statusCode).toBe(201);
    const venueId = (created.json() as { id: string }).id;
    const replay = await app.inject({
      method: 'POST',
      url: '/venues',
      headers: createHeaders,
      payload: createPayload,
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { id: string }).id).toBe(venueId);
    expect(
      await db
        .selectFrom('venues')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('organization_id', '=', organizationId)
        .where('name', '=', 'Saved Hall')
        .execute(),
    ).toHaveLength(1);
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
      headers: { 'Idempotency-Key': `disposable-venue-${suffix}` },
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
