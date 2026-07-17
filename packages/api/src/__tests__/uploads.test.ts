import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
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
import { attachEventMedia, EVENT_MEDIA_RENDITION_MAX_BYTES } from '../services/event-media.js';
import sharp from 'sharp';

const s3Send = vi.fn();
const signedUrlInputs: unknown[] = [];
const s3ClientOptions: unknown[] = [];

async function deterministicNoisePng(width = 1600, height = 1000): Promise<Buffer> {
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let state = 0x6d2b79f5;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

function animatedGif(frameCount: number): Buffer {
  const header = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xff, 0xff,
  ]);
  const frame = Buffer.from([
    0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
  ]);
  return Buffer.concat([
    header,
    ...Array.from({ length: frameCount }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

function buildClassicCheckoutPdf(objectBodies: string[], trailer = '/Size 4 /Root 1 0 R'): Buffer {
  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let objects = header;
  for (const body of objectBodies) {
    offsets.push(Buffer.byteLength(objects, 'latin1'));
    objects += body;
  }
  const xrefOffset = Buffer.byteLength(objects, 'latin1');
  return Buffer.from(`${objects}xref
0 ${objectBodies.length + 1}
0000000000 65535 f
${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n`).join('\n')}
trailer
<< ${trailer} >>
startxref
${xrefOffset}
%%EOF
`);
}

function safeCheckoutPdf(extraCatalogEntries = ''): Buffer {
  return buildClassicCheckoutPdf([
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${extraCatalogEntries} >>\nendobj\n`,
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
  ]);
}

function checkoutPdfWithStream(length: string, boundary = '\nendstream'): Buffer {
  return buildClassicCheckoutPdf(
    [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n',
      `4 0 obj\n<< /Length ${length} >>\nstream\nhello${boundary}\nendobj\n`,
    ],
    '/Size 5 /Root 1 0 R',
  );
}

function checkoutPdfWithObjectTrailingPayload(): Buffer {
  return buildClassicCheckoutPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\nTRAILING_PAYLOAD\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
  ]);
}

function checkoutPdfWithRootDictionary(rootDictionary: string): Buffer {
  return buildClassicCheckoutPdf([
    `1 0 obj\n${rootDictionary}\nendobj\n`,
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
  ]);
}

async function startClamAvTestServer(
  behavior: {
    response?: Buffer | string;
    disconnect?: boolean;
    responseDelayMs?: number;
    dripIntervalMs?: number;
  } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (behavior.disconnect) {
      socket.destroy();
      return;
    }
    const response = behavior.response;
    let request = Buffer.alloc(0);
    let responded = false;
    let dripTimer: NodeJS.Timeout | undefined;
    socket.on('close', () => {
      if (dripTimer) clearInterval(dripTimer);
    });
    socket.on('data', (chunk) => {
      if (responded) return;
      request = Buffer.concat([request, chunk]);
      const command = Buffer.from('zINSTREAM\0');
      if (request.length < command.length) return;
      if (!request.subarray(0, command.length).equals(command)) {
        socket.destroy();
        return;
      }
      let offset = command.length;
      let complete = false;
      while (offset + 4 <= request.length) {
        const size = request.readUInt32BE(offset);
        offset += 4;
        if (size === 0) {
          if (offset !== request.length) socket.destroy();
          else complete = true;
          break;
        }
        if (offset + size > request.length) return;
        offset += size;
      }
      if (!complete) return;
      responded = true;
      if (response === undefined) return;
      const sendResponse = (): void => {
        if (!behavior.dripIntervalMs) {
          socket.end(response);
          return;
        }
        const bytes = Buffer.from(response);
        let responseOffset = 0;
        dripTimer = setInterval(() => {
          if (responseOffset >= bytes.length) {
            clearInterval(dripTimer);
            dripTimer = undefined;
            socket.end();
            return;
          }
          socket.write(bytes.subarray(responseOffset, responseOffset + 1));
          responseOffset += 1;
        }, behavior.dripIntervalMs);
      };
      if (behavior.responseDelayMs) setTimeout(sendResponse, behavior.responseDelayMs);
      else sendResponse();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test ClamAV server has no TCP port');
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function mutatePdfXrefRow(pdf: Buffer, rowIndex: number, row: string): Buffer {
  const source = pdf.toString('latin1');
  const rows = [...source.matchAll(/^\d{10} \d{5} [nf]$/gm)];
  const target = rows[rowIndex];
  if (!target || row.length !== target[0].length) throw new Error('Invalid test xref mutation');
  return Buffer.from(
    `${source.slice(0, target.index)}${row}${source.slice(target.index! + target[0].length)}`,
    'latin1',
  );
}

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    constructor(options: unknown) {
      s3ClientOptions.push(options);
    }
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
  return {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, command, options) => {
    signedUrlInputs.push({ command: command.input, options });
    return `https://s3.test/${encodeURIComponent(String(command.input.Key))}`;
  }),
}));

type Row = Record<string, unknown>;
type RowPredicate = (row: Row) => boolean;

