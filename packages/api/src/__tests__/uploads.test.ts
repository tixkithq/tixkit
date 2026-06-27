import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../app.js';
import { registerErrorHandler } from '../app.js';
import {
  assertCompletedUploadArtifacts,
  cleanupExpiredUploadArtifacts,
  completeUploadArtifact,
  createUploadArtifact,
  getUploadArtifactDownloadUrl,
  scanUploadBuffer,
} from '../services/uploads.js';
import { publicUploadRoutes, uploadRoutes } from '../routes/modules/uploads.js';

const s3Send = vi.fn();
const signedUrlInputs: unknown[] = [];

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send = s3Send;
  }
  class PutObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class DeleteObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class HeadObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class GetObjectCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, command, options) => {
    signedUrlInputs.push({ command: command.input, options });
    return `https://s3.test/${encodeURIComponent(String(command.input.Key))}`;
  }),
}));

type Row = Record<string, unknown>;

function createMockDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { upload_artifacts: [], ...seed };

  function rowsFor(table: string): Row[] {
    tables[table] ??= [];
    return tables[table];
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- this helper is local to the lightweight Kysely mock.
  function matches(row: Row, conditions: Array<[string, string, unknown]>): boolean {
    return conditions.every(([column, operator, value]) => {
      if (operator === 'in' && Array.isArray(value)) return value.includes(row[column]);
      if (operator === '<') return new Date(row[column] as string | Date).getTime() < new Date(value as string | Date).getTime();
      return row[column] === value;
    });
  }

  function selectFrom(table: string) {
    const conditions: Array<[string, string, unknown]> = [];
    let limitCount: number | undefined;
    const query = {
      select: () => query,
      selectAll: () => query,
      orderBy: () => query,
      limit(value: number) {
        limitCount = value;
        return query;
      },
      where(column: string, operator: string, value: unknown) {
        conditions.push([column, operator, value]);
        return query;
      },
      executeTakeFirst: async () => rowsFor(table).find((row) => matches(row, conditions)),
      execute: async () => {
        const result = rowsFor(table).filter((row) => matches(row, conditions));
        return typeof limitCount === 'number' ? result.slice(0, limitCount) : result;
      },
    };
    return query;
  }

  function insertInto(table: string) {
    return {
      values(values: Row) {
        return {
          execute: async () => {
            rowsFor(table).push({ ...values });
          },
        };
      },
    };
  }

  function updateTable(table: string) {
    return {
      set(values: Row) {
        const conditions: Array<[string, string, unknown]> = [];
        return {
          where(column: string, operator: string, value: unknown) {
            conditions.push([column, operator, value]);
            return this;
          },
          execute: async () => {
            for (const row of rowsFor(table)) {
              if (matches(row, conditions)) Object.assign(row, values);
            }
          },
        };
      },
    };
  }

  return {
    tables,
    db: { selectFrom, insertInto, updateTable } as unknown as Database,
  };
}

function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.write', 'settings.write'],
    brandIds: ['brd_1'],
    eventIds: ['evt_1'],
    ...overrides,
  };
}

async function setupUploadApp(
  db: Database,
  routes = uploadRoutes,
  principal = makePrincipal(),
) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(routes);
  registerErrorHandler(app);
  return app;
}

