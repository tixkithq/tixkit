import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {
  parsePortableJson,
  portableManifestSha256,
  type PortableBundleManifest,
} from '@tixkit/portability';
import { ImportRepository, type Database } from '@tixkit/db';
import {
  canonicalMigrationContentFingerprint,
  MIGRATION_ENTITY_DEPENDENCY_ORDER,
  type MigrationEntityType,
  type NormalizedMigrationEntity,
} from '@tixkit/migration-core';
import type {
  MigrationCommitOutcome,
  MigrationCommitterRegistry,
  MigrationDomainCommitter,
} from './migration-repository-service.js';

const REQUIRED_ATTRIBUTES: Record<MigrationEntityType, readonly string[]> = {
  organization: ['name'],
  brand: ['name'],
  venue: ['name'],
  event: ['title', 'currency', 'timezone'],
  occurrence: ['startsAt', 'endsAt', 'timezone'],
  'inventory-pool': ['name', 'totalCapacity'],
  'ticket-type': ['name', 'currency', 'priceMinor'],
  product: ['name', 'currency', 'priceMinor'],
  question: ['label', 'type'],
  discount: ['code', 'type', 'value'],
  'access-code': ['code'],
  buyer: ['email'],
  attendee: ['email'],
  'historical-order': ['orderNumber', 'currency', 'totalMinor', 'buyerEmail'],
  ticket: ['code'],
  'historical-payment': [],
  'historical-refund': [],
  'check-in': ['occurredAt'],
};

const HISTORICAL_TYPES = new Set<MigrationEntityType>([
  'historical-order',
  'historical-payment',
  'historical-refund',
  'check-in',
]);

function assertRequiredAttributes(entity: NormalizedMigrationEntity): void {
  for (const name of REQUIRED_ATTRIBUTES[entity.entityType]) {
    const value = entity.attributes[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`MIGRATION_ATTRIBUTE_REQUIRED:${entity.entityType}:${name}`);
    }
  }
  if (
    (entity.entityType === 'historical-payment' || entity.entityType === 'historical-refund') &&
    !entity.financialSnapshot
  ) {
    throw new Error(`MIGRATION_FINANCIAL_SNAPSHOT_REQUIRED:${entity.entityType}`);
  }
}

function assertSuppressedSideEffects(
  input: Parameters<MigrationDomainCommitter['commit']>[0],
): void {
  const policy = input.sideEffects;
  if (
    policy.fulfillment !== 'suppressed' ||
    policy.notifications !== 'suppressed' ||
    policy.webhooks !== 'suppressed' ||
    policy.providerSuccessEvents !== 'suppressed' ||
    policy.financialRecords !== 'historical_snapshots_only'
  ) {
    throw new Error('MIGRATION_SIDE_EFFECT_POLICY_REJECTED');
  }
}

type DependencyIds = ReadonlyMap<MigrationEntityType, string>;

export interface MigrationMediaObjectStore {
  bucket: string;
  putVerified(input: {
    objectKey: string;
    bytes: Uint8Array;
    sha256: string;
    contentType: string;
  }): Promise<void>;
  delete(objectKey: string): Promise<void>;
}

export interface MigrationPortableAssetResolver {
  resolve(input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    portableId: string;
    sha256: string;
    bytes: number;
    mediaType: string;
  }): Promise<Uint8Array>;
}

async function s3BodyBytes(body: unknown, maximumBytes: number): Promise<Uint8Array> {
  if (!body || !(Symbol.asyncIterator in Object(body)))
    throw new Error('MIGRATION_MEDIA_OBJECT_BODY_INVALID');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const bytes = Uint8Array.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) throw new Error('MIGRATION_MEDIA_OBJECT_TOO_LARGE');
    chunks.push(bytes);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function createMigrationMediaObjectStore(
  environment: NodeJS.ProcessEnv = process.env,
  providedClient?: Pick<S3Client, 'send'>,
): MigrationMediaObjectStore {
  const bucket = environment.S3_BUCKET?.trim() ?? '';
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error('MIGRATION_MEDIA_STORAGE_CREDENTIALS_INCOMPLETE');
  const client =
    providedClient ??
    new S3Client({
      region: environment.S3_REGION?.trim() ?? 'us-east-1',
      ...(environment.S3_ENDPOINT?.trim()
        ? {
            endpoint: environment.S3_ENDPOINT.trim(),
            forcePathStyle: environment.S3_FORCE_PATH_STYLE === 'true',
          }
        : {}),
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: {
              accessKeyId,
              secretAccessKey,
            },
          }
        : {}),
    });
  return {
    bucket,
    async putVerified(input) {
      if (!bucket) throw new Error('MIGRATION_MEDIA_BUCKET_REQUIRED');
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.objectKey,
            Body: input.bytes,
            ContentType: input.contentType,
            ContentLength: input.bytes.byteLength,
            ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
            CacheControl: 'public, max-age=31536000, immutable',
            IfNoneMatch: '*',
            ServerSideEncryption: 'AES256',
          }),
        );
      } catch (error) {
        const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (candidate.name !== 'PreconditionFailed' && candidate.$metadata?.httpStatusCode !== 412)
          throw error;
        const existing = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: input.objectKey }),
        );
        const bytes = await s3BodyBytes(existing.Body, input.bytes.byteLength);
        if (
          bytes.byteLength !== input.bytes.byteLength ||
          createHash('sha256').update(bytes).digest('hex') !== input.sha256
        )
          throw new Error('MIGRATION_MEDIA_OBJECT_CONFLICT', { cause: error });
      }
    },
    async delete(objectKey) {
      if (!bucket) throw new Error('MIGRATION_MEDIA_BUCKET_REQUIRED');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    },
  };
}

