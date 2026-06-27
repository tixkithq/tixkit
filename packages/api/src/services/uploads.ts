import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Socket } from 'node:net';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ulid } from 'ulid';
import type { Database } from '@tixkit/db';
import { ValidationError, NotFoundError } from '@tixkit/domain';
import { config } from '../config/index.js';

export type UploadPurpose = 'checkout_answer' | 'brand_logo' | 'user_avatar';

export type CreateUploadInput = {
  tenantId: string;
  organizationId?: string | null;
  brandId?: string | null;
  eventId?: string | null;
  createdByUserId?: string | null;
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
  publicComplete?: boolean;
};

export type UploadArtifactResponse = {
  artifactId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  completeUrl: string;
  completeToken?: string;
  expiresAt: string;
};

const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const UPLOAD_TTL_SECONDS = 15 * 60;

const PURPOSE_LIMITS: Record<UploadPurpose, { maxSizeBytes: number; contentTypes: Set<string>; prefix: string }> = {
  checkout_answer: {
    maxSizeBytes: 10 * 1024 * 1024,
    contentTypes: new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain']),
    prefix: 'checkout-answers',
  },
  brand_logo: {
    maxSizeBytes: 2 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp']),
    prefix: 'brand-logos',
  },
  user_avatar: {
    maxSizeBytes: 2 * 1024 * 1024,
    contentTypes: new Set(['image/jpeg', 'image/png', 'image/webp']),
    prefix: 'avatars',
  },
};

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function uploadTokenMatches(expectedHash: string | null, token: string): boolean {
  if (!expectedHash) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const candidate = Buffer.from(tokenHash(token), 'hex');
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

function safeFileName(name: string): string {
  const trimmed = name.trim().replaceAll(/[/\\]/g, '-').replaceAll(/[^\w .@-]/g, '_');
  return trimmed.length > 0 ? trimmed.slice(0, 180) : 'upload';
}

function extension(name: string): string {
  const match = /\.[A-Za-z0-9]{1,12}$/.exec(name);
  return match ? match[0].toLowerCase() : '';
}

function assertUploadAllowed(input: Pick<CreateUploadInput, 'purpose' | 'contentType' | 'sizeBytes'>): void {
  const limits = PURPOSE_LIMITS[input.purpose];
  if (!limits.contentTypes.has(input.contentType)) {
    throw new ValidationError(`Unsupported upload content type: ${input.contentType}`);
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > limits.maxSizeBytes) {
    throw new ValidationError(`Upload exceeds ${limits.maxSizeBytes} byte limit`);
  }
}

function finalObjectKeyFromStaging(stagingKey: string): string {
  if (stagingKey.includes('/staging/')) return stagingKey.replace('/staging/', '/final/');
  return `${stagingKey}.final`;
}

function createS3Client(): S3Client {
  return new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
  });
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body || typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== 'function') {
    return Buffer.alloc(0);
  }
  const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(bytes);
}

async function scanWithClamAv(buffer: Buffer): Promise<{ clean: boolean; result: string }> {
  const host = process.env.CLAMAV_HOST;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  if (!host) {
    throw new Error('CLAMAV_HOST is required when UPLOAD_MALWARE_SCANNER=clamav');
  }

  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const chunks: Buffer[] = [];
    socket.setTimeout(10_000);
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('error', reject);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('ClamAV scan timed out'));
    });
    socket.on('close', () => {
      const response = Buffer.concat(chunks).toString('utf8');
      if (response.includes('FOUND')) resolve({ clean: false, result: response.trim() });
      else if (response.includes('OK')) resolve({ clean: true, result: response.trim() });
      else reject(new Error(`Unexpected ClamAV response: ${response.trim()}`));
    });
    socket.connect(port, host, () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < buffer.length; offset += 8192) {
        const chunk = buffer.subarray(offset, offset + 8192);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
      socket.end();
    });
  });
}

function isMissingS3ObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.Code === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function markUploadArtifactRejected(db: Database, artifactId: string, result: string): Promise<void> {
  await db.updateTable('upload_artifacts').set({
    status: 'rejected',
    scan_status: 'blocked',
    scan_result: result,
    updated_at: new Date(),
  }).where('id', '=', artifactId).execute();
}

async function tryDeleteUploadObject(s3: S3Client, bucket: string, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    // The artifact is still rejected; deletion failures should not hide the validation error.
  }
}

export async function cleanupExpiredUploadArtifacts(db: Database, now = new Date(), limit = 100): Promise<number> {
  const rows = await db
    .selectFrom('upload_artifacts')
    .select(['id', 'status', 'scan_result', 'bucket', 'object_key'])
    .where('status', 'in', ['pending', 'rejected'])
    .where('expires_at', '<', now)
    .orderBy('expires_at')
    .limit(limit)
    .execute();

  if (rows.length === 0) return 0;

  const s3 = createS3Client();
  await Promise.all(rows.map(async (row) => {
    await tryDeleteUploadObject(s3, row.bucket, row.object_key);
    await db
      .updateTable('upload_artifacts')
      .set({
        status: 'rejected',
        scan_status: 'blocked',
        scan_result: row.scan_result ?? 'Upload artifact expired before completion',
        updated_at: now,
      })
      .where('id', '=', row.id)
      .execute();
  }));

  return rows.length;
}