describe('upload artifact service', () => {
  beforeEach(() => {
    signedUrlInputs.length = 0;
    s3Send.mockReset();
    delete process.env.UPLOAD_MALWARE_SCANNER;
  });

  it('creates scoped presigned PUT artifacts without storing the public completion token', async () => {
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: '../waiver?.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      metadata: { questionId: 'q_file' },
      publicComplete: true,
    });

    expect(artifact.artifactId).toMatch(/^upl_/);
    expect(artifact.uploadHeaders).toEqual({ 'Content-Type': 'application/pdf' });
    expect(artifact.completeUrl).toBe(`/v1/public/upload-artifacts/${artifact.artifactId}/complete`);
    expect(artifact.completeToken).toBeTruthy();
    const signedPut = signedUrlInputs[0] as { command: Record<string, unknown>; options: { signableHeaders: Set<string> } };
    expect(signedPut).toMatchObject({
      command: {
        Bucket: 'tixkit',
        ContentType: 'application/pdf',
        ContentLength: 1024,
      },
      options: { expiresIn: 900 },
    });
    const signableHeaders = [...signedPut.options.signableHeaders];
    // eslint-disable-next-line unicorn/no-array-sort -- sorting a fresh array keeps this assertion compatible with the package TS lib target.
    expect(signableHeaders.sort()).toEqual(['content-length', 'content-type']);
    const stored = tables.upload_artifacts[0];
    expect(stored.object_key).toBe(`uploads/tnt_1/checkout-answers/evt_1/staging/${artifact.artifactId}.pdf`);
    expect(stored.file_name).toBe('..-waiver_.pdf');
    expect(stored.client_token_hash).toEqual(expect.any(String));
    expect(stored.client_token_hash).not.toBe(artifact.completeToken);
    expect(stored.metadata).toBe(JSON.stringify({ questionId: 'q_file' }));
  });

  it('rejects unsupported content types and oversized uploads before creating artifacts', async () => {
    const { db, tables } = createMockDb();
    await expect(createUploadArtifact(db, {
      tenantId: 'tnt_1',
      purpose: 'checkout_answer',
      fileName: 'script.html',
      contentType: 'text/html',
      sizeBytes: 10,
    })).rejects.toThrow('Unsupported upload content type');

    await expect(createUploadArtifact(db, {
      tenantId: 'tnt_1',
      purpose: 'brand_logo',
      fileName: 'logo.png',
      contentType: 'image/png',
      sizeBytes: 3 * 1024 * 1024,
    })).rejects.toThrow('Upload exceeds');
    expect(tables.upload_artifacts).toHaveLength(0);
  });

  it('cleans expired pending staging objects opportunistically before creating new artifacts', async () => {
    const { db, tables } = createMockDb({
      upload_artifacts: [{
        id: 'upl_expired',
        status: 'pending',
        scan_status: 'pending',
        scan_result: null,
        bucket: 'tixkit',
        object_key: 'uploads/tnt_1/checkout-answers/evt_1/staging/upl_expired.txt',
        expires_at: new Date(Date.now() - 60_000),
      }],
    });
    s3Send.mockResolvedValueOnce({});

    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
    });

    expect(artifact.artifactId).toMatch(/^upl_/);
    expect(tables.upload_artifacts[0]).toMatchObject({
      id: 'upl_expired',
      status: 'rejected',
      scan_status: 'blocked',
      scan_result: 'Upload artifact expired before completion',
    });
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(s3Send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: 'uploads/tnt_1/checkout-answers/evt_1/staging/upl_expired.txt',
    });
    expect(tables.upload_artifacts).toHaveLength(2);
  });

  it('limits explicit expired upload cleanup work', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_expired_1',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/staging/upl_expired_1.txt',
          expires_at: new Date(now.getTime() - 60_000),
        },
        {
          id: 'upl_expired_2',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/staging/upl_expired_2.txt',
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
    });
    s3Send.mockResolvedValue({});

    await expect(cleanupExpiredUploadArtifacts(db, now, 1)).resolves.toBe(1);

    expect(tables.upload_artifacts.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('marks clean uploaded objects complete after size/type verification, scanning, and final-key promotion', async () => {
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: 5, ContentType: 'text/plain' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new TextEncoder().encode('clean') },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).resolves.toEqual({
      artifactId: artifact.artifactId,
      status: 'uploaded',
      scanStatus: 'clean',
    });
    const stagingKey = `uploads/tnt_1/checkout-answers/evt_1/staging/${artifact.artifactId}.txt`;
    const finalKey = `uploads/tnt_1/checkout-answers/evt_1/final/${artifact.artifactId}.txt`;
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'uploaded',
      scan_status: 'clean',
      scan_result: 'No EICAR test signature found',
      object_key: finalKey,
    });
    expect(tables.upload_artifacts[0].checksum_sha256).toEqual(expect.any(String));
    expect(s3Send.mock.calls[0][0].input).toMatchObject({ Bucket: 'tixkit', Key: stagingKey });
    expect(s3Send.mock.calls[1][0].input).toMatchObject({ Bucket: 'tixkit', Key: stagingKey });
    expect(Buffer.isBuffer(s3Send.mock.calls[2][0].input.Body)).toBe(true);
    expect(s3Send.mock.calls[2][0].input.Body.toString('utf8')).toBe('clean');
    expect(s3Send.mock.calls[2][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: finalKey,
      ContentType: 'text/plain',
      ContentLength: 5,
    });
    expect(s3Send.mock.calls[2][0].input).not.toHaveProperty('CopySource');
    expect(s3Send.mock.calls[2][0].input).not.toHaveProperty('MetadataDirective');
    expect(s3Send.mock.calls[3][0].input).toMatchObject({ Bucket: 'tixkit', Key: stagingKey });

    const downloadUrl = await getUploadArtifactDownloadUrl(db, artifact.artifactId);
    expect(downloadUrl).toBe(`https://s3.test/${encodeURIComponent(finalKey)}`);
    expect(signedUrlInputs.at(-1)).toMatchObject({
      command: {
        Bucket: 'tixkit',
        Key: finalKey,
      },
    });
    expect(signedUrlInputs.at(-1)).not.toMatchObject({
      command: {
        Key: stagingKey,
      },
    });
  });

  it('returns already-clean uploaded artifacts without trusting or rescanning the old staging key', async () => {
    const { db } = createMockDb({
      upload_artifacts: [{
        id: 'upl_clean',
        status: 'uploaded',
        scan_status: 'clean',
        bucket: 'tixkit',
        object_key: 'uploads/tnt_1/checkout-answers/evt_1/final/upl_clean.txt',
        content_type: 'text/plain',
        size_bytes: 5,
        expires_at: new Date(Date.now() - 60_000),
      }],
    });
    s3Send.mockImplementation(async () => {
      throw new Error('storage should not be called for an already clean artifact');
    });

    await expect(completeUploadArtifact(db, 'upl_clean')).resolves.toEqual({
      artifactId: 'upl_clean',
      status: 'uploaded',
      scanStatus: 'clean',
    });
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('rejects size-mismatched uploaded objects, blocks the row, and deletes the staging object', async () => {
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
    });
    const stagingKey = tables.upload_artifacts[0].object_key;
    s3Send
      .mockResolvedValueOnce({ ContentLength: 6, ContentType: 'text/plain' })
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow('size does not match declared size');
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      object_key: stagingKey,
    });
    expect(tables.upload_artifacts[0].scan_result).toBe('Uploaded object size does not match declared size: expected 5 bytes, received 6 bytes');
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[1][0].input).toMatchObject({ Bucket: 'tixkit', Key: stagingKey });
  });

  it('rejects content-type-mismatched uploaded objects, blocks the row, and deletes the staging object', async () => {
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
    });
    const stagingKey = tables.upload_artifacts[0].object_key;
    s3Send
      .mockResolvedValueOnce({ ContentLength: 5, ContentType: 'image/png' })
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow('content type does not match declared content type');
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      object_key: stagingKey,
    });
    expect(tables.upload_artifacts[0].scan_result).toBe('Uploaded object content type does not match declared content type: expected text/plain, received image/png');
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[1][0].input).toMatchObject({ Bucket: 'tixkit', Key: stagingKey });
  });

  it('rejects missing storage objects and blocks the row', async () => {
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
    });
    s3Send.mockRejectedValueOnce({ name: 'NoSuchKey' });

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow('Uploaded object is missing from storage');
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      scan_result: 'Uploaded object is missing from storage',
    });
  });

  it('blocks EICAR-positive uploaded objects and records the rejected scan result', async () => {
    const { db, tables } = createMockDb();
    const signature = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'eicar.txt',
      contentType: 'text/plain',
      sizeBytes: signature.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: signature.length, ContentType: 'text/plain' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new TextEncoder().encode(signature) },
      })
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow('Uploaded file failed malware scan');
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      scan_result: 'EICAR test signature found',
    });
  });

  it('fails closed in production unless a malware scanner is configured', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(scanUploadBuffer(Buffer.from('clean'))).rejects.toThrow('UPLOAD_MALWARE_SCANNER must be configured');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('requires referenced file-answer artifacts to be completed, clean, tenant scoped, and event scoped', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        { id: 'upl_clean', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'uploaded', scan_status: 'clean', metadata: JSON.stringify({ questionId: 'q_file' }) },
        { id: 'upl_pending', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'pending', scan_status: 'pending', metadata: JSON.stringify({ questionId: 'q_file' }) },
        { id: 'upl_other_event', tenant_id: 'tnt_1', event_id: 'evt_2', status: 'uploaded', scan_status: 'clean', metadata: JSON.stringify({ questionId: 'q_file' }) },
      ],
    });

    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_clean' },
    })).resolves.toBeUndefined();
    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_pending' },
    })).rejects.toThrow('not completed and clean');
    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_other_event' },
    })).rejects.toThrow('not completed and clean');
  });

  it('rejects referenced file-answer artifacts whose metadata questionId belongs to another question', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        { id: 'upl_mismatch', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'uploaded', scan_status: 'clean', metadata: JSON.stringify({ questionId: 'q_other' }) },
      ],
    });

    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_mismatch' },
    })).rejects.toThrow('different question');
  });

  it('rejects reuse of one metadata-bound file artifact across different question answers', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        { id: 'upl_shared', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'uploaded', scan_status: 'clean', metadata: JSON.stringify({ questionId: 'q_file' }) },
      ],
    });

    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_shared' },
      q_other: { artifactId: 'upl_shared' },
    })).rejects.toThrow('different question');
  });

  it('rejects file-answer artifacts without matching questionId metadata after scope and scan checks', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        { id: 'upl_missing', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'uploaded', scan_status: 'clean', metadata: JSON.stringify({}) },
        { id: 'upl_malformed', tenant_id: 'tnt_1', event_id: 'evt_1', status: 'uploaded', scan_status: 'clean', metadata: '{' },
      ],
    });

    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_missing' },
    })).rejects.toThrow('without question metadata');
    await expect(assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
      q_file: { artifactId: 'upl_malformed' },
    })).rejects.toThrow('without question metadata');
  });
});

