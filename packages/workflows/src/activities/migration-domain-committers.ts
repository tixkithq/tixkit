import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {
  canonicalPortableJson,
  parsePortableJson,
  portableImportControlInputSha256,
  portableManifestSha256,
  validatePortableContentDocument,
  type PortableBundleManifest,
} from '@tixkit/portability';
import { ImportRepository, sql, type Database } from '@tixkit/db';
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
  'content-document': ['channel', 'key', 'name', 'locale', 'versions'],
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

const PORTABLE_MEDIA_TARGETS = {
  poster: [
    { variant: 'thumbnail', width: 320, height: 320, maxBytes: 150_000 },
    { variant: 'card', width: 480, height: 270, maxBytes: 200_000 },
    { variant: 'page', width: 1080, height: 1350, maxBytes: 600_000 },
    { variant: 'social', width: 1200, height: 630, maxBytes: 400_000 },
  ],
  cover: [
    { variant: 'thumbnail', width: 320, height: 320, maxBytes: 150_000 },
    { variant: 'card', width: 480, height: 270, maxBytes: 200_000 },
    { variant: 'page', width: 1600, height: 900, maxBytes: 600_000 },
    { variant: 'social', width: 1200, height: 630, maxBytes: 400_000 },
  ],
  social: [
    { variant: 'thumbnail', width: 320, height: 320, maxBytes: 150_000 },
    { variant: 'card', width: 480, height: 270, maxBytes: 200_000 },
    { variant: 'page', width: 1200, height: 630, maxBytes: 600_000 },
    { variant: 'social', width: 1200, height: 630, maxBytes: 400_000 },
  ],
} as const;

