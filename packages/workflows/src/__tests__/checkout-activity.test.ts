import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const temporalState = vi.hoisted(() => ({
  workflowStart: vi.fn(async () => undefined),
}));

// Mock @temporalio/client so startNotificationWorkflow doesn't try to connect.
vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn(async () => ({ close: vi.fn() })) },
  Client: vi.fn(function Client() {
    return { workflow: { start: temporalState.workflowStart } };
  }),
}));

const dbState = vi.hoisted(() => ({
  existingJob: undefined as Record<string, unknown> | undefined,
  providerRoute: undefined as { id: string } | undefined,
  publishedTemplate: { version: { id: 'ntv_default' }, document: { id: 'cdoc_1' } } as
    | { version: { id: string }; document: { id: string } }
    | undefined,
  createJobErrorOnce: undefined as Error | undefined,
  createdJobs: [] as Record<string, unknown>[],
  updatedJobs: [] as Array<{ id: string; input: Record<string, unknown> }>,
  order: {
    id: 'ord_1',
    order_number: 'TK-1001',
    event_id: 'evt_1',
    currency: 'USD',
    total_cents: 4500,
    refunded_cents: 0,
    buyer_email: 'buyer@example.com',
    buyer_first_name: 'Jordan',
    buyer_last_name: 'Lee',
    buyer_phone: '+15551234567',
  },
  event: {
    id: 'evt_1',
    title: 'Founders Summit',
    starts_at: new Date('2027-05-12T18:30:00.000Z'),
    timezone: 'America/New_York',
    venue: JSON.stringify({
      name: 'Main Hall',
      address: '100 Market St',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
    }),
  },
  brand: {
    id: 'brd_1',
    name: 'Northstar Events',
    theme: JSON.stringify({ primaryColor: '#1f6feb' }),
  },
  tickets: [] as Record<string, unknown>[],
  ticketTypes: [{ id: 'tt_1', name: 'General Admission' }] as Record<string, unknown>[],
  attendees: [
    {
      id: 'att_1',
      email: 'ada@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
    },
  ] as Record<string, unknown>[],
  destroy: vi.fn(),
}));

vi.mock('@tixkit/db', () => {
  class EmailJobRepository {
    async create(input: Record<string, unknown>) {
      if (dbState.createJobErrorOnce) {
        const error = dbState.createJobErrorOnce;
        dbState.createJobErrorOnce = undefined;
        throw error;
      }
      dbState.createdJobs.push(input);
      return { id: 'emj_1', status: 'pending', ...input };
    }
    async update(id: string, input: Record<string, unknown>) {
      dbState.updatedJobs.push({ id, input });
      if (dbState.existingJob?.id === id) {
        Object.assign(dbState.existingJob, input);
        return dbState.existingJob;
      }
      return { id, ...input };
    }
  }

  class OrderRepository {
    async findById(orderId: string) {
      return { ...dbState.order, id: orderId };
    }
  }

  class PaymentIntentRepository {
    async findById() {
      return undefined;
    }
  }

  class ContentRepository {
    async findPublishedEmailTemplate() {
      return dbState.publishedTemplate;
    }
  }

  function createQuery(table: string) {
    const query = {
      innerJoin() {
        return query;
      },
      select() {
        return query;
      },
      selectAll() {
        return query;
      },
      where() {
        return query;
      },
      orderBy() {
        return query;
      },
      async executeTakeFirst() {
        if (table === 'email_jobs') return dbState.existingJob;
        if (table === 'email_provider_routes') return dbState.providerRoute;
        if (table === 'events') return dbState.event;
        if (table === 'brands') return dbState.brand;
        return undefined;
      },
      async execute() {
        if (table === 'tickets') return dbState.tickets;
        if (table === 'ticket_types') return dbState.ticketTypes;
        if (table === 'attendees') return dbState.attendees;
        return [];
      },
    };
    return query;
  }

  return {
    createDb: () => ({
      selectFrom: createQuery,
      destroy: dbState.destroy,
    }),
    EmailJobRepository,
    OrderRepository,
    PaymentIntentRepository,
    ContentRepository,
  };
});

const { sendConfirmationEmailActivity, issueTicketsActivity } =
  await import('../activities/checkout.js');

