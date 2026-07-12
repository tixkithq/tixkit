import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ulid } from 'ulid';
import type { Database } from '@tixkit/db';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import {
  deleteEventMediaRendition,
  readCleanUploadArtifact,
  streamPublicUploadArtifact,
  writeEventMediaRendition,
} from './uploads.js';

export type EventMediaRole = 'poster' | 'cover' | 'social';

const PURPOSE_BY_ROLE: Record<EventMediaRole, string[]> = {
  poster: ['event_poster'],
  cover: ['event_cover'],
  social: ['event_social', 'event_seo_image'],
};

const TARGETS: Record<
  EventMediaRole,
  Array<{
    variant: 'thumbnail' | 'page' | 'social';
    width: number;
    height: number;
  }>
> = {
  poster: [
    { variant: 'thumbnail', width: 320, height: 400 },
    { variant: 'page', width: 1080, height: 1350 },
    { variant: 'social', width: 1200, height: 630 },
  ],
  cover: [
    { variant: 'thumbnail', width: 480, height: 270 },
    { variant: 'page', width: 1600, height: 900 },
    { variant: 'social', width: 1200, height: 630 },
  ],
  social: [
    { variant: 'thumbnail', width: 480, height: 252 },
    { variant: 'page', width: 1200, height: 630 },
    { variant: 'social', width: 1200, height: 630 },
  ],
};

function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

