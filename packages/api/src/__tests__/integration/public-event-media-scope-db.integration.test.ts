import { createDb, EventRepository, type Database } from '@tixkit/db';
import { ulid } from 'ulid';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadPublicEventById, loadPublicEventMedia } from '../../routes/modules/public.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

const suffix = ulid().slice(-8).toLowerCase();
const tenantA = `tnt_pem_a_${suffix}`;
const tenantB = `tnt_pem_b_${suffix}`;
const organizationA = `org_pem_a_${suffix}`;
const organizationB = `org_pem_b_${suffix}`;
const brandA = `brd_pem_a_${suffix}`;
const brandB = `brd_pem_b_${suffix}`;
const actorId = `usr_pem_${suffix}`;
const fixedNow = new Date('2026-07-21T12:00:00.000Z');

type MediaRole = 'poster' | 'cover' | 'social';
type RenditionVariant = 'thumbnail' | 'card' | 'page' | 'social';

let db: Database;
let previousDriver: string | undefined;
let eventA: string;
let eventB: string;

function uploadId(label: string): string {
  return `upl_pem_${label}_${suffix}`;
}

function assetId(label: string): string {
  return `ema_pem_${label}_${suffix}`;
}

function renditionId(label: string): string {
  return `emr_pem_${label}_${suffix}`;
}

async function insertTenant(id: string, name: string): Promise<void> {
  await db
    .insertInto('tenants')
    .values({
      id,
      name,
      status: 'active',
      plan: 'test',
      created_at: fixedNow,
      updated_at: fixedNow,
    })
    .execute();
}

async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
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
      created_at: fixedNow,
      updated_at: fixedNow,
    })
    .execute();
}

async function insertBrand(
  id: string,
  tenantId: string,
  organizationId: string,
  name: string,
): Promise<void> {
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
      created_at: fixedNow,
      updated_at: fixedNow,
    })
    .execute();
}

async function createPublishedEvent(
  tenantId: string,
  organizationId: string,
  brandId: string,
  label: string,
): Promise<string> {
  const event = await new EventRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    slug: `public-media-${label}-${suffix}`,
    title: `Public media ${label}`,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date('2027-10-01T18:00:00.000Z'),
  });
  await db
    .updateTable('events')
    .set({ status: 'published', visibility: 'public', updated_at: fixedNow })
    .where('id', '=', event.id)
    .execute();
  return event.id;
}

async function insertUpload(
  id: string,
  scope: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId: string;
  },
  role: MediaRole,
): Promise<void> {
  await db
    .insertInto('upload_artifacts')
    .values({
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      brand_id: scope.brandId,
      event_id: scope.eventId,
      created_by_user_id: actorId,
      purpose: `event_${role}`,
      status: 'uploaded',
      scan_status: 'clean',
      scan_result: 'integration fixture',
      bucket: 'public-event-media-scope',
      object_key: `uploads/${id}/original.webp`,
      file_name: `${role}.webp`,
      content_type: 'image/webp',
      size_bytes: 2_048,
      checksum_sha256: 'a'.repeat(64),
      client_token_hash: null,
      metadata: JSON.stringify({ image: { width: 1600, height: 900, format: 'webp' } }),
      consumed_by_checkout_session_id: null,
      consumed_at: null,
      completion_owner_token: null,
      completion_started_at: null,
      expires_at: new Date('2028-01-01T00:00:00.000Z'),
      created_at: fixedNow,
      updated_at: fixedNow,
    })
    .execute();
}

async function insertAsset(input: {
  id: string;
  uploadArtifactId: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  role: MediaRole;
  altText: string;
}): Promise<void> {
  await db
    .insertInto('event_media_assets')
    .values({
      id: input.id,
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      brand_id: input.brandId,
      event_id: input.eventId,
      upload_artifact_id: input.uploadArtifactId,
      role: input.role,
      width: 1600,
      height: 900,
      format: 'webp',
      checksum_sha256: 'a'.repeat(64),
      size_bytes: 2_048,
      focal_x: '0.4',
      focal_y: '0.6',
      alt_text: input.altText,
      created_by: actorId,
      created_at: fixedNow,
      updated_at: fixedNow,
    })
    .execute();
}

