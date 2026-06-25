import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @temporalio/client so notification workflow start doesn't try to connect.
vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn() },
  Client: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  exportJob: {
    id: 'exp_1',
    tenant_id: 'tnt_1',
    event_id: 'evt_1',
    type: 'attendees',
    format: 'csv',
    status: 'processing',
    filters: null,
    file_url: null,
    completed_at: null,
  } as Record<string, unknown>,
  updateCalls: [] as Record<string, unknown>[],
  user: { email: 'admin@test.com', tenant_id: 'tnt_1' } as Record<string, unknown> | null,
  providerRoute: { id: 'epr_1', brand_id: 'brd_1' } as Record<string, unknown> | null,
  templateVersion: { id: 'ntv_1' } as Record<string, unknown> | null,
  createdJobs: [] as Record<string, unknown>[],
  exportEvents: [] as Record<string, unknown>[],
  destroy: vi.fn(),
}));

vi.mock('@gatekit/db', () => {
  class EmailJobRepository {
    async create(input: Record<string, unknown>) {
      dbState.createdJobs.push(input);
      return { id: 'emj_1', status: 'pending', ...input };
    }
  }

  function createQuery(table: string) {
    const query = {
      innerJoin() { return query; },
      select() { return query; },
      selectAll() { return query; },
      where() { return query; },
      orderBy() { return query; },
      async executeTakeFirst() {
        if (table === 'export_jobs') return dbState.exportJob;
        if (table === 'user_profiles') return dbState.user;
        if (table === 'email_provider_routes') return dbState.providerRoute;
        if (table === 'notification_templates as template') return dbState.templateVersion;
        return undefined;
      },
      async executeTakeFirstOrThrow() {
        if (table === 'export_jobs') return dbState.exportJob;
        if (table === 'user_profiles') return dbState.user;
        if (table === 'email_provider_routes') return dbState.providerRoute;
        if (table === 'notification_templates as template') return dbState.templateVersion;
        throw new Error(`No mock row for table ${table}`);
      },
      async execute() {
        if (table === 'attendees') return [{ id: 'att_1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@test.com', status: 'registered', tenant_id: 'tnt_1', event_id: 'evt_1', created_at: new Date('2026-06-01') }];
        if (table === 'orders') return [{ id: 'ord_1', order_number: 'GK-1001', status: 'paid', total_cents: 10000, currency: 'USD', buyer_email: 'buyer@test.com', tenant_id: 'tnt_1', event_id: 'evt_1', created_at: new Date('2026-06-01') }];
        if (table === 'scan_logs') return [{ id: 'slog_1', outcome: 'accepted', qr_hash: 'hash_1', tenant_id: 'tnt_1', created_at: new Date('2026-06-01') }];
        if (table === 'tickets') return [{ attendee_id: 'att_1' }];
        return [];
      },
    };
    return query;
  }

  function createMockDb() {
    const db = {
      selectFrom: createQuery,
      updateTable: (table: string) => ({
        set: (values: Record<string, unknown>) => {
          dbState.updateCalls.push({ table, ...values });
          // Simulate the DB update by mutating the in-memory export job.
          if (table === 'export_jobs') {
            Object.assign(dbState.exportJob, values);
          }
          return {
            where: () => ({
              execute: async () => [],
            }),
          };
        },
      }),
      insertInto: (table: string) => ({
        values: (values: Record<string, unknown>) => ({
          execute: async () => {
            if (table === 'export_job_events') {
              dbState.exportEvents.push(values);
            }
          },
        }),
      }),
      transaction: () => ({
        execute: async (fn: (trx: typeof db) => Promise<unknown>) => fn(db),
      }),
      destroy: dbState.destroy,
    };
    return db;
  }

  return {
    createDb: createMockDb,
    EmailJobRepository,
  };
});

const { generateExportActivity, uploadFileActivity, markExportFailedActivity, notifyExportCompleteActivity } = await import('../activities/export.js');