async function enqueueMediaObjectCleanup(
  db: any,
  input: {
    tenantId: string;
    organizationId: string;
    bucket: string;
    objectKey: string;
    sha256: string;
    reason: string;
    availableAt?: Date;
  },
): Promise<string> {
  const cleanupIdentitySha256 = createHash('sha256')
    .update(`${input.bucket}:${input.objectKey}`)
    .digest('hex');
  const existing = await db
    .selectFrom('media_object_cleanup_jobs')
    .select('id')
    .where('cleanup_identity_sha256', '=', cleanupIdentitySha256)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('media_object_cleanup_jobs')
      .set({
        reason: input.reason,
        status: 'pending',
        available_at: input.availableAt ?? new Date(),
        last_error: null,
        updated_at: new Date(),
      })
      .where('id', '=', existing.id)
      .execute();
    return existing.id;
  }
  const now = new Date();
  await db
    .insertInto('media_object_cleanup_jobs')
    .values({
      id: `moc_${cleanupIdentitySha256.slice(0, 26)}`,
      tenant_id: input.tenantId,
      organization_id: input.organizationId,
      bucket: input.bucket,
      object_key: input.objectKey,
      cleanup_identity_sha256: cleanupIdentitySha256,
      checksum_sha256: input.sha256,
      reason: input.reason,
      status: 'pending',
      attempts: 0,
      available_at: input.availableAt ?? now,
      last_error: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return `moc_${cleanupIdentitySha256.slice(0, 26)}`;
}

export async function processMigrationMediaCleanupJobs(
  db: Database,
  store: MigrationMediaObjectStore,
  now = new Date(),
  limit = 100,
): Promise<{ completed: number; retained: number; failed: number }> {
  const jobs = await db
    .selectFrom('media_object_cleanup_jobs')
    .selectAll()
    .where((eb) =>
      eb.or([
        eb('status', '=', 'pending'),
        eb.and([
          eb('status', '=', 'processing'),
          eb('updated_at', '<', new Date(now.getTime() - 15 * 60_000)),
        ]),
      ]),
    )
    .where('available_at', '<=', now)
    .orderBy('created_at', 'asc')
    .limit(limit)
    .execute();
  let completed = 0;
  let retained = 0;
  let failed = 0;
  for (const job of jobs) {
    const claimed = await db
      .updateTable('media_object_cleanup_jobs')
      .set({ status: 'processing', updated_at: now })
      .where('id', '=', job.id)
      .where('status', '=', job.status)
      .where('updated_at', '=', job.updated_at)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) continue;
    const [uploadReference, renditionReference] = await Promise.all([
      db
        .selectFrom('upload_artifacts')
        .select('id')
        .where('bucket', '=', job.bucket)
        .where('object_key', '=', job.object_key)
        .executeTakeFirst(),
      db
        .selectFrom('event_media_renditions')
        .select('id')
        .where('bucket', '=', job.bucket)
        .where('object_key', '=', job.object_key)
        .executeTakeFirst(),
    ]);
    if (uploadReference || renditionReference) {
      await db
        .updateTable('media_object_cleanup_jobs')
        .set({ status: 'retained', updated_at: now })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .execute();
      retained += 1;
      continue;
    }
    try {
      if (store.bucket !== job.bucket) throw new Error('MIGRATION_MEDIA_CLEANUP_BUCKET_MISMATCH');
      await store.delete(job.object_key);
      await db
        .updateTable('media_object_cleanup_jobs')
        .set({ status: 'completed', attempts: job.attempts + 1, last_error: null, updated_at: now })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .execute();
      completed += 1;
    } catch (error) {
      await db
        .updateTable('media_object_cleanup_jobs')
        .set({
          status: 'pending',
          attempts: job.attempts + 1,
          last_error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          available_at: new Date(now.getTime() + Math.min(60, 2 ** job.attempts) * 60_000),
          updated_at: now,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .execute();
      failed += 1;
    }
  }
  return { completed, retained, failed };
}

export function createMigrationPortableAssetResolver(
  db: Database,
  environment: NodeJS.ProcessEnv = process.env,
  providedClient?: Pick<S3Client, 'send'>,
): MigrationPortableAssetResolver {
  const client = providedClient ?? createMigrationMediaObjectStoreClient(environment);
  return {
    async resolve(input) {
      const repository = new ImportRepository(db);
      const files = await repository.listFiles(input.tenantId, input.organizationId, input.jobId);
      if (files.length !== 1 || files[0]!.status !== 'ready')
        throw new Error('MIGRATION_PORTABLE_ASSET_BUNDLE_NOT_FOUND');
      const artifact = await db
        .selectFrom('upload_artifacts')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('purpose', '=', 'migration_import')
        .where('status', '=', 'uploaded')
        .where('scan_status', '=', 'clean')
        .where('object_key', '=', files[0]!.object_key)
        .executeTakeFirst();
      if (
        !artifact?.checksum_sha256 ||
        artifact.checksum_sha256 !== files[0]!.sha256 ||
        Number(artifact.size_bytes) !== Number(files[0]!.byte_size)
      )
        throw new Error('MIGRATION_PORTABLE_ASSET_BUNDLE_EVIDENCE_INVALID');
      const object = await client.send(
        new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.object_key }),
      );
      const transport = await s3BodyBytes(object.Body, artifact.size_bytes);
      if (
        transport.byteLength !== artifact.size_bytes ||
        createHash('sha256').update(transport).digest('hex') !== artifact.checksum_sha256
      )
        throw new Error('MIGRATION_PORTABLE_ASSET_BUNDLE_INTEGRITY_FAILED');
      const parsed = parsePortableJson(new TextDecoder('utf-8', { fatal: true }).decode(transport));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('MIGRATION_PORTABLE_ASSET_BUNDLE_INVALID');
      const bundle = parsed as {
        envelope?: { manifest?: PortableBundleManifest };
        payloads?: Record<string, unknown>;
      };
      const manifest = bundle.envelope?.manifest;
      const preflight = await repository.findPortablePreflight(
        input.tenantId,
        input.organizationId,
        input.jobId,
      );
      if (!manifest || !preflight || portableManifestSha256(manifest) !== preflight.manifest_sha256)
        throw new Error('MIGRATION_PORTABLE_ASSET_MANIFEST_EVIDENCE_INVALID');
      const asset = manifest.assets.find((candidate) => candidate.portableId === input.portableId);
      const encoded = asset && bundle.payloads?.[asset.path];
      if (
        !asset ||
        asset.sha256 !== input.sha256 ||
        asset.bytes !== input.bytes ||
        asset.mediaType !== input.mediaType ||
        typeof encoded !== 'string'
      )
        throw new Error('MIGRATION_PORTABLE_ASSET_REFERENCE_INVALID');
      const bytes = Buffer.from(encoded, 'base64');
      if (
        bytes.toString('base64') !== encoded ||
        bytes.byteLength !== input.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== input.sha256
      )
        throw new Error('MIGRATION_PORTABLE_ASSET_INTEGRITY_FAILED');
      return bytes;
    },
  };
}

