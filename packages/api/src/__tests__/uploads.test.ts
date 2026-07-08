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
  getContentEmailImageArtifact,
  getBrandLogoArtifact,
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
      if (operator === 'is') return value === null ? row[column] == null : row[column] === value;
      if (operator === '<')
        return (
          new Date(row[column] as string | Date).getTime() <
          new Date(value as string | Date).getTime()
        );
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
            let updatedCount = 0;
            for (const row of rowsFor(table)) {
              if (matches(row, conditions)) {
                Object.assign(row, values);
                updatedCount += 1;
              }
            }
            return [{ numUpdatedRows: BigInt(updatedCount) }];
          },
          executeTakeFirst: async () => {
            let updatedCount = 0;
            for (const row of rowsFor(table)) {
              if (matches(row, conditions)) {
                Object.assign(row, values);
                updatedCount += 1;
              }
            }
            return { numUpdatedRows: BigInt(updatedCount) };
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

function fileQuestion(overrides: Row = {}): Row {
  return {
    id: 'q_file',
    event_id: 'evt_1',
    type: 'file',
    status: 'active',
    is_hidden: false,
    hidden_at: null,
    deleted_at: null,
    ...overrides,
  };
}

async function setupUploadApp(db: Database, routes = uploadRoutes, principal = makePrincipal()) {
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
  registerErrorHandler(app);
  await app.register(routes);
  return app;
}

describe('upload artifact service', () => {
  beforeEach(() => {
    signedUrlInputs.length = 0;
    s3Send.mockReset();
    delete process.env.UPLOAD_MALWARE_SCANNER;
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
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
    expect(artifact.completeUrl).toBe(
      `/v1/public/upload-artifacts/${artifact.artifactId}/complete`,
    );
    expect(artifact.completeToken).toBeTruthy();
    const signedPut = signedUrlInputs[0] as {
      command: Record<string, unknown>;
      options: { signableHeaders: Set<string> };
    };
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
    expect(stored.object_key).toBe(
      `uploads/tnt_1/checkout-answers/evt_1/staging/${artifact.artifactId}.pdf`,
    );
    expect(stored.file_name).toBe('..-waiver_.pdf');
    expect(stored.client_token_hash).toEqual(expect.any(String));
    expect(stored.client_token_hash).not.toBe(artifact.completeToken);
    expect(stored.metadata).toBe(JSON.stringify({ questionId: 'q_file' }));
  });

  it('rejects unsupported content types and oversized uploads before creating artifacts', async () => {
    const { db, tables } = createMockDb();
    await expect(
      createUploadArtifact(db, {
        tenantId: 'tnt_1',
        purpose: 'checkout_answer',
        fileName: 'script.html',
        contentType: 'text/html',
        sizeBytes: 10,
      }),
    ).rejects.toThrow('Unsupported upload content type');

    await expect(
      createUploadArtifact(db, {
        tenantId: 'tnt_1',
        purpose: 'brand_logo',
        fileName: 'logo.png',
        contentType: 'image/png',
        sizeBytes: 3 * 1024 * 1024,
      }),
    ).rejects.toThrow('Upload exceeds');
    expect(tables.upload_artifacts).toHaveLength(0);
  });

  it('rejects upload ticket creation in production before signing URLs when scanner is unavailable', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { db, tables } = createMockDb();

      await expect(
        createUploadArtifact(db, {
          tenantId: 'tnt_1',
          organizationId: 'org_1',
          brandId: 'brd_1',
          eventId: 'evt_1',
          purpose: 'checkout_answer',
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          metadata: { questionId: 'q_file' },
          publicComplete: true,
        }),
      ).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
        message: 'Upload malware scanner is unavailable',
      });

      expect(tables.upload_artifacts).toHaveLength(0);
      expect(signedUrlInputs).toHaveLength(0);
      expect(s3Send).not.toHaveBeenCalled();

      process.env.UPLOAD_MALWARE_SCANNER = 'eicar';
      await expect(
        createUploadArtifact(db, {
          tenantId: 'tnt_1',
          purpose: 'checkout_answer',
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow('Upload malware scanner is unavailable');

      process.env.UPLOAD_MALWARE_SCANNER = 'clamav';
      process.env.CLAMAV_HOST = '127.0.0.1';
      await expect(
        createUploadArtifact(db, {
          tenantId: 'tnt_1',
          purpose: 'checkout_answer',
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
        }),
      ).resolves.toMatchObject({
        uploadHeaders: { 'Content-Type': 'application/pdf' },
      });
    } finally {
      process.env.NODE_ENV = originalEnv;
      delete process.env.UPLOAD_MALWARE_SCANNER;
      delete process.env.CLAMAV_HOST;
    }
  });

  it('cleans expired pending staging objects opportunistically before creating new artifacts', async () => {
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_expired',
          status: 'pending',
          scan_status: 'pending',
          scan_result: null,
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/staging/upl_expired.txt',
          expires_at: new Date(Date.now() - 60_000),
        },
      ],
      questions: [fileQuestion()],
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
      questions: [fileQuestion()],
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

  it('rejects image uploads whose bytes do not match the declared content type', async () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fakeBytes = Buffer.from('not a real image');
    for (const purpose of ['brand_logo', 'user_avatar', 'content_email_image'] as const) {
      const { db, tables } = createMockDb();
      const artifact = await createUploadArtifact(db, {
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        purpose,
        fileName: 'fake.png',
        contentType: 'image/png',
        sizeBytes: fakeBytes.length,
      });
      s3Send
        .mockResolvedValueOnce({ ContentLength: fakeBytes.length, ContentType: 'image/png' })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => new Uint8Array(fakeBytes) },
        })
        .mockResolvedValueOnce({});

      await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
        'Uploaded image content does not match declared content type: image/png',
      );
      expect(tables.upload_artifacts[0]).toMatchObject({
        status: 'rejected',
        scan_status: 'blocked',
      });
      expect(tables.upload_artifacts[0].scan_result).toBe(
        'Uploaded image content does not match declared content type: image/png',
      );
    }

    const validPng = Buffer.concat([pngMagic, Buffer.alloc(64)]);
    const { db, tables } = createMockDb();
    const validArtifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'brand_logo',
      fileName: 'logo.png',
      contentType: 'image/png',
      sizeBytes: validPng.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: validPng.length, ContentType: 'image/png' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(validPng) },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    await expect(completeUploadArtifact(db, validArtifact.artifactId)).resolves.toEqual({
      artifactId: validArtifact.artifactId,
      status: 'uploaded',
      scanStatus: 'clean',
    });
    expect(tables.upload_artifacts[0]).toMatchObject({ status: 'uploaded' });
  });

  it('accepts valid JPEG, WebP, and GIF image bytes for content_email_image', async () => {
    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const webpMagic = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
      Buffer.alloc(4),
      Buffer.from([0x57, 0x45, 0x42, 0x50]),
    ]);
    const gifMagic = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const cases = [
      { name: 'jpeg', bytes: Buffer.concat([jpegMagic, Buffer.alloc(64)]), type: 'image/jpeg' },
      { name: 'webp', bytes: Buffer.concat([webpMagic, Buffer.alloc(64)]), type: 'image/webp' },
      { name: 'gif', bytes: Buffer.concat([gifMagic, Buffer.alloc(64)]), type: 'image/gif' },
    ];
    for (const c of cases) {
      const { db, tables } = createMockDb();
      const artifact = await createUploadArtifact(db, {
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        purpose: 'content_email_image',
        fileName: `image.${c.name}`,
        contentType: c.type,
        sizeBytes: c.bytes.length,
      });
      s3Send
        .mockResolvedValueOnce({ ContentLength: c.bytes.length, ContentType: c.type })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => new Uint8Array(c.bytes) },
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      await expect(completeUploadArtifact(db, artifact.artifactId)).resolves.toEqual({
        artifactId: artifact.artifactId,
        status: 'uploaded',
        scanStatus: 'clean',
      });
      expect(tables.upload_artifacts[0]).toMatchObject({ status: 'uploaded' });
    }
  });

  it('rejects SVG content type for brand_logo uploads', async () => {
    const { db, tables } = createMockDb();
    await expect(
      createUploadArtifact(db, {
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        purpose: 'brand_logo',
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 100,
      }),
    ).rejects.toThrow('Unsupported upload content type: image/svg+xml');
    expect(tables.upload_artifacts).toHaveLength(0);
  });

  it('returns already-clean uploaded artifacts without trusting or rescanning the old staging key', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_clean',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/final/upl_clean.txt',
          content_type: 'text/plain',
          size_bytes: 5,
          expires_at: new Date(Date.now() - 60_000),
        },
      ],
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

  it('fails closed for corrupt persisted upload artifact purposes before scanning', async () => {
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_future',
          status: 'pending',
          scan_status: 'pending',
          purpose: 'future_artifact',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/future/staging/upl_future.txt',
          content_type: 'text/plain',
          size_bytes: 5,
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    s3Send.mockResolvedValueOnce({ ContentLength: 5, ContentType: 'text/plain' });
    s3Send.mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, 'upl_future')).rejects.toThrow(
      'Uploaded object metadata is invalid: Unsupported upload purpose: future_artifact',
    );
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      scan_result:
        'Uploaded object metadata is invalid: Unsupported upload purpose: future_artifact',
    });
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(s3Send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: 'uploads/tnt_1/future/staging/upl_future.txt',
    });
    expect(s3Send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: 'uploads/tnt_1/future/staging/upl_future.txt',
    });
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

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'size does not match declared size',
    );
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      object_key: stagingKey,
    });
    expect(tables.upload_artifacts[0].scan_result).toBe(
      'Uploaded object size does not match declared size: expected 5 bytes, received 6 bytes',
    );
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

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'content type does not match declared content type',
    );
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
      object_key: stagingKey,
    });
    expect(tables.upload_artifacts[0].scan_result).toBe(
      'Uploaded object content type does not match declared content type: expected text/plain, received image/png',
    );
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

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'Uploaded object is missing from storage',
    );
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

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'Uploaded file failed malware scan',
    );
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
      await expect(scanUploadBuffer(Buffer.from('clean'))).rejects.toThrow(
        'Upload malware scanner is unavailable',
      );
      process.env.UPLOAD_MALWARE_SCANNER = 'eicar';
      await expect(scanUploadBuffer(Buffer.from('clean'))).rejects.toThrow(
        'Upload malware scanner is unavailable',
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
      delete process.env.UPLOAD_MALWARE_SCANNER;
    }
  });

  it('requires referenced file-answer artifacts to be completed, clean, tenant scoped, and event scoped', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_clean',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
        },
        {
          id: 'upl_pending',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'pending',
          scan_status: 'pending',
          metadata: JSON.stringify({ questionId: 'q_file' }),
        },
        {
          id: 'upl_other_event',
          tenant_id: 'tnt_1',
          event_id: 'evt_2',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_clean' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_pending' },
      }),
    ).rejects.toThrow('not completed and clean');
    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_other_event' },
      }),
    ).rejects.toThrow('not completed and clean');
  });

  it('rejects clean user-avatar artifacts even when checkout answer metadata matches', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_avatar',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'user_avatar',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_avatar' },
      }),
    ).rejects.toThrow('not a checkout answer upload');
  });

  it('rejects clean brand-logo artifacts even when checkout answer metadata matches', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_logo',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'brand_logo',
          status: 'uploaded',
          scan_status: 'clean',
          content_type: 'image/svg+xml',
          metadata: JSON.stringify({ questionId: 'q_file' }),
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_logo' },
      }),
    ).rejects.toThrow('not a checkout answer upload');
  });

  it('rejects referenced file-answer artifacts whose metadata questionId belongs to another question', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_mismatch',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_other' }),
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_mismatch' },
      }),
    ).rejects.toThrow('different question');
  });

  it('rejects reuse of one metadata-bound file artifact across different question answers', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_shared',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_shared' },
        q_other: { artifactId: 'upl_shared' },
      }),
    ).rejects.toThrow('only be used once');
  });

  it('rejects duplicate file artifact reuse and claims clean artifacts for one checkout session', async () => {
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_clean',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
          consumed_by_checkout_session_id: null,
        },
        {
          id: 'upl_other',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_other' }),
          consumed_by_checkout_session_id: null,
        },
      ],
    });
    const claimedArtifactIds = new Set<string>();

    await expect(
      assertCompletedUploadArtifacts(
        db,
        'tnt_1',
        'evt_1',
        {
          q_file: { artifactId: 'upl_clean' },
          q_other: { artifactId: 'upl_clean' },
        },
        { checkoutSessionId: 'cs_1', claimedArtifactIds },
      ),
    ).rejects.toThrow('only be used once');

    await expect(
      assertCompletedUploadArtifacts(
        db,
        'tnt_1',
        'evt_1',
        { q_file: { artifactId: 'upl_clean' } },
        { checkoutSessionId: 'cs_1', claimedArtifactIds },
      ),
    ).resolves.toBeUndefined();
    expect(tables.upload_artifacts[0]).toMatchObject({
      consumed_by_checkout_session_id: 'cs_1',
    });
    expect(claimedArtifactIds.has('upl_clean')).toBe(true);

    await expect(
      assertCompletedUploadArtifacts(
        db,
        'tnt_1',
        'evt_1',
        { q_other: { artifactId: 'upl_other' } },
        { checkoutSessionId: 'cs_1', claimedArtifactIds },
      ),
    ).resolves.toBeUndefined();
    expect(tables.upload_artifacts[1]).toMatchObject({
      consumed_by_checkout_session_id: 'cs_1',
    });
  });

  it('rejects file artifact replay from another checkout session', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_consumed',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({ questionId: 'q_file' }),
          consumed_by_checkout_session_id: 'cs_existing',
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(
        db,
        'tnt_1',
        'evt_1',
        { q_file: { artifactId: 'upl_consumed' } },
        { checkoutSessionId: 'cs_other', claimedArtifactIds: new Set() },
      ),
    ).rejects.toThrow('already been used');
  });

  it('rejects file-answer artifacts without matching questionId metadata after scope and scan checks', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_missing',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: JSON.stringify({}),
        },
        {
          id: 'upl_malformed',
          tenant_id: 'tnt_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          metadata: '{',
        },
      ],
    });

    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_missing' },
      }),
    ).rejects.toThrow('without question metadata');
    await expect(
      assertCompletedUploadArtifacts(db, 'tnt_1', 'evt_1', {
        q_file: { artifactId: 'upl_malformed' },
      }),
    ).rejects.toThrow('without question metadata');
  });
});