describe('upload artifact routes', () => {
  beforeEach(() => {
    signedUrlInputs.length = 0;
    s3Send.mockReset();
  });

  it('rejects public completion with an invalid token before touching storage', async () => {
    const { db } = createMockDb({
      events: [{
        id: 'evt_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        status: 'published',
      }],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);
    const create = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/upload-artifacts',
      payload: { fileName: 'waiver.pdf', contentType: 'application/pdf', sizeBytes: 12, questionId: 'q_file' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    const complete = await app.inject({
      method: 'POST',
      url: `/public/upload-artifacts/${created.artifactId}/complete`,
      payload: { token: 'wrong-token' },
    });
    expect(complete.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires settings.write for authenticated brand-logo uploads', async () => {
    const { db, tables } = createMockDb({
      brands: [{
        id: 'brd_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
      }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['events.write'] }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: { purpose: 'brand_logo', brandId: 'brd_1', fileName: 'logo.png', contentType: 'image/png', sizeBytes: 12 },
    });
    expect(res.statusCode).toBe(403);
    expect(tables.upload_artifacts).toHaveLength(0);
    await app.close();
  });

  it('prevents tenants from downloading another tenant upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [{
        id: 'upl_other',
        tenant_id: 'tnt_other',
        status: 'uploaded',
        scan_status: 'clean',
        bucket: 'tixkit',
        object_key: 'uploads/tnt_other/file.png',
        content_type: 'image/png',
        file_name: 'file.png',
      }],
    });
    const app = await setupUploadApp(db);
    const res = await app.inject({ method: 'GET', url: '/upload-artifacts/upl_other/download' });
    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('prevents event-scoped principals from completing another event upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [{
        id: 'upl_evt_2_pending',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_2',
        purpose: 'checkout_answer',
        status: 'pending',
        scan_status: 'pending',
        bucket: 'tixkit',
        object_key: 'uploads/tnt_1/checkout-answers/evt_2/staging/upl_evt_2_pending.txt',
        content_type: 'text/plain',
        size_bytes: 5,
        expires_at: new Date(Date.now() + 60_000),
      }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ eventIds: ['evt_1'] }),
    );

    const res = await app.inject({ method: 'POST', url: '/upload-artifacts/upl_evt_2_pending/complete' });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('prevents event-scoped principals from downloading another event upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [{
        id: 'upl_evt_2_clean',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        event_id: 'evt_2',
        purpose: 'checkout_answer',
        status: 'uploaded',
        scan_status: 'clean',
        bucket: 'tixkit',
        object_key: 'uploads/tnt_1/checkout-answers/evt_2/final/upl_evt_2_clean.txt',
        content_type: 'text/plain',
        file_name: 'answer.txt',
      }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ eventIds: ['evt_1'] }),
    );

    const res = await app.inject({ method: 'GET', url: '/upload-artifacts/upl_evt_2_clean/download' });

    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('prevents brand-scoped principals from completing another brand upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [{
        id: 'upl_brd_2_pending',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_2',
        event_id: null,
        purpose: 'brand_logo',
        status: 'pending',
        scan_status: 'pending',
        bucket: 'tixkit',
        object_key: 'uploads/tnt_1/brand-logos/brd_2/staging/upl_brd_2_pending.png',
        content_type: 'image/png',
        size_bytes: 12,
        expires_at: new Date(Date.now() + 60_000),
      }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ brandIds: ['brd_1'] }),
    );

    const res = await app.inject({ method: 'POST', url: '/upload-artifacts/upl_brd_2_pending/complete' });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('prevents organization-scoped principals from downloading another organization upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [{
        id: 'upl_org_2_clean',
        tenant_id: 'tnt_1',
        organization_id: 'org_2',
        brand_id: null,
        event_id: null,
        purpose: 'user_avatar',
        status: 'uploaded',
        scan_status: 'clean',
        bucket: 'tixkit',
        object_key: 'uploads/tnt_1/avatars/usr_2/final/upl_org_2_clean.png',
        content_type: 'image/png',
        file_name: 'avatar.png',
      }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ organizationIds: ['org_1'] }),
    );

    const res = await app.inject({ method: 'GET', url: '/upload-artifacts/upl_org_2_clean/download' });

    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });
}
);
