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
  // Configurable row sets so each test can stage its own export dataset.
  attendees: [
    {
      id: 'att_1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@test.com',
      phone: '+15550000001',
      status: 'registered',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      order_id: 'ord_1',
      ticket_type_id: 'tt_1',
      custom_answers: null,
      checked_in_at: null,
      created_at: new Date('2026-06-01'),
    },
  ] as Record<string, unknown>[],
  orders: [
    {
      id: 'ord_1',
      order_number: 'TK-1001',
      status: 'paid',
      total_cents: 10000,
      refunded_cents: 0,
      tax_cents: 500,
      fee_cents: 200,
      subtotal_cents: 9300,
      discount_cents: 0,
      currency: 'USD',
      buyer_email: 'buyer@test.com',
      buyer_first_name: 'Ada',
      buyer_last_name: 'Lovelace',
      paid_at: new Date('2026-06-01'),
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      created_at: new Date('2026-06-01'),
    },
  ] as Record<string, unknown>[],
  questions: [] as Record<string, unknown>[],
  destroy: vi.fn(),
}));

vi.mock('@tixkit/db', () => {
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
        if (table === 'attendees') return dbState.attendees;
        if (table === 'orders') return dbState.orders;
        if (table === 'questions') return dbState.questions;
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
    dbState.questions = [];
    dbState.attendees = [
      {
        id: 'att_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@test.com',
        phone: '+15550000001',
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
    ];
    dbState.orders = [
      {
        id: 'ord_1',
        order_number: 'TK-1001',
        status: 'paid',
        total_cents: 10000,
        refunded_cents: 0,
        tax_cents: 500,
        fee_cents: 200,
        subtotal_cents: 9300,
        discount_cents: 0,
        currency: 'USD',
        buyer_email: 'buyer@test.com',
        buyer_first_name: 'Ada',
        buyer_last_name: 'Lovelace',
        paid_at: new Date('2026-06-01'),
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        created_at: new Date('2026-06-01'),
      },
    ];
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

// ---------------------------------------------------------------------------
// T30: Export file content validation
// These suites validate the actual generated CSV content (headers, data rows,
// field counts, financial totals, question/consent answer columns, and failure
// recovery) rather than only the workflow status transitions.
// ---------------------------------------------------------------------------

/**
 * Parse a CSV string into a 2D array of cells. Handles quoted fields containing
 * commas, doubled-quote escapes, and newlines. Splits on `\n` (the export
 * activity joins rows with `\n`).
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  // Trailing field/row (no final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('T30 export content validation - attendee CSV', () => {
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
    dbState.questions = [];
    dbState.attendees = [
      {
        id: 'att_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@test.com',
        phone: '+15550000001',
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date('2026-06-01T10:00:00Z'),
      },
      {
        id: 'att_2',
        first_name: 'Grace',
        last_name: 'Hopper',
        email: 'grace@test.com',
        phone: '+15550000002',
        status: 'checked_in',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_2',
        ticket_type_id: 'tt_1',
        custom_answers: null,
        checked_in_at: new Date('2026-06-01T11:00:00Z'),
        created_at: new Date('2026-06-01T09:00:00Z'),
      },
    ];
  });

  it('emits the expected attendee export headers in order', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    expect(headers).toEqual([
      'id',
      'email',
      'firstName',
      'lastName',
      'phone',
      'status',
      'eventId',
      'orderId',
      'checkedInAt',
      'createdAt',
    ]);
  });

  it('produces one data row per attendee plus a header row', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    // header + 2 data rows
    expect(rows).toHaveLength(3);
    // Every data row has the same number of fields as the header row.
    for (const row of rows) {
      expect(row).toHaveLength(rows[0].length);
    }
  });

  it('includes rows through the end of a date-only to filter', async () => {
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: JSON.stringify({ from: '2026-06-01', to: '2026-06-01' }),
    };

    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    expect(rows.map((row) => row[1])).toEqual(['email', 'ada@test.com', 'grace@test.com']);
  });

  it('includes attendee field values in the correct columns', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const emailCol = headers.indexOf('email');
    const firstNameCol = headers.indexOf('firstName');
    const lastNameCol = headers.indexOf('lastName');
    const statusCol = headers.indexOf('status');

    // First attendee (Ada)
    expect(rows[1][emailCol]).toBe('ada@test.com');
    expect(rows[1][firstNameCol]).toBe('Ada');
    expect(rows[1][lastNameCol]).toBe('Lovelace');
    expect(rows[1][statusCol]).toBe('registered');

    // Second attendee (Grace)
    expect(rows[2][emailCol]).toBe('grace@test.com');
    expect(rows[2][firstNameCol]).toBe('Grace');
    expect(rows[2][statusCol]).toBe('checked_in');
  });

  it('returns an empty CSV body (no header) when there are zero attendees', async () => {
    dbState.attendees = [];
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(0);
    // toCsv returns '' for empty row sets.
    expect(result.value.data).toBe('');
  });
});

describe('T30 export content validation - sales report CSV', () => {
  beforeEach(() => {
    dbState.exportJob = {
      id: 'exp_1',
      tenant_id: 'tnt_1',
      event_id: 'evt_1',
      type: 'sales',
      format: 'csv',
      status: 'processing',
      filters: null,
      file_url: null,
      completed_at: null,
    };
    dbState.updateCalls = [];
    dbState.exportEvents = [];
    dbState.questions = [];
    dbState.orders = [
      {
        id: 'ord_1',
        order_number: 'TK-1001',
        status: 'paid',
        total_cents: 10000,
        refunded_cents: 0,
        tax_cents: 500,
        fee_cents: 200,
        currency: 'USD',
        buyer_email: 'buyer@test.com',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        created_at: new Date('2026-06-01'),
      },
      {
        id: 'ord_2',
        order_number: 'TK-1002',
        status: 'partially_refunded',
        total_cents: 5000,
        refunded_cents: 1500,
        tax_cents: 250,
        fee_cents: 100,
        currency: 'USD',
        buyer_email: 'buyer2@test.com',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        created_at: new Date('2026-06-02'),
      },
    ];
  });

  it('emits the expected sales report headers in order', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'sales',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    expect(rows[0]).toEqual([
      'orderId',
      'orderNumber',
      'status',
      'currency',
      'grossCents',
      'refundedCents',
      'netCents',
      'taxCents',
      'feeCents',
      'buyerEmail',
      'createdAt',
    ]);
  });

  it('produces one data row per order plus a header row with consistent field counts', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'sales',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rowCount).toBe(2);
    const rows = parseCsv(result.value.data);
    expect(rows).toHaveLength(3);
    const headerLen = rows[0].length;
    for (const row of rows) {
      expect(row).toHaveLength(headerLen);
    }
  });

  it('computes gross, refunded, and net financial totals correctly per row', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'sales',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const grossCol = headers.indexOf('grossCents');
    const refundedCol = headers.indexOf('refundedCents');
    const netCol = headers.indexOf('netCents');
    const taxCol = headers.indexOf('taxCents');
    const feeCol = headers.indexOf('feeCents');

    // Order 1: gross 10000, refunded 0, net 10000
    expect(Number(rows[1][grossCol])).toBe(10000);
    expect(Number(rows[1][refundedCol])).toBe(0);
    expect(Number(rows[1][netCol])).toBe(10000);
    expect(Number(rows[1][taxCol])).toBe(500);
    expect(Number(rows[1][feeCol])).toBe(200);

    // Order 2: gross 5000, refunded 1500, net 3500
    expect(Number(rows[2][grossCol])).toBe(5000);
    expect(Number(rows[2][refundedCol])).toBe(1500);
    expect(Number(rows[2][netCol])).toBe(3500);
  });

  it('aggregates financial totals across all rows match the sum of the dataset', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'sales',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const grossCol = headers.indexOf('grossCents');
    const refundedCol = headers.indexOf('refundedCents');
    const netCol = headers.indexOf('netCents');

    let totalGross = 0;
    let totalRefunded = 0;
    let totalNet = 0;
    for (let i = 1; i < rows.length; i++) {
      totalGross += Number(rows[i][grossCol]);
      totalRefunded += Number(rows[i][refundedCol]);
      totalNet += Number(rows[i][netCol]);
    }

    expect(totalGross).toBe(15000);
    expect(totalRefunded).toBe(1500);
    expect(totalNet).toBe(13500);
    // net must equal gross - refunded
    expect(totalNet).toBe(totalGross - totalRefunded);
  });
});

describe('T30 export content validation - checkout question answers', () => {
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
    dbState.questions = [
      {
        id: 'q_company',
        label: 'Company Name',
        is_consent_field: false,
        consent_text: null,
        consent_version: null,
        applies_to: 'attendee',
        ticket_type_id: null,
        sort_order: 1,
      },
      {
        id: 'q_shirt',
        label: 'T-Shirt Size',
        is_consent_field: false,
        consent_text: null,
        consent_version: null,
        applies_to: 'attendee',
        ticket_type_id: null,
        sort_order: 2,
      },
    ];
    dbState.attendees = [
      {
        id: 'att_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@test.com',
        phone: null,
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        custom_answers: JSON.stringify({
          q_company: 'Analytical Engines Inc.',
          q_shirt: ['S', 'M'],
        }),
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
      {
        id: 'att_2',
        first_name: 'Grace',
        last_name: 'Hopper',
        email: 'grace@test.com',
        phone: null,
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_2',
        ticket_type_id: 'tt_1',
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
    ];
  });

  it('appends question label columns after the base attendee columns', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const baseHeaderCount = 10;
    expect(headers.slice(0, baseHeaderCount)).toEqual([
      'id',
      'email',
      'firstName',
      'lastName',
      'phone',
      'status',
      'eventId',
      'orderId',
      'checkedInAt',
      'createdAt',
    ]);
    // Question columns appended in sort order.
    expect(headers.slice(baseHeaderCount)).toEqual(['Company Name', 'T-Shirt Size']);
  });

  it('populates question answer values from custom_answers, joining arrays with "; "', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const companyCol = headers.indexOf('Company Name');
    const shirtCol = headers.indexOf('T-Shirt Size');

    // Ada answered both questions.
    expect(rows[1][companyCol]).toBe('Analytical Engines Inc.');
    expect(rows[1][shirtCol]).toBe('S; M');

    // Grace has no answers; cells should be empty.
    expect(rows[2][companyCol]).toBe('');
    expect(rows[2][shirtCol]).toBe('');
  });

  it('keeps all rows at the same field count including question columns', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headerLen = rows[0].length;
    expect(headerLen).toBe(12); // 10 base + 2 questions
    for (const row of rows) {
      expect(row).toHaveLength(headerLen);
    }
  });

  it('does not append question columns when no questions are configured', async () => {
    dbState.questions = [];
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    expect(rows[0]).toHaveLength(10);
  });
});

describe('T30 export content validation - consent field data', () => {
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
    dbState.questions = [
      {
        id: 'q_marketing',
        label: 'Marketing Consent',
        is_consent_field: true,
        consent_text: 'I agree to receive marketing emails.',
        consent_version: 'v2',
        applies_to: 'attendee',
        ticket_type_id: null,
        sort_order: 1,
      },
    ];
    dbState.attendees = [
      {
        id: 'att_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@test.com',
        phone: null,
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        custom_answers: JSON.stringify({
          q_marketing: {
            accepted: true,
            consentText: 'I agree to receive marketing emails.',
            consentVersion: 'v2',
            consentedAt: '2026-06-01T10:00:00.000Z',
          },
        }),
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
      {
        id: 'att_2',
        first_name: 'Grace',
        last_name: 'Hopper',
        email: 'grace@test.com',
        phone: null,
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_2',
        ticket_type_id: 'tt_1',
        // Bare boolean true (no snapshot) - should fall back to question definition.
        custom_answers: JSON.stringify({ q_marketing: true }),
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
      {
        id: 'att_3',
        first_name: 'Alan',
        last_name: 'Turing',
        email: 'alan@test.com',
        phone: null,
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_3',
        ticket_type_id: 'tt_1',
        // Declined (no answer key present).
        custom_answers: JSON.stringify({}),
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
    ];
  });

  it('emits two columns per consent field: acceptance and historical consent text', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    expect(headers).toContain('Marketing Consent');
    expect(headers).toContain('Marketing Consent (consent text)');
  });

  it('records "accepted" and the historical consent text/version snapshot for accepted attendees', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const acceptCol = headers.indexOf('Marketing Consent');
    const textCol = headers.indexOf('Marketing Consent (consent text)');

    // Ada - full snapshot.
    expect(rows[1][acceptCol]).toBe('accepted');
    expect(rows[1][textCol]).toBe('I agree to receive marketing emails. (v2)');
  });

  it('falls back to the question definition consent text/version when the answer is a bare boolean', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const acceptCol = headers.indexOf('Marketing Consent');
    const textCol = headers.indexOf('Marketing Consent (consent text)');

    // Grace - bare true, falls back to question.consent_text / consent_version.
    expect(rows[2][acceptCol]).toBe('accepted');
    expect(rows[2][textCol]).toBe('I agree to receive marketing emails. (v2)');
  });

  it('leaves consent columns empty for attendees who did not accept', async () => {
    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = parseCsv(result.value.data);
    const headers = rows[0];
    const acceptCol = headers.indexOf('Marketing Consent');
    const textCol = headers.indexOf('Marketing Consent (consent text)');

    // Alan - declined.
    expect(rows[3][acceptCol]).toBe('');
    expect(rows[3][textCol]).toBe('');
  });
});

describe('T30 export failure recovery', () => {
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
    dbState.questions = [];
    dbState.attendees = [
      {
        id: 'att_1',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@test.com',
        phone: null,
        status: 'registered',
        tenant_id: 'tnt_1',
        event_id: 'evt_1',
        order_id: 'ord_1',
        ticket_type_id: 'tt_1',
        custom_answers: null,
        checked_in_at: null,
        created_at: new Date('2026-06-01'),
      },
    ];
  });

  it('markExportFailedActivity records a terminal failed status with a reason', async () => {
    const result = await markExportFailedActivity({
      exportId: 'exp_1',
      reason: 'S3 upload timed out',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.failed).toBe(true);
    }
    expect(dbState.updateCalls).toContainEqual(
      expect.objectContaining({ table: 'export_jobs', status: 'failed' }),
    );
    const failedUpdate = dbState.updateCalls.find(
      (c) => c.table === 'export_jobs' && c.status === 'failed',
    );
    expect(failedUpdate?.completed_at).toBeInstanceOf(Date);
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({
      status: 'failed',
      export_job_id: 'exp_1',
    });
    expect(String(dbState.exportEvents[0].payload)).toContain('S3 upload timed out');
  });

  it('generateExportActivity returns a retryable error result when generation fails', async () => {
    // Force a failure by making the export job lookup throw via a corrupted
    // filters payload that JSON.parse cannot handle.
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: '{not valid json',
    };

    const result = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('EXPORT_GENERATION_FAILED');
      expect(result.retryable).toBe(true);
    }
  });

  it('a failed export can be retried by re-running generateExportActivity after the job is reset to processing', async () => {
    // First attempt: simulate a failure by corrupting filters.
    dbState.exportJob = {
      ...dbState.exportJob,
      filters: '{bad',
    };
    const failedResult = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });
    expect(failedResult.ok).toBe(false);

    // Mark the export as failed in the DB (as the workflow would).
    const markResult = await markExportFailedActivity({
      exportId: 'exp_1',
      reason: 'Generation failed',
    });
    expect(markResult.ok).toBe(true);

    // Reset the job to processing with valid filters for retry.
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

    const retryResult = await generateExportActivity({
      exportId: 'exp_1',
      type: 'attendees',
      format: 'csv',
    });

    expect(retryResult.ok).toBe(true);
    if (retryResult.ok) {
      expect(retryResult.value.rowCount).toBe(1);
      expect(retryResult.value.data).toContain('ada@test.com');
    }
    // The retry should record a fresh processing event.
    expect(dbState.exportEvents).toHaveLength(1);
    expect(dbState.exportEvents[0]).toMatchObject({ status: 'processing' });
  });
});

describe('T30 export download file URL', () => {
  // The HTTP download endpoint (GET /exports/:exportId/download) is covered by
  // packages/api/src/__tests__/integration/orders-reporting-routes.test.ts.
  // These tests validate that uploadFileActivity produces the file URL that the
  // download endpoint redirects to, and that the URL points at the generated
  // export artifact for the correct format.

  it('produces a download URL ending in .csv for CSV exports', async () => {
    const result = await uploadFileActivity({
      exportId: 'exp_download',
      data: 'id,email\natt_1,ada@test.com',
      format: 'csv',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toMatch(/^https:\/\//);
      expect(result.value.fileUrl).toContain('exp_download.csv');
    }
  });

  it('produces a download URL ending in .json for JSON exports', async () => {
    const result = await uploadFileActivity({
      exportId: 'exp_json',
      data: '[{"id":"att_1"}]',
      format: 'json',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fileUrl).toMatch(/^https:\/\//);
      expect(result.value.fileUrl).toContain('exp_json.json');
    }
  });

  it('the completed export job file_url matches the uploaded artifact URL used by the download endpoint', async () => {
    // Upload the generated file.
    const uploadResult = await uploadFileActivity({
      exportId: 'exp_1',
      data: 'id,email\natt_1,ada@test.com',
      format: 'csv',
    });
    expect(uploadResult.ok).toBe(true);
    if (!uploadResult.ok) return;

    // Notify completion, which persists file_url on the export job.
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
    dbState.user = null;
    dbState.providerRoute = null;
    dbState.templateVersion = null;

    await notifyExportCompleteActivity({
      exportId: 'exp_1',
      fileUrl: uploadResult.value.fileUrl,
      requestedBy: 'usr_1',
      tenantId: 'tnt_1',
    });

    // The persisted file_url is what GET /exports/:exportId/download redirects to.
    const completedUpdate = dbState.updateCalls.find(
      (c) => c.table === 'export_jobs' && c.status === 'completed',
    );
    expect(completedUpdate?.file_url).toBe(uploadResult.value.fileUrl);
    expect(completedUpdate?.file_url).toContain('exp_1.csv');
  });
});