function createMigrationMediaObjectStoreClient(environment: NodeJS.ProcessEnv): S3Client {
  const accessKeyId = environment.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.S3_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey))
    throw new Error('MIGRATION_MEDIA_STORAGE_CREDENTIALS_INCOMPLETE');
  return new S3Client({
    region: environment.S3_REGION?.trim() ?? 'us-east-1',
    ...(environment.S3_ENDPOINT?.trim()
      ? {
          endpoint: environment.S3_ENDPOINT.trim(),
          forcePathStyle: environment.S3_FORCE_PATH_STYLE === 'true',
        }
      : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
}

const CANONICAL_TABLE: Record<MigrationEntityType, string> = {
  organization: 'organizations',
  brand: 'brands',
  venue: 'venues',
  event: 'events',
  occurrence: 'event_occurrences',
  'inventory-pool': 'inventory_pools',
  'ticket-type': 'ticket_types',
  product: 'products',
  question: 'questions',
  discount: 'discount_codes',
  'access-code': 'access_rules',
  buyer: 'buyers',
  attendee: 'attendees',
  'historical-order': 'orders',
  ticket: 'tickets',
  'historical-payment': 'historical_financial_snapshots',
  'historical-refund': 'historical_financial_snapshots',
  'check-in': 'historical_check_ins',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function canonicalHash(
  tx: any,
  type: MigrationEntityType,
  id: string,
  lock = false,
): Promise<string | undefined> {
  let query = tx.selectFrom(CANONICAL_TABLE[type]).selectAll().where('id', '=', id);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) return undefined;
  const media =
    type === 'event'
      ? await tx
          .selectFrom('event_media_assets')
          .selectAll()
          .where('event_id', '=', id)
          .orderBy('role', 'asc')
          .execute()
      : [];
  return createHash('sha256')
    .update(
      JSON.stringify(type === 'event' ? { row, media } : row, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    .digest('hex');
}

function textAttribute(entity: NormalizedMigrationEntity, name: string, fallback = ''): string {
  const value = entity.attributes[name];
  return value === undefined || value === null ? fallback : String(value);
}

function numberAttribute(entity: NormalizedMigrationEntity, name: string, fallback = 0): number {
  const value = Number(entity.attributes[name] ?? fallback);
  if (!Number.isFinite(value))
    throw new Error(`MIGRATION_ATTRIBUTE_INVALID:${entity.entityType}:${name}`);
  return value;
}

function nullableNumberAttribute(entity: NormalizedMigrationEntity, name: string): number | null {
  const value = entity.attributes[name];
  return value === undefined || value === null ? null : numberAttribute(entity, name);
}

function booleanAttribute(
  entity: NormalizedMigrationEntity,
  name: string,
  fallback = false,
): boolean {
  const value = entity.attributes[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean')
    throw new Error(`MIGRATION_ATTRIBUTE_INVALID:${entity.entityType}:${name}`);
  return value;
}

function nullableDateAttribute(entity: NormalizedMigrationEntity, name: string): Date | null {
  const value = entity.attributes[name];
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime()))
    throw new Error(`MIGRATION_ATTRIBUTE_INVALID:${entity.entityType}:${name}`);
  return date;
}

function jsonAttribute(entity: NormalizedMigrationEntity, name: string, fallback: unknown): string {
  const value = entity.attributes[name] ?? fallback;
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    throw new Error(`MIGRATION_ATTRIBUTE_INVALID:${entity.entityType}:${name}`);
  }
}

function dependency(ids: DependencyIds, type: MigrationEntityType): string {
  const id = ids.get(type);
  if (!id) throw new Error(`MIGRATION_DEPENDENCY_REQUIRED:${type}`);
  return id;
}

async function writePortableEventMedia(
  tx: any,
  input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    id: string;
    entity: NormalizedMigrationEntity;
    now: Date;
    mediaStore: MigrationMediaObjectStore;
    assetResolver: MigrationPortableAssetResolver;
    writtenObjects: Array<{ bucket: string; objectKey: string; sha256: string }>;
    cleanupDb: Database;
    stagedCleanupIds: string[];
    sourceSystem: string;
  },
  brandId: string,
): Promise<void> {
  const value = input.entity.attributes.mediaAssets;
  if (value === undefined) return;
  if (input.sourceSystem !== 'tixkit-portable')
    throw new Error('MIGRATION_EVENT_MEDIA_SOURCE_NOT_TRUSTED');
  if (!Array.isArray(value) || value.length > 3) throw new Error('MIGRATION_EVENT_MEDIA_INVALID');
  const existingAssets = await tx
    .selectFrom('event_media_assets')
    .select(['id', 'upload_artifact_id'])
    .where('tenant_id', '=', input.tenantId)
    .where('organization_id', '=', input.organizationId)
    .where('event_id', '=', input.id)
    .execute();
  if (existingAssets.length > 0) {
    const existingUploads = await tx
      .selectFrom('upload_artifacts')
      .select(['bucket', 'object_key', 'checksum_sha256'])
      .where(
        'id',
        'in',
        existingAssets.map((asset: { upload_artifact_id: string }) => asset.upload_artifact_id),
      )
      .execute();
    for (const upload of existingUploads) {
      if (upload.checksum_sha256)
        await enqueueMediaObjectCleanup(tx, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          bucket: upload.bucket,
          objectKey: upload.object_key,
          sha256: upload.checksum_sha256,
          reason: 'portable-media-replaced',
        });
    }
    await tx
      .deleteFrom('event_media_assets')
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('event_id', '=', input.id)
      .execute();
    await tx
      .deleteFrom('upload_artifacts')
      .where(
        'id',
        'in',
        existingAssets.map((asset: { upload_artifact_id: string }) => asset.upload_artifact_id),
      )
      .execute();
  }
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('MIGRATION_EVENT_MEDIA_INVALID');
    const media = candidate as Record<string, unknown>;
    const role = String(media.role);
    const portableId = String(media.portableId);
    const sha256 = String(media.sha256);
    const mediaType = String(media.mediaType);
    const altText = String(media.altText);
    const focalPoint = media.focalPoint as { x?: unknown; y?: unknown } | undefined;
    const width = Number(media.width);
    const height = Number(media.height);
    const declaredBytes = Number(media.bytes);
    if (
      !['poster', 'cover', 'social'].includes(role) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(portableId) ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      mediaType !== 'image/webp' ||
      altText.length < 1 ||
      altText.length > 500 ||
      !Number.isSafeInteger(width) ||
      width < 1 ||
      !Number.isSafeInteger(height) ||
      height < 1 ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 1 ||
      !focalPoint ||
      typeof focalPoint.x !== 'number' ||
      focalPoint.x < 0 ||
      focalPoint.x > 1 ||
      typeof focalPoint.y !== 'number' ||
      focalPoint.y < 0 ||
      focalPoint.y > 1
    )
      throw new Error('MIGRATION_EVENT_MEDIA_INVALID');
    const bytes = await input.assetResolver.resolve({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      portableId,
      sha256,
      bytes: declaredBytes,
      mediaType,
    });
    const decoded = await sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: 40_000_000,
      sequentialRead: true,
    }).metadata();
    if (decoded.format !== 'webp' || decoded.width !== width || decoded.height !== height)
      throw new Error('MIGRATION_EVENT_MEDIA_DECODED_EVIDENCE_MISMATCH');
    const identity = createHash('sha256')
      .update(`${input.tenantId}:${portableId}`)
      .digest('hex')
      .slice(0, 26);
    const assetId = `ema_${identity}`;
    const uploadId = `upl_${identity}`;
    const renditionId = `emr_${identity}`;
    const objectKey = `event-media/${input.tenantId}/${input.id}/${assetId}/${sha256}.webp`;
    input.stagedCleanupIds.push(
      await enqueueMediaObjectCleanup(input.cleanupDb, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        bucket: input.mediaStore.bucket,
        objectKey,
        sha256,
        reason: 'portable-media-commit-staged',
        availableAt: new Date(Date.now() + 15 * 60_000),
      }),
    );
    await input.mediaStore.putVerified({
      objectKey,
      bytes,
      sha256,
      contentType: 'image/webp',
    });
    input.writtenObjects.push({
      bucket: input.mediaStore.bucket,
      objectKey,
      sha256,
    });
    await tx
      .insertInto('upload_artifacts')
      .values({
        id: uploadId,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: brandId,
        event_id: input.id,
        created_by_user_id: null,
        purpose: `event_${role}`,
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: 'Verified signed portable media asset',
        bucket: input.mediaStore.bucket,
        object_key: objectKey,
        file_name: `${role}.webp`,
        content_type: 'image/webp',
        size_bytes: bytes.byteLength,
        checksum_sha256: sha256,
        client_token_hash: null,
        metadata: JSON.stringify({ image: { width, height, format: 'webp' }, portableId }),
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        completion_owner_token: null,
        completion_started_at: null,
        expires_at: new Date('9999-12-31T23:59:59.000Z'),
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    await tx
      .insertInto('event_media_assets')
      .values({
        id: assetId,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: brandId,
        event_id: input.id,
        upload_artifact_id: uploadId,
        role,
        width,
        height,
        format: 'webp',
        checksum_sha256: sha256,
        size_bytes: bytes.byteLength,
        focal_x: String(focalPoint.x),
        focal_y: String(focalPoint.y),
        alt_text: altText,
        created_by: `migration:${input.jobId}`,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    await tx
      .insertInto('event_media_renditions')
      .values({
        id: renditionId,
        asset_id: assetId,
        variant: 'page',
        width,
        height,
        format: 'webp',
        content_type: 'image/webp',
        bucket: input.mediaStore.bucket,
        object_key: objectKey,
        checksum_sha256: sha256,
        size_bytes: bytes.byteLength,
        created_at: input.now,
      })
      .execute();
  }
}

async function verifyPortableEventMediaStorage(input: {
  tenantId: string;
  organizationId: string;
  eventId: string;
  entity: NormalizedMigrationEntity;
  sourceSystem: string;
  mediaStore: MigrationMediaObjectStore;
  assetResolver: MigrationPortableAssetResolver;
  jobId: string;
}): Promise<void> {
  const value = input.entity.attributes.mediaAssets;
  if (value === undefined) return;
  if (input.sourceSystem !== 'tixkit-portable' || !Array.isArray(value) || value.length > 3)
    throw new Error('MIGRATION_EVENT_MEDIA_SOURCE_NOT_TRUSTED');
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('MIGRATION_EVENT_MEDIA_INVALID');
    const media = candidate as Record<string, unknown>;
    const portableId = String(media.portableId);
    const sha256 = String(media.sha256);
    const mediaType = String(media.mediaType);
    const declaredBytes = Number(media.bytes);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(portableId) ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 1
    )
      throw new Error('MIGRATION_EVENT_MEDIA_INVALID');
    if (mediaType !== 'image/webp') throw new Error('MIGRATION_EVENT_MEDIA_INVALID');
    const bytes = await input.assetResolver.resolve({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      portableId,
      sha256,
      bytes: declaredBytes,
      mediaType,
    });
    const identity = createHash('sha256')
      .update(`${input.tenantId}:${portableId}`)
      .digest('hex')
      .slice(0, 26);
    await input.mediaStore.putVerified({
      objectKey: `event-media/${input.tenantId}/${input.eventId}/ema_${identity}/${sha256}.webp`,
      bytes,
      sha256,
      contentType: 'image/webp',
    });
  }
}

