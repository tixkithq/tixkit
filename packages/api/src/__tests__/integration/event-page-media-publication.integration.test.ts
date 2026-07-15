import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ContentRepository, EventRepository, createDb, type Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import {
  createDefaultEventPageDocument,
  eventPageMediaReference,
} from '@tixkit/content-event-page';
import { ulid } from 'ulid';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { contentRoutes, publicContentRoutes } from '../../routes/modules/content.js';
import { eventMediaRoutes } from '../../routes/modules/event-media.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

describeWithIntegrationDatabase('event-page publication and media serialization', () => {
  let db: Database;
  let app: FastifyInstance;
  let previousDriver: string | undefined;
  let releasePublish: (() => void) | undefined;
  let eventLocked: Promise<void>;
  let signalEventLocked: (() => void) | undefined;
  const suffix = ulid().slice(-10).toLowerCase();
  const tenantId = `tnt_epm_${suffix}`;
  const organizationId = `org_epm_${suffix}`;
  const brandId = `brd_epm_${suffix}`;
  const assetId = `ema_epm_${suffix}`;
  const uploadId = `upl_epm_${suffix}`;
  let eventId: string;
  let documentId: string;
  let versionId: string;

  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    const now = new Date();
    await db
      .insertInto('tenants')
      .values({
        id: tenantId,
        name: 'Event page media serialization tenant',
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
        name: 'Event page media serialization organization',
        slug: `epm-${suffix}`,
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
        name: 'Event page media serialization brand',
        slug: `epm-${suffix}`,
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
    const event = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId,
      slug: `epm-${suffix}`,
      title: 'Serialized media publication',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-03-01T18:00:00.000Z'),
    });
    eventId = event.id;
    await db
      .updateTable('events')
      .set({ status: 'published', visibility: 'public', updated_at: now })
      .where('id', '=', eventId)
      .execute();
    await db
      .insertInto('upload_artifacts')
      .values({
        id: uploadId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        event_id: eventId,
        created_by_user_id: null,
        purpose: 'event_cover',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: 'integration fixture',
        bucket: 'event-media-test',
        object_key: `event-media/${eventId}/cover.webp`,
        file_name: 'cover.webp',
        content_type: 'image/webp',
        size_bytes: 1024,
        checksum_sha256: 'a'.repeat(64),
        client_token_hash: null,
        metadata: '{}',
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        completion_owner_token: null,
        completion_started_at: null,
        expires_at: new Date('2028-01-01T00:00:00.000Z'),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_assets')
      .values({
        id: assetId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brandId,
        event_id: eventId,
        upload_artifact_id: uploadId,
        role: 'cover',
        width: 1600,
        height: 900,
        format: 'webp',
        checksum_sha256: 'a'.repeat(64),
        size_bytes: 1024,
        focal_x: '0.5',
        focal_y: '0.5',
        alt_text: 'Serialization cover',
        created_by: `usr_epm_${suffix}`,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_renditions')
      .values(
        [
          ['thumbnail', 320, 320],
          ['card', 480, 270],
          ['page', 1600, 900],
          ['social', 1200, 630],
        ].map(([variant, width, height]) => ({
          id: `emr_epm_${variant}_${suffix}`,
          asset_id: assetId,
          variant: String(variant),
          width: Number(width),
          height: Number(height),
          format: 'webp',
          content_type: 'image/webp',
          bucket: 'event-media-test',
          object_key: `event-media/${eventId}/${String(variant)}.webp`,
          checksum_sha256: 'b'.repeat(64),
          size_bytes: 512,
          created_at: now,
        })),
      )
      .execute();
    const content = new ContentRepository(db);
    const document = await content.createDocument({
      tenantId,
      organizationId,
      brandId,
      eventId,
      channel: 'event_page',
      key: 'main',
      name: 'Serialized event page',
      locale: 'en',
    });
    documentId = document.id;
    const page = createDefaultEventPageDocument({
      eventId,
      eventTitle: 'Serialized media publication',
      startsAt: '2027-03-01T18:00:00.000Z',
      timezone: 'UTC',
      coverImageUrl: eventPageMediaReference('cover'),
      coverImageAlt: 'Serialization cover',
      publicUrl: `/e/${eventId}`,
    });
    const version = await content.createVersion({
      documentId,
      contentJson: page,
      variables: [],
      validation: { valid: true, severity: 'warning', issues: [] },
      createdBy: `usr_epm_${suffix}`,
    });
    versionId = version.id;
    const principal: Principal = {
      type: 'user',
      id: `usr_epm_${suffix}`,
      tenantId,
      organizationIds: [organizationId],
      brandIds: [brandId],
      eventIds: [eventId],
      scopes: ['events.read', 'events.write'],
    };
    eventLocked = new Promise((resolve) => {
      signalEventLocked = resolve;
    });
    app = Fastify();
    app.decorate('context', {
      db,
      eventPagePublishCheckpoint: async () => {
        signalEventLocked?.();
        await new Promise<void>((resolve) => {
          releasePublish = resolve;
        });
      },
    } as unknown as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = principal;
    });
    registerErrorHandler(app);
    await app.register(contentRoutes);
    await app.register(publicContentRoutes);
    await app.register(eventMediaRoutes);
  }, 120_000);

  afterAll(async () => {
    releasePublish?.();
    await app?.close();
    await db?.destroy();
    restoreDatabaseDriver(previousDriver);
  });

  it('serializes publication against concurrent media removal and preserves referenced assets', async () => {
    const publish = app.inject({
      method: 'POST',
      url: `/content-documents/${documentId}/versions/${versionId}/publish`,
    });
    await eventLocked;
    let removalSettled = false;
    const removal = app
      .inject({ method: 'DELETE', url: `/events/${eventId}/media/cover` })
      .finally(() => {
        removalSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(removalSettled).toBe(false);
    releasePublish?.();
    expect((await publish).statusCode).toBe(200);
    const removalResponse = await removal;
    expect(removalResponse.statusCode).toBe(409);
    expect(removalResponse.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        details: {
          code: 'EVENT_MEDIA_ROLE_REFERENCED',
          role: 'cover',
        },
      },
    });
    const stored = await new ContentRepository(db).findDocumentById(documentId);
    expect(stored?.publishedVersionId).toBe(versionId);
    expect(
      await db.selectFrom('event_media_assets').select('id').where('id', '=', assetId).execute(),
    ).toEqual([{ id: assetId }]);
    const publicPage = await app.inject({
      method: 'GET',
      url: `/public/events/${eventId}/content-page`,
    });
    expect(publicPage.statusCode, publicPage.body).toBe(200);
    expect(publicPage.body).not.toContain('tixkit:event-media:');
    expect(publicPage.body).not.toContain('/v1/upload-artifacts/');
    expect(publicPage.body).toContain('/v1/public/event-media/renditions/');
  }, 30_000);
});