describe('generateExportActivity', () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: 'exp_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'attendees',
      format: 'csv',
      status: 'processing',
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
  });

  it('generates a CSV export for attendees', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rowCount).toBe(1);
      expect(result.value.data).toContain('Ada');
      expect(result.value.data).toContain('ada@test.com');
    }
  });

  it('sets status to processing when generation starts', async () => {
    await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({ table: 'export_jobs', status: 'processing' }),
    );
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      export_job_id: 'exp_1',
      status: 'processing',
    });
  });
});

describe('uploadFileActivity', () => {
  it('returns a file URL based on bucket and key', async () => {
    const result = await uploadFileActivity({
      exportId: 'exp_1',
      data: 'id,name\n1,Test',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toContain('exp_1.csv');
      expect(result.value.fileUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('markExportFailedActivity', () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: 'exp_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'attendees',
      format: 'csv',
      status: 'processing',
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
  });

  it('updates export job status to failed with a terminal timestamp', async () => {
    const result = await markExportFailedActivity({
      exportId: 'exp_1',
      reason: 'Upload failed',
    });

    expect(result.ok).toBe(true);
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: 'export_jobs',
        status: 'failed',
      }),
    );
    const failedUpdate = dbState.updateCalls.find(
      (c) => c.table === 'export_jobs' && c.status === 'failed',
    );
    expect(failedUpdate?.completed_at).toBeInstanceOf(Date);
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      export_job_id: 'exp_1',
      status: 'failed',
    });
    expect(String(dbState.exportEvents[0].payload)).toContain('Upload failed');
  });
});

describe('notifyExportCompleteActivity', () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: 'exp_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'attendees',
      format: 'csv',
      status: 'processing',
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.user = { email: 'admin@test.com', tenant_id: 'tnt_1' };
    dbState.providerRoute = { id: 'epr_1', brand_id: 'brd_1' };
    dbState.templateVersion = { id: 'ntv_1' };
    dbState.createdJobs = [];
  });

  it('updates export job status to completed and sets file_url', async () => {
    const result = await notifyExportCompleteActivity({
      exportId: 'exp_1',
      fileUrl: 'https://bucket.s3.amazonaws.com/exports/exp_1.csv',
      requestedBy: 'usr_1',
      tenantId: 'tnt_1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notified).toBe(true);
    }

    // Verify the DB was updated to completed status with file URL.
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: 'export_jobs',
        status: 'completed',
        file_url: 'https://bucket.s3.amazonaws.com/exports/exp_1.csv',
      }),
    );
    // completed_at should be set to a Date.
    const completedUpdate = dbState.updateCalls.find(
      (c) => c.table === 'export_jobs' && c.status === 'completed',
    );
    expect(completedUpdate?.completed_at).toBeInstanceOf(Date);
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      tenant_id: 'tnt_1',
      export_job_id: 'exp_1',
      status: 'completed',
    });
    expect(String(dbState.exportEvents[0].payload)).toContain('/v1/exports/exp_1/download');
  });

  it('queues an admin notification email with the file URL', async () => {
    await notifyExportCompleteActivity({
      exportId: 'exp_1',
      fileUrl: 'https://bucket.s3.amazonaws.com/exports/exp_1.csv',
      requestedBy: 'usr_1',
      tenantId: 'tnt_1',
    });

    expect(dbState.createdJobs).toHaveLength(1);
    expect(dbState.createdJobs[0]).toMatchObject({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'staff-order-notification',
      toEmail: 'admin@test.com',
      providerRouteId: 'epr_1',
      idempotencyKey: 'export-complete:exp_1',
    });
    expect(dbState.createdJobs[0].variables).toMatchObject({
      exportId: 'exp_1',
      fileUrl: 'https://bucket.s3.amazonaws.com/exports/exp_1.csv',
    });
  });

  it('still marks export as completed when no user email is found', async () => {
    dbState.user = null;

    const result = await notifyExportCompleteActivity({
      exportId: 'exp_1',
      fileUrl: 'https://bucket.s3.amazonaws.com/exports/exp_1.csv',
      requestedBy: 'usr_unknown',
      tenantId: 'tnt_1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.notified).toBe(true);
    }
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({
        table: 'export_jobs',
        status: 'completed',
      }),
    );
    // No email job should be created.
    expect(dbState.createdJobs).toHaveLength(0);
  });
});