async function renderAtFocalPoint(
  normalized: Buffer,
  source: { width: number; height: number },
  target: { width: number; height: number },
  focal: { x: number; y: number },
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const resizedWidth = Math.max(target.width, Math.ceil(source.width * scale));
  const resizedHeight = Math.max(target.height, Math.ceil(source.height * scale));
  const left = Math.max(
    0,
    Math.min(resizedWidth - target.width, Math.round(focal.x * resizedWidth - target.width / 2)),
  );
  const top = Math.max(
    0,
    Math.min(
      resizedHeight - target.height,
      Math.round(focal.y * resizedHeight - target.height / 2),
    ),
  );
  const { data, info } = await sharp(normalized)
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extract({ left, top, width: target.width, height: target.height })
    .webp({ quality: 82, effort: 5 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

export async function attachEventMedia(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  uploadArtifactId: string;
  role: EventMediaRole;
  altText: string;
  focalPoint: { x: number; y: number };
  createdBy: string;
}) {
  if (
    input.altText !== input.altText.trim() ||
    input.altText.length < 1 ||
    input.altText.length > 500 ||
    !Number.isFinite(input.focalPoint.x) ||
    !Number.isFinite(input.focalPoint.y) ||
    input.focalPoint.x < 0 ||
    input.focalPoint.x > 1 ||
    input.focalPoint.y < 0 ||
    input.focalPoint.y > 1
  )
    throw new ValidationError('Event media alt text or focal point is invalid');
  const event = await input.db
    .selectFrom('events')
    .select(['id', 'tenant_id', 'organization_id', 'brand_id'])
    .where('id', '=', input.eventId)
    .where('tenant_id', '=', input.tenantId)
    .where('organization_id', '=', input.organizationId)
    .where('brand_id', '=', input.brandId)
    .executeTakeFirst();
  if (!event) throw new NotFoundError('Event', input.eventId);
  const { artifact, buffer } = await readCleanUploadArtifact(input.db, input.uploadArtifactId);
  if (
    artifact.tenant_id !== input.tenantId ||
    artifact.organization_id !== input.organizationId ||
    artifact.brand_id !== input.brandId ||
    artifact.event_id !== input.eventId ||
    !PURPOSE_BY_ROLE[input.role].includes(artifact.purpose) ||
    !artifact.checksum_sha256
  )
    throw new NotFoundError('UploadArtifact', input.uploadArtifactId);
  const metadata = JSON.parse(artifact.metadata) as {
    image?: { width?: number; height?: number; format?: string };
  };
  const width = metadata.image?.width;
  const height = metadata.image?.height;
  const format = metadata.image?.format;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !width ||
    !height ||
    (format !== 'jpeg' && format !== 'png' && format !== 'webp')
  )
    throw new ValidationError('Event media upload is missing verified image metadata');
  const normalized = await sharp(buffer, {
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  })
    .rotate()
    .toBuffer();
  const existing = await input.db
    .selectFrom('event_media_assets')
    .select('id')
    .where('event_id', '=', input.eventId)
    .where('role', '=', input.role)
    .executeTakeFirst();
  const previousRenditions = existing
    ? await input.db
        .selectFrom('event_media_renditions')
        .select(['bucket', 'object_key'])
        .where('asset_id', '=', existing.id)
        .execute()
    : [];
  const assetId = existing?.id ?? id('ema');
  const renditions: Array<{
    id: string;
    asset_id: string;
    variant: 'thumbnail' | 'page' | 'social';
    width: number;
    height: number;
    format: string;
    content_type: string;
    bucket: string;
    object_key: string;
    checksum_sha256: string;
    size_bytes: number;
    created_at: Date;
  }> = [];
  try {
    for (const target of TARGETS[input.role]) {
      const rendered = await renderAtFocalPoint(
        normalized,
        { width, height },
        target,
        input.focalPoint,
      );
      const renditionId = id('emr');
      const objectKey = `event-media/${input.tenantId}/${input.eventId}/${assetId}/${renditionId}.webp`;
      const checksumSha256 = createHash('sha256').update(rendered.buffer).digest('hex');
      const rendition = {
        id: renditionId,
        asset_id: assetId,
        variant: target.variant,
        width: rendered.width,
        height: rendered.height,
        format: 'webp',
        content_type: 'image/webp',
        bucket: artifact.bucket,
        object_key: objectKey,
        checksum_sha256: checksumSha256,
        size_bytes: rendered.buffer.length,
        created_at: new Date(),
      } as const;
      renditions.push(rendition);
      await writeEventMediaRendition({
        bucket: artifact.bucket,
        objectKey,
        body: rendered.buffer,
        contentType: 'image/webp',
        checksumSha256,
      });
    }
  } catch (error) {
    await Promise.all(
      renditions.map((rendition) =>
        deleteEventMediaRendition(rendition.bucket, rendition.object_key),
      ),
    );
    throw error;
  }
  const now = new Date();
  try {
    await input.db.transaction().execute(async (transaction) => {
      if (existing) {
        await transaction
          .updateTable('event_media_assets')
          .set({
            upload_artifact_id: artifact.id,
            width,
            height,
            format,
            checksum_sha256: artifact.checksum_sha256!,
            size_bytes: artifact.size_bytes,
            focal_x: String(input.focalPoint.x),
            focal_y: String(input.focalPoint.y),
            alt_text: input.altText,
            created_by: input.createdBy,
            updated_at: now,
          })
          .where('id', '=', assetId)
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('event_id', '=', input.eventId)
          .execute();
        await transaction
          .deleteFrom('event_media_renditions')
          .where('asset_id', '=', assetId)
          .execute();
      } else {
        await transaction
          .insertInto('event_media_assets')
          .values({
            id: assetId,
            tenant_id: input.tenantId,
            organization_id: input.organizationId,
            brand_id: input.brandId,
            event_id: input.eventId,
            upload_artifact_id: artifact.id,
            role: input.role,
            width,
            height,
            format,
            checksum_sha256: artifact.checksum_sha256!,
            size_bytes: artifact.size_bytes,
            focal_x: String(input.focalPoint.x),
            focal_y: String(input.focalPoint.y),
            alt_text: input.altText,
            created_by: input.createdBy,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      await transaction.insertInto('event_media_renditions').values(renditions).execute();
    });
  } catch (error) {
    await Promise.all(
      renditions.map((rendition) =>
        deleteEventMediaRendition(rendition.bucket, rendition.object_key),
      ),
    );
    throw error;
  }
  await Promise.all(
    previousRenditions.map((rendition) =>
      deleteEventMediaRendition(rendition.bucket, rendition.object_key),
    ),
  );
  return {
    id: assetId,
    role: input.role,
    original: {
      uploadArtifactId: artifact.id,
      width,
      height,
      format,
      checksumSha256: artifact.checksum_sha256,
      sizeBytes: artifact.size_bytes,
    },
    focalPoint: input.focalPoint,
    altText: input.altText,
    renditions: renditions.map((rendition) => ({
      id: rendition.id,
      variant: rendition.variant,
      width: rendition.width,
      height: rendition.height,
      format: rendition.format,
      checksumSha256: rendition.checksum_sha256,
      sizeBytes: rendition.size_bytes,
      url: `/v1/public/event-media/renditions/${rendition.id}`,
    })),
  };
}

export async function streamEventMediaRendition(db: Database, renditionId: string) {
  const rendition = await db
    .selectFrom('event_media_renditions as rendition')
    .innerJoin('event_media_assets as asset', 'asset.id', 'rendition.asset_id')
    .innerJoin('events as event', 'event.id', 'asset.event_id')
    .select([
      'rendition.bucket',
      'rendition.object_key',
      'rendition.content_type',
      'rendition.variant',
      'rendition.checksum_sha256',
      'asset.event_id',
    ])
    .where('rendition.id', '=', renditionId)
    .where('event.status', '=', 'published')
    .where('event.visibility', '!=', 'private')
    .executeTakeFirst();
  if (!rendition) throw new NotFoundError('EventMediaRendition', renditionId);
  return {
    ...(await streamPublicUploadArtifact({
      bucket: rendition.bucket,
      objectKey: rendition.object_key,
      contentType: rendition.content_type,
      fileName: `${rendition.event_id}-${rendition.variant}.webp`,
    })),
    checksumSha256: rendition.checksum_sha256,
  };
}
