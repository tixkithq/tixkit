import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { bumpEventPublicRevision, type Database } from '@tixkit/db';
import {
  collectEventPageMediaReferences,
  normalizeEventPageDocumentV2,
  type EventPageDocumentV2,
} from '@tixkit/content-event-page';
import { ConflictError, NotFoundError, ValidationError } from '@tixkit/domain';
import {
  deleteEventMediaRendition,
  parseUploadArtifactMetadata,
  readCleanUploadArtifact,
  streamPublicUploadArtifact,
  writeEventMediaRendition,
} from './uploads.js';

export type EventMediaRole = 'poster' | 'cover' | 'social';

export type EventMediaThumbnail = {
  renditionId: string;
  role: EventMediaRole;
  variant: 'card' | 'thumbnail';
  altText: string;
  width: number;
  height: number;
  checksumSha256: string;
  url: string;
};

export const EVENT_MEDIA_RENDITION_MAX_BYTES = {
  thumbnail: 150_000,
  card: 200_000,
  page: 600_000,
  social: 400_000,
} as const;

const RENDITION_QUALITY_STEPS = [82, 76, 70, 64, 58, 52, 46, 40] as const;
const EVENT_MEDIA_CONFLICT_REFERENCE_LIMIT = 50;
const EVENT_MEDIA_CONFLICT_FIELD_MAX_LENGTH = 200;
const EVENT_MEDIA_CLEANUP_LEASE_MS = 60_000;
const EVENT_MEDIA_CLEANUP_HEARTBEAT_MS = 10_000;
const EVENT_MEDIA_RENDITION_PUT_TIMEOUT_MS = 20_000;

const PURPOSE_BY_ROLE: Record<EventMediaRole, string[]> = {
  poster: ['event_poster'],
  cover: ['event_cover'],
  social: ['event_social', 'event_seo_image'],
};

const TARGETS: Record<
  EventMediaRole,
  Array<{
    variant: 'thumbnail' | 'card' | 'page' | 'social';
    width: number;
    height: number;
  }>
> = {
  poster: [
    { variant: 'thumbnail', width: 320, height: 320 },
    { variant: 'card', width: 480, height: 270 },
    { variant: 'page', width: 1080, height: 1350 },
    { variant: 'social', width: 1200, height: 630 },
  ],
  cover: [
    { variant: 'thumbnail', width: 320, height: 320 },
    { variant: 'card', width: 480, height: 270 },
    { variant: 'page', width: 1600, height: 900 },
    { variant: 'social', width: 1200, height: 630 },
  ],
  social: [
    { variant: 'thumbnail', width: 320, height: 320 },
    { variant: 'card', width: 480, height: 270 },
    { variant: 'page', width: 1200, height: 630 },
    { variant: 'social', width: 1200, height: 630 },
  ],
};

function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

type EventPageImageSource = {
  surface: 'page' | 'social';
  path: string;
  value: string;
};

function collectEventPageImageSources(document: EventPageDocumentV2): EventPageImageSource[] {
  const sources: EventPageImageSource[] = [];
  const add = (value: unknown, surface: 'page' | 'social', path: string): void => {
    if (typeof value === 'string') sources.push({ value, surface, path });
  };
  add(
    document.editor.data.root.props.coverImageUrl,
    'page',
    'editor.data.root.props.coverImageUrl',
  );
  add(
    document.editor.data.root.props.socialImageUrl,
    'social',
    'editor.data.root.props.socialImageUrl',
  );
  add(document.settings.discovery.coverImageUrl, 'page', 'settings.discovery.coverImageUrl');
  add(document.settings.discovery.socialImageUrl, 'social', 'settings.discovery.socialImageUrl');
  const addComponent = (
    component: EventPageDocumentV2['editor']['data']['content'][number],
    path: string,
  ): void => {
    if (
      component.type !== 'EventHeader' &&
      component.type !== 'EventDescription' &&
      component.type !== 'Media'
    )
      return;
    add(component.props.imageUrl, 'page', `${path}.props.imageUrl`);
  };
  document.editor.data.content.forEach((component, index) => {
    addComponent(component, `editor.data.content.${index}`);
  });
  for (const [zoneName, components] of Object.entries(document.editor.data.zones ?? {})) {
    components.forEach((component, index) => {
      addComponent(component, `editor.data.zones.${zoneName}.${index}`);
    });
  }
  return sources;
}