// Kysely cannot express a switch whose branches target unrelated tables as one generic type.
// Every branch below remains a concrete, parameterized query inside the caller's transaction.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeCanonicalEntity(
  tx: any,
  input: {
    tenantId: string;
    jobId: string;
    organizationId: string;
    id: string;
    entity: NormalizedMigrationEntity;
    dependencies: DependencyIds;
    existing: boolean;
    provenance: string;
    now: Date;
    mediaStore: MigrationMediaObjectStore;
    assetResolver: MigrationPortableAssetResolver;
    writtenObjects: Array<{ bucket: string; objectKey: string; sha256: string }>;
    cleanupDb: Database;
    stagedCleanupIds: string[];
    sourceSystem: string;
  },
): Promise<void> {
  const { entity, dependencies: deps, id, now } = input;
  const organizationId = input.organizationId;
  const updateOrInsert = async (table: string, values: Record<string, unknown>) => {
    if (input.existing) {
      let update = tx.updateTable(table).set(values).where('id', '=', id);
      if (
        new Set([
          'brands',
          'venues',
          'events',
          'buyers',
          'orders',
          'historical_financial_snapshots',
          'historical_check_ins',
        ]).has(table)
      ) {
        update = update.where('organization_id', '=', input.organizationId);
      }
      if (new Set(['venues', 'buyers', 'orders']).has(table)) {
        update = update.where('tenant_id', '=', input.tenantId);
      }
      const result = await update.executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1)
        throw new Error(`MIGRATION_CANONICAL_ENTITY_MISSING:${entity.entityType}:${id}`);
    } else {
      await tx
        .insertInto(table)
        .values({ id, ...values })
        .execute();
    }
  };

  switch (entity.entityType) {
    case 'organization':
      if (!input.existing || id !== input.organizationId) {
        throw new Error('MIGRATION_ORGANIZATION_TARGET_REQUIRED');
      }
      if (
        !(await tx
          .selectFrom('organizations')
          .select('id')
          .where('tenant_id', '=', input.tenantId)
          .where('id', '=', input.organizationId)
          .executeTakeFirst())
      )
        throw new Error('MIGRATION_ORGANIZATION_TARGET_NOT_FOUND');
      return;
    case 'brand':
      await updateOrInsert('brands', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        name: textAttribute(entity, 'name'),
        slug: textAttribute(entity, 'slug', `import-${id}`),
        status: 'draft',
        theme: jsonAttribute(entity, 'theme', {}),
        email_identity_id: null,
        sms_identity_id: null,
        payment_account_id: null,
        support_url: textAttribute(entity, 'supportUrl') || null,
        legal_urls: jsonAttribute(entity, 'legalUrls', {}),
        white_label: booleanAttribute(entity, 'whiteLabel'),
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'venue':
      await updateOrInsert('venues', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        name: textAttribute(entity, 'name'),
        address: textAttribute(entity, 'address') || null,
        timezone: textAttribute(entity, 'timezone') || null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'event':
      await updateOrInsert('events', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        brand_id: dependency(deps, 'brand'),
        venue_id: deps.get('venue') ?? null,
        slug: textAttribute(entity, 'slug', `import-${id}`),
        title: textAttribute(entity, 'title'),
        description: textAttribute(entity, 'description') || null,
        status: 'draft',
        currency: textAttribute(entity, 'currency'),
        timezone: textAttribute(entity, 'timezone'),
        starts_at: new Date(textAttribute(entity, 'startsAt', now.toISOString())),
        ends_at: nullableDateAttribute(entity, 'endsAt'),
        venue: null,
        visibility: 'private',
        seo: '{}',
        capacity: nullableNumberAttribute(entity, 'capacity'),
        minimum_age: nullableNumberAttribute(entity, 'minimumAge'),
        cover_image_url: null,
        external_url: null,
        last_setup_section: null,
        cover_image_alt: null,
        resale_max_absolute_cents: null,
        code_format:
          entity.attributes.codeFormat === undefined || entity.attributes.codeFormat === null
            ? null
            : jsonAttribute(entity, 'codeFormat', null),
        public_revision: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      await writePortableEventMedia(tx, input, dependency(deps, 'brand'));
      return;
    case 'occurrence':
      await updateOrInsert('event_occurrences', {
        event_id: dependency(deps, 'event'),
        title: textAttribute(entity, 'title', 'Imported occurrence'),
        starts_at: new Date(textAttribute(entity, 'startsAt')),
        ends_at: new Date(textAttribute(entity, 'endsAt')),
        timezone: textAttribute(entity, 'timezone'),
        venue: null,
        venue_id: deps.get('venue') ?? null,
        capacity: nullableNumberAttribute(entity, 'capacity'),
        sort_order: numberAttribute(entity, 'sortOrder'),
        status: 'cancelled',
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'inventory-pool':
      await updateOrInsert('inventory_pools', {
        event_id: dependency(deps, 'event'),
        name: textAttribute(entity, 'name'),
        total_capacity: numberAttribute(entity, 'totalCapacity'),
        hold_ttl_seconds: numberAttribute(entity, 'holdTtlSeconds', 900),
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'ticket-type':
      await updateOrInsert('ticket_types', {
        event_id: dependency(deps, 'event'),
        name: textAttribute(entity, 'name'),
        description: textAttribute(entity, 'description') || null,
        kind: textAttribute(entity, 'kind', 'paid'),
        status: 'draft',
        visibility: 'hidden',
        currency: textAttribute(entity, 'currency'),
        price_cents: numberAttribute(entity, 'priceMinor'),
        minimum_price_cents: nullableNumberAttribute(entity, 'minimumPriceMinor'),
        sales_start_at: nullableDateAttribute(entity, 'salesStartAt'),
        sales_end_at: nullableDateAttribute(entity, 'salesEndAt'),
        min_per_order: numberAttribute(entity, 'minPerOrder', 1),
        max_per_order: numberAttribute(entity, 'maxPerOrder', 10),
        inventory_pool_id: dependency(deps, 'inventory-pool'),
        sort_order: numberAttribute(entity, 'sortOrder'),
        requires_access_code: booleanAttribute(entity, 'requiresAccessCode'),
        access_code_hint: null,
        event_occurrence_id: deps.get('occurrence') ?? null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'product':
      await updateOrInsert('products', {
        event_id: dependency(deps, 'event'),
        name: textAttribute(entity, 'name'),
        description: textAttribute(entity, 'description') || null,
        price_cents: numberAttribute(entity, 'priceMinor'),
        currency: textAttribute(entity, 'currency'),
        category_id: null,
        max_per_order: numberAttribute(entity, 'maxPerOrder', 10),
        available_from: nullableDateAttribute(entity, 'availableFrom'),
        available_until: nullableDateAttribute(entity, 'availableUntil'),
        status: 'inactive',
        sort_order: numberAttribute(entity, 'sortOrder'),
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'question':
      await updateOrInsert('questions', {
        event_id: dependency(deps, 'event'),
        ticket_type_id: deps.get('ticket-type') ?? null,
        type: textAttribute(entity, 'type'),
        label: textAttribute(entity, 'label'),
        description: textAttribute(entity, 'description') || null,
        required: booleanAttribute(entity, 'required'),
        applies_to: textAttribute(entity, 'appliesTo', 'attendee'),
        options:
          entity.attributes.options === undefined || entity.attributes.options === null
            ? null
            : jsonAttribute(entity, 'options', null),
        placeholder: textAttribute(entity, 'placeholder') || null,
        validation_pattern: null,
        conditional_visibility: null,
        hidden_at: null,
        deleted_at: null,
        sort_order: numberAttribute(entity, 'sortOrder'),
        is_consent_field: booleanAttribute(entity, 'isConsentField'),
        consent_text: textAttribute(entity, 'consentText') || null,
        consent_version: textAttribute(entity, 'consentVersion') || null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'discount':
      await updateOrInsert('discount_codes', {
        event_id: dependency(deps, 'event'),
        code: textAttribute(entity, 'code'),
        type: textAttribute(entity, 'type'),
        value: numberAttribute(entity, 'value'),
        currency: textAttribute(entity, 'currency', 'USD'),
        max_uses: numberAttribute(entity, 'maxUses', 0),
        valid_from: nullableDateAttribute(entity, 'validFrom'),
        valid_until: nullableDateAttribute(entity, 'validUntil'),
        min_order_cents: nullableNumberAttribute(entity, 'minOrderMinor'),
        max_discount_cents: nullableNumberAttribute(entity, 'maxDiscountMinor'),
        ticket_type_ids: null,
        status: 'inactive',
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'access-code':
      await updateOrInsert('access_rules', {
        ticket_type_id: dependency(deps, 'ticket-type'),
        type: textAttribute(entity, 'type', 'code'),
        value: textAttribute(entity, 'code'),
        max_uses: nullableNumberAttribute(entity, 'maxUses'),
        expires_at: nullableDateAttribute(entity, 'expiresAt'),
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'buyer':
      await updateOrInsert('buyers', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        email: textAttribute(entity, 'email'),
        first_name: textAttribute(entity, 'firstName') || null,
        last_name: textAttribute(entity, 'lastName') || null,
        phone: textAttribute(entity, 'phone') || null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'attendee':
      await updateOrInsert('attendees', {
        tenant_id: input.tenantId,
        order_id: deps.get('historical-order') ?? null,
        event_id: dependency(deps, 'event'),
        event_occurrence_id: deps.get('occurrence') ?? null,
        ticket_type_id: dependency(deps, 'ticket-type'),
        ticket_id: null,
        first_name: textAttribute(entity, 'firstName') || null,
        last_name: textAttribute(entity, 'lastName') || null,
        email: textAttribute(entity, 'email'),
        phone: null,
        date_of_birth: null,
        status: 'historical',
        custom_answers: null,
        checked_in_at: null,
        check_in_device_id: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    case 'historical-order': {
      const sessionId = `ims_${id.slice(0, 28)}`;
      if (!input.existing)
        await tx
          .insertInto('checkout_sessions')
          .values({
            id: sessionId,
            tenant_id: input.tenantId,
            event_id: dependency(deps, 'event'),
            brand_id: dependency(deps, 'brand'),
            status: 'completed',
            hold_id: null,
            currency: textAttribute(entity, 'currency'),
            cart: '[]',
            buyer: JSON.stringify({
              email: textAttribute(entity, 'buyerEmail'),
            }),
            quote: '{}',
            payment_intent_id: null,
            order_id: id,
            success_url: null,
            cancel_url: null,
            expires_at: now,
            idempotency_key: `import:${input.jobId}:${entity.externalId}`,
            client_token: randomUUID(),
            created_at: now,
            updated_at: now,
          })
          .execute();
      await updateOrInsert('orders', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        brand_id: dependency(deps, 'brand'),
        event_id: dependency(deps, 'event'),
        checkout_session_id: sessionId,
        order_number: textAttribute(entity, 'orderNumber'),
        status: 'historical',
        currency: textAttribute(entity, 'currency'),
        subtotal_cents: numberAttribute(
          entity,
          'subtotalMinor',
          numberAttribute(entity, 'totalMinor'),
        ),
        discount_cents: numberAttribute(entity, 'discountMinor'),
        tax_cents: numberAttribute(entity, 'taxMinor'),
        fee_cents: numberAttribute(entity, 'feeMinor'),
        total_cents: numberAttribute(entity, 'totalMinor'),
        buyer_email: textAttribute(entity, 'buyerEmail'),
        buyer_first_name: null,
        buyer_last_name: null,
        buyer_phone: null,
        buyer_date_of_birth: null,
        payment_intent_id: null,
        payment_provider: null,
        operator_id: null,
        tender_type: null,
        paid_at: null,
        refunded_at: null,
        cancelled_at: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      await tx
        .updateTable('attendees')
        .set({ order_id: id, updated_at: now })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', deps.get('attendee') ?? '')
        .execute();
      await tx
        .updateTable('imported_domain_entities')
        .set({
          canonical_hash: await canonicalHash(tx, 'attendee', dependency(deps, 'attendee')),
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', dependency(deps, 'attendee'))
        .execute();
      return;
    }
    case 'ticket': {
      const nonRedeemableCode = `historical_${createHash('sha256')
        .update(`${input.jobId}\0${entity.externalId}`)
        .digest('hex')
        .slice(0, 39)}`;
      await updateOrInsert('tickets', {
        tenant_id: input.tenantId,
        order_id: dependency(deps, 'historical-order'),
        attendee_id: dependency(deps, 'attendee'),
        event_id: dependency(deps, 'event'),
        event_occurrence_id: deps.get('occurrence') ?? null,
        ticket_type_id: dependency(deps, 'ticket-type'),
        status: 'void',
        code: nonRedeemableCode,
        qr_payload: nonRedeemableCode,
        qr_hash: createHash('sha256').update(nonRedeemableCode).digest('hex'),
        transferred_to_email: null,
        transferred_at: null,
        checked_in_at: null,
        checked_in_by_device_id: null,
        wallet_pass_id: null,
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      await tx
        .updateTable('attendees')
        .set({ ticket_id: id, updated_at: now })
        .where('tenant_id', '=', input.tenantId)
        .where('id', '=', dependency(deps, 'attendee'))
        .execute();
      await tx
        .updateTable('imported_domain_entities')
        .set({
          canonical_hash: await canonicalHash(tx, 'attendee', dependency(deps, 'attendee')),
        })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', dependency(deps, 'attendee'))
        .execute();
      return;
    }
    case 'historical-payment':
    case 'historical-refund': {
      const snapshot = entity.financialSnapshot!;
      await updateOrInsert('historical_financial_snapshots', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        order_id: dependency(deps, 'historical-order'),
        kind: snapshot.kind,
        amount_minor: snapshot.amountMinor,
        currency: snapshot.currency,
        provider_reference: snapshot.providerReference ?? null,
        occurred_at: new Date(snapshot.occurredAt),
        provenance: JSON.stringify(snapshot.provenance),
        reconciliation_status: snapshot.reconciliationStatus,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
    }
    case 'check-in':
      await updateOrInsert('historical_check_ins', {
        tenant_id: input.tenantId,
        organization_id: organizationId,
        ticket_id: dependency(deps, 'ticket'),
        occurred_at: new Date(textAttribute(entity, 'occurredAt')),
        result: textAttribute(entity, 'result', 'accepted'),
        provenance: input.provenance,
        ...(!input.existing ? { created_at: now } : {}),
      });
      return;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deleteCanonicalEntity(
  tx: any,
  input: {
    tenantId: string;
    organizationId: string;
    id: string;
    type: MigrationEntityType;
  },
): Promise<boolean> {
  const table: Record<MigrationEntityType, string> = {
    organization: 'organizations',
    brand: 'brands',
    venue: 'venues',
    event: 'events',
    occurrence: 'event_occurrences',
    'inventory-pool': 'inventory_pools',
    'ticket-type': 'ticket_types',
    product: 'products',
    question: 'questions',
    discount: 'discount_codes',
    'access-code': 'access_rules',
    buyer: 'buyers',
    attendee: 'attendees',
    'historical-order': 'orders',
    ticket: 'tickets',
    'historical-payment': 'historical_financial_snapshots',
    'historical-refund': 'historical_financial_snapshots',
    'check-in': 'historical_check_ins',
  };
  if (input.type === 'event') {
    const media = await tx
      .selectFrom('event_media_assets')
      .select('upload_artifact_id')
      .where('tenant_id', '=', input.tenantId)
      .where('event_id', '=', input.id)
      .execute();
    const mediaObjects =
      media.length > 0
        ? await tx
            .selectFrom('upload_artifacts')
            .select(['bucket', 'object_key', 'checksum_sha256'])
            .where(
              'id',
              'in',
              media.map((asset: { upload_artifact_id: string }) => asset.upload_artifact_id),
            )
            .execute()
        : [];
    for (const object of mediaObjects) {
      if (object.checksum_sha256)
        await enqueueMediaObjectCleanup(tx, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          bucket: object.bucket,
          objectKey: object.object_key,
          sha256: object.checksum_sha256,
          reason: 'portable-media-rollback',
        });
    }
    await tx
      .deleteFrom('event_media_assets')
      .where('tenant_id', '=', input.tenantId)
      .where('event_id', '=', input.id)
      .execute();
    if (media.length > 0)
      await tx
        .deleteFrom('upload_artifacts')
        .where(
          'id',
          'in',
          media.map((asset: { upload_artifact_id: string }) => asset.upload_artifact_id),
        )
        .execute();
  }
  if (input.type === 'ticket') {
    await tx
      .updateTable('attendees')
      .set({ ticket_id: null })
      .where('tenant_id', '=', input.tenantId)
      .where('ticket_id', '=', input.id)
      .execute();
  }
  if (input.type === 'historical-order') {
    await tx
      .updateTable('attendees')
      .set({ order_id: null })
      .where('tenant_id', '=', input.tenantId)
      .where('order_id', '=', input.id)
      .execute();
  }
  let deletion = tx.deleteFrom(table[input.type]).where('id', '=', input.id);
  if (
    new Set<MigrationEntityType>([
      'brand',
      'venue',
      'event',
      'buyer',
      'historical-order',
      'historical-payment',
      'historical-refund',
      'check-in',
    ]).has(input.type)
  ) {
    deletion = deletion.where('organization_id', '=', input.organizationId);
  }
  if (
    new Set<MigrationEntityType>(['venue', 'buyer', 'historical-order', 'ticket']).has(input.type)
  ) {
    deletion = deletion.where('tenant_id', '=', input.tenantId);
  }
  const result = await deletion.executeTakeFirst();
  if (Number(result.numDeletedRows) !== 1) return false;
  if (input.type === 'historical-order') {
    await tx
      .deleteFrom('checkout_sessions')
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', `ims_${input.id.slice(0, 28)}`)
      .execute();
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function hasAuthoritativeRollbackBlocker(
  tx: any,
  input: {
    tenantId: string;
    jobId: string;
    id: string;
    type: MigrationEntityType;
    canonicalHash: string;
  },
): Promise<boolean> {
  const count = async (table: string, column: string) =>
    Number(
      (
        await tx
          .selectFrom(table)
          .select(({ fn }: any) => fn.countAll().as('count'))
          .where(column, '=', input.id)
          .executeTakeFirstOrThrow()
      ).count,
    ) > 0;
  const hasExternalRows = async (table: string, column: string) => {
    const rows = await tx.selectFrom(table).select(['id']).where(column, '=', input.id).execute();
    if (rows.length === 0) return false;
    const imported = await tx
      .selectFrom('imported_domain_entities')
      .select(['id'])
      .where('tenant_id', '=', input.tenantId)
      .where('created_by_import_job_id', '=', input.jobId)
      .where(
        'id',
        'in',
        rows.map((row: { id: string }) => row.id),
      )
      .execute();
    const importedIds = new Set(imported.map((row: { id: string }) => row.id));
    return rows.some((row: { id: string }) => !importedIds.has(row.id));
  };
  if ((await canonicalHash(tx, input.type, input.id, true)) !== input.canonicalHash) return true;
  if (input.type === 'event' && (await hasExternalRows('orders', 'event_id'))) return true;
  if (input.type === 'ticket-type' && (await count('order_line_items', 'ticket_type_id')))
    return true;
  if (input.type === 'product' && (await count('order_line_items', 'product_id'))) return true;
  if (input.type === 'ticket') {
    const ticket = await tx
      .selectFrom('tickets')
      .select(['transferred_at', 'checked_in_at', 'updated_at'])
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!ticket || ticket.transferred_at || ticket.checked_in_at) return true;
    if ((await count('scan_logs', 'ticket_id')) || (await count('ticket_listings', 'ticket_id')))
      return true;
  }
  if (
    input.type === 'historical-order' &&
    ((await count('payment_intents', 'order_id')) ||
      (await count('refunds', 'order_id')) ||
      (await count('order_timeline_events', 'order_id')))
  )
    return true;
  if (input.type === 'attendee') {
    const attendee = await tx
      .selectFrom('attendees')
      .select(['updated_at', 'checked_in_at'])
      .where('tenant_id', '=', input.tenantId)
      .where('id', '=', input.id)
      .forUpdate()
      .executeTakeFirst();
    if (!attendee || attendee.checked_in_at) return true;
  }
  return false;
}

class ProductionMigrationCommitter implements MigrationDomainCommitter {
  constructor(
    private readonly db: Database,
    private readonly entityType: MigrationEntityType,
    private readonly mediaStore: MigrationMediaObjectStore,
    private readonly assetResolver: MigrationPortableAssetResolver,
  ) {}

  async assessUntouched(input: Parameters<MigrationDomainCommitter['assessUntouched']>[0]) {
    return this.db.transaction().execute(async (transaction) => {
      const entity = await transaction
        .selectFrom('imported_domain_entities')
        .select(['created_by_import_job_id', 'canonical_hash'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.tixkitId)
        .where('entity_type', '=', this.entityType)
        .executeTakeFirst();
      if (!entity || entity.created_by_import_job_id !== input.jobId)
        return {
          eligible: false,
          reason: 'Import provenance does not own canonical entity',
        };
      const evidence = await transaction
        .selectFrom('import_job_rows')
        .select(['domain_activity_at', 'rollback_blocked_reason'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('entity_type', '=', this.entityType)
        .where('tixkit_id', '=', input.tixkitId)
        .executeTakeFirst();
      if (!evidence || evidence.domain_activity_at || evidence.rollback_blocked_reason) {
        return {
          eligible: false,
          reason: evidence?.rollback_blocked_reason ?? 'Domain activity recorded after import',
        };
      }
      if (
        await hasAuthoritativeRollbackBlocker(transaction, {
          tenantId: input.tenantId,
          jobId: input.jobId,
          id: input.tixkitId,
          type: this.entityType,
          canonicalHash: entity.canonical_hash,
        })
      ) {
        return {
          eligible: false,
          reason: 'Authoritative domain activity or canonical edit detected',
        };
      }
      return { eligible: true };
    });
  }

  async commit(
    input: Parameters<MigrationDomainCommitter['commit']>[0],
  ): Promise<MigrationCommitOutcome> {
    if (input.entity.entityType !== this.entityType)
      throw new Error('MIGRATION_COMMITTER_TYPE_MISMATCH');
    assertRequiredAttributes(input.entity);
    assertSuppressedSideEffects(input);

    const writtenObjects: Array<{ bucket: string; objectKey: string; sha256: string }> = [];
    const stagedCleanupIds: string[] = [];
    try {
      const outcome: MigrationCommitOutcome = await this.db
        .transaction()
        .execute(async (transaction) => {
          const job = await transaction
            .selectFrom('import_jobs')
            .select(['source_system'])
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('id', '=', input.jobId)
            .executeTakeFirst();
          if (!job) throw new Error('MIGRATION_JOB_NOT_FOUND');

          const dependencies = new Map<MigrationEntityType, string>();
          for (const dependency of input.entity.dependencies ?? []) {
            const reference = await transaction
              .selectFrom('external_references')
              .select(['tixkit_id'])
              .where('tenant_id', '=', input.tenantId)
              .where('organization_id', '=', input.organizationId)
              .where('source_system', '=', job.source_system)
              .where('entity_type', '=', dependency.entityType)
              .where('external_id', '=', dependency.externalId)
              .executeTakeFirst();
            if (!reference) {
              throw new Error(
                `MIGRATION_DEPENDENCY_UNRESOLVED:${dependency.entityType}:${dependency.externalId}`,
              );
            }
            dependencies.set(dependency.entityType, reference.tixkit_id);
          }

          const existingReference = await transaction
            .selectFrom('external_references')
            .select(['tixkit_id'])
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .where('source_system', '=', job.source_system)
            .where('entity_type', '=', this.entityType)
            .where('external_id', '=', input.entity.externalId)
            .executeTakeFirst();
          let existing = existingReference
            ? await transaction
                .selectFrom('imported_domain_entities')
                .selectAll()
                .where('tenant_id', '=', input.tenantId)
                .where('organization_id', '=', input.organizationId)
                .where('id', '=', existingReference.tixkit_id)
                .executeTakeFirst()
            : await transaction
                .selectFrom('imported_domain_entities')
                .selectAll()
                .where('tenant_id', '=', input.tenantId)
                .where('organization_id', '=', input.organizationId)
                .where('source_system', '=', job.source_system)
                .where('entity_type', '=', this.entityType)
                .where('source_external_id', '=', input.entity.externalId)
                .executeTakeFirst();
          if (!existing && this.entityType === 'organization') {
            existing = await transaction
              .selectFrom('imported_domain_entities')
              .selectAll()
              .where('tenant_id', '=', input.tenantId)
              .where('organization_id', '=', input.organizationId)
              .where('id', '=', input.organizationId)
              .where('entity_type', '=', 'organization')
              .executeTakeFirst();
          }
          const attributes = JSON.stringify(input.entity.attributes);
          const snapshot = input.entity.financialSnapshot
            ? JSON.stringify(input.entity.financialSnapshot)
            : null;
          const provenance = JSON.stringify({
            sourceSystem: job.source_system,
            sourceExternalId: input.entity.externalId,
            sourcePosition: input.entity.sourcePosition,
            importJobId: input.jobId,
          });
          const now = new Date();
          const id =
            existing?.id ??
            (this.entityType === 'organization'
              ? input.organizationId
              : randomUUID().replaceAll('-', ''));
          const unchanged =
            Boolean(existing) &&
            canonicalMigrationContentFingerprint({
              attributes: JSON.parse(existing!.attributes) as Record<string, unknown>,
              financialSnapshot: existing!.financial_snapshot
                ? (JSON.parse(
                    existing!.financial_snapshot,
                  ) as NormalizedMigrationEntity['financialSnapshot'])
                : undefined,
            }) === canonicalMigrationContentFingerprint(input.entity);
          const canonicalExisting = Boolean(existing) || this.entityType === 'organization';

          if (existing && unchanged) {
            if (this.entityType === 'event')
              await verifyPortableEventMediaStorage({
                tenantId: input.tenantId,
                organizationId: input.organizationId,
                eventId: id,
                jobId: input.jobId,
                entity: input.entity,
                sourceSystem: job.source_system,
                mediaStore: this.mediaStore,
                assetResolver: this.assetResolver,
              });
            await transaction
              .updateTable('imported_domain_entities')
              .set({ last_seen_import_job_id: input.jobId })
              .where('tenant_id', '=', input.tenantId)
              .where('organization_id', '=', input.organizationId)
              .where('id', '=', id)
              .execute();
            return { disposition: 'skipped', tixkitId: id };
          }
          if (
            existing &&
            (this.entityType === 'historical-payment' || this.entityType === 'historical-refund')
          ) {
            return { disposition: 'conflict', tixkitId: id };
          }

          await writeCanonicalEntity(transaction, {
            tenantId: input.tenantId,
            organizationId: input.organizationId,
            jobId: input.jobId,
            id,
            entity: input.entity,
            dependencies,
            existing: canonicalExisting,
            provenance,
            now,
            mediaStore: this.mediaStore,
            assetResolver: this.assetResolver,
            writtenObjects,
            cleanupDb: this.db,
            stagedCleanupIds,
            sourceSystem: job.source_system,
          });
          const persistedCanonicalHash = await canonicalHash(transaction, this.entityType, id);
          if (!persistedCanonicalHash)
            throw new Error(`MIGRATION_CANONICAL_ENTITY_MISSING:${this.entityType}:${id}`);

          if (existing) {
            await transaction
              .updateTable('imported_domain_entities')
              .set({
                attributes,
                financial_snapshot: snapshot,
                source_provenance: provenance,
                canonical_hash: persistedCanonicalHash,
                last_seen_import_job_id: input.jobId,
                updated_at: now,
              })
              .where('tenant_id', '=', input.tenantId)
              .where('organization_id', '=', input.organizationId)
              .where('id', '=', id)
              .execute();
            await transaction
              .deleteFrom('imported_entity_dependencies')
              .where('tenant_id', '=', input.tenantId)
              .where('organization_id', '=', input.organizationId)
              .where('entity_id', '=', id)
              .execute();
          } else {
            await transaction
              .insertInto('imported_domain_entities')
              .values({
                id,
                tenant_id: input.tenantId,
                organization_id: input.organizationId,
                created_by_import_job_id: input.jobId,
                last_seen_import_job_id: input.jobId,
                source_system: job.source_system,
                entity_type: this.entityType,
                source_external_id: input.entity.externalId,
                attributes,
                financial_snapshot: snapshot,
                source_provenance: provenance,
                canonical_hash: persistedCanonicalHash,
                side_effects_suppressed: HISTORICAL_TYPES.has(this.entityType),
                created_at: now,
                updated_at: now,
              })
              .execute();
          }
          if (dependencies.size > 0) {
            const dependencyIds = [...new Set(dependencies.values())];
            const importedDependencies = await transaction
              .selectFrom('imported_domain_entities')
              .select('id')
              .where('tenant_id', '=', input.tenantId)
              .where('organization_id', '=', input.organizationId)
              .where('id', 'in', dependencyIds)
              .execute();
            if (importedDependencies.length > 0)
              await transaction
                .insertInto('imported_entity_dependencies')
                .values(
                  importedDependencies.map(({ id: dependsOnId }) => ({
                    tenant_id: input.tenantId,
                    organization_id: input.organizationId,
                    entity_id: id,
                    depends_on_entity_id: dependsOnId,
                    created_at: now,
                  })),
                )
                .execute();
          }
          return {
            disposition: canonicalExisting
              ? existing && unchanged
                ? 'skipped'
                : 'updated'
              : 'created',
            tixkitId: id,
          };
        });
      if (stagedCleanupIds.length > 0)
        await this.db
          .updateTable('media_object_cleanup_jobs')
          .set({ status: 'retained', updated_at: new Date() })
          .where('id', 'in', stagedCleanupIds)
          .where('status', '=', 'pending')
          .execute();
      return outcome;
    } catch (error) {
      for (const object of writtenObjects) {
        const cleanupId = await enqueueMediaObjectCleanup(this.db, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          bucket: object.bucket,
          objectKey: object.objectKey,
          sha256: object.sha256,
          reason: 'portable-media-commit-failed',
        });
        if (!stagedCleanupIds.includes(cleanupId)) stagedCleanupIds.push(cleanupId);
      }
      throw error;
    }
  }

  async deleteUntouched(
    input: Parameters<MigrationDomainCommitter['deleteUntouched']>[0],
  ): Promise<boolean> {
    return this.db.transaction().execute(async (transaction) => {
      const entity = await transaction
        .selectFrom('imported_domain_entities')
        .select(['id', 'created_by_import_job_id', 'canonical_hash'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.tixkitId)
        .where('entity_type', '=', this.entityType)
        .forUpdate()
        .executeTakeFirst();
      if (!entity || entity.created_by_import_job_id !== input.jobId) return false;
      const evidence = await transaction
        .selectFrom('import_job_rows')
        .select(['domain_activity_at', 'rollback_blocked_reason'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('entity_type', '=', this.entityType)
        .where('tixkit_id', '=', input.tixkitId)
        .executeTakeFirst();
      if (!evidence || evidence.domain_activity_at || evidence.rollback_blocked_reason)
        return false;
      if (
        await hasAuthoritativeRollbackBlocker(transaction, {
          tenantId: input.tenantId,
          jobId: input.jobId,
          id: input.tixkitId,
          type: this.entityType,
          canonicalHash: entity.canonical_hash,
        })
      )
        return false;
      const dependent = await transaction
        .selectFrom('imported_entity_dependencies')
        .select(['entity_id'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('depends_on_entity_id', '=', input.tixkitId)
        .executeTakeFirst();
      if (dependent) return false;
      await transaction
        .deleteFrom('imported_entity_dependencies')
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('entity_id', '=', input.tixkitId)
        .execute();
      if (
        !(await deleteCanonicalEntity(transaction, {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          id: input.tixkitId,
          type: this.entityType,
        }))
      )
        return false;
      await transaction
        .deleteFrom('external_references')
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('entity_type', '=', this.entityType)
        .where('tixkit_id', '=', input.tixkitId)
        .where('created_by_import_job_id', '=', input.jobId)
        .execute();
      const rowResult = await transaction
        .updateTable('import_job_rows')
        .set({ status: 'rolled-back', updated_at: new Date() })
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('import_job_id', '=', input.jobId)
        .where('entity_type', '=', this.entityType)
        .where('tixkit_id', '=', input.tixkitId)
        .where('status', '=', 'created')
        .executeTakeFirst();
      if (Number(rowResult.numUpdatedRows) !== 1) return false;
      const result = await transaction
        .deleteFrom('imported_domain_entities')
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.tixkitId)
        .where('created_by_import_job_id', '=', input.jobId)
        .executeTakeFirst();
      return Number(result.numDeletedRows) === 1;
    });
  }
}

export function createProductionMigrationCommitters(
  db: Database,
  mediaStore: MigrationMediaObjectStore = createMigrationMediaObjectStore(),
  assetResolver: MigrationPortableAssetResolver = createMigrationPortableAssetResolver(db),
): MigrationCommitterRegistry {
  return new Map(
    MIGRATION_ENTITY_DEPENDENCY_ORDER.map((type) => [
      type,
      new ProductionMigrationCommitter(db, type, mediaStore, assetResolver),
    ]),
  );
}