describe('sendConfirmationEmailActivity', () => {
  beforeEach(() => {
    dbState.existingJob = undefined;
    dbState.providerRoute = undefined;
    dbState.publishedTemplate = { version: { id: 'ntv_default' }, document: { id: 'cdoc_1' } };
    dbState.createJobErrorOnce = undefined;
    dbState.createdJobs = [];
    dbState.updatedJobs = [];
    dbState.tickets = [];
    dbState.ticketTypes = [{ id: 'tt_1', name: 'General Admission' }];
    dbState.attendees = [
      {
        id: 'att_1',
        email: 'ada@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
      },
    ];
    dbState.destroy.mockClear();
    temporalState.workflowStart.mockReset();
    temporalState.workflowStart.mockResolvedValue(undefined);
  });

  it('skips when no active provider route is persisted for the brand', async () => {
    const result = await sendConfirmationEmailActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { status: 'skipped' } });
    expect(dbState.createdJobs).toEqual([]);
  });

  it('skips when no published email content template is configured for the scope', async () => {
    dbState.providerRoute = { id: 'epr_1' };
    dbState.publishedTemplate = undefined;

    const result = await sendConfirmationEmailActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { status: 'skipped' } });
    expect(dbState.createdJobs).toEqual([]);
  });

  it('queues with the persisted provider route id when delivery is configured', async () => {
    dbState.providerRoute = { id: 'epr_1' };

    const result = await sendConfirmationEmailActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { jobId: 'emj_1', status: 'queued' } });
    expect(dbState.createdJobs).toMatchObject([
      {
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        templateVersionId: 'ntv_default',
        providerRouteId: 'epr_1',
        idempotencyKey: 'order-confirmed:ord_1',
      },
    ]);
    expect(dbState.createdJobs[0].variables).toMatchObject({
      notificationType: 'transactional',
      event: { title: 'Founders Summit', venueName: 'Main Hall', venueCity: 'New York' },
      brand: { name: 'Northstar Events' },
      recipient: { name: 'Jordan Lee', email: 'buyer@example.com' },
      order: { id: 'TK-1001', total: '$45.00', buyerName: 'Jordan Lee' },
    });
    expect(dbState.updatedJobs).toContainEqual({
      id: 'emj_1',
      input: { status: 'queued', workflow_id: 'notification:emj_1' },
    });
  });

  it('marks a newly queued confirmation email start_failed when Temporal rejects the handoff', async () => {
    dbState.providerRoute = { id: 'epr_1' };
    temporalState.workflowStart.mockRejectedValue(new Error('Temporal unavailable'));

    const result = await sendConfirmationEmailActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_QUEUE_FAILED',
      retryable: true,
    });
    expect(dbState.createdJobs).toHaveLength(1);
    expect(dbState.updatedJobs).toContainEqual({
      id: 'emj_1',
      input: { status: 'start_failed', workflow_id: null },
    });
  });

  it('restarts an existing queued confirmation email with no durable workflow id', async () => {
    dbState.existingJob = {
      id: 'emj_existing',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      template_key: 'order-confirmed',
      template_version_id: 'ntv_default',
      to_email: 'buyer@example.com',
      to_name: null,
      variables: JSON.stringify({ notificationType: 'transactional', orderId: 'ord_1' }),
      provider_route_id: 'epr_1',
      status: 'queued',
      workflow_id: null,
      scheduled_at: null,
    };

    const result = await sendConfirmationEmailActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { jobId: 'emj_existing', status: 'queued' } });
    expect(dbState.createdJobs).toHaveLength(0);
    expect(temporalState.workflowStart).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ workflowId: 'notification:emj_existing' }),
    );
    expect(dbState.updatedJobs).toContainEqual({
      id: 'emj_existing',
      input: { status: 'queued', workflow_id: 'notification:emj_existing' },
    });
  });
});