function boundedConflictField(value: string): string {
  return value.slice(0, EVENT_MEDIA_CONFLICT_FIELD_MAX_LENGTH);
}

async function stageRenditionCleanup(
  db: Database,
  input: {
    tenantId: string;
    organizationId: string;
    reason: 'event-media-prewrite' | 'event-media-replaced' | 'event-media-removed';
    availableAt?: Date;
    renditions: Array<{
      bucket: string;
      object_key: string;
      checksum_sha256: string;
    }>;
  },
): Promise<EventMediaCleanupLeaseEntry[]> {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const availableAt = input.availableAt ?? now;
  const entries: EventMediaCleanupLeaseEntry[] = [];
  for (const rendition of input.renditions) {
    const identity = createHash('sha256')
      .update(
        `${input.tenantId}:${input.organizationId}:${rendition.bucket}:${rendition.object_key}:${rendition.checksum_sha256}`,
      )
      .digest('hex');
    const existing = await db
      .selectFrom('media_object_cleanup_jobs')
      .select(['id', 'tenant_id', 'organization_id', 'bucket', 'object_key', 'checksum_sha256'])
      .where((eb) =>
        eb.or([
          eb('cleanup_identity_sha256', '=', identity),
          eb.and([
            eb('bucket', '=', rendition.bucket),
            eb('object_key', '=', rendition.object_key),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (existing) {
      if (
        existing.tenant_id !== input.tenantId ||
        existing.organization_id !== input.organizationId ||
        existing.bucket !== rendition.bucket ||
        existing.object_key !== rendition.object_key ||
        existing.checksum_sha256 !== rendition.checksum_sha256
      ) {
        throw new Error('Event media cleanup identity is bound to a different object scope');
      }
      const updated = await db
        .updateTable('media_object_cleanup_jobs')
        .set({
          reason: input.reason,
          status: 'pending',
          available_at: availableAt,
          last_error: null,
          updated_at: now,
        })
        .where('id', '=', existing.id)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('bucket', '=', rendition.bucket)
        .where('object_key', '=', rendition.object_key)
        .where('checksum_sha256', '=', rendition.checksum_sha256)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new Error('Event media cleanup intent fence was lost');
      }
      entries.push({
        id: existing.id,
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        bucket: rendition.bucket,
        objectKey: rendition.object_key,
        checksumSha256: rendition.checksum_sha256,
        updatedAt: now,
      });
      continue;
    }
    await db
      .insertInto('media_object_cleanup_jobs')
      .values({
        id: `moc_${identity.slice(0, 26)}`,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        bucket: rendition.bucket,
        object_key: rendition.object_key,
        cleanup_identity_sha256: identity,
        checksum_sha256: rendition.checksum_sha256,
        reason: input.reason,
        status: 'pending',
        attempts: 0,
        available_at: availableAt,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    entries.push({
      id: `moc_${identity.slice(0, 26)}`,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      bucket: rendition.bucket,
      objectKey: rendition.object_key,
      checksumSha256: rendition.checksum_sha256,
      updatedAt: now,
    });
  }
  return entries;
}

type EventMediaCleanupLeaseEntry = {
  id: string;
  tenantId: string;
  organizationId: string;
  bucket: string;
  objectKey: string;
  checksumSha256: string;
  updatedAt: Date;
};

async function extendEventMediaCleanupLease(
  db: Database,
  entries: EventMediaCleanupLeaseEntry[],
): Promise<void> {
  for (const entry of entries) {
    const heartbeatAt = new Date(
      Math.ceil(Math.max(Date.now(), entry.updatedAt.getTime() + 1000) / 1000) * 1000,
    );
    const updated = await db
      .updateTable('media_object_cleanup_jobs')
      .set({
        available_at: new Date(heartbeatAt.getTime() + EVENT_MEDIA_CLEANUP_LEASE_MS),
        updated_at: heartbeatAt,
      })
      .where('id', '=', entry.id)
      .where('tenant_id', '=', entry.tenantId)
      .where('organization_id', '=', entry.organizationId)
      .where('bucket', '=', entry.bucket)
      .where('object_key', '=', entry.objectKey)
      .where('checksum_sha256', '=', entry.checksumSha256)
      .where('status', '=', 'pending')
      .where('updated_at', '=', entry.updatedAt)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) {
      throw new Error('Event media cleanup intent fence was lost');
    }
    entry.updatedAt = heartbeatAt;
  }
}

async function lockEventMediaCleanupLease(
  db: Database,
  entries: EventMediaCleanupLeaseEntry[],
): Promise<void> {
  for (const entry of entries) {
    const locked = await db
      .selectFrom('media_object_cleanup_jobs')
      .select('id')
      .where('id', '=', entry.id)
      .where('tenant_id', '=', entry.tenantId)
      .where('organization_id', '=', entry.organizationId)
      .where('bucket', '=', entry.bucket)
      .where('object_key', '=', entry.objectKey)
      .where('checksum_sha256', '=', entry.checksumSha256)
      .where('status', '=', 'pending')
      .where('updated_at', '=', entry.updatedAt)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw new Error('Event media cleanup intent transaction fence was lost');
  }
}

function startEventMediaCleanupLease(db: Database, entries: EventMediaCleanupLeaseEntry[]) {
  let failure: Error | undefined;
  let currentPutAbortController: AbortController | undefined;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(() => extendEventMediaCleanupLease(db, entries))
      .catch(() => {
        failure = new Error('Event media cleanup lease was lost');
        currentPutAbortController?.abort();
        clearInterval(timer);
      });
  }, EVENT_MEDIA_CLEANUP_HEARTBEAT_MS);
  timer.unref();
  return {
    assertActive(): void {
      if (failure) throw failure;
    },
    setCurrentPutAbortController(controller: AbortController | undefined): void {
      currentPutAbortController = controller;
      if (failure) controller?.abort();
    },
    async stop(): Promise<void> {
      clearInterval(timer);
      await heartbeat;
    },
  };
}

async function attemptImmediateRenditionCleanup(
  renditions: Array<{ bucket: string; object_key: string }>,
): Promise<void> {
  // The durable pre-write intents remain authoritative. This is only a best-effort latency
  // optimization, so a delete outage must neither erase recovery state nor replace the causal
  // rendering/storage/database error returned to the caller.
  await Promise.allSettled(
    renditions.map((rendition) =>
      deleteEventMediaRendition(rendition.bucket, rendition.object_key),
    ),
  );
}

async function renderAtFocalPoint(
  normalized: Buffer,
  source: { width: number; height: number },
  target: {
    variant: keyof typeof EVENT_MEDIA_RENDITION_MAX_BYTES;
    width: number;
    height: number;
  },
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
  const rendition = sharp(normalized)
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extract({ left, top, width: target.width, height: target.height });
  const maxBytes = EVENT_MEDIA_RENDITION_MAX_BYTES[target.variant];
  for (const quality of RENDITION_QUALITY_STEPS) {
    const { data, info } = await rendition
      .clone()
      .webp({ quality, effort: 5 })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= maxBytes)
      return { buffer: data, width: info.width, height: info.height };
  }
  throw new ValidationError(
    `The ${target.variant} event media rendition exceeds its ${maxBytes}-byte performance budget`,
  );
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
  afterSnapshot?: () => Promise<void>;
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
  const metadata = parseUploadArtifactMetadata(artifact.metadata) as {
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
  const normalizedImage = await sharp(buffer, {
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  })
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const normalized = normalizedImage.data;
  const normalizedWidth = normalizedImage.info.width;
  const normalizedHeight = normalizedImage.info.height;
  if (!normalizedWidth || !normalizedHeight) {
    throw new ValidationError('Event media upload has invalid normalized dimensions');
  }
  const existing = await input.db
    .selectFrom('event_media_assets')
    .select(['id', 'updated_at', 'upload_artifact_id'])
    .where('tenant_id', '=', input.tenantId)
    .where('organization_id', '=', input.organizationId)
    .where('brand_id', '=', input.brandId)
    .where('event_id', '=', input.eventId)
    .where('role', '=', input.role)
    .executeTakeFirst();
  const replacedRenditions = existing
    ? await input.db
        .selectFrom('event_media_renditions')
        .select(['id', 'bucket', 'object_key', 'checksum_sha256'])
        .where('asset_id', '=', existing.id)
        .execute()
    : [];
  await input.afterSnapshot?.();
  const assetId = existing?.id ?? id('ema');
  const renditions: Array<{
    id: string;
    asset_id: string;
    variant: 'thumbnail' | 'card' | 'page' | 'social';
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
  const preparedRenditions: Array<{ body: Buffer; rendition: (typeof renditions)[number] }> = [];
  for (const target of TARGETS[input.role]) {
    const rendered = await renderAtFocalPoint(
      normalized,
      { width: normalizedWidth, height: normalizedHeight },
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
    preparedRenditions.push({ body: rendered.buffer, rendition });
  }
  const cleanupLeaseEntries = await stageRenditionCleanup(input.db, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    reason: 'event-media-prewrite',
    availableAt: new Date(Date.now() + EVENT_MEDIA_CLEANUP_LEASE_MS),
    renditions,
  });
  const cleanupLease = startEventMediaCleanupLease(input.db, cleanupLeaseEntries);
  let committed = false;
  const attemptedRenditions: typeof renditions = [];
  try {
    for (const { body, rendition } of preparedRenditions) {
      cleanupLease.assertActive();
      attemptedRenditions.push(rendition);
      const putAbortController = new AbortController();
      cleanupLease.setCurrentPutAbortController(putAbortController);
      const putTimeout = setTimeout(
        () => putAbortController.abort(),
        EVENT_MEDIA_RENDITION_PUT_TIMEOUT_MS,
      );
      putTimeout.unref();
      try {
        try {
          await writeEventMediaRendition({
            bucket: rendition.bucket,
            objectKey: rendition.object_key,
            body,
            contentType: rendition.content_type,
            checksumSha256: rendition.checksum_sha256,
            abortSignal: putAbortController.signal,
          });
        } catch {
          if (putAbortController.signal.aborted) {
            throw new Error('Event media rendition storage deadline exceeded');
          }
          throw new Error('Event media rendition storage failed');
        }
        if (putAbortController.signal.aborted) {
          throw new Error('Event media rendition storage deadline exceeded');
        }
      } finally {
        clearTimeout(putTimeout);
        cleanupLease.setCurrentPutAbortController(undefined);
      }
      cleanupLease.assertActive();
    }
    await cleanupLease.stop();
    cleanupLease.assertActive();
    await extendEventMediaCleanupLease(input.db, cleanupLeaseEntries);
    const now = new Date();
    await input.db.transaction().execute(async (transaction) => {
      await lockEventMediaCleanupLease(transaction as typeof input.db, cleanupLeaseEntries);
      const lockedEvent = await transaction
        .selectFrom('events')
        .select('id')
        .where('id', '=', input.eventId)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('brand_id', '=', input.brandId)
        .forUpdate()
        .executeTakeFirst();
      if (!lockedEvent) throw new NotFoundError('Event', input.eventId);
      if (existing) {
        const current = await transaction
          .selectFrom('event_media_assets')
          .select(['id', 'upload_artifact_id', 'updated_at'])
          .where('id', '=', existing.id)
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('brand_id', '=', input.brandId)
          .where('event_id', '=', input.eventId)
          .where('role', '=', input.role)
          .forUpdate()
          .executeTakeFirst();
        const currentRenditions = current
          ? await transaction
              .selectFrom('event_media_renditions')
              .select(['id', 'bucket', 'object_key', 'checksum_sha256'])
              .where('asset_id', '=', current.id)
              .orderBy('id', 'asc')
              .execute()
          : [];
        const expectedIds = replacedRenditions.map((rendition) => rendition.id).sort();
        const currentIds = currentRenditions.map((rendition) => rendition.id);
        if (
          !current ||
          current.upload_artifact_id !== existing.upload_artifact_id ||
          current.updated_at.getTime() !== existing.updated_at.getTime() ||
          currentIds.length !== expectedIds.length ||
          currentIds.some((value, index) => value !== expectedIds[index])
        ) {
          throw new ValidationError('Event media changed while the replacement was being prepared');
        }
        await stageRenditionCleanup(transaction as typeof input.db, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          reason: 'event-media-replaced',
          renditions: currentRenditions,
        });
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
      await bumpEventPublicRevision(transaction, input.eventId, now);
    });
    committed = true;
  } catch (error) {
    await cleanupLease.stop();
    if (!committed) await attemptImmediateRenditionCleanup(attemptedRenditions);
    throw error;
  }
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

export async function removeEventMedia(input: {
  db: Database;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  role: EventMediaRole;
}): Promise<boolean> {
  return input.db.transaction().execute(async (transaction) => {
    const event = await transaction
      .selectFrom('events')
      .select('id')
      .where('id', '=', input.eventId)
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('brand_id', '=', input.brandId)
      .forUpdate()
      .executeTakeFirst();
    if (!event) return false;
    const asset = await transaction
      .selectFrom('event_media_assets')
      .select('id')
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('brand_id', '=', input.brandId)
      .where('event_id', '=', input.eventId)
      .where('role', '=', input.role)
      .forUpdate()
      .executeTakeFirst();
    if (!asset) return false;
    const renditions = await transaction
      .selectFrom('event_media_renditions')
      .select(['id', 'bucket', 'object_key', 'checksum_sha256'])
      .where('asset_id', '=', asset.id)
      .execute();
    const renditionUrls = new Set(
      renditions.map((rendition) => `/v1/public/event-media/renditions/${rendition.id}`),
    );
    const publishedDocuments = await transaction
      .selectFrom('content_documents as document')
      .innerJoin(
        'content_document_versions as version',
        'version.id',
        'document.published_version_id',
      )
      .select(['document.id', 'version.id as version_id', 'version.content_json'])
      .where('document.tenant_id', '=', input.tenantId)
      .where('document.organization_id', '=', input.organizationId)
      .where('document.brand_id', '=', input.brandId)
      .where('document.event_id', '=', input.eventId)
      .where('document.channel', '=', 'event_page')
      .where('document.status', '=', 'published')
      .where('version.status', '=', 'published')
      .forUpdate()
      .execute();
    const references: Array<{
      documentId: string;
      versionId: string;
      surface: string;
      path: string;
    }> = [];
    for (const document of publishedDocuments) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(document.content_json);
      } catch {
        parsed = undefined;
      }
      const normalized = normalizeEventPageDocumentV2(parsed);
      if (normalized) {
        for (const reference of collectEventPageMediaReferences(normalized)) {
          if (reference.role !== input.role) continue;
          references.push({
            documentId: boundedConflictField(document.id),
            versionId: boundedConflictField(document.version_id),
            surface: boundedConflictField(reference.surface),
            path: boundedConflictField(reference.path),
          });
        }
        for (const source of collectEventPageImageSources(normalized)) {
          if (!renditionUrls.has(source.value)) continue;
          references.push({
            documentId: boundedConflictField(document.id),
            versionId: boundedConflictField(document.version_id),
            surface: boundedConflictField(source.surface),
            path: boundedConflictField(source.path),
          });
        }
      } else {
        references.push({
          documentId: boundedConflictField(document.id),
          versionId: boundedConflictField(document.version_id),
          surface: 'unknown',
          path: 'unparseable-published-content',
        });
      }
    }
    if (references.length > 0) {
      throw new ConflictError('Event media role is referenced by published content', {
        code: 'EVENT_MEDIA_ROLE_REFERENCED',
        role: input.role,
        referenceCount: references.length,
        references: references.slice(0, EVENT_MEDIA_CONFLICT_REFERENCE_LIMIT),
      });
    }
    await stageRenditionCleanup(transaction as typeof input.db, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      reason: 'event-media-removed',
      renditions,
    });
    const deleted = await transaction
      .deleteFrom('event_media_assets')
      .where('id', '=', asset.id)
      .where('tenant_id', '=', input.tenantId)
      .executeTakeFirst();
    const removed = Number(deleted.numDeletedRows) === 1;
    if (removed) await bumpEventPublicRevision(transaction, input.eventId);
    return removed;
  });
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

const DASHBOARD_RENDITION_PRIORITY: Readonly<
  Record<'card' | 'thumbnail', Readonly<Record<EventMediaRole, number>>>
> = {
  card: { cover: 0, poster: 1, social: 2 },
  thumbnail: { cover: 3, poster: 4, social: 5 },
};

type EventMediaThumbnailRow = {
  rendition_id: string;
  width: number;
  height: number;
  checksum_sha256: string;
  event_id: string;
  role: string;
  variant: string;
  alt_text: string;
};

export function resolveEventMediaThumbnails(
  rows: EventMediaThumbnailRow[],
): Map<string, EventMediaThumbnail> {
  const result = new Map<string, EventMediaThumbnail>();
  for (const row of rows) {
    if (
      (row.role !== 'cover' && row.role !== 'poster' && row.role !== 'social') ||
      (row.variant !== 'card' && row.variant !== 'thumbnail')
    )
      continue;
    const existing = result.get(row.event_id);
    if (
      existing &&
      DASHBOARD_RENDITION_PRIORITY[existing.variant][existing.role] <=
        DASHBOARD_RENDITION_PRIORITY[row.variant][row.role]
    )
      continue;
    result.set(row.event_id, {
      renditionId: row.rendition_id,
      role: row.role,
      variant: row.variant,
      altText: row.alt_text,
      width: row.width,
      height: row.height,
      checksumSha256: row.checksum_sha256,
      url: `/v1/events/${row.event_id}/media/renditions/${row.rendition_id}`,
    });
  }
  return result;
}

/**
 * Resolves one bounded, optimized rendition per event for organizer surfaces.
 * The role order is deterministic and deliberately never falls back to an
 * original upload artifact.
 */
export async function loadEventMediaThumbnails(
  db: Database,
  input: { tenantId: string; eventIds: string[] },
): Promise<Map<string, EventMediaThumbnail>> {
  const eventIds = [...new Set(input.eventIds)];
  if (eventIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('event_media_renditions as rendition')
    .innerJoin('event_media_assets as asset', 'asset.id', 'rendition.asset_id')
    .select([
      'rendition.id as rendition_id',
      'rendition.width',
      'rendition.height',
      'rendition.checksum_sha256',
      'rendition.variant',
      'asset.event_id',
      'asset.role',
      'asset.alt_text',
    ])
    .where('asset.tenant_id', '=', input.tenantId)
    .where('asset.event_id', 'in', eventIds)
    .where('rendition.variant', 'in', ['card', 'thumbnail'])
    .execute();
  return resolveEventMediaThumbnails(rows);
}

/** Streams a rendition only after every persisted ownership dimension matches. */
export async function streamScopedEventMediaRendition(
  db: Database,
  input: {
    renditionId: string;
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId: string;
  },
) {
  const rendition = await db
    .selectFrom('event_media_renditions as rendition')
    .innerJoin('event_media_assets as asset', 'asset.id', 'rendition.asset_id')
    .select([
      'rendition.bucket',
      'rendition.object_key',
      'rendition.content_type',
      'rendition.variant',
      'rendition.checksum_sha256',
    ])
    .where('rendition.id', '=', input.renditionId)
    .where('asset.tenant_id', '=', input.tenantId)
    .where('asset.organization_id', '=', input.organizationId)
    .where('asset.brand_id', '=', input.brandId)
    .where('asset.event_id', '=', input.eventId)
    .executeTakeFirst();
  if (!rendition) throw new NotFoundError('EventMediaRendition', input.renditionId);
  return {
    ...(await streamPublicUploadArtifact({
      bucket: rendition.bucket,
      objectKey: rendition.object_key,
      contentType: rendition.content_type,
      fileName: `${input.eventId}-${rendition.variant}.webp`,
    })),
    checksumSha256: rendition.checksum_sha256,
  };
}