function createMockDb(
  seed: Record<string, Row[]> = {},
  options: { onUpdate?: (table: string, row: Row, values: Row) => void } = {},
) {
  const tables: Record<string, Row[]> = { upload_artifacts: [], ...seed };

  function rowsFor(table: string): Row[] {
    tables[table] ??= [];
    return tables[table];
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping -- this helper is local to the lightweight Kysely mock.
  function matches(row: Row, conditions: Array<[string, string, unknown] | RowPredicate>): boolean {
    return conditions.every((condition) => {
      if (typeof condition === 'function') return condition(row);
      const [column, operator, value] = condition;
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
    const conditions: Array<[string, string, unknown] | RowPredicate> = [];
    let limitCount: number | undefined;
    const query = {
      select: () => query,
      selectAll: () => query,
      orderBy: () => query,
      forUpdate: () => query,
      limit(value: number) {
        limitCount = value;
        return query;
      },
      where(
        column: string | ((eb: RowPredicateBuilder) => RowPredicate),
        operator?: string,
        value?: unknown,
      ) {
        conditions.push(
          typeof column === 'function'
            ? column(createPredicateBuilder())
            : [column, operator!, value],
        );
        return query;
      },
      executeTakeFirst: async () => {
        const row = rowsFor(table).find((candidate) => matches(candidate, conditions));
        return row ? { ...row } : undefined;
      },
      execute: async () => {
        const result = rowsFor(table)
          .filter((row) => matches(row, conditions))
          .map((row) => ({ ...row }));
        return typeof limitCount === 'number' ? result.slice(0, limitCount) : result;
      },
    };
    return query;
  }

  function insertInto(table: string) {
    return {
      values(values: Row | Row[]) {
        return {
          execute: async () => {
            rowsFor(table).push(
              ...(Array.isArray(values) ? values : [values]).map((value) => ({
                ...value,
              })),
            );
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
                options.onUpdate?.(table, row, values);
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
                options.onUpdate?.(table, row, values);
                updatedCount += 1;
              }
            }
            return { numUpdatedRows: BigInt(updatedCount) };
          },
        };
      },
    };
  }

  function deleteFrom(table: string) {
    const conditions: Array<[string, string, unknown]> = [];
    const query = {
      where(column: string, operator: string, value: unknown) {
        conditions.push([column, operator, value]);
        return query;
      },
      execute: async () => {
        const retained = rowsFor(table).filter((row) => !matches(row, conditions));
        const deleted = rowsFor(table).length - retained.length;
        tables[table] = retained;
        return [{ numDeletedRows: BigInt(deleted) }];
      },
    };
    return query;
  }

  const db = {
    selectFrom,
    insertInto,
    updateTable,
    deleteFrom,
  } as unknown as Database;
  Object.assign(db, {
    transaction: () => ({
      execute: (work: (transaction: Database) => unknown) => work(db),
    }),
  });
  return { tables, db };
}

type RowPredicateBuilder = ((column: string, operator: string, value: unknown) => RowPredicate) & {
  or: (predicates: RowPredicate[]) => RowPredicate;
  and: (predicates: RowPredicate[]) => RowPredicate;
};

function createPredicateBuilder(): RowPredicateBuilder {
  const builder = ((column: string, operator: string, value: unknown) => (row: Row) => {
    if (operator === 'in' && Array.isArray(value)) return value.includes(row[column]);
    if (operator === '<')
      return (
        new Date(row[column] as string | Date).getTime() <
        new Date(value as string | Date).getTime()
      );
    return row[column] === value;
  }) as RowPredicateBuilder;
  builder.or = (predicates) => (row) => predicates.some((predicate) => predicate(row));
  builder.and = (predicates) => (row) => predicates.every((predicate) => predicate(row));
  return builder;
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
    s3ClientOptions.length = 0;
    s3Send.mockReset();
    delete process.env.S3_PUBLIC_ENDPOINT;
    delete process.env.UPLOAD_MALWARE_SCANNER;
    delete process.env.CLAMAV_HOST;
    delete process.env.CLAMAV_PORT;
    delete process.env.CLAMAV_TIMEOUT_MS;
  });

  it('signs browser-facing object URLs against the public storage endpoint', async () => {
    process.env.S3_PUBLIC_ENDPOINT = 'http://localhost:59002';
    const { db } = createMockDb();

    await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      purpose: 'migration_import',
      fileName: 'portable.tixkit.json',
      contentType: 'application/vnd.tixkit.portable+json',
      sizeBytes: 1024,
    });

    expect(s3ClientOptions.at(-1)).toMatchObject({
      endpoint: 'http://localhost:59002',
    });
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
    expect(artifact.uploadHeaders).toEqual({
      'Content-Type': 'application/pdf',
    });
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
      process.env.CLAMAV_PORT = '0';
      await expect(
        createUploadArtifact(db, {
          tenantId: 'tnt_1',
          purpose: 'checkout_answer',
          fileName: 'waiver.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
        }),
      ).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Upload malware scanner is unavailable',
      });

      process.env.CLAMAV_PORT = '3310';
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
      delete process.env.CLAMAV_PORT;
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
      status: 'cleanup_complete',
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

    expect(tables.upload_artifacts.filter((row) => row.status === 'cleanup_complete')).toHaveLength(
      1,
    );
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('claims an expired artifact once across concurrent cleanup workers', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_concurrent',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/staging/upl_concurrent.txt',
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
    });
    s3Send.mockResolvedValue({});

    const results = await Promise.all([
      cleanupExpiredUploadArtifacts(db, now),
      cleanupExpiredUploadArtifacts(db, now),
    ]);

    expect(results.reduce((sum, result) => sum + result, 0)).toBe(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'cleanup_complete',
    });
    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('reclaims an aged cleanup claim and moves it to a terminal state', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_stale_claim',
          status: 'cleanup_pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/staging/upl_stale_claim.txt',
          expires_at: new Date(now.getTime() - 60_000),
          updated_at: new Date(now.getTime() - 16 * 60_000),
        },
      ],
    });
    s3Send.mockResolvedValue({});

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'cleanup_complete',
      scan_status: 'blocked',
    });
  });

  it('retains immutable completed event media when recovering an aged cleanup claim', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_media_stale_claim',
          status: 'cleanup_pending',
          scan_status: 'clean',
          purpose: 'event_social',
          checksum_sha256: 'a'.repeat(64),
          bucket: 'tixkit',
          object_key: `uploads/tnt_1/event-social/final/upl_media.webp/${'a'.repeat(64)}`,
          expires_at: new Date(now.getTime() - 60_000),
          updated_at: new Date(now.getTime() - 16 * 60_000),
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(1);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]?.status).toBe('cleanup_complete');
  });

  it('renews referenced event media and never deletes it', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_cover',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/event-cover/upl_cover.png',
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          cover_image_url: '/v1/public/event-media/event_cover/upl_cover',
          seo: '{}',
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]?.status).toBe('uploaded');
    expect(new Date(tables.upload_artifacts[0]?.expires_at as Date).getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  it('renews structured poster media attachments without relying on legacy event URLs', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_poster',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_poster',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/shared-original.jpg',
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
      event_media_assets: [
        {
          id: 'ema_poster',
          upload_artifact_id: 'upl_poster',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]?.status).toBe('uploaded');
    expect(new Date(tables.upload_artifacts[0]?.expires_at as Date).getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  it('renews a recently active migration from relational linkage despite malformed metadata', async () => {
    const now = new Date();
    const objectKey = 'uploads/tnt_1/migration-imports/org_1/final/upl_migration_active.json';
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_migration_active',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: objectKey,
          content_type: 'application/vnd.tixkit.portable+json',
          size_bytes: 10,
          checksum_sha256: 'a'.repeat(64),
          metadata: '{malformed',
          consumed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
      import_job_files: [
        {
          id: 'imf_active',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          import_job_id: 'imp_active',
          object_key: objectKey,
          media_type: 'application/vnd.tixkit.portable+json',
          byte_size: 10,
          sha256: 'a'.repeat(64),
          status: 'ready',
        },
      ],
      import_jobs: [
        {
          id: 'imp_active',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          status: 'preparing',
          updated_at: now,
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]?.status).toBe('uploaded');
    expect(new Date(tables.upload_artifacts[0]?.expires_at as Date).getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  it('cleans stale pending, failed, and paused migration registrations after retention', async () => {
    const now = new Date();
    const statuses = ['pending', 'failed', 'paused'];
    const uploadArtifacts = statuses.map((_status, index) => ({
      id: `upl_migration_stale_${index}`,
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      purpose: 'migration_import',
      status: 'uploaded',
      scan_status: 'clean',
      bucket: 'tixkit',
      object_key: `uploads/tnt_1/migration-imports/org_1/final/upl_migration_stale_${index}.json`,
      content_type: 'application/vnd.tixkit.portable+json',
      size_bytes: 10,
      checksum_sha256: 'b'.repeat(64),
      metadata: '{}',
      consumed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      expires_at: new Date(now.getTime() - 60_000),
    }));
    const { db, tables } = createMockDb({
      upload_artifacts: uploadArtifacts,
      import_job_files: statuses.map((_status, index) => ({
        id: `imf_stale_${index}`,
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        import_job_id: `imp_stale_${index}`,
        object_key: uploadArtifacts[index]!.object_key,
        media_type: 'application/vnd.tixkit.portable+json',
        byte_size: 10,
        sha256: 'b'.repeat(64),
        status: 'ready',
      })),
      import_jobs: statuses.map((status, index) => ({
        id: `imp_stale_${index}`,
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        status,
        updated_at: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      })),
    });
    s3Send.mockResolvedValue({});

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(3);
    expect(s3Send).toHaveBeenCalledTimes(3);
    expect(tables.upload_artifacts.every((row) => row.status === 'cleanup_complete')).toBe(true);
  });

  it('enforces the absolute retention ceiling for a recently active migration', async () => {
    const now = new Date();
    const objectKey = 'uploads/tnt_1/migration-imports/org_1/final/upl_migration_max.json';
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_migration_max',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: objectKey,
          content_type: 'application/vnd.tixkit.portable+json',
          size_bytes: 10,
          checksum_sha256: 'c'.repeat(64),
          metadata: '{}',
          consumed_at: new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000),
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
      import_job_files: [
        {
          id: 'imf_max',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          import_job_id: 'imp_max',
          object_key: objectKey,
          media_type: 'application/vnd.tixkit.portable+json',
          byte_size: 10,
          sha256: 'c'.repeat(64),
          status: 'ready',
        },
      ],
      import_jobs: [
        {
          id: 'imp_max',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          status: 'preparing',
          updated_at: now,
        },
      ],
    });
    s3Send.mockResolvedValue({});

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(1);
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(tables.upload_artifacts[0]?.status).toBe('cleanup_complete');
  });

  it('places inconsistent consumed migration linkage on retention hold', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_migration_inconsistent',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/migration-imports/org_1/final/upl_migration_inconsistent.json',
          metadata: '{malformed',
          consumed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'retention_hold',
      scan_result: 'Migration import retention linkage is inconsistent',
    });
  });

  it('places a consumed migration with a missing linked job on retention hold', async () => {
    const now = new Date();
    const objectKey = 'uploads/tnt_1/migration-imports/org_1/final/upl_missing_job.json';
    const checksum = 'e'.repeat(64);
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_missing_job',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: objectKey,
          content_type: 'application/vnd.tixkit.portable+json',
          size_bytes: 10,
          checksum_sha256: checksum,
          consumed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
      import_job_files: [
        {
          id: 'imf_missing_job',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          import_job_id: 'imp_missing',
          object_key: objectKey,
          media_type: 'application/vnd.tixkit.portable+json',
          byte_size: 10,
          sha256: checksum,
          status: 'ready',
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'retention_hold',
      scan_result: 'Migration import retention job is missing',
    });
  });

  it('places checksum, byte-size, media-type, and status linkage drift on retention hold', async () => {
    const now = new Date();
    const mismatches = [
      {
        sha256: 'f'.repeat(64),
        byte_size: 10,
        media_type: 'application/json',
        status: 'ready',
      },
      {
        sha256: 'a'.repeat(64),
        byte_size: 11,
        media_type: 'application/json',
        status: 'ready',
      },
      {
        sha256: 'a'.repeat(64),
        byte_size: 10,
        media_type: 'text/plain',
        status: 'ready',
      },
      {
        sha256: 'a'.repeat(64),
        byte_size: 10,
        media_type: 'application/json',
        status: 'rejected',
      },
    ];
    const artifacts = mismatches.map((_mismatch, index) => ({
      id: `upl_linkage_drift_${index}`,
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      purpose: 'migration_import',
      status: 'uploaded',
      scan_status: 'clean',
      bucket: 'tixkit',
      object_key: `uploads/tnt_1/migration-imports/org_1/final/upl_linkage_drift_${index}.json`,
      content_type: 'application/json',
      size_bytes: 10,
      checksum_sha256: 'a'.repeat(64),
      consumed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      expires_at: new Date(now.getTime() - 60_000),
    }));
    const { db, tables } = createMockDb({
      upload_artifacts: artifacts,
      import_job_files: mismatches.map((mismatch, index) => ({
        id: `imf_linkage_drift_${index}`,
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        import_job_id: `imp_linkage_drift_${index}`,
        object_key: artifacts[index]!.object_key,
        ...mismatch,
      })),
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts).toHaveLength(4);
    expect(
      tables.upload_artifacts.every(
        (artifact) =>
          artifact.status === 'retention_hold' &&
          artifact.scan_result === 'Migration import retention linkage is inconsistent',
      ),
    ).toBe(true);
  });

  it('deletes expired unregistered and terminal-job migration artifacts', async () => {
    const now = new Date();
    const terminalObjectKey =
      'uploads/tnt_1/migration-imports/org_1/final/upl_migration_terminal.json';
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_migration_unregistered',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/migration-imports/org_1/final/upl_migration_unregistered.json',
          metadata: '{}',
          consumed_at: null,
          expires_at: new Date(now.getTime() - 120_000),
        },
        {
          id: 'upl_migration_terminal',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: terminalObjectKey,
          content_type: 'application/vnd.tixkit.portable+json',
          size_bytes: 10,
          checksum_sha256: 'd'.repeat(64),
          metadata: JSON.stringify({
            migrationImport: {
              jobId: 'imp_terminal',
              registeredAt: now.toISOString(),
            },
          }),
          consumed_at: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
      import_job_files: [
        {
          id: 'imf_terminal',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          import_job_id: 'imp_terminal',
          object_key: terminalObjectKey,
          media_type: 'application/vnd.tixkit.portable+json',
          byte_size: 10,
          sha256: 'd'.repeat(64),
          status: 'ready',
        },
      ],
      import_jobs: [
        {
          id: 'imp_terminal',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          status: 'activated',
          updated_at: now,
        },
      ],
    });
    s3Send.mockResolvedValue({});

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(2);
    expect(s3Send).toHaveBeenCalledTimes(2);
    expect(tables.upload_artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'upl_migration_unregistered',
          status: 'cleanup_complete',
          scan_result: 'Migration import artifact retention expired',
        }),
        expect.objectContaining({
          id: 'upl_migration_terminal',
          status: 'cleanup_complete',
          scan_result: 'Migration import artifact retention expired',
        }),
      ]),
    );
  });

  it('does not delete a shared original while another event media asset references it', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_unattached',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/shared-original.jpg',
          expires_at: new Date(now.getTime() - 60_000),
        },
        {
          id: 'upl_attached_copy',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_2',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/shared-original.jpg',
          expires_at: new Date(now.getTime() + 60_000),
        },
      ],
      event_media_assets: [{ id: 'ema_copy', upload_artifact_id: 'upl_attached_copy' }],
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          cover_image_url: null,
          seo: '{}',
        },
      ],
    });

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(1);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]?.status).toBe('cleanup_complete');
    expect(tables.upload_artifacts[1]?.status).toBe('uploaded');
  });

  it('restores the prior status when object deletion fails', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_delete_failure',
          status: 'pending',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/staging/upl_delete_failure.txt',
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
    });
    s3Send.mockRejectedValue(new Error('S3 unavailable'));

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(tables.upload_artifacts[0]).toMatchObject({ status: 'pending' });
    expect(new Date(tables.upload_artifacts[0]?.expires_at as Date).getTime()).toBeGreaterThan(
      now.getTime(),
    );
    s3Send.mockResolvedValue({});
    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('restores a claimed artifact when an event attaches it before deletion', async () => {
    const now = new Date();
    const events: Row[] = [
      {
        id: 'evt_1',
        tenant_id: 'tnt_1',
        organization_id: 'org_1',
        brand_id: 'brd_1',
        cover_image_url: null,
        seo: '{}',
      },
    ];
    const { db, tables } = createMockDb(
      {
        upload_artifacts: [
          {
            id: 'upl_attach_race',
            tenant_id: 'tnt_1',
            organization_id: 'org_1',
            brand_id: 'brd_1',
            event_id: 'evt_1',
            purpose: 'event_cover',
            status: 'uploaded',
            scan_status: 'clean',
            bucket: 'tixkit',
            object_key: 'uploads/tnt_1/event-cover/upl_attach_race.png',
            expires_at: new Date(now.getTime() - 60_000),
          },
        ],
        events,
      },
      {
        onUpdate(table, row, values) {
          if (
            table === 'upload_artifacts' &&
            row.id === 'upl_attach_race' &&
            values.status === 'cleanup_pending'
          ) {
            events[0]!.cover_image_url = '/v1/public/event-media/event_cover/upl_attach_race';
          }
        },
      },
    );

    await expect(cleanupExpiredUploadArtifacts(db, now)).resolves.toBe(0);
    expect(s3Send).not.toHaveBeenCalled();
    expect(tables.upload_artifacts[0]?.status).toBe('uploaded');
  });

  it('does not let unrelated uploaded artifacts starve cleanable rows', async () => {
    const now = new Date();
    const { db, tables } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_unrelated',
          status: 'uploaded',
          purpose: 'checkout_answer',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/final/upl_unrelated.txt',
          expires_at: new Date(now.getTime() - 120_000),
        },
        {
          id: 'upl_cleanable',
          status: 'pending',
          purpose: 'checkout_answer',
          scan_status: 'pending',
          bucket: 'tixkit',
          object_key: 'uploads/tnt_1/staging/upl_cleanable.txt',
          expires_at: new Date(now.getTime() - 60_000),
        },
      ],
    });
    s3Send.mockResolvedValue({});

    await expect(cleanupExpiredUploadArtifacts(db, now, 1)).resolves.toBe(1);
    expect(tables.upload_artifacts[0]?.status).toBe('uploaded');
    expect(tables.upload_artifacts[1]?.status).toBe('cleanup_complete');
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
        Body: {
          transformToByteArray: async () => new TextEncoder().encode('clean'),
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).resolves.toEqual({
      artifactId: artifact.artifactId,
      status: 'uploaded',
      scanStatus: 'clean',
    });
    const stagingKey = `uploads/tnt_1/checkout-answers/evt_1/staging/${artifact.artifactId}.txt`;
    const checksum = createHash('sha256').update('clean').digest('hex');
    const finalKey = `uploads/tnt_1/checkout-answers/evt_1/final/${artifact.artifactId}.txt/${checksum}`;
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'uploaded',
      scan_status: 'clean',
      scan_result: 'No EICAR test signature found',
      object_key: finalKey,
    });
    expect(tables.upload_artifacts[0].checksum_sha256).toEqual(expect.any(String));
    expect(s3Send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: stagingKey,
    });
    expect(s3Send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: stagingKey,
    });
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
    expect(s3Send.mock.calls[3][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: stagingKey,
    });

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

  it('atomically claims upload completion so concurrent workers cannot publish conflicting evidence', async () => {
    const { db } = createMockDb();
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
        Body: {
          transformToByteArray: async () => new TextEncoder().encode('clean'),
        },
      })
      .mockResolvedValue({});

    const results = await Promise.allSettled([
      completeUploadArtifact(db, artifact.artifactId),
      completeUploadArtifact(db, artifact.artifactId),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(s3Send.mock.calls.filter(([command]) => command.input.Body)).toHaveLength(1);
  });

  it('rejects a worker that arrives after another worker owns the completion lease', async () => {
    const { db } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'checkout_answer',
      fileName: 'note.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
    });
    let releaseHead!: () => void;
    const headBlocked = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    s3Send
      .mockImplementationOnce(async () => {
        await headBlocked;
        return { ContentLength: 5, ContentType: 'text/plain' };
      })
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => new TextEncoder().encode('clean'),
        },
      })
      .mockResolvedValue({});

    const owner = completeUploadArtifact(db, artifact.artifactId);
    await vi.waitFor(() => expect(s3Send).toHaveBeenCalledTimes(1));
    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'already in progress',
    );
    releaseHead();
    await expect(owner).resolves.toMatchObject({
      status: 'uploaded',
      scanStatus: 'clean',
    });
    expect(s3Send.mock.calls.filter(([command]) => command.input.Body)).toHaveLength(1);
  });

  it('rejects image uploads whose bytes do not match the declared content type', async () => {
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
        .mockResolvedValueOnce({
          ContentLength: fakeBytes.length,
          ContentType: 'image/png',
        })
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

    const validPng = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer();
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
      .mockResolvedValueOnce({
        ContentLength: validPng.length,
        ContentType: 'image/png',
      })
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
    const image = sharp({
      create: { width: 2, height: 2, channels: 4, background: '#336699' },
    });
    const cases = [
      {
        name: 'jpeg',
        bytes: await image.clone().jpeg().toBuffer(),
        type: 'image/jpeg',
      },
      {
        name: 'webp',
        bytes: await image.clone().webp().toBuffer(),
        type: 'image/webp',
      },
      {
        name: 'gif',
        bytes: await image.clone().gif().toBuffer(),
        type: 'image/gif',
      },
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
        .mockResolvedValueOnce({
          ContentLength: c.bytes.length,
          ContentType: c.type,
        })
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

  it('rejects signature-only, truncated, trailing-data, and excessive-frame images before publication', async () => {
    const validPng = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer();
    const cases = [
      {
        name: 'signature-only JPEG',
        type: 'image/jpeg',
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      {
        name: 'signature-only PNG',
        type: 'image/png',
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
      {
        name: 'signature-only WebP',
        type: 'image/webp',
        bytes: Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'latin1'),
      },
      { name: 'signature-only GIF', type: 'image/gif', bytes: Buffer.from('GIF89a;', 'latin1') },
      { name: 'truncated PNG', type: 'image/png', bytes: validPng.subarray(0, -12) },
      {
        name: 'PNG with trailing payload',
        type: 'image/png',
        bytes: Buffer.concat([validPng, Buffer.from('<script>payload</script>')]),
      },
      { name: 'excessive-frame GIF', type: 'image/gif', bytes: animatedGif(21) },
    ] as const;

    for (const testCase of cases) {
      const { db, tables } = createMockDb();
      const artifact = await createUploadArtifact(db, {
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        purpose: 'content_email_image',
        fileName: testCase.name,
        contentType: testCase.type,
        sizeBytes: testCase.bytes.length,
      });
      s3Send
        .mockResolvedValueOnce({
          ContentLength: testCase.bytes.length,
          ContentType: testCase.type,
        })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => new Uint8Array(testCase.bytes) },
          ContentType: testCase.type,
        })
        .mockResolvedValueOnce({});

      await expect(completeUploadArtifact(db, artifact.artifactId), testCase.name).rejects.toThrow(
        /Uploaded (?:image|PNG)/u,
      );
      expect(tables.upload_artifacts[0], testCase.name).toMatchObject({
        status: 'rejected',
        scan_status: 'blocked',
      });
      expect(
        s3Send.mock.calls.filter(([command]) => command.input.Body),
        testCase.name,
      ).toHaveLength(0);
      s3Send.mockReset();
    }
  });

  it('rejects images whose decoded pixel count exceeds the bounded policy', async () => {
    const oversized = await sharp({
      create: { width: 6500, height: 6500, channels: 3, background: '#000000' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      purpose: 'brand_logo',
      fileName: 'oversized.png',
      contentType: 'image/png',
      sizeBytes: oversized.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: oversized.length, ContentType: 'image/png' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(oversized) },
        ContentType: 'image/png',
      })
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'Uploaded image is malformed or exceeds decode limits',
    );
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
    });
  });

  it('binds event media decoding to the declared image content type', async () => {
    const webp = await sharp({
      create: { width: 4, height: 3, channels: 3, background: '#336699' },
    })
      .webp()
      .toBuffer();
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'event_cover',
      fileName: 'cover.jpg',
      contentType: 'image/jpeg',
      sizeBytes: webp.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: webp.length, ContentType: 'image/jpeg' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(webp) },
        ContentType: 'image/jpeg',
      })
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'Uploaded image content does not match declared content type: image/jpeg',
    );
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
    });
  });

  it('rejects an event JPEG with payload appended after its first structural EOI', async () => {
    const jpeg = await sharp({
      create: { width: 4, height: 3, channels: 3, background: '#336699' },
    })
      .jpeg({ progressive: true })
      .toBuffer();
    const hostile = Buffer.concat([
      jpeg,
      Buffer.from('<script>payload</script>'),
      Buffer.from([0xff, 0xd9]),
    ]);
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'event_cover',
      fileName: 'cover.jpg',
      contentType: 'image/jpeg',
      sizeBytes: hostile.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: hostile.length, ContentType: 'image/jpeg' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(hostile) },
        ContentType: 'image/jpeg',
      })
      .mockResolvedValueOnce({});

    await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toThrow(
      'Uploaded image is truncated or contains trailing data',
    );
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'rejected',
      scan_status: 'blocked',
    });
    expect(s3Send.mock.calls.filter(([command]) => command.input.Body)).toHaveLength(0);
    expect(s3Send).toHaveBeenCalledTimes(3);
  });

  it('rejects event PNGs with copied-IEND payloads, invalid lengths, or corrupt chunk CRCs', async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer();
    const malformedLength = Buffer.from(png);
    malformedLength.writeUInt32BE(0xffffffff, 8);
    const corruptHeaderCrc = Buffer.from(png);
    const headerCrcOffset = 8 + 4 + 4 + 13;
    corruptHeaderCrc[headerCrcOffset] = corruptHeaderCrc[headerCrcOffset]! ^ 0xff;
    const cases = [
      {
        name: 'payload followed by a copied IEND',
        bytes: Buffer.concat([png, Buffer.from('arbitrary-payload'), png.subarray(-12)]),
      },
      { name: 'out-of-range chunk length', bytes: malformedLength },
      { name: 'corrupt IHDR CRC', bytes: corruptHeaderCrc },
    ];

    for (const testCase of cases) {
      const { db, tables } = createMockDb();
      const artifact = await createUploadArtifact(db, {
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        purpose: 'event_cover',
        fileName: `${testCase.name}.png`,
        contentType: 'image/png',
        sizeBytes: testCase.bytes.length,
      });
      s3Send
        .mockResolvedValueOnce({
          ContentLength: testCase.bytes.length,
          ContentType: 'image/png',
        })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => new Uint8Array(testCase.bytes) },
          ContentType: 'image/png',
        })
        .mockResolvedValueOnce({});

      const completionResult = await completeUploadArtifact(db, artifact.artifactId).catch(
        (error: unknown) => error,
      );
      expect(completionResult, testCase.name).toBeInstanceOf(Error);
      expect((completionResult as Error).message, testCase.name).toMatch(/Uploaded PNG/u);
      expect(tables.upload_artifacts[0], testCase.name).toMatchObject({
        status: 'rejected',
        scan_status: 'blocked',
      });
      expect(
        s3Send.mock.calls.filter(([command]) => command.input.Body),
        testCase.name,
      ).toHaveLength(0);
      expect(s3Send, testCase.name).toHaveBeenCalledTimes(3);
      s3Send.mockReset();
    }
  });

  it('strips metadata from generic public images and records the persisted byte evidence', async () => {
    const original = await sharp({
      create: { width: 4, height: 3, channels: 3, background: '#336699' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(original).metadata()).orientation).toBe(6);
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      purpose: 'brand_logo',
      fileName: 'logo.jpg',
      contentType: 'image/jpeg',
      sizeBytes: original.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: original.length, ContentType: 'image/jpeg' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(original) },
        ContentType: 'image/jpeg',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await completeUploadArtifact(db, artifact.artifactId);
    const persisted = s3Send.mock.calls[2]?.[0].input.Body as Buffer;
    const persistedMetadata = await sharp(persisted).metadata();
    expect(persistedMetadata.orientation).toBeUndefined();
    expect(persistedMetadata).toMatchObject({ width: 3, height: 4 });
    expect(tables.upload_artifacts[0]).toMatchObject({
      size_bytes: persisted.length,
      checksum_sha256: createHash('sha256').update(persisted).digest('hex'),
      status: 'uploaded',
    });
  });

  it('preserves bounded GIF animation while sanitizing the public image', async () => {
    const original = await sharp(Buffer.from([0xff, 0x00, 0x00, 0xff, 0x00, 0x00, 0xff, 0xff]), {
      raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
    })
      .gif({ delay: [80, 240], loop: 3 })
      .toBuffer();
    const { db, tables } = createMockDb();
    const artifact = await createUploadArtifact(db, {
      tenantId: 'tnt_1',
      eventId: 'evt_1',
      purpose: 'content_email_image',
      fileName: 'animation.gif',
      contentType: 'image/gif',
      sizeBytes: original.length,
    });
    s3Send
      .mockResolvedValueOnce({ ContentLength: original.length, ContentType: 'image/gif' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(original) },
        ContentType: 'image/gif',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    await completeUploadArtifact(db, artifact.artifactId);
    const persisted = s3Send.mock.calls[2]?.[0].input.Body as Buffer;
    expect(await sharp(persisted, { animated: true }).metadata()).toMatchObject({
      format: 'gif',
      pages: 2,
      delay: [80, 240],
      loop: 3,
    });
    expect(tables.upload_artifacts[0]).toMatchObject({
      size_bytes: persisted.length,
      checksum_sha256: createHash('sha256').update(persisted).digest('hex'),
      status: 'uploaded',
    });
  });

  it('validates checkout PDFs conservatively and rejects active, compressed, or ambiguous structures', async () => {
    const validPdf = safeCheckoutPdf();
    const validSource = validPdf.toString('latin1');
    const xrefRows = [...validSource.matchAll(/^\d{10} \d{5} [nf]$/gm)].map((match) => match[0]);
    const firstObjectOffset = Number(xrefRows[1]!.slice(0, 10));
    const hostilePdfs = [
      { name: 'fake PDF', bytes: Buffer.from('not a pdf') },
      { name: 'missing EOF', bytes: validPdf.subarray(0, validPdf.indexOf('%%EOF')) },
      { name: 'encryption', bytes: safeCheckoutPdf('/Encrypt 4 0 R') },
      {
        name: 'JavaScript action',
        bytes: safeCheckoutPdf('/OpenAction << /S /JavaScript /JS (x) >>'),
      },
      { name: 'embedded file', bytes: safeCheckoutPdf('/Names << /EmbeddedFiles 4 0 R >>') },
      {
        name: 'external URI',
        bytes: safeCheckoutPdf('/OpenAction << /S /URI /URI (https://example.test) >>'),
      },
      { name: 'escaped JavaScript name', bytes: safeCheckoutPdf('/OpenAction << /S /J#53 >>') },
      { name: 'compressed object stream', bytes: safeCheckoutPdf('/Type /ObjStm') },
      {
        name: 'misaligned in-use offset',
        bytes: mutatePdfXrefRow(
          validPdf,
          1,
          `${String(firstObjectOffset + 1).padStart(10, '0')} 00000 n`,
        ),
      },
      {
        name: 'out-of-range in-use offset',
        bytes: mutatePdfXrefRow(validPdf, 1, '9999999999 00000 n'),
      },
      {
        name: 'duplicate object offset',
        bytes: mutatePdfXrefRow(validPdf, 2, xrefRows[1]!),
      },
      {
        name: 'out-of-range free-list offset',
        bytes: mutatePdfXrefRow(validPdf, 2, '9999999999 00000 f'),
      },
      {
        name: 'wrong trailer size',
        bytes: Buffer.from(validSource.replace('/Size 4', '/Size 5'), 'latin1'),
      },
      {
        name: 'root is not a catalog',
        bytes: Buffer.from(validSource.replace('/Root 1 0 R', '/Root 2 0 R'), 'latin1'),
      },
      {
        name: 'root generation mismatch',
        bytes: Buffer.from(validSource.replace('/Root 1 0 R', '/Root 1 1 R'), 'latin1'),
      },
      {
        name: 'xref generation does not match object header',
        bytes: mutatePdfXrefRow(validPdf, 1, `${xrefRows[1]!.slice(0, 11)}00001 n`),
      },
      {
        name: 'multiple xref revision tokens',
        bytes: Buffer.from(validSource.replace('trailer\n', 'xref\ntrailer\n'), 'latin1'),
      },
      {
        name: 'multiple startxref revision tokens',
        bytes: Buffer.from(
          validSource.replace('startxref\n', 'startxref\n0\nstartxref\n'),
          'latin1',
        ),
      },
      {
        name: 'incremental Prev pointer',
        bytes: Buffer.from(validSource.replace('/Size 4', '/Prev 0 /Size 4'), 'latin1'),
      },
      { name: 'stream length too short', bytes: checkoutPdfWithStream('4') },
      { name: 'stream length too long', bytes: checkoutPdfWithStream('6') },
      { name: 'indirect stream length', bytes: checkoutPdfWithStream('5 0 R') },
      { name: 'malformed stream boundary', bytes: checkoutPdfWithStream('5', 'endstream') },
      { name: 'trailing payload after object', bytes: checkoutPdfWithObjectTrailingPayload() },
      { name: 'annotations surface', bytes: safeCheckoutPdf('/Annots []') },
      {
        name: 'Named Print action',
        bytes: safeCheckoutPdf('/Extension << /S /Named /N /Print >>'),
      },
      {
        name: 'GoToE Rendition action',
        bytes: safeCheckoutPdf('/Extension << /S /GoToE /Rendition 4 0 R >>'),
      },
      {
        name: 'Catalog spoofed by a literal string',
        bytes: checkoutPdfWithRootDictionary('<< /Pages 2 0 R /Note (/Type /Catalog) >>'),
      },
      {
        name: 'Catalog spoofed by a comment',
        bytes: checkoutPdfWithRootDictionary('<< /Pages 2 0 R % /Type /Catalog\n>>'),
      },
      {
        name: 'Catalog spoofed by a nested dictionary',
        bytes: checkoutPdfWithRootDictionary('<< /Pages 2 0 R /Metadata << /Type /Catalog >> >>'),
      },
      {
        name: 'Catalog spoofed inside an array',
        bytes: checkoutPdfWithRootDictionary('<< /Pages 2 0 R /Metadata [ /Type /Catalog ] >>'),
      },
      {
        name: 'trailer garbage after dictionary',
        bytes: Buffer.from(
          validSource.replace('<< /Size 4 /Root 1 0 R >>', '<< /Size 4 /Root 1 0 R >> garbage'),
          'latin1',
        ),
      },
      {
        name: 'multiple trailer dictionaries',
        bytes: Buffer.from(
          validSource.replace(
            '<< /Size 4 /Root 1 0 R >>',
            '<< /Size 4 /Root 1 0 R >> << /Extra /Dictionary >>',
          ),
          'latin1',
        ),
      },
    ];

    for (const testCase of [
      { name: 'valid PDF', bytes: validPdf, valid: true },
      { name: 'valid direct-length stream PDF', bytes: checkoutPdfWithStream('5'), valid: true },
      {
        name: 'valid PDF with inert lexical lookalikes',
        bytes: safeCheckoutPdf(
          '/Note (/Annots /JavaScript) /Hex <2f4f70656e416374696f6e> % /Rendition\n',
        ),
        valid: true,
      },
      ...hostilePdfs,
    ]) {
      const { db, tables } = createMockDb();
      const artifact = await createUploadArtifact(db, {
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        purpose: 'checkout_answer',
        fileName: `${testCase.name}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: testCase.bytes.length,
      });
      s3Send
        .mockResolvedValueOnce({
          ContentLength: testCase.bytes.length,
          ContentType: 'application/pdf',
        })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => new Uint8Array(testCase.bytes) },
          ContentType: 'application/pdf',
        });
      if ('valid' in testCase) {
        s3Send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
        await expect(completeUploadArtifact(db, artifact.artifactId)).resolves.toMatchObject({
          status: 'uploaded',
        });
      } else {
        s3Send.mockResolvedValueOnce({});
        const completionResult = await completeUploadArtifact(db, artifact.artifactId).catch(
          (error: unknown) => error,
        );
        expect(completionResult, testCase.name).toBeInstanceOf(Error);
        expect((completionResult as Error).message, testCase.name).toMatch(/Checkout PDF/u);
        expect(tables.upload_artifacts[0], testCase.name).toMatchObject({ status: 'rejected' });
        expect(
          s3Send.mock.calls.filter(([command]) => command.input.Body),
          testCase.name,
        ).toHaveLength(0);
        expect(s3Send, testCase.name).toHaveBeenCalledTimes(3);
      }
      s3Send.mockReset();
    }
  });

  it('accepts plain UTF-8 checkout text and rejects ambiguous or binary text', async () => {
    const cases = [
      {
        name: 'valid UTF-8',
        bytes: Buffer.from('Guest accessibility notes\nNo stairs.'),
        valid: true,
      },
      { name: 'invalid UTF-8', bytes: Buffer.from([0xc3, 0x28]) },
      { name: 'UTF-8 BOM', bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x61]) },
      { name: 'NUL', bytes: Buffer.from('hello\0world') },
      { name: 'binary controls', bytes: Buffer.from([0x61, 0x01, 0x02, 0x62]) },
      { name: 'pathological line', bytes: Buffer.from('x'.repeat(16_385)) },
    ];

    for (const testCase of cases) {
      const { db, tables } = createMockDb();
      const artifact = await createUploadArtifact(db, {
        tenantId: 'tnt_1',
        eventId: 'evt_1',
        purpose: 'checkout_answer',
        fileName: `${testCase.name}.txt`,
        contentType: 'text/plain',
        sizeBytes: testCase.bytes.length,
      });
      s3Send
        .mockResolvedValueOnce({ ContentLength: testCase.bytes.length, ContentType: 'text/plain' })
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => new Uint8Array(testCase.bytes) },
          ContentType: 'text/plain',
        });
      if (testCase.valid) {
        s3Send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
        await expect(completeUploadArtifact(db, artifact.artifactId)).resolves.toMatchObject({
          status: 'uploaded',
        });
      } else {
        s3Send.mockResolvedValueOnce({});
        await expect(
          completeUploadArtifact(db, artifact.artifactId),
          testCase.name,
        ).rejects.toThrow(/Checkout text/u);
        expect(tables.upload_artifacts[0], testCase.name).toMatchObject({ status: 'rejected' });
      }
      s3Send.mockReset();
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
    s3Send.mockResolvedValueOnce({
      ContentLength: 5,
      ContentType: 'text/plain',
    });
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
    expect(s3Send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: stagingKey,
    });
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
    expect(s3Send.mock.calls[1][0].input).toMatchObject({
      Bucket: 'tixkit',
      Key: stagingKey,
    });
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
      .mockResolvedValueOnce({
        ContentLength: signature.length,
        ContentType: 'text/plain',
      })
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => new TextEncoder().encode(signature),
        },
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

  it('accepts only exact bounded ClamAV protocol responses', async () => {
    process.env.UPLOAD_MALWARE_SCANNER = 'clamav';
    process.env.CLAMAV_HOST = '127.0.0.1';

    for (const [response, expected] of [
      ['stream: OK\0', { clean: true, result: 'stream: OK' }],
      [
        'stream: Eicar-Signature FOUND\0',
        { clean: false, result: 'stream: Eicar-Signature FOUND' },
      ],
    ] as const) {
      const scanner = await startClamAvTestServer({ response });
      process.env.CLAMAV_PORT = String(scanner.port);
      try {
        await expect(scanUploadBuffer(Buffer.from('sample'))).resolves.toEqual(expected);
      } finally {
        await scanner.close();
      }
    }

    for (const behavior of [
      { response: 'stream: OK' },
      { response: '\nstream: OK\0' },
      { response: 'stream: OK\n\0' },
      { response: 'stream: OK\0\0' },
      { response: 'stream: NOT OK\0' },
      { response: 'stream: Eicar-Signature FOUND\nstream: OK\0' },
      { response: Buffer.alloc(4097, 0x41) },
      { disconnect: true },
    ]) {
      const scanner = await startClamAvTestServer(behavior);
      process.env.CLAMAV_PORT = String(scanner.port);
      try {
        await expect(scanUploadBuffer(Buffer.from('sample'))).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
          statusCode: 503,
          message: 'Upload malware scanner is unavailable',
        });
      } finally {
        await scanner.close();
      }
    }

    const scanner = await startClamAvTestServer();
    process.env.CLAMAV_PORT = String(scanner.port);
    process.env.CLAMAV_TIMEOUT_MS = '50';
    try {
      await expect(scanUploadBuffer(Buffer.from('sample'))).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
        message: 'Upload malware scanner is unavailable',
      });
    } finally {
      await scanner.close();
    }

    const dripScanner = await startClamAvTestServer({
      response: 'stream: OK\0',
      dripIntervalMs: 20,
    });
    process.env.CLAMAV_PORT = String(dripScanner.port);
    const startedAt = Date.now();
    try {
      await expect(scanUploadBuffer(Buffer.from('sample'))).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
        message: 'Upload malware scanner is unavailable',
      });
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      await dripScanner.close();
    }
  });

  it('releases only its completion claim after a transient scanner failure for immediate retry', async () => {
    const failingScanner = await startClamAvTestServer({ response: 'stream: unavailable ERROR\0' });
    process.env.UPLOAD_MALWARE_SCANNER = 'clamav';
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(failingScanner.port);
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
      });

    try {
      await expect(completeUploadArtifact(db, artifact.artifactId)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
        message: 'Upload malware scanner is unavailable',
      });
    } finally {
      await failingScanner.close();
    }
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'pending',
      scan_status: 'pending',
      scan_result: null,
      completion_owner_token: null,
      completion_started_at: null,
    });
    expect(s3Send).toHaveBeenCalledTimes(2);

    const healthyScanner = await startClamAvTestServer({ response: 'stream: OK\0' });
    process.env.CLAMAV_PORT = String(healthyScanner.port);
    s3Send
      .mockResolvedValueOnce({ ContentLength: 5, ContentType: 'text/plain' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new TextEncoder().encode('clean') },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    try {
      await expect(completeUploadArtifact(db, artifact.artifactId)).resolves.toMatchObject({
        status: 'uploaded',
        scanStatus: 'clean',
      });
    } finally {
      await healthyScanner.close();
    }
  });

  it('does not release a replacement owner after a delayed scanner failure', async () => {
    const scanner = await startClamAvTestServer({
      response: 'stream: unavailable ERROR\0',
      responseDelayMs: 500,
    });
    process.env.UPLOAD_MALWARE_SCANNER = 'clamav';
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = String(scanner.port);
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
      });

    const completion = completeUploadArtifact(db, artifact.artifactId);
    const completionResult = completion.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(s3Send).toHaveBeenCalledTimes(2));
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'processing',
      scan_status: 'scanning',
    });
    tables.upload_artifacts[0]!.completion_owner_token = 'ucl_replacement_owner';
    try {
      await expect(completionResult).resolves.toMatchObject({
        message: 'Upload artifact completion lease was lost',
      });
    } finally {
      await scanner.close();
    }
    expect(tables.upload_artifacts[0]).toMatchObject({
      status: 'processing',
      scan_status: 'scanning',
      completion_owner_token: 'ucl_replacement_owner',
    });
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

  it('preserves event media originals and generates immutable focal-point renditions', async () => {
    const original = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: '#14532d' },
    })
      .jpeg()
      .toBuffer();
    const checksum = createHash('sha256').update(original).digest('hex');
    const writes: Array<Record<string, unknown>> = [];
    s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      if (command.input.Body) writes.push(command.input);
      return command.input.Body
        ? {}
        : {
            Body: { transformToByteArray: async () => original },
            ContentType: 'image/jpeg',
          };
    });
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
        },
      ],
      upload_artifacts: [
        {
          id: 'upl_cover',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/original.jpg',
          checksum_sha256: checksum,
          size_bytes: original.length,
          metadata: JSON.stringify({
            image: { width: 1600, height: 1000, format: 'jpeg' },
          }),
        },
      ],
    });

    const media = await attachEventMedia({
      db,
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      uploadArtifactId: 'upl_cover',
      role: 'cover',
      altText: 'Crowd watching the main stage',
      focalPoint: { x: 0.75, y: 0.4 },
      createdBy: 'usr_1',
    });

    expect(media.renditions.map(({ variant }) => variant)).toEqual([
      'thumbnail',
      'card',
      'page',
      'social',
    ]);
    expect(media.renditions.map(({ width, height }) => [width, height])).toEqual([
      [320, 320],
      [480, 270],
      [1600, 900],
      [1200, 630],
    ]);
    expect(writes).toHaveLength(4);
    for (const rendition of media.renditions)
      expect(rendition.sizeBytes).toBeLessThanOrEqual(
        EVENT_MEDIA_RENDITION_MAX_BYTES[rendition.variant],
      );
    expect(new Set(writes.map((write) => write.Key))).toHaveLength(4);
    expect(writes.every((write) => String(write.Key).includes('/emr_'))).toBe(true);
    expect(tables.event_media_assets).toHaveLength(1);
    expect(tables.event_media_renditions).toHaveLength(4);
    expect(tables.upload_artifacts).toHaveLength(1);
  });

  it('uses post-orientation dimensions for focal-point rendition geometry', async () => {
    const sourceSvg = Buffer.from(`
      <svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg">
        <rect width="600" height="400" x="0" y="0" fill="#dc2626" />
        <rect width="600" height="400" x="600" y="0" fill="#2563eb" />
        <rect width="600" height="400" x="0" y="400" fill="#16a34a" />
        <rect width="600" height="400" x="600" y="400" fill="#eab308" />
      </svg>
    `);
    const original = await sharp(sourceSvg).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const checksum = createHash('sha256').update(original).digest('hex');
    const writes: Array<Record<string, unknown>> = [];
    s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      if (command.input.Body) writes.push(command.input);
      return command.input.Body
        ? {}
        : {
            Body: { transformToByteArray: async () => original },
            ContentType: 'image/jpeg',
          };
    });
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_oriented',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
        },
      ],
      upload_artifacts: [
        {
          id: 'upl_oriented',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_oriented',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/oriented.jpg',
          checksum_sha256: checksum,
          size_bytes: original.length,
          metadata: JSON.stringify({
            image: { width: 1200, height: 800, format: 'jpeg' },
          }),
        },
      ],
    });

    await attachEventMedia({
      db,
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_oriented',
      uploadArtifactId: 'upl_oriented',
      role: 'cover',
      altText: 'Four colored stage quadrants',
      focalPoint: { x: 0.5, y: 0.5 },
      createdBy: 'usr_1',
    });

    const normalized = await sharp(original).rotate().toBuffer();
    const expectedPage = await sharp(normalized)
      .resize(1600, 2400, { fit: 'fill' })
      .extract({ left: 0, top: 750, width: 1600, height: 900 })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
    const pageObjectKey = tables.event_media_renditions.find(
      (rendition) => rendition.variant === 'page',
    )?.object_key;
    const pageWrite = writes.find((write) => write.Key === pageObjectKey);
    expect(pageWrite).toBeDefined();
    expect(
      createHash('sha256')
        .update(pageWrite!.Body as Buffer)
        .digest('hex'),
    ).toBe(createHash('sha256').update(expectedPage).digest('hex'));
  });

  it('reduces WebP quality until a high-entropy social rendition meets its byte budget', async () => {
    const original = await deterministicNoisePng();
    const checksum = createHash('sha256').update(original).digest('hex');
    const quality82 = await sharp(original)
      .resize(1200, 750, { fit: 'fill' })
      .extract({ left: 0, top: 60, width: 1200, height: 630 })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
    expect(quality82.byteLength).toBeGreaterThan(EVENT_MEDIA_RENDITION_MAX_BYTES.social);
    const writes: Array<Record<string, unknown>> = [];
    s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      if (command.input.Body) {
        writes.push(command.input);
        return {};
      }
      return {
        Body: { transformToByteArray: async () => original },
        ContentType: 'image/png',
      };
    });
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
        },
      ],
      upload_artifacts: [
        {
          id: 'upl_social_entropy',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_social',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/social-entropy.png',
          checksum_sha256: checksum,
          size_bytes: original.length,
          metadata: JSON.stringify({
            image: { width: 1600, height: 1000, format: 'png' },
          }),
        },
      ],
    });

    const media = await attachEventMedia({
      db,
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      uploadArtifactId: 'upl_social_entropy',
      role: 'social',
      altText: 'High-detail social card',
      focalPoint: { x: 0.5, y: 0.5 },
      createdBy: 'usr_1',
    });

    expect(writes).toHaveLength(4);
    const social = media.renditions.find(({ variant }) => variant === 'social');
    expect(social).toBeDefined();
    expect(social!.sizeBytes).toBeLessThanOrEqual(EVENT_MEDIA_RENDITION_MAX_BYTES.social);
    expect((writes[3]!.Body as Buffer).byteLength).toBe(social!.sizeBytes);
    expect(tables.event_media_assets).toHaveLength(1);
    expect(tables.event_media_renditions).toHaveLength(4);
  }, 15_000);

  it('removes staged renditions and preserves the database when no quality meets a budget', async () => {
    const original = await deterministicNoisePng();
    const checksum = createHash('sha256').update(original).digest('hex');
    const minimumQualityPage = await sharp(original)
      .resize(1600, 1000, { fit: 'fill' })
      .extract({ left: 0, top: 50, width: 1600, height: 900 })
      .webp({ quality: 40, effort: 5 })
      .toBuffer();
    expect(minimumQualityPage.byteLength).toBeGreaterThan(EVENT_MEDIA_RENDITION_MAX_BYTES.page);
    const writes: string[] = [];
    const deletes: string[] = [];
    s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      const key = String(command.input.Key ?? '');
      if (command.input.Body) {
        writes.push(key);
        return {};
      }
      if (key.startsWith('event-media/')) {
        deletes.push(key);
        return {};
      }
      return {
        Body: { transformToByteArray: async () => original },
        ContentType: 'image/png',
      };
    });
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
        },
      ],
      upload_artifacts: [
        {
          id: 'upl_cover_entropy',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/cover-entropy.png',
          checksum_sha256: checksum,
          size_bytes: original.length,
          metadata: JSON.stringify({
            image: { width: 1600, height: 1000, format: 'png' },
          }),
        },
      ],
    });

    await expect(
      attachEventMedia({
        db,
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        eventId: 'evt_1',
        uploadArtifactId: 'upl_cover_entropy',
        role: 'cover',
        altText: 'High-detail cover image',
        focalPoint: { x: 0.5, y: 0.5 },
        createdBy: 'usr_1',
      }),
    ).rejects.toThrow('page event media rendition exceeds its 600000-byte performance budget');
    expect(writes).toHaveLength(2);
    expect(deletes).toEqual(writes);
    expect(tables.event_media_assets ?? []).toHaveLength(0);
    expect(tables.event_media_renditions ?? []).toHaveLength(0);
  }, 15_000);

  it('compensates every attempted rendition object when a later write fails', async () => {
    const original = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: '#14532d' },
    })
      .jpeg()
      .toBuffer();
    const checksum = createHash('sha256').update(original).digest('hex');
    let writes = 0;
    const deletedKeys: string[] = [];
    s3Send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
      if (command.input.Body) {
        writes += 1;
        if (writes === 2) throw new Error('object store unavailable');
        return {};
      }
      if (String(command.input.Key).startsWith('event-media/')) {
        deletedKeys.push(String(command.input.Key));
        return {};
      }
      return { Body: { transformToByteArray: async () => original } };
    });
    const { db, tables } = createMockDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
        },
      ],
      upload_artifacts: [
        {
          id: 'upl_cover',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          purpose: 'event_cover',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'uploads/original.jpg',
          checksum_sha256: checksum,
          size_bytes: original.length,
          metadata: JSON.stringify({
            image: { width: 1600, height: 1000, format: 'jpeg' },
          }),
        },
      ],
    });

    await expect(
      attachEventMedia({
        db,
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        eventId: 'evt_1',
        uploadArtifactId: 'upl_cover',
        role: 'cover',
        altText: 'Crowd watching the main stage',
        focalPoint: { x: 0.5, y: 0.5 },
        createdBy: 'usr_1',
      }),
    ).rejects.toThrow('object store unavailable');
    expect(deletedKeys).toHaveLength(2);
    expect(tables.event_media_assets ?? []).toHaveLength(0);
    expect(tables.event_media_renditions ?? []).toHaveLength(0);
  });
});

describe('upload artifact routes', () => {
  it('creates organization-scoped portable migration uploads for authorized operators', async () => {
    const { db, tables } = createMockDb({
      organizations: [{ id: 'org_1', tenant_id: 'tnt_1' }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['migrations.write'] }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'migration_import',
        organizationId: 'org_1',
        fileName: 'portable-bundle.tixkit.json',
        contentType: 'application/vnd.tixkit.portable+json',
        sizeBytes: 50 * 1024 * 1024,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(tables.upload_artifacts[0]).toMatchObject({
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: null,
      event_id: null,
      purpose: 'migration_import',
      content_type: 'application/vnd.tixkit.portable+json',
    });
    expect(tables.upload_artifacts[0]?.object_key).toContain('/migration-imports/org_1/staging/');
    tables.upload_artifacts[0] = {
      ...tables.upload_artifacts[0],
      status: 'uploaded',
      scan_status: 'clean',
    };
    const complete = await app.inject({
      method: 'POST',
      url: `/upload-artifacts/${tables.upload_artifacts[0]?.id}/complete`,
    });
    expect(complete.statusCode, complete.body).toBe(200);
    const download = await app.inject({
      method: 'GET',
      url: `/upload-artifacts/${tables.upload_artifacts[0]?.id}/download`,
    });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.json()).toMatchObject({
      downloadUrl: expect.stringContaining('https://'),
    });
    await app.close();
  });

  it('allows read-only migration operators to download but not complete scoped imports', async () => {
    const { db } = createMockDb({
      upload_artifacts: [
        {
          id: 'upl_migration_clean',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: null,
          event_id: null,
          purpose: 'migration_import',
          status: 'uploaded',
          scan_status: 'clean',
          bucket: 'tixkit',
          object_key: 'migration-imports/tnt_1/org_1/upl_migration_clean.json',
          content_type: 'application/vnd.tixkit.portable+json',
          file_name: 'portable-bundle.json',
        },
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['migrations.read'] }),
    );
    const download = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_migration_clean/download',
    });
    expect(download.statusCode, download.body).toBe(200);
    const complete = await app.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_migration_clean/complete',
    });
    expect(complete.statusCode, complete.body).toBe(403);
    await app.close();
    const noPermission = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: [] }));
    const deniedComplete = await noPermission.inject({
      method: 'POST',
      url: '/upload-artifacts/upl_migration_clean/complete',
    });
    const deniedDownload = await noPermission.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_migration_clean/download',
    });
    expect(deniedComplete.statusCode, deniedComplete.body).toBe(403);
    expect(deniedDownload.statusCode, deniedDownload.body).toBe(403);
    await noPermission.close();
  });

  it('hides migration imports outside the principal tenant and organization before storage access', async () => {
    const artifact = (id: string, tenantId: string, organizationId: string) => ({
      id,
      tenant_id: tenantId,
      organization_id: organizationId,
      brand_id: null,
      event_id: null,
      purpose: 'migration_import',
      status: 'uploaded',
      scan_status: 'clean',
      bucket: 'tixkit',
      object_key: `migration-imports/${tenantId}/${organizationId}/${id}.json`,
      content_type: 'application/vnd.tixkit.portable+json',
      file_name: 'portable-bundle.json',
    });
    const { db } = createMockDb({
      upload_artifacts: [
        artifact('upl_migration_other_org', 'tnt_1', 'org_2'),
        artifact('upl_migration_other_tenant', 'tnt_2', 'org_1'),
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['migrations.read', 'migrations.write'] }),
    );
    for (const artifactId of ['upl_migration_other_org', 'upl_migration_other_tenant']) {
      const complete = await app.inject({
        method: 'POST',
        url: `/upload-artifacts/${artifactId}/complete`,
      });
      const download = await app.inject({
        method: 'GET',
        url: `/upload-artifacts/${artifactId}/download`,
      });
      expect(complete.statusCode, complete.body).toBe(404);
      expect(download.statusCode, download.body).toBe(404);
    }
    expect(s3Send).not.toHaveBeenCalled();
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('rejects unscoped, resource-scoped, unauthorized, and cross-purpose organization uploads', async () => {
    const { db, tables } = createMockDb({
      organizations: [{ id: 'org_1', tenant_id: 'tnt_1' }],
    });
    const authorized = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['migrations.write'] }),
    );
    const base = {
      purpose: 'migration_import',
      fileName: 'portable-bundle.tixkit.json',
      contentType: 'application/vnd.tixkit.portable+json',
      sizeBytes: 4096,
    };
    const invalidCases: Array<{
      payload: Record<string, unknown>;
      expectedStatus: number;
    }> = [
      { payload: base, expectedStatus: 400 },
      {
        payload: { ...base, organizationId: 'org_other' },
        expectedStatus: 404,
      },
      {
        payload: { ...base, organizationId: 'org_1', brandId: 'brd_1' },
        expectedStatus: 400,
      },
      {
        payload: { ...base, organizationId: 'org_1', eventId: 'evt_1' },
        expectedStatus: 400,
      },
      {
        payload: { ...base, organizationId: 'org_1', brandId: '' },
        expectedStatus: 400,
      },
      {
        payload: { ...base, organizationId: 'org_1', eventId: '' },
        expectedStatus: 400,
      },
      {
        payload: {
          ...base,
          organizationId: 'org_1',
          sizeBytes: 50 * 1024 * 1024 + 1,
        },
        expectedStatus: 400,
      },
      {
        payload: {
          purpose: 'user_avatar',
          organizationId: 'org_1',
          fileName: 'avatar.png',
          contentType: 'image/png',
          sizeBytes: 1024,
        },
        expectedStatus: 400,
      },
    ];
    for (const { payload, expectedStatus } of invalidCases) {
      const response = await authorized.inject({
        method: 'POST',
        url: '/upload-artifacts',
        payload,
      });
      expect(response.statusCode, response.body).toBe(expectedStatus);
    }
    await authorized.close();
    const unauthorized = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: [] }));
    const denied = await unauthorized.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: { ...base, organizationId: 'org_1' },
    });
    expect(denied.statusCode).toBe(403);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await unauthorized.close();
  });

  it('rejects a system principal organization from another tenant before signing', async () => {
    const { db, tables } = createMockDb({
      organizations: [{ id: 'org_other_tenant', tenant_id: 'tnt_2' }],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({
        type: 'system',
        scopes: ['migrations.write'],
        organizationIds: [],
        brandIds: [],
        eventIds: [],
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'migration_import',
        organizationId: 'org_other_tenant',
        fileName: 'portable-bundle.tixkit.json',
        contentType: 'application/vnd.tixkit.portable+json',
        sizeBytes: 4096,
      },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(tables.upload_artifacts).toHaveLength(0);
    expect(signedUrlInputs).toHaveLength(0);
    await app.close();
  });

  it('scopes event-cover uploads and returns a durable public artifact URL', async () => {
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
    const response = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'event_cover',
        brandId: 'brd_1',
        eventId: 'evt_1',
        fileName: 'cover.webp',
        contentType: 'image/webp',
        sizeBytes: 1024,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(tables.upload_artifacts[0]).toMatchObject({
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      purpose: 'event_cover',
    });
    tables.upload_artifacts[0] = {
      ...tables.upload_artifacts[0],
      status: 'uploaded',
      scan_status: 'clean',
    };
    const download = await app.inject({
      method: 'GET',
      url: `/upload-artifacts/${tables.upload_artifacts[0]?.id}/download`,
    });
    expect(download.json()).toMatchObject({
      downloadUrl: expect.stringContaining('https://s3.test/'),
    });
    expect(download.json()).not.toHaveProperty('durable');
    const wrongBrand = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'event_cover',
        brandId: 'brd_other',
        eventId: 'evt_1',
        fileName: 'cover.webp',
        contentType: 'image/webp',
        sizeBytes: 1024,
      },
    });
    expect(wrongBrand.statusCode).toBe(400);
    await app.close();
  });
  beforeEach(() => {
    signedUrlInputs.length = 0;
    s3ClientOptions.length = 0;
    s3Send.mockReset();
    delete process.env.S3_PUBLIC_ENDPOINT;
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

  it('allows events.write principals to create content event page image uploads', async () => {
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
          id: 'cdoc_page_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          event_id: 'evt_1',
          channel: 'event_page',
        },
      ],
    });
    const app = await setupUploadApp(db, uploadRoutes, makePrincipal({ scopes: ['events.write'] }));

    const res = await app.inject({
      method: 'POST',
      url: '/upload-artifacts',
      payload: {
        purpose: 'content_event_page_image',
        brandId: 'brd_1',
        eventId: 'evt_1',
        fileName: 'hero.png',
        contentType: 'image/png',
        sizeBytes: 12,
        metadata: {
          source: 'admin_event_page_editor',
          contentDocumentId: 'cdoc_page_1',
        },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(tables.upload_artifacts).toHaveLength(1);
    expect(tables.upload_artifacts[0]).toMatchObject({
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      event_id: 'evt_1',
      purpose: 'content_event_page_image',
      content_type: 'image/png',
    });
    expect(String(tables.upload_artifacts[0]?.object_key)).toContain('content-event-page-images');

    tables.upload_artifacts[0] = {
      ...tables.upload_artifacts[0],
      status: 'uploaded',
      scan_status: 'clean',
    };
    const download = await app.inject({
      method: 'GET',
      url: `/upload-artifacts/${tables.upload_artifacts[0]?.id}/download`,
    });

    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({
      downloadUrl: `/v1/public/content-event-page-images/${tables.upload_artifacts[0]?.id}`,
      durable: true,
    });
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
      payload: {
        ...basePayload,
        metadata: { contentDocumentId: 'cdoc_other_event' },
      },
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
    const imageBytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#336699' },
    })
      .png()
      .toBuffer();
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
          size_bytes: imageBytes.length,
          metadata: '{}',
          expires_at: new Date(Date.now() + 60_000),
        },
      ],
    });
    const app = await setupUploadApp(
      db,
      uploadRoutes,
      makePrincipal({ scopes: ['messages.write'] }),
    );
    s3Send
      .mockResolvedValueOnce({ ContentLength: imageBytes.length, ContentType: 'image/png' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array(imageBytes) },
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
    s3Send.mockResolvedValueOnce({
      Body: imageStream,
      ContentType: 'image/png',
    });

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
    s3Send.mockResolvedValueOnce({
      Body: imageStream,
      ContentType: 'image/png',
    });

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

  it('rejects every non-user principal across the user-avatar artifact lifecycle', async () => {
    for (const principalType of ['api_key', 'agent', 'mobile_device', 'system'] as const) {
      signedUrlInputs.length = 0;
      s3Send.mockReset();
      const principalId = `${principalType}_avatar_owner`;
      const { db, tables } = createMockDb({
        upload_artifacts: [
          {
            id: `upl_${principalType}_pending`,
            tenant_id: 'tnt_1',
            organization_id: null,
            brand_id: null,
            event_id: null,
            created_by_user_id: principalId,
            purpose: 'user_avatar',
            status: 'pending',
            scan_status: 'pending',
            bucket: 'tixkit',
            object_key: `uploads/tnt_1/avatars/${principalId}/staging/pending.png`,
            content_type: 'image/png',
            size_bytes: 12,
            expires_at: new Date(Date.now() + 60_000),
          },
          {
            id: `upl_${principalType}_clean`,
            tenant_id: 'tnt_1',
            organization_id: null,
            brand_id: null,
            event_id: null,
            created_by_user_id: principalId,
            purpose: 'user_avatar',
            status: 'uploaded',
            scan_status: 'clean',
            bucket: 'tixkit',
            object_key: `uploads/tnt_1/avatars/${principalId}/final/clean.png`,
            content_type: 'image/png',
            file_name: 'avatar.png',
          },
        ],
      });
      const app = await setupUploadApp(
        db,
        uploadRoutes,
        makePrincipal({ type: principalType, id: principalId, scopes: [] }),
      );

      const create = await app.inject({
        method: 'POST',
        url: '/upload-artifacts',
        payload: {
          purpose: 'user_avatar',
          fileName: 'avatar.png',
          contentType: 'image/png',
          sizeBytes: 12,
        },
      });
      const complete = await app.inject({
        method: 'POST',
        url: `/upload-artifacts/upl_${principalType}_pending/complete`,
      });
      const download = await app.inject({
        method: 'GET',
        url: `/upload-artifacts/upl_${principalType}_clean/download`,
      });

      for (const response of [create, complete, download]) {
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe('FORBIDDEN');
      }
      expect(tables.upload_artifacts).toHaveLength(2);
      expect(s3Send).not.toHaveBeenCalled();
      expect(signedUrlInputs).toHaveLength(0);
      await app.close();
    }
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
    const res = await app.inject({
      method: 'GET',
      url: '/upload-artifacts/upl_other/download',
    });
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