async function renderPortableMediaRendition(
  bytes: Uint8Array,
  source: { width: number; height: number },
  target: { width: number; height: number; maxBytes: number },
  focalPoint: { x: number; y: number },
): Promise<Buffer> {
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const resizedWidth = Math.max(target.width, Math.ceil(source.width * scale));
  const resizedHeight = Math.max(target.height, Math.ceil(source.height * scale));
  const left = Math.max(
    0,
    Math.min(
      resizedWidth - target.width,
      Math.round(focalPoint.x * resizedWidth - target.width / 2),
    ),
  );
  const top = Math.max(
    0,
    Math.min(
      resizedHeight - target.height,
      Math.round(focalPoint.y * resizedHeight - target.height / 2),
    ),
  );
  const pipeline = sharp(bytes)
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extract({ left, top, width: target.width, height: target.height });
  for (const quality of [82, 76, 70, 64, 58, 52, 46, 40]) {
    const rendered = await pipeline.clone().webp({ quality, effort: 5 }).toBuffer();
    if (rendered.byteLength <= target.maxBytes) return rendered;
  }
  throw new Error('MIGRATION_EVENT_MEDIA_RENDITION_BUDGET_EXCEEDED');
}

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
  verify(input: { objectKey: string; bytes: number; sha256: string }): Promise<void>;
  delete(objectKey: string, abortSignal: AbortSignal): Promise<void>;
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
        const candidate = error as {
          name?: string;
          $metadata?: { httpStatusCode?: number };
        };
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
    async verify(input) {
      if (!bucket) throw new Error('MIGRATION_MEDIA_BUCKET_REQUIRED');
      const existing = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: input.objectKey }),
      );
      const bytes = await s3BodyBytes(existing.Body, input.bytes);
      if (
        bytes.byteLength !== input.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== input.sha256
      )
        throw new Error('MIGRATION_MEDIA_OBJECT_INTEGRITY_FAILED');
    },
    async delete(objectKey, abortSignal) {
      if (!bucket) throw new Error('MIGRATION_MEDIA_BUCKET_REQUIRED');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }), {
        abortSignal,
      });
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
  options: { deleteTimeoutMs?: number } = {},
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
    const claimToken = new Date(
      Math.ceil(Math.max(now.getTime(), job.updated_at.getTime() + 1000) / 1000) * 1000,
    );
    const resultToken = new Date(claimToken.getTime() + 1000);
    const claimed = await db
      .updateTable('media_object_cleanup_jobs')
      .set({ status: 'processing', updated_at: claimToken })
      .where('id', '=', job.id)
      .where('status', '=', job.status)
      .where('updated_at', '=', job.updated_at)
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) !== 1) continue;
    const [uploadReference, renditionReference] = await Promise.all([
      db
        .selectFrom('upload_artifacts')
        .select(['id', 'checksum_sha256'])
        .where('bucket', '=', job.bucket)
        .where('object_key', '=', job.object_key)
        .executeTakeFirst(),
      db
        .selectFrom('event_media_renditions')
        .select(['id', 'checksum_sha256'])
        .where('bucket', '=', job.bucket)
        .where('object_key', '=', job.object_key)
        .executeTakeFirst(),
    ]);
    if (
      uploadReference?.checksum_sha256 === job.checksum_sha256 ||
      renditionReference?.checksum_sha256 === job.checksum_sha256
    ) {
      const retainedResult = await db
        .updateTable('media_object_cleanup_jobs')
        .set({ status: 'retained', updated_at: resultToken })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .where('updated_at', '=', claimToken)
        .executeTakeFirst();
      if (Number(retainedResult.numUpdatedRows) === 1) retained += 1;
      continue;
    }
    if (uploadReference || renditionReference) {
      const mismatchResult = await db
        .updateTable('media_object_cleanup_jobs')
        .set({
          status: 'pending',
          attempts: job.attempts + 1,
          last_error: 'cleanup_reference_checksum_mismatch',
          available_at: new Date(now.getTime() + Math.min(60, 2 ** job.attempts) * 60_000),
          updated_at: resultToken,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .where('updated_at', '=', claimToken)
        .executeTakeFirst();
      if (Number(mismatchResult.numUpdatedRows) === 1) failed += 1;
      continue;
    }
    try {
      if (store.bucket !== job.bucket) throw new Error('MIGRATION_MEDIA_CLEANUP_BUCKET_MISMATCH');
      const deleteTimeoutMs = options.deleteTimeoutMs ?? 20_000;
      const deleteAbortController = new AbortController();
      let deleteTimedOut = false;
      const deleteTimeout = setTimeout(() => {
        deleteTimedOut = true;
        deleteAbortController.abort();
      }, deleteTimeoutMs);
      deleteTimeout.unref();
      try {
        await store.delete(job.object_key, deleteAbortController.signal);
        if (deleteTimedOut) throw new Error('MIGRATION_MEDIA_CLEANUP_DELETE_TIMEOUT');
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- provider abort errors can contain request identifiers and must not escape the redaction boundary.
        if (deleteTimedOut) throw new Error('MIGRATION_MEDIA_CLEANUP_DELETE_TIMEOUT');
        throw error;
      } finally {
        clearTimeout(deleteTimeout);
      }
      const completedResult = await db
        .updateTable('media_object_cleanup_jobs')
        .set({
          status: 'completed',
          attempts: job.attempts + 1,
          last_error: null,
          updated_at: resultToken,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .where('updated_at', '=', claimToken)
        .executeTakeFirst();
      if (Number(completedResult.numUpdatedRows) === 1) completed += 1;
    } catch (error) {
      const lastError =
        error instanceof Error && error.message === 'MIGRATION_MEDIA_CLEANUP_BUCKET_MISMATCH'
          ? 'cleanup_bucket_mismatch'
          : error instanceof Error && error.message === 'MIGRATION_MEDIA_CLEANUP_DELETE_TIMEOUT'
            ? 'cleanup_delete_timeout'
            : 'cleanup_delete_failed';
      const retryResult = await db
        .updateTable('media_object_cleanup_jobs')
        .set({
          status: 'pending',
          attempts: job.attempts + 1,
          last_error: lastError,
          available_at: new Date(now.getTime() + Math.min(60, 2 ** job.attempts) * 60_000),
          updated_at: resultToken,
        })
        .where('id', '=', job.id)
        .where('status', '=', 'processing')
        .where('updated_at', '=', claimToken)
        .executeTakeFirst();
      if (Number(retryResult.numUpdatedRows) === 1) failed += 1;
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
        Number(artifact.size_bytes) !== Number(files[0]!.byte_size) ||
        artifact.content_type !== files[0]!.media_type
      )
        throw new Error('MIGRATION_PORTABLE_ASSET_BUNDLE_EVIDENCE_INVALID');
      const object = await client.send(
        new GetObjectCommand({
          Bucket: artifact.bucket,
          Key: artifact.object_key,
        }),
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
  'content-document': 'content_documents',
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
          .selectFrom('event_media_assets as asset')
          .innerJoin('upload_artifacts as upload', 'upload.id', 'asset.upload_artifact_id')
          .selectAll('asset')
          .select([
            'upload.bucket as upload_bucket',
            'upload.object_key as upload_object_key',
            'upload.checksum_sha256 as upload_checksum_sha256',
            'upload.size_bytes as upload_size_bytes',
            'upload.metadata as upload_metadata',
          ])
          .where('asset.event_id', '=', id)
          .orderBy('asset.role', 'asc')
          .execute()
      : [];
  const renditions =
    type === 'event' && media.length > 0
      ? await tx
          .selectFrom('event_media_renditions')
          .selectAll()
          .where(
            'asset_id',
            'in',
            media.map(({ id: assetId }: { id: string }) => assetId),
          )
          .orderBy('asset_id', 'asc')
          .orderBy('variant', 'asc')
          .execute()
      : [];
  const contentVersions =
    type === 'content-document'
      ? await tx
          .selectFrom('content_document_versions')
          .selectAll()
          .where('document_id', '=', id)
          .orderBy('version_number', 'asc')
          .execute()
      : [];
  return createHash('sha256')
    .update(
      JSON.stringify(
        type === 'event'
          ? { row, media, renditions }
          : type === 'content-document'
            ? { row, versions: contentVersions }
            : row,
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
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

function storedJsonMatches(value: unknown, expected: string): boolean {
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value) === expected;
  } catch {
    return false;
  }
}

function storedBooleanMatches(value: unknown, expected: boolean): boolean {
  return value === expected || value === (expected ? 1 : 0);
}

type PortableContentVersion = {
  portableId: string;
  versionNumber: number;
  schemaVersion: number;
  subject: string | null;
  previewText: string | null;
  contentJson: unknown;
  variables: unknown;
  validation: unknown;
  createdAt: string;
};

function portableContentVersions(
  entity: NormalizedMigrationEntity,
  channel: string,
): PortableContentVersion[] {
  const value = entity.attributes.versions;
  if (!Array.isArray(value))
    throw new Error('MIGRATION_ATTRIBUTE_INVALID:content-document:versions');
  const seenIds = new Set<string>();
  const seenNumbers = new Set<number>();
  const versions = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error('MIGRATION_ATTRIBUTE_INVALID:content-document:versions');
    const version = candidate as Record<string, unknown>;
    const allowedKeys = new Set([
      'portableId',
      'versionNumber',
      'schemaVersion',
      'subject',
      'previewText',
      'contentJson',
      'variables',
      'validation',
      'createdAt',
    ]);
    const portableId = typeof version.portableId === 'string' ? version.portableId.trim() : '';
    const versionNumber = Number(version.versionNumber);
    const schemaVersion = Number(version.schemaVersion);
    const createdAt = typeof version.createdAt === 'string' ? version.createdAt : '';
    if (
      !portableId ||
      !Number.isSafeInteger(versionNumber) ||
      versionNumber < 1 ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1 ||
      Object.keys(version).some((key) => !allowedKeys.has(key)) ||
      !Object.hasOwn(version, 'contentJson') ||
      !validatePortableContentDocument(channel, version.contentJson) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      seenIds.has(portableId) ||
      seenNumbers.has(versionNumber)
    )
      throw new Error('MIGRATION_ATTRIBUTE_INVALID:content-document:versions');
    seenIds.add(portableId);
    seenNumbers.add(versionNumber);
    return {
      portableId,
      versionNumber,
      schemaVersion,
      subject: typeof version.subject === 'string' ? version.subject : null,
      previewText: typeof version.previewText === 'string' ? version.previewText : null,
      contentJson: version.contentJson,
      variables: version.variables ?? [],
      validation: version.validation ?? { valid: true, severity: 'warning', issues: [] },
      createdAt,
    };
  });
  return versions.sort((left, right) => left.versionNumber - right.versionNumber);
}

function portableContentVersionId(documentId: string, portableId: string): string {
  const digest = createHash('sha256').update(`${documentId}:${portableId}`).digest('hex');
  return `cver_${digest.slice(0, 26)}`;
}

export interface PortableCanonicalAdoptionPlan {
  policyVersion: 'compact-bootstrap-brand-v1';
  entityType: 'brand';
  externalId: string;
  targetId: string;
  beforeCanonicalSha256: string;
  disposition: 'skip';
}

export async function resolvePortableCanonicalAdoption(
  db: Database,
  input: {
    tenantId: string;
    organizationId: string;
    sourceSystem: string;
    entity: NormalizedMigrationEntity;
    lock?: boolean;
  },
): Promise<PortableCanonicalAdoptionPlan | undefined> {
  if (
    input.sourceSystem !== 'tixkit-portable' ||
    input.entity.entityType !== 'brand' ||
    input.entity.externalId !== 'brd_dev_local'
  )
    return undefined;
  let exactQuery = db.selectFrom('brands').selectAll().where('id', '=', input.entity.externalId);
  if (input.lock) exactQuery = exactQuery.forUpdate();
  const exact = await exactQuery.executeTakeFirst();
  const importedSlug = textAttribute(input.entity, 'slug');
  let slugQuery = db
    .selectFrom('brands')
    .select('id')
    .where('tenant_id', '=', input.tenantId)
    .where('slug', '=', importedSlug);
  if (input.lock) slugQuery = slugQuery.forUpdate();
  const slugOwner = await slugQuery.executeTakeFirst();
  if (!exact) {
    if (slugOwner) throw new Error('PORTABLE_CANONICAL_ADOPTION_CONFLICT');
    return undefined;
  }
  if (
    exact.tenant_id !== input.tenantId ||
    exact.organization_id !== input.organizationId ||
    importedSlug !== 'tixkit-dev' ||
    (slugOwner && slugOwner.id !== exact.id) ||
    exact.name !== textAttribute(input.entity, 'name') ||
    !storedJsonMatches(exact.theme, jsonAttribute(input.entity, 'theme', {})) ||
    exact.support_url !== (textAttribute(input.entity, 'supportUrl') || null) ||
    !storedJsonMatches(exact.legal_urls, jsonAttribute(input.entity, 'legalUrls', {})) ||
    !storedBooleanMatches(exact.white_label, booleanAttribute(input.entity, 'whiteLabel')) ||
    exact.email_identity_id !== null ||
    exact.sms_identity_id !== null ||
    exact.payment_account_id !== null
  )
    throw new Error('PORTABLE_CANONICAL_ADOPTION_CONFLICT');
  const beforeCanonicalSha256 = await canonicalHash(db, 'brand', exact.id, input.lock);
  if (!beforeCanonicalSha256) throw new Error('PORTABLE_CANONICAL_ADOPTION_CONFLICT');
  return {
    policyVersion: 'compact-bootstrap-brand-v1',
    entityType: 'brand',
    externalId: input.entity.externalId,
    targetId: exact.id,
    beforeCanonicalSha256,
    disposition: 'skip',
  };
}

async function authenticatedPortableCanonicalAdoption(
  db: Database,
  input: {
    tenantId: string;
    organizationId: string;
    jobId: string;
    entity: NormalizedMigrationEntity;
    configuration: string | null;
    summary: string | null;
  },
): Promise<PortableCanonicalAdoptionPlan | undefined> {
  const repository = new ImportRepository(db);
  const authorization = await repository.findPortableImportCommitAuthorization(
    input.tenantId,
    input.organizationId,
    input.jobId,
  );
  const approval = authorization
    ? await repository.findPortableImportApproval({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        jobId: input.jobId,
        approvalId: authorization.approval_id,
      })
    : undefined;
  if (
    !authorization ||
    !approval ||
    approval.approval_digest !== authorization.approval_digest ||
    approval.input_sha256 !== authorization.input_sha256
  )
    throw new Error('PORTABILITY_COMMIT_DESTINATION_CHANGED');

  const rows = [];
  for (let offset = 0; ; offset += 5_000) {
    const page = await repository.listRows({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      jobId: input.jobId,
      limit: 5_000,
      offset,
    });
    rows.push(...page);
    if (page.length < 5_000) break;
  }
  const canonicalAdoptions: PortableCanonicalAdoptionPlan[] = [];
  for (const row of rows) {
    if (!row.normalized_data) continue;
    const adoption = await resolvePortableCanonicalAdoption(db, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      sourceSystem: 'tixkit-portable',
      entity: JSON.parse(row.normalized_data) as NormalizedMigrationEntity,
      lock: true,
    });
    if (adoption) canonicalAdoptions.push(adoption);
  }
  const files = await repository.listFiles(input.tenantId, input.organizationId, input.jobId);
  const mappings = await repository.listMappings(
    input.tenantId,
    input.organizationId,
    'tixkit-portable',
  );
  const inputSha256 = portableImportControlInputSha256({
    configuration: input.configuration ? JSON.parse(input.configuration) : null,
    files: files.map((file) => ({
      id: file.id,
      sha256: file.sha256,
      byteSize: String(file.byte_size),
    })),
    mappings: mappings.map((mapping) => ({
      id: mapping.id,
      version: mapping.version,
      mapping: JSON.parse(mapping.mapping),
    })),
    rows: rows.map((row) => ({
      id: row.id,
      source: JSON.parse(row.source_data),
      normalized: row.normalized_data ? JSON.parse(row.normalized_data) : null,
    })),
    ...(canonicalAdoptions.length > 0 ? { canonicalAdoptions } : {}),
  });
  let summary: { accepted?: boolean; inputHash?: string; canonicalAdoptions?: unknown };
  try {
    summary = input.summary ? JSON.parse(input.summary) : {};
  } catch {
    throw new Error('PORTABILITY_COMMIT_DESTINATION_CHANGED');
  }
  const summarizedAdoptions = Array.isArray(summary.canonicalAdoptions)
    ? summary.canonicalAdoptions
    : [];
  if (
    summary.accepted !== true ||
    summary.inputHash !== inputSha256 ||
    authorization.input_sha256 !== inputSha256 ||
    approval.input_sha256 !== inputSha256 ||
    canonicalPortableJson(summarizedAdoptions) !== canonicalPortableJson(canonicalAdoptions)
  )
    throw new Error('PORTABILITY_COMMIT_DESTINATION_CHANGED');
  const matching = canonicalAdoptions.filter(
    (plan) =>
      plan.entityType === input.entity.entityType && plan.externalId === input.entity.externalId,
  );
  if (matching.length > 1) throw new Error('PORTABILITY_COMMIT_DESTINATION_CHANGED');
  return matching[0];
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
    writtenObjects: Array<{
      bucket: string;
      objectKey: string;
      sha256: string;
    }>;
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
  const existingMediaObjects: Array<{
    bucket: string;
    objectKey: string;
    sha256: string;
  }> = [];
  const reusedExistingObjectKeys = new Set<string>();
  const objectIdentity = (bucket: string, objectKey: string) => `${bucket}\u0000${objectKey}`;
  const stageObjectWrite = async (objectKey: string, sha256: string): Promise<boolean> => {
    const identity = objectIdentity(input.mediaStore.bucket, objectKey);
    const existing = existingMediaObjects.find(
      (object) => objectIdentity(object.bucket, object.objectKey) === identity,
    );
    if (existing) {
      if (existing.sha256 !== sha256) throw new Error('MIGRATION_MEDIA_OBJECT_CONFLICT');
      reusedExistingObjectKeys.add(identity);
      return true;
    }
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
    return false;
  };
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
    const existingRenditions = await tx
      .selectFrom('event_media_renditions')
      .select(['bucket', 'object_key', 'checksum_sha256'])
      .where(
        'asset_id',
        'in',
        existingAssets.map((asset: { id: string }) => asset.id),
      )
      .execute();
    for (const object of [...existingUploads, ...existingRenditions])
      if (object.checksum_sha256)
        existingMediaObjects.push({
          bucket: object.bucket,
          objectKey: object.object_key,
          sha256: object.checksum_sha256,
        });
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
    const objectKey = `event-media/${input.tenantId}/${input.id}/${assetId}/${sha256}.webp`;
    const reusedOriginal = await stageObjectWrite(objectKey, sha256);
    await input.mediaStore.putVerified({
      objectKey,
      bytes,
      sha256,
      contentType: 'image/webp',
    });
    if (!reusedOriginal)
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
        metadata: JSON.stringify({
          image: { width, height, format: 'webp' },
          portableId,
        }),
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
    for (const target of PORTABLE_MEDIA_TARGETS[role as keyof typeof PORTABLE_MEDIA_TARGETS]) {
      const rendered = await renderPortableMediaRendition(bytes, { width, height }, target, {
        x: focalPoint.x,
        y: focalPoint.y,
      });
      const renditionSha256 = createHash('sha256').update(rendered).digest('hex');
      const renditionId = `emr_${identity}_${target.variant}`;
      const renditionObjectKey = `event-media/${input.tenantId}/${input.id}/${assetId}/${renditionId}/${renditionSha256}.webp`;
      const reusedRendition = await stageObjectWrite(renditionObjectKey, renditionSha256);
      await input.mediaStore.putVerified({
        objectKey: renditionObjectKey,
        bytes: rendered,
        sha256: renditionSha256,
        contentType: 'image/webp',
      });
      if (!reusedRendition)
        input.writtenObjects.push({
          bucket: input.mediaStore.bucket,
          objectKey: renditionObjectKey,
          sha256: renditionSha256,
        });
      await tx
        .insertInto('event_media_renditions')
        .values({
          id: renditionId,
          asset_id: assetId,
          variant: target.variant,
          width: target.width,
          height: target.height,
          format: 'webp',
          content_type: 'image/webp',
          bucket: input.mediaStore.bucket,
          object_key: renditionObjectKey,
          checksum_sha256: renditionSha256,
          size_bytes: rendered.byteLength,
          created_at: input.now,
        })
        .execute();
    }
  }
  for (const object of existingMediaObjects) {
    if (reusedExistingObjectKeys.has(objectIdentity(object.bucket, object.objectKey))) continue;
    await enqueueMediaObjectCleanup(tx, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      bucket: object.bucket,
      objectKey: object.objectKey,
      sha256: object.sha256,
      reason: 'portable-media-replaced',
    });
  }
}