async function insertRendition(
  id: string,
  targetAssetId: string,
  variant: RenditionVariant,
  width: number,
  height: number,
): Promise<void> {
  await db
    .insertInto('event_media_renditions')
    .values({
      id,
      asset_id: targetAssetId,
      variant,
      width,
      height,
      format: 'webp',
      content_type: 'image/webp',
      bucket: 'public-event-media-scope',
      object_key: `renditions/${targetAssetId}/${variant}.webp`,
      checksum_sha256: 'b'.repeat(64),
      size_bytes: 1_024,
      created_at: fixedNow,
    })
    .execute();
}

async function mediaSnapshot() {
  const [events, uploads, assets, renditions] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'status', 'visibility'])
      .where('id', 'in', [eventA, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('upload_artifacts')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id', 'event_id'])
      .where('created_by_user_id', '=', actorId)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('event_media_assets')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'brand_id',
        'event_id',
        'upload_artifact_id',
        'role',
        'alt_text',
      ])
      .where('event_id', 'in', [eventA, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('event_media_renditions as rendition')
      .innerJoin('event_media_assets as asset', 'asset.id', 'rendition.asset_id')
      .select(['rendition.id', 'rendition.asset_id', 'rendition.variant'])
      .where('asset.event_id', 'in', [eventA, eventB])
      .orderBy('rendition.id')
      .execute(),
  ]);
  return { events, uploads, assets, renditions };
}