export async function scanUploadBuffer(buffer: Buffer): Promise<{ clean: boolean; result: string }> {
  const mode = process.env.UPLOAD_MALWARE_SCANNER ?? (process.env.NODE_ENV === 'production' ? '' : 'eicar');
  if (mode === 'clamav') return scanWithClamAv(buffer);
  if (mode === 'eicar') {
    const text = buffer.toString('utf8');
    return text.includes(EICAR_SIGNATURE)
      ? { clean: false, result: 'EICAR test signature found' }
      : { clean: true, result: 'No EICAR test signature found' };
  }
  throw new Error('UPLOAD_MALWARE_SCANNER must be configured in production');
}

export async function createUploadArtifact(db: Database, input: CreateUploadInput): Promise<UploadArtifactResponse> {
  assertUploadAllowed(input);
  const id = `upl_${ulid()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000);
  const fileName = safeFileName(input.fileName);
  const limits = PURPOSE_LIMITS[input.purpose];
  try {
    await cleanupExpiredUploadArtifacts(db, now, 25);
  } catch {
    // Upload creation should not fail because best-effort stale-object cleanup failed.
  }
  const objectKeyPrefix = [
    'uploads',
    input.tenantId,
    limits.prefix,
    input.eventId ?? input.brandId ?? input.createdByUserId ?? 'global',
  ].join('/');
  const objectKey = `${objectKeyPrefix}/staging/${id}${extension(fileName)}`;
  const completeToken = input.publicComplete ? randomBytes(32).toString('base64url') : undefined;
  const uploadHeaders = { 'Content-Type': input.contentType };
  const s3 = createS3Client();
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: objectKey,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    }),
    { expiresIn: UPLOAD_TTL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
  );

  await db.insertInto('upload_artifacts').values({
    id,
    tenant_id: input.tenantId,
    organization_id: input.organizationId ?? null,
    brand_id: input.brandId ?? null,
    event_id: input.eventId ?? null,
    created_by_user_id: input.createdByUserId ?? null,
    purpose: input.purpose,
    status: 'pending',
    scan_status: 'pending',
    scan_result: null,
    bucket: config.s3Bucket,
    object_key: objectKey,
    file_name: fileName,
    content_type: input.contentType,
    size_bytes: input.sizeBytes,
    checksum_sha256: null,
    client_token_hash: completeToken ? tokenHash(completeToken) : null,
    metadata: JSON.stringify(input.metadata ?? {}),
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  }).execute();

  return {
    artifactId: id,
    uploadUrl,
    uploadHeaders,
    completeUrl: input.publicComplete ? `/v1/public/upload-artifacts/${id}/complete` : `/v1/upload-artifacts/${id}/complete`,
    completeToken,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function completeUploadArtifact(db: Database, artifactId: string): Promise<{ artifactId: string; status: string; scanStatus: string }> {
  const artifact = await db.selectFrom('upload_artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  if (!artifact) throw new NotFoundError('UploadArtifact', artifactId);
  if (artifact.status === 'uploaded' && artifact.scan_status === 'clean') {
    return { artifactId, status: artifact.status, scanStatus: artifact.scan_status };
  }
  if (new Date(artifact.expires_at) < new Date()) {
    const result = 'Upload artifact URL has expired';
    const s3 = createS3Client();
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, artifact.object_key);
    throw new ValidationError(result);
  }

  const s3 = createS3Client();
  const stagingObjectKey = artifact.object_key;
  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: artifact.bucket, Key: stagingObjectKey }));
  } catch (error) {
    if (!isMissingS3ObjectError(error)) throw error;
    const result = 'Uploaded object is missing from storage';
    await markUploadArtifactRejected(db, artifact.id, result);
    throw new ValidationError(result);
  }
  const actualSize = Number(head.ContentLength ?? 0);
  const actualType = typeof head.ContentType === 'string' ? head.ContentType : '';
  try {
    assertUploadAllowed({ purpose: artifact.purpose as UploadPurpose, contentType: actualType, sizeBytes: actualSize });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const result = `Uploaded object metadata is invalid: ${error.message}`;
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  if (actualSize !== artifact.size_bytes) {
    const result = `Uploaded object size does not match declared size: expected ${artifact.size_bytes} bytes, received ${actualSize} bytes`;
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  if (actualType !== artifact.content_type) {
    const result = `Uploaded object content type does not match declared content type: expected ${artifact.content_type}, received ${actualType}`;
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }

  const object = await s3.send(new GetObjectCommand({ Bucket: artifact.bucket, Key: stagingObjectKey }));
  const buffer = await bodyToBuffer(object.Body);
  const objectContentType = typeof object.ContentType === 'string' ? object.ContentType : actualType;
  if (buffer.length !== artifact.size_bytes) {
    const result = `Uploaded object size does not match declared size: expected ${artifact.size_bytes} bytes, received ${buffer.length} bytes`;
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  if (objectContentType !== artifact.content_type) {
    const result = `Uploaded object content type does not match declared content type: expected ${artifact.content_type}, received ${objectContentType}`;
    await markUploadArtifactRejected(db, artifact.id, result);
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError(result);
  }
  const scan = await scanUploadBuffer(buffer);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const now = new Date();
  if (!scan.clean) {
    await db.updateTable('upload_artifacts').set({
      status: 'rejected',
      scan_status: 'blocked',
      scan_result: scan.result,
      checksum_sha256: checksum,
      updated_at: now,
    }).where('id', '=', artifact.id).execute();
    await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);
    throw new ValidationError('Uploaded file failed malware scan');
  }

  const finalObjectKey = finalObjectKeyFromStaging(stagingObjectKey);
  await s3.send(new PutObjectCommand({
    Bucket: artifact.bucket,
    Key: finalObjectKey,
    Body: buffer,
    ContentType: artifact.content_type,
    ContentLength: buffer.length,
  }));
  await db.updateTable('upload_artifacts').set({
    status: 'uploaded',
    scan_status: 'clean',
    scan_result: scan.result,
    checksum_sha256: checksum,
    object_key: finalObjectKey,
    updated_at: now,
  }).where('id', '=', artifact.id).execute();
  await tryDeleteUploadObject(s3, artifact.bucket, stagingObjectKey);

  return { artifactId, status: 'uploaded', scanStatus: 'clean' };
}

export async function getUploadArtifactDownloadUrl(db: Database, artifactId: string): Promise<string> {
  const artifact = await db.selectFrom('upload_artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  if (!artifact || artifact.status !== 'uploaded' || artifact.scan_status !== 'clean') {
    throw new NotFoundError('UploadArtifact', artifactId);
  }
  return getSignedUrl(
    createS3Client(),
    new GetObjectCommand({
      Bucket: artifact.bucket,
      Key: artifact.object_key,
      ResponseContentType: artifact.content_type,
      ResponseContentDisposition: `attachment; filename="${artifact.file_name.replaceAll('"', '')}"`,
    }),
    { expiresIn: 900 },
  );
}