describe('issueTicketsActivity', () => {
  beforeEach(() => {
    dbState.existingJob = undefined;
    dbState.providerRoute = { id: 'epr_1' };
    dbState.publishedTemplate = { version: { id: 'ntv_default' }, document: { id: 'cdoc_1' } };
    dbState.createJobErrorOnce = undefined;
    dbState.createdJobs = [];
    dbState.updatedJobs = [];
    dbState.tickets = [
      {
        id: 'tkt_1',
        order_id: 'ord_1',
        attendee_id: 'att_1',
        ticket_type_id: 'tt_1',
        code: 'TK-ABC123',
        qr_payload: 'signed_qr_payload_1',
      },
    ];
    dbState.destroy.mockClear();
    temporalState.workflowStart.mockReset();
    temporalState.workflowStart.mockResolvedValue(undefined);
    delete process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE;
    delete process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE_KEY;
    delete process.env.APPLE_WALLET_ENABLED;
    delete process.env.GOOGLE_WALLET_ENABLED;
  });

  it('injects one non-production ticket issue activity failure for provider-backed retry proof', async () => {
    process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE = '1';
    process.env.E2E_FAIL_TICKET_ISSUE_ACTIVITY_ONCE_KEY = 'retry-proof@example.com';

    await expect(
      issueTicketsActivity({
        orderId: 'ord_1',
        toEmail: 'retry-proof@example.com',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
      }),
    ).rejects.toThrow('E2E injected ticket issue activity failure for retry-proof@example.com');
    expect(dbState.destroy).not.toHaveBeenCalled();
    expect(dbState.createdJobs).toHaveLength(0);

    const retryResult = await issueTicketsActivity({
      orderId: 'ord_1',
      toEmail: 'retry-proof@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(retryResult).toEqual({ ok: true, value: { issued: 1, jobId: 'emj_1' } });
    expect(dbState.createdJobs).toHaveLength(1);
  });

  it('queues tickets-issued email with a valid branded PDF attachment containing ticket metadata', async () => {
    const result = await issueTicketsActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { issued: 1, jobId: 'emj_1' } });
    expect(dbState.createdJobs).toHaveLength(1);

    const variables = dbState.createdJobs[0].variables as {
      attachments: {
        filename: string;
        contentType: string;
        content: string;
        contentEncoding: 'base64';
      }[];
    };
    expect(variables.attachments).toHaveLength(1);
    expect(variables.attachments[0]).toMatchObject({
      filename: 'ticket-TK-ABC123.pdf',
      contentType: 'application/pdf',
      contentEncoding: 'base64',
    });

    const pdfBytes = Buffer.from(variables.attachments[0].content, 'base64');
    expect(pdfBytes.subarray(0, 5).toString('utf8')).toBe('%PDF-');

    const pdf = await PDFDocument.load(pdfBytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Tixkit ticket TK-ABC123');
    expect(pdf.getSubject()).toContain('Founders Summit');
    expect(pdf.getKeywords()).toContain('tkt_1');
    expect(pdf.getKeywords()).toContain('TK-ABC123');
    expect(pdf.getKeywords()).not.toContain('signed_qr_payload_1');
    expect(pdf.getKeywords()).not.toContain('buyer@example.com');
    expect(pdf.getKeywords()).not.toContain('ada@example.com');
    const pdfText = pdfBytes.toString('latin1');
    expect(pdfText).not.toContain('signed_qr_payload_1');
    expect(pdfText).not.toContain('buyer@example.com');
    expect(pdfText).not.toContain('ada@example.com');

    // C-101: the tickets-issued email job carries a MergeTagContext so lifecycle
    // merge tags resolve at send time (event/brand/recipient/order/ticket).
    expect(dbState.createdJobs[0].variables).toMatchObject({
      notificationType: 'transactional',
      event: { title: 'Founders Summit' },
      brand: { name: 'Northstar Events' },
      recipient: { name: 'Jordan Lee', email: 'buyer@example.com' },
      order: { id: 'TK-1001', total: '$45.00' },
      ticket: { type: 'General Admission', code: 'TK-ABC123' },
    });
  });

  it('continues ticket issuance when optional wallet pass configuration is incomplete', async () => {
    process.env.APPLE_WALLET_ENABLED = 'true';

    const result = await issueTicketsActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { issued: 1, jobId: 'emj_1' } });
    expect(dbState.createdJobs).toHaveLength(1);
    expect(dbState.createdJobs[0].variables).toMatchObject({
      walletPasses: [],
    });
  });

  it('can retry a transient ticket email queue failure without duplicate jobs', async () => {
    dbState.createJobErrorOnce = new Error('database temporarily unavailable');

    await expect(
      issueTicketsActivity({
        orderId: 'ord_1',
        toEmail: 'buyer@example.com',
        tenantId: 'tnt_1',
        brandId: 'brd_1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: 'TICKET_ISSUE_FAILED',
      retryable: true,
    });
    expect(dbState.createdJobs).toHaveLength(0);

    const retryResult = await issueTicketsActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(retryResult).toEqual({ ok: true, value: { issued: 1, jobId: 'emj_1' } });
    expect(dbState.createdJobs).toHaveLength(1);
    expect(dbState.createdJobs[0]).toMatchObject({
      templateKey: 'tickets-issued',
      idempotencyKey: 'tickets-issued:ord_1',
      providerRouteId: 'epr_1',
    });
  });

  it('returns the existing ticket email job on retry without queueing another job', async () => {
    dbState.existingJob = { id: 'emj_existing', status: 'failed' };

    const result = await issueTicketsActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { issued: 1, jobId: 'emj_existing' } });
    expect(dbState.createdJobs).toHaveLength(0);
  });

  it('restarts an existing start_failed ticket email with no durable workflow id', async () => {
    dbState.existingJob = {
      id: 'emj_existing',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      template_key: 'tickets-issued',
      template_version_id: 'ntv_default',
      to_email: 'buyer@example.com',
      to_name: null,
      variables: JSON.stringify({ notificationType: 'transactional', orderId: 'ord_1' }),
      provider_route_id: 'epr_1',
      status: 'start_failed',
      workflow_id: null,
      scheduled_at: null,
    };

    const result = await issueTicketsActivity({
      orderId: 'ord_1',
      toEmail: 'buyer@example.com',
      tenantId: 'tnt_1',
      brandId: 'brd_1',
    });

    expect(result).toEqual({ ok: true, value: { issued: 1, jobId: 'emj_existing' } });
    expect(dbState.createdJobs).toHaveLength(0);
    expect(temporalState.workflowStart).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ workflowId: 'notification:emj_existing' }),
    );
    expect(dbState.updatedJobs).toContainEqual({
      id: 'emj_existing',
      input: { status: 'queued', workflow_id: 'notification:emj_existing' },
    });
  });
});