describeWithIntegrationDatabase('public event media hierarchy scope', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());

    await insertTenant(tenantA, 'Public media tenant A');
    await insertTenant(tenantB, 'Public media tenant B');
    await insertOrganization(organizationA, tenantA, 'Public media organization A');
    await insertOrganization(organizationB, tenantB, 'Public media organization B');
    await insertBrand(brandA, tenantA, organizationA, 'Public media brand A');
    await insertBrand(brandB, tenantB, organizationB, 'Public media brand B');
    eventA = await createPublishedEvent(tenantA, organizationA, brandA, 'a');
    eventB = await createPublishedEvent(tenantB, organizationB, brandB, 'b');

    const validAssets = [
      {
        label: 'a_cover',
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        eventId: eventA,
        role: 'cover' as const,
        altText: 'Event A cover',
      },
      {
        label: 'a_poster',
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        eventId: eventA,
        role: 'poster' as const,
        altText: 'Event A poster',
      },
      {
        label: 'a_social',
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandA,
        eventId: eventA,
        role: 'social' as const,
        altText: 'Event A social image',
      },
      {
        label: 'b_cover',
        tenantId: tenantB,
        organizationId: organizationB,
        brandId: brandB,
        eventId: eventB,
        role: 'cover' as const,
        altText: 'Event B cover must remain private to B',
      },
    ];
    for (const asset of validAssets) {
      const targetUploadId = uploadId(asset.label);
      await insertUpload(targetUploadId, asset, asset.role);
      await insertAsset({
        id: assetId(asset.label),
        uploadArtifactId: targetUploadId,
        ...asset,
      });
    }

    await insertRendition(renditionId('a_cover_page'), assetId('a_cover'), 'page', 1600, 900);
    await insertRendition(renditionId('a_cover_card'), assetId('a_cover'), 'card', 480, 270);
    await insertRendition(
      renditionId('a_poster_thumbnail'),
      assetId('a_poster'),
      'thumbnail',
      320,
      480,
    );
    await insertRendition(renditionId('a_poster_social'), assetId('a_poster'), 'social', 1200, 630);
    await insertRendition(renditionId('a_social_social'), assetId('a_social'), 'social', 1200, 630);
    await insertRendition(renditionId('b_cover_page'), assetId('b_cover'), 'page', 1600, 900);

    const invalidScopes = [
      {
        label: 'wrong_tenant',
        tenantId: tenantB,
        organizationId: organizationA,
        brandId: brandA,
      },
      {
        label: 'wrong_org',
        tenantId: tenantA,
        organizationId: organizationB,
        brandId: brandA,
      },
      {
        label: 'wrong_brand',
        tenantId: tenantA,
        organizationId: organizationA,
        brandId: brandB,
      },
    ];
    for (const scope of invalidScopes) {
      await insertUpload(uploadId(scope.label), { ...scope, eventId: eventA }, 'cover');
    }
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.deleteFrom('event_media_assets').where('event_id', 'in', [eventA, eventB]).execute();
      await db.deleteFrom('upload_artifacts').where('created_by_user_id', '=', actorId).execute();
      await db.deleteFrom('events').where('id', 'in', [eventA, eventB]).execute();
      await db.deleteFrom('brands').where('id', 'in', [brandA, brandB]).execute();
      await db
        .deleteFrom('organizations')
        .where('id', 'in', [organizationA, organizationB])
        .execute();
      await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
      await db.destroy();
    }
    restoreDatabaseDriver(previousDriver);
  });

  it('returns only the exact public event scope with deterministic role and variant order', async () => {
    const before = await mediaSnapshot();
    const publicEvent = await loadPublicEventById(db, eventA);

    await expect(
      loadPublicEventMedia(db, {
        eventId: publicEvent.id,
        tenantId: publicEvent.tenant_id,
        organizationId: publicEvent.organization_id,
        brandId: publicEvent.brand_id,
      }),
    ).resolves.toEqual([
      {
        role: 'cover',
        altText: 'Event A cover',
        focalPoint: { x: 0.4, y: 0.6 },
        renditions: [
          {
            variant: 'card',
            width: 480,
            height: 270,
            url: `/v1/public/event-media/renditions/${renditionId('a_cover_card')}`,
          },
          {
            variant: 'page',
            width: 1600,
            height: 900,
            url: `/v1/public/event-media/renditions/${renditionId('a_cover_page')}`,
          },
        ],
      },
      {
        role: 'poster',
        altText: 'Event A poster',
        focalPoint: { x: 0.4, y: 0.6 },
        renditions: [
          {
            variant: 'social',
            width: 1200,
            height: 630,
            url: `/v1/public/event-media/renditions/${renditionId('a_poster_social')}`,
          },
          {
            variant: 'thumbnail',
            width: 320,
            height: 480,
            url: `/v1/public/event-media/renditions/${renditionId('a_poster_thumbnail')}`,
          },
        ],
      },
      {
        role: 'social',
        altText: 'Event A social image',
        focalPoint: { x: 0.4, y: 0.6 },
        renditions: [
          {
            variant: 'social',
            width: 1200,
            height: 630,
            url: `/v1/public/event-media/renditions/${renditionId('a_social_social')}`,
          },
        ],
      },
    ]);
    await expect(
      loadPublicEventMedia(db, {
        eventId: eventA,
        tenantId: tenantB,
        organizationId: organizationB,
        brandId: brandB,
      }),
    ).resolves.toEqual([]);
    await expect(mediaSnapshot()).resolves.toEqual(before);
  });

  it.each([
    ['tenant', tenantB, organizationA, brandA, 'wrong_tenant'],
    ['organization', tenantA, organizationB, brandA, 'wrong_org'],
    ['brand', tenantA, organizationA, brandB, 'wrong_brand'],
  ] as const)(
    'rejects an asset mismatching only %s through the composite event scope FK without residue',
    async (_boundary, tenantId, organizationId, brandId, label) => {
      const before = await mediaSnapshot();
      const invalidAssetId = assetId(label);

      await expect(
        insertAsset({
          id: invalidAssetId,
          uploadArtifactId: uploadId(label),
          tenantId,
          organizationId,
          brandId,
          eventId: eventA,
          role: 'cover',
          altText: `Invalid ${label}`,
        }),
      ).rejects.toThrow();

      await expect(
        db.selectFrom('event_media_assets').select('id').where('id', '=', invalidAssetId).execute(),
      ).resolves.toEqual([]);
      await expect(mediaSnapshot()).resolves.toEqual(before);
    },
  );
});