function uploadArtifactAnswerEntries(answers: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(answers)
    .filter((entry): entry is [string, { artifactId: string }] =>
      Boolean(
        entry[1] &&
          typeof entry[1] === 'object' &&
          !Array.isArray(entry[1]) &&
          typeof (entry[1] as { artifactId?: unknown }).artifactId === 'string',
      ),
    )
    .map(([questionId, answer]) => [questionId, answer.artifactId]);
}

function metadataQuestionId(metadata: unknown): string | undefined {
  if (typeof metadata === 'string') {
    try {
      return metadataQuestionId(JSON.parse(metadata));
    } catch {
      return undefined;
    }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const questionId = (metadata as { questionId?: unknown }).questionId;
  return typeof questionId === 'string' && questionId.length > 0 ? questionId : undefined;
}

export async function assertCompletedUploadArtifacts(
  db: Database,
  tenantId: string,
  eventId: string,
  answers: Record<string, unknown>,
): Promise<void> {
  const answerArtifacts = uploadArtifactAnswerEntries(answers);
  const artifactIds = answerArtifacts.map(([, artifactId]) => artifactId);
  if (artifactIds.length === 0) return;

  const questionIdsByArtifactId = new Map<string, Set<string>>();
  for (const [questionId, artifactId] of answerArtifacts) {
    const questionIds = questionIdsByArtifactId.get(artifactId) ?? new Set<string>();
    questionIds.add(questionId);
    questionIdsByArtifactId.set(artifactId, questionIds);
  }

  const rows = await db
    .selectFrom('upload_artifacts')
    .select(['id', 'status', 'scan_status', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('event_id', '=', eventId)
    .where('id', 'in', artifactIds)
    .execute();
  const valid = new Set<string>();
  const mismatched = new Set<string>();
  const missingQuestionMetadata = new Set<string>();
  for (const row of rows) {
    if (row.status !== 'uploaded' || row.scan_status !== 'clean') continue;

    const artifactQuestionId = metadataQuestionId(row.metadata);
    const answerQuestionIds = questionIdsByArtifactId.get(row.id);
    if (!artifactQuestionId) {
      missingQuestionMetadata.add(row.id);
      continue;
    }
    if (!answerQuestionIds || [...answerQuestionIds].some((questionId) => questionId !== artifactQuestionId)) {
      mismatched.add(row.id);
      continue;
    }

    valid.add(row.id);
  }

  if (mismatched.size > 0) {
    throw new ValidationError('File answer references an upload artifact for a different question', {
      artifactIds: [...mismatched],
    });
  }

  if (missingQuestionMetadata.size > 0) {
    throw new ValidationError('File answer references an upload artifact without question metadata', {
      artifactIds: [...missingQuestionMetadata],
    });
  }

  const missing = artifactIds.filter((artifactId) => !valid.has(artifactId));
  if (missing.length > 0) {
    throw new ValidationError('File answer references an upload artifact that is not completed and clean', { artifactIds: missing });
  }
}