describe('upload artifact routes', () => {
  beforeEach(() => {
    signedUrlInputs.length = 0;
    s3Send.mockReset();
    delete process.env.UPLOAD_MALWARE_SCANNER;
    delete process.env.CLAMAV_HOST;
  });

  it('rejects public completion with an invalid token before touching storage', async () => {
    const { db } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
        },
      ],
      questions: [fileQuestion()],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);
    const create = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/upload-artifacts',
      payload: {
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        questionId: 'q_file',
      },
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

  it('returns 503 before issuing public upload tickets when production scanner is unavailable', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { db, tables } = createMockDb({
        events: [
          {
            id: 'evt_1',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            brand_id: 'brd_1',
            status: 'published',
          },
        ],
        questions: [fileQuestion()],
      });
      const app = await setupUploadApp(db, publicUploadRoutes);
      const response = await app.inject({
        method: 'POST',
        url: '/public/events/evt_1/upload-artifacts',
        payload: {
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 12,
          questionId: 'q_file',
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Upload malware scanner is unavailable',
        },
      });
      expect(tables.upload_artifacts).toHaveLength(0);
      expect(signedUrlInputs).toHaveLength(0);
      await app.close();
    } finally {
      process.env.NODE_ENV = originalEnv;
      delete process.env.UPLOAD_MALWARE_SCANNER;
      delete process.env.CLAMAV_HOST;
    }
  });

  it('rejects public upload tickets without an active file question before signing', async () => {
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
        },
      ],
      questions: [
        fileQuestion({ id: 'q_text', type: 'text' }),
        fileQuestion({ id: 'q_hidden', status: 'hidden' }),
      ],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);

    const missingQuestionId = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/upload-artifacts',
      payload: {
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
      },
    });
    const nonFileQuestion = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/upload-artifacts',
      payload: {
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        questionId: 'q_text',
      },
    });
    const hiddenQuestion = await app.inject({
      method: 'POST',
      url: '/public/events/evt_1/upload-artifacts',
      payload: {
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        questionId: 'q_hidden',
      },
    });

    expect(missingQuestionId.statusCode).toBe(400);
    expect(nonFileQuestion.statusCode).toBe(400);
    expect(hiddenQuestion.statusCode).toBe(400);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('requires settings.write for authenticated brand-logo uploads', async () => {
    const { db, tables } = createMockDb({
      brands: [
        {
          id: 'brd_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: ['events.write'] }));
    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'brand_logo',
        brandId: 'brd_1',
        fileName: 'logo.png',
        contentType: 'image/png',
        sizeBytes: 12,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(tables.upload_artifacts).toHaveLength(0);
    await app.close();
  });

  it('allows messages.write principals to create content email image uploads scoped to the event brand', async () => {
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'draft',
        },
      ],
      content_documents: [
        {
          id: 'cdoc_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          channel: 'email',
        },
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['messages.write'] }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'content_email_image',
        brandId: 'brd_1',
        eventId: 'evt_1',
        fileName: 'hero.png',
        contentType: 'image/png',
        sizeBytes: 12,
        metadata: { source: 'admin_email_editor', contentDocumentId: 'cdoc_1' },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(tables.upload_artifacts).toHaveLength(1);
    expect(tables.upload_artifacts[0]).toMatchObject({
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      purpose: 'content_email_image',
      content_type: 'image/png',
    });
    expect(String(tables.upload_artifacts[0]?.object_key)).toContain('content-email-images');
    expect(signedUrlInputs).toHaveLength(1);
    await app.close();
  });

  it('rejects content email image uploads without messages.write', async () => {
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'draft',
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: ['events.write'] }));

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'content_email_image',
        brandId: 'brd_1',
        eventId: 'evt_1',
        fileName: 'hero.png',
        contentType: 'image/png',
        sizeBytes: 12,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('requires content email image metadata documents to match the same email document scope', async () => {
    const event = {
      id: 'evt_1',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      status: 'draft',
    };
    const basePayload = {
      purpose: 'content_email_image',
      brandId: 'brd_1',
      eventId: 'evt_1',
      fileName: 'hero.png',
      contentType: 'image/png',
      sizeBytes: 12,
    };

    const wrongChannelDb = createMockDb({
      events: [event],
      content_documents: [
        {
          id: 'cdoc_sms',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          channel: 'sms',
        },
      ],
    });
    const wrongChannelApp = await setupUploadApp(
      wrongChannelDb.db,
      uploadRoutes,
      makePrincipal({ scopes: ['messages.write'] }),
    );
    const wrongChannel = await wrongChannelApp.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: { ...basePayload, metadata: { contentDocumentId: 'cdoc_sms' } },
    });
    expect(wrongChannel.statusCode).toBe(400);
    expect(wrongChannelDb.tables.upload_artifacts).toHaveLength(0);
    await wrongChannelApp.close();

    const wrongEventDb = createMockDb({
      events: [event],
      content_documents: [
        {
          id: 'cdoc_other_event',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_other',
          channel: 'email',
        },
      ],
    });
    const wrongEventApp = await setupUploadApp(
      wrongEventDb.db,
      uploadRoutes,
      makePrincipal({ scopes: ['messages.write'] }),
    );
    const wrongEvent = await wrongEventApp.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: { ...basePayload, metadata: { contentDocumentId: 'cdoc_other_event' } },
    });
    expect(wrongEvent.statusCode).toBe(404);
    expect(wrongEventDb.tables.upload_artifacts).toHaveLength(0);
    await wrongEventApp.close();
  });

  it('rejects content email image uploads outside the event brand scope', async () => {
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'draft',
        },
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['messages.write'] }),
    );

    const missingEvent = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'content_email_image',
        brandId: 'brd_1',
        fileName: 'hero.png',
        contentType: 'image/png',
        sizeBytes: 12,
      },
    });
    const mismatchedBrand = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'content_email_image',
        brandId: 'brd_other',
        eventId: 'evt_1',
        fileName: 'hero.png',
        contentType: 'image/png',
        sizeBytes: 12,
      },
    });
    const checkoutMetadata = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'content_email_image',
        brandId: 'brd_1',
        eventId: 'evt_1',
        fileName: 'hero.png',
        contentType: 'image/png',
        sizeBytes: 12,
        metadata: { questionId: 'q_file' },
      },
    });

    expect(missingEvent.statusCode).toBe(400);
    expect(mismatchedBrand.statusCode).toBe(400);
    expect(checkoutMetadata.statusCode).toBe(400);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('allows messages.write principals to complete and download scoped content email image artifacts', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_email_pending',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'content_email_image',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/content-email-images/evt_1/staging/upl_email_pending.png',
          content_type: 'image/png',
          file_name: 'hero.png',
          size_bytes: 12,
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['messages.write'] }),
    );
    const imageBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]);
    s3Send
      .mockResolvedValueOnce({ ContentLength: 12, ContentType: 'image/png' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => imageBytes },
        ContentType: 'image/png',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const complete = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_email_pending/complete',
    });
    expect(complete.statusCode).toBe(200);

    const download = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_email_pending/download',
    });
    expect(download.statusCode).toBe(200);
    expect(signedUrlInputs).toHaveLength(0);
    expect(download.json()).toMatchObject({
      downloadUrl: '/v1/public/content-email-images/upl_email_pending',
      durable: true,
    });
    await app.close();
  });

  it('returns a durable public URL for clean brand-logo artifact downloads', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_logo_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: null,
          purpose: 'brand_logo',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/brand-logos/brd_1/final/upl_logo_clean.png',
          content_type: 'image/png',
          file_name: 'logo.png',
          size_bytes: 12,
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes);

    const download = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_logo_clean/download',
    });

    expect(download.statusCode).toBe(200);
    expect(signedUrlInputs).toHaveLength(0);
    expect(download.json()).toMatchObject({
      downloadUrl: '/v1/public/brand-logos/upl_logo_clean',
      durable: true,
    });
    await app.close();
  });

  it('serves content email images via the public route with inline disposition and long cache lifetime', async () => {
    const { Readable } = await import('node:stream');
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_email_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'content_email_image',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/content-email-images/evt_1/final/upl_email_clean.png',
          content_type: 'image/png',
          file_name: 'hero.png',
          size_bytes: 12,
        },
      ],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);
    const imageStream = Readable.from([Buffer.from('image-data')]);
    s3Send.mockResolvedValueOnce({ Body: imageStream, ContentType: 'image/png' });

    const res = await app.inject({
      method: 'GET',
      url: '/public/content-email-images/upl_email_clean',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['content-disposition']).toContain('hero.png');
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    await app.close();
  });

  it('serves brand logos via the public route with inline disposition and long cache lifetime', async () => {
    const { Readable } = await import('node:stream');
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_logo_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: null,
          purpose: 'brand_logo',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/brand-logos/brd_1/final/upl_logo_clean.png',
          content_type: 'image/png',
          file_name: 'logo.png',
          size_bytes: 12,
        },
      ],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);
    const imageStream = Readable.from([Buffer.from('logo-data')]);
    s3Send.mockResolvedValueOnce({ Body: imageStream, ContentType: 'image/png' });

    const res = await app.inject({
      method: 'GET',
      url: '/public/brand-logos/upl_logo_clean',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.headers['content-disposition']).toContain('logo.png');
    expect(res.headers['cache-control']).toContain('max-age=31536000');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    await app.close();
  });

  it('rejects non-content-email-image artifacts via the public content email image route', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_checkout_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/final/upl_checkout_clean.txt',
          content_type: 'text/plain',
          file_name: 'answer.txt',
        },
      ],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/public/content-email-images/upl_checkout_clean',
    });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects pending or non-clean content email images via the public route', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_email_pending',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'content_email_image',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/content-email-images/evt_1/staging/upl_email_pending.png',
          content_type: 'image/png',
          file_name: 'hero.png',
          size_bytes: 12,
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    const app = await setupUploadApp(db, publicUploadRoutes);

    const res = await app.inject({
      method: 'GET',
      url: '/public/content-email-images/upl_email_pending',
    });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('getContentEmailImageArtifact returns artifact metadata for clean content_email_image', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_email_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'content_email_image',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/content-email-images/evt_1/final/upl_email_clean.png',
          content_type: 'image/png',
          file_name: 'hero.png',
        },
      ],
    });

    const artifact = await getContentEmailImageArtifact(db, 'upl_email_clean');
    expect(artifact).toMatchObject({
      bucket: 'tixkit',
      objectKey: 'uploads/tnt_1/content-email-images/evt_1/final/upl_email_clean.png',
      contentType: 'image/png',
      fileName: 'hero.png',
    });
  });

  it('getBrandLogoArtifact returns artifact metadata for clean brand_logo', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_logo_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: null,
          purpose: 'brand_logo',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/brand-logos/brd_1/final/upl_logo_clean.png',
          content_type: 'image/png',
          file_name: 'logo.png',
        },
      ],
    });

    const artifact = await getBrandLogoArtifact(db, 'upl_logo_clean');
    expect(artifact).toMatchObject({
      bucket: 'tixkit',
      objectKey: 'uploads/tnt_1/brand-logos/brd_1/final/upl_logo_clean.png',
      contentType: 'image/png',
      fileName: 'logo.png',
    });
  });

  it('getContentEmailImageArtifact rejects non-content-email-image artifacts', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_checkout',
          tenant_id: 'tnt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/final/upl_checkout.txt',
          content_type: 'text/plain',
          file_name: 'answer.txt',
        },
      ],
    });

    await expect(getContentEmailImageArtifact(db, 'upl_checkout')).rejects.toThrow();
  });

  it('rejects authenticated user-avatar uploads with checkout event scope or question metadata', async () => {
    const { db, tables } = createMockDb();
    const app = await setupUploadApp(db);

    const eventScoped = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'user_avatar',
        eventId: 'evt_1',
        fileName: 'avatar.png',
        contentType: 'image/png',
        sizeBytes: 12,
      },
    });
    const brandScoped = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'user_avatar',
        brandId: 'brd_1',
        fileName: 'avatar.png',
        contentType: 'image/png',
        sizeBytes: 12,
      },
    });
    const questionScoped = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'user_avatar',
        fileName: 'avatar.png',
        contentType: 'image/png',
        sizeBytes: 12,
        metadata: { questionId: 'q_file' },
      },
    });

    expect(eventScoped.statusCode).toBe(400);
    expect(brandScoped.statusCode).toBe(400);
    expect(questionScoped.statusCode).toBe(400);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('rejects brand-logo uploads with checkout event scope or question metadata before creating artifacts', async () => {
    const { db, tables } = createMockDb({
      brands: [
        {
          id: 'brd_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
        },
      ],
    });
    const app = await setupUploadApp(db);

    const eventScoped = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'brand_logo',
        brandId: 'brd_1',
        eventId: 'evt_1',
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 12,
        metadata: { questionId: 'q_file' },
      },
    });
    const questionScoped = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'brand_logo',
        brandId: 'brd_1',
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 12,
        metadata: { questionId: 'q_file' },
      },
    });

    expect(eventScoped.statusCode).toBe(400);
    expect(questionScoped.statusCode).toBe(400);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('requires authenticated checkout-answer uploads to reference an active file question', async () => {
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
        },
      ],
      questions: [fileQuestion(), fileQuestion({ id: 'q_text', type: 'text' })],
    });
    const app = await setupUploadApp(db);

    const missingMetadata = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'checkout_answer',
        eventId: 'evt_1',
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
      },
    });
    const nonFileQuestion = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'checkout_answer',
        eventId: 'evt_1',
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        metadata: { questionId: 'q_text' },
      },
    });
    const fileQuestionUpload = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'checkout_answer',
        eventId: 'evt_1',
        fileName: 'waiver.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        metadata: { questionId: 'q_file' },
      },
    });

    expect(missingMetadata.statusCode).toBe(400);
    expect(nonFileQuestion.statusCode).toBe(400);
    expect(fileQuestionUpload.statusCode).toBe(201);
    expect(tables.upload_artifacts).toHaveLength(1);
    expect(signedUrlInputs).toHaveLength(1);
    await app.close();
  });

  it('prevents tenants from downloading another tenant upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_other',
          tenant_id: 'tnt_other',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_other/file.png',
          content_type: 'image/png',
          file_name: 'file.png',
        },
      ],
    });
    const app = await setupUploadApp(db);
    const res = await app.inject({ method: 'GET', url: '/upload-artifacts/upl_other/download' });
    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('prevents event-scoped principals from completing another event upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
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
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ eventIds: ['evt_1'] }));

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_evt_2_pending/complete',
    });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires events.write to complete checkout answer artifacts', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_evt_1_pending',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/staging/upl_evt_1_pending.txt',
          content_type: 'text/plain',
          size_bytes: 5,
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: ['events.read'] }));

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_evt_1_pending/complete',
    });

    expect(res.statusCode).toBe(403);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('prevents event-scoped principals from downloading another event upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
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
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ eventIds: ['evt_1'] }));

    const res = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_evt_2_clean/download',
    });

    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('allows events.read principals to download scoped checkout answer artifacts', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_evt_1_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'checkout_answer',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/checkout-answers/evt_1/final/upl_evt_1_clean.txt',
          content_type: 'text/plain',
          file_name: 'answer.txt',
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: ['events.read'] }));

    const res = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_evt_1_clean/download',
    });

    expect(res.statusCode).toBe(200);
    expect(signedUrlInputs).toHaveLength(1);
    await app.close();
  });

  it('denies complete and download for unknown upload artifact purposes', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_unknown',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'future_artifact',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/future/upl_unknown.txt',
          content_type: 'text/plain',
          file_name: 'future.txt',
        },
      ],
    });
    const app = await setupUploadApp(db);

    const complete = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_unknown/complete',
    });
    const download = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_unknown/download',
    });

    expect(complete.statusCode).toBe(403);
    expect(download.statusCode).toBe(403);
    expect(s3Send).not.toHaveBeenCalled();
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('prevents brand-scoped principals from completing another brand upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
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
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ brandIds: ['brd_1'] }));

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_brd_2_pending/complete',
    });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('prevents organization-scoped principals from downloading another organization upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
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
        },
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ organizationIds: ['org_1'] }),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_org_2_clean/download',
    });

    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('prevents principals from completing another user avatar upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_avatar_other_pending',
          tenant_id: 'tnt_1',
          organization_id: null,
          brand_id: null,
          event_id: null,
          created_by_user_id: 'usr_2',
          purpose: 'user_avatar',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/avatars/usr_2/staging/upl_avatar_other_pending.png',
          content_type: 'image/png',
          size_bytes: 12,
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    const app = await setupUploadApp(db);

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_avatar_other_pending/complete',
    });

    expect(res.statusCode).toBe(404);
    expect(s3Send).not.toHaveBeenCalled();
    await app.close();
  });

  it('prevents principals from downloading another user avatar upload artifact', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_avatar_other_clean',
          tenant_id: 'tnt_1',
          organization_id: null,
          brand_id: null,
          event_id: null,
          created_by_user_id: 'usr_2',
          purpose: 'user_avatar',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/avatars/usr_2/final/upl_avatar_other_clean.png',
          content_type: 'image/png',
          file_name: 'avatar.png',
        },
      ],
    });
    const app = await setupUploadApp(db);

    const res = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_avatar_other_clean/download',
    });

    expect(res.statusCode).toBe(404);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });
});