async function verifyPortableEventMediaStorage(input: {
  tenantId: string;
  organizationId: string;
  eventId: string;
  entity: NormalizedMigrationEntity;
  sourceSystem: string;
  mediaStore: MigrationMediaObjectStore;
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
    const identity = createHash('sha256')
      .update(`${input.tenantId}:${portableId}`)
      .digest('hex')
      .slice(0, 26);
    await input.mediaStore.verify({
      objectKey: `event-media/${input.tenantId}/${input.eventId}/ema_${identity}/${sha256}.webp`,
      bytes: declaredBytes,
      sha256,
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
    writtenObjects: Array<{
      bucket: string;
      objectKey: string;
      sha256: string;
    }>;
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
          'content_documents',
          'buyers',
          'orders',
          'historical_financial_snapshots',
          'historical_check_ins',
        ]).has(table)
      ) {
        update = update.where('organization_id', '=', input.organizationId);
      }
      if (new Set(['venues', 'content_documents', 'buyers', 'orders']).has(table)) {
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
        ...(input.existing ? { version: sql<number>`version + 1` } : {}),
        updated_at: now,
        ...(!input.existing ? { created_at: now } : {}),
      });
      await writePortableEventMedia(tx, input, dependency(deps, 'brand'));
      return;
    case 'content-document':
      {
        const channel = textAttribute(entity, 'channel');
        if (!['event_page', 'email', 'sms', 'imessage', 'social_invite'].includes(channel))
          throw new Error('MIGRATION_ATTRIBUTE_INVALID:content-document:channel');
        const versions = portableContentVersions(entity, channel);
        await updateOrInsert('content_documents', {
          tenant_id: input.tenantId,
          organization_id: organizationId,
          brand_id: dependency(deps, 'brand'),
          event_id: deps.get('event') ?? null,
          channel,
          key: textAttribute(entity, 'key'),
          name: textAttribute(entity, 'name'),
          status: 'draft',
          locale: textAttribute(entity, 'locale', 'en'),
          current_draft_version_id: null,
          published_version_id: null,
          updated_at: now,
          ...(!input.existing ? { created_at: now } : {}),
        });
        const incomingVersionIds = versions.map((version) =>
          portableContentVersionId(id, version.portableId),
        );
        if (input.existing) {
          const existingVersions = await tx
            .selectFrom('content_document_versions')
            .select('id')
            .where('document_id', '=', id)
            .execute();
          const incomingIds = new Set(incomingVersionIds);
          const staleIds = existingVersions
            .map((version: { id: string }) => version.id)
            .filter((versionId: string) => !incomingIds.has(versionId));
          if (staleIds.length > 0) {
            for (const table of [
              'content_assets',
              'content_render_artifacts',
              'content_test_sends',
            ]) {
              const reference = await tx
                .selectFrom(table)
                .select('id')
                .where('document_id', '=', id)
                .where('version_id', 'in', staleIds)
                .executeTakeFirst();
              if (reference) throw new Error(`MIGRATION_CONTENT_VERSION_IN_USE:${id}:${table}`);
            }
            await tx
              .deleteFrom('content_document_versions')
              .where('document_id', '=', id)
              .where('id', 'in', staleIds)
              .execute();
          }
        }
        for (const version of versions) {
          const versionId = portableContentVersionId(id, version.portableId);
          const values = {
            document_id: id,
            version_number: version.versionNumber,
            status: 'draft',
            schema_version: version.schemaVersion,
            subject: version.subject,
            preview_text: version.previewText,
            content_json: JSON.stringify(version.contentJson),
            rendered_html: null,
            rendered_text: null,
            variables: JSON.stringify(version.variables),
            validation: JSON.stringify(version.validation),
            created_by: 'migration-import',
            created_at: new Date(version.createdAt),
            published_at: null,
          };
          const existingVersion = await tx
            .selectFrom('content_document_versions')
            .select('id')
            .where('id', '=', versionId)
            .where('document_id', '=', id)
            .executeTakeFirst();
          if (existingVersion) {
            await tx
              .updateTable('content_document_versions')
              .set(values)
              .where('id', '=', versionId)
              .where('document_id', '=', id)
              .execute();
          } else {
            await tx
              .insertInto('content_document_versions')
              .values({ id: versionId, ...values })
              .execute();
          }
        }
        const currentDraftVersionId = versions.at(-1)
          ? portableContentVersionId(id, versions.at(-1)!.portableId)
          : null;
        await tx
          .updateTable('content_documents')
          .set({ current_draft_version_id: currentDraftVersionId, published_version_id: null })
          .where('id', '=', id)
          .where('tenant_id', '=', input.tenantId)
          .execute();
      }
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
    'content-document': 'content_documents',
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
  if (input.type === 'content-document') {
    await tx.deleteFrom('content_document_versions').where('document_id', '=', input.id).execute();
  }
  let deletion = tx.deleteFrom(table[input.type]).where('id', '=', input.id);
  if (
    new Set<MigrationEntityType>([
      'brand',
      'venue',
      'event',
      'content-document',
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
    new Set<MigrationEntityType>([
      'venue',
      'content-document',
      'buyer',
      'historical-order',
      'ticket',
    ]).has(input.type)
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
  if (input.type === 'content-document' && (await count('content_assets', 'document_id')))
    return true;
  if (
    input.type === 'content-document' &&
    ((await count('content_render_artifacts', 'document_id')) ||
      (await count('content_test_sends', 'document_id')))
  )
    return true;
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

function isAdoptedCanonicalProvenance(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return (
      Boolean(parsed) &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).canonicalAdopted === true
    );
  } catch {
    return false;
  }
}

class ProductionMigrationCommitter implements MigrationDomainCommitter {
  constructor(
    private readonly db: Database,
    private readonly entityType: MigrationEntityType,
    private readonly mediaStore: MigrationMediaObjectStore,
    private readonly assetResolver: MigrationPortableAssetResolver,
  ) {}

  async assessReconciled(input: Parameters<MigrationDomainCommitter['assessReconciled']>[0]) {
    const job = await this.db
      .selectFrom('import_jobs')
      .select('source_system')
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.jobId)
      .executeTakeFirst();
    const reference = job
      ? await this.db
          .selectFrom('external_references')
          .select(['tixkit_id', 'last_seen_import_job_id'])
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('source_system', '=', job.source_system)
          .where('entity_type', '=', this.entityType)
          .where('external_id', '=', input.externalId)
          .executeTakeFirst()
      : undefined;
    const entity = await this.db
      .selectFrom('imported_domain_entities')
      .select([
        'attributes',
        'financial_snapshot',
        'canonical_hash',
        'source_external_id',
        'last_seen_import_job_id',
      ])
      .where('tenant_id', '=', input.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('id', '=', input.tixkitId)
      .where('entity_type', '=', this.entityType)
      .forUpdate()
      .executeTakeFirst();
    if (
      !job ||
      !reference ||
      reference.tixkit_id !== input.tixkitId ||
      reference.last_seen_import_job_id !== input.jobId ||
      !entity ||
      entity.source_external_id !== input.externalId ||
      entity.last_seen_import_job_id !== input.jobId ||
      canonicalMigrationContentFingerprint({
        attributes: JSON.parse(entity.attributes) as Record<string, unknown>,
        financialSnapshot: entity.financial_snapshot
          ? (JSON.parse(
              entity.financial_snapshot,
            ) as NormalizedMigrationEntity['financialSnapshot'])
          : undefined,
      }) !== canonicalMigrationContentFingerprint(input.entity)
    )
      return {
        reconciled: false,
        reason: 'Import provenance or normalized content does not match the source row',
      };
    const actualHash = await canonicalHash(this.db, this.entityType, input.tixkitId, true);
    if (!actualHash || actualHash !== entity.canonical_hash)
      return {
        reconciled: false,
        reason: 'Canonical entity differs from the committed import evidence',
      };
    if (this.entityType === 'event') {
      try {
        await verifyPortableEventMediaStorage({
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          eventId: input.tixkitId,
          entity: input.entity,
          sourceSystem: job.source_system,
          mediaStore: this.mediaStore,
        });
      } catch (error) {
        return {
          reconciled: false,
          reason:
            error instanceof Error ? error.message : 'Event media storage verification failed',
        };
      }
    }
    return { reconciled: true };
  }

  async assessUntouched(input: Parameters<MigrationDomainCommitter['assessUntouched']>[0]) {
    return this.db.transaction().execute(async (transaction) => {
      const entity = await transaction
        .selectFrom('imported_domain_entities')
        .select(['created_by_import_job_id', 'canonical_hash', 'source_provenance'])
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
      if (isAdoptedCanonicalProvenance(entity.source_provenance))
        return {
          eligible: false,
          reason: 'Canonical entity predates import',
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

    const writtenObjects: Array<{
      bucket: string;
      objectKey: string;
      sha256: string;
    }> = [];
    const stagedCleanupIds: string[] = [];
    try {
      const outcome: MigrationCommitOutcome = await this.db
        .transaction()
        .execute(async (transaction) => {
          const job = await transaction
            .selectFrom('import_jobs')
            .select(['source_system', 'configuration', 'summary'])
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
          if (existingReference && !existing) {
            throw new Error(
              `MIGRATION_EXTERNAL_REFERENCE_TARGET_INVALID:${this.entityType}:${existingReference.tixkit_id}`,
            );
          }
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
          let adoptedCanonicalBrand: PortableCanonicalAdoptionPlan | undefined;
          if (
            job.source_system === 'tixkit-portable' &&
            input.entity.entityType === 'brand' &&
            input.entity.externalId === 'brd_dev_local'
          ) {
            try {
              adoptedCanonicalBrand = await authenticatedPortableCanonicalAdoption(
                transaction as Database,
                {
                  tenantId: input.tenantId,
                  organizationId: input.organizationId,
                  jobId: input.jobId,
                  entity: input.entity,
                  configuration: job.configuration,
                  summary: job.summary,
                },
              );
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === 'PORTABILITY_COMMIT_DESTINATION_CHANGED'
              )
                throw error;
              throw new Error('PORTABILITY_COMMIT_DESTINATION_CHANGED', { cause: error });
            }
          } else if (!existing) {
            adoptedCanonicalBrand = await resolvePortableCanonicalAdoption(
              transaction as Database,
              {
                tenantId: input.tenantId,
                organizationId: input.organizationId,
                sourceSystem: job.source_system,
                entity: input.entity,
                lock: true,
              },
            );
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
            ...(adoptedCanonicalBrand ? { canonicalAdopted: true } : {}),
          });
          const now = new Date();
          const id =
            existing?.id ??
            adoptedCanonicalBrand?.targetId ??
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
          const canonicalExisting =
            Boolean(existing) ||
            Boolean(adoptedCanonicalBrand) ||
            this.entityType === 'organization';

          if (existing && unchanged) {
            if (this.entityType === 'event')
              await verifyPortableEventMediaStorage({
                tenantId: input.tenantId,
                organizationId: input.organizationId,
                eventId: id,
                entity: input.entity,
                sourceSystem: job.source_system,
                mediaStore: this.mediaStore,
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

          if (!adoptedCanonicalBrand)
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
            disposition: adoptedCanonicalBrand
              ? 'skipped'
              : canonicalExisting
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
        .select(['id', 'created_by_import_job_id', 'canonical_hash', 'source_provenance'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('id', '=', input.tixkitId)
        .where('entity_type', '=', this.entityType)
        .forUpdate()
        .executeTakeFirst();
      if (!entity || entity.created_by_import_job_id !== input.jobId) return false;
      if (isAdoptedCanonicalProvenance(entity.source_provenance)) return false;
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
