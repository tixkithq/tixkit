import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @temporalio/client so startNotificationWorkflow doesn't try to connect.
vi.mock('@temporalio/client', () => ({
  Connection: { connect: vi.fn() },
  Client: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  existingJob: undefined as { id: string; status: string } | undefined,
  providerRoute: undefined as { id: string } | undefined,
  templateVersion: { id: 'ntv_default' } as { id: string } | undefined,
  createdJobs: [] as Record<string, unknown>[],
  destroy: vi.fn(),
}));

vi.mock('@gatekit/db', () => {
  class EmailJobRepository {
    async create(input: Record<string, unknown>) {
      dbState.createdJobs.push(input);
      return { id: 'emj_1', status: 'pending', ...input };
    }
  }

  class OrderRepository {
    async findById(orderId: string) {
      return {
        id: orderId,
        order_number: 'GK-1001',
        event_id: 'evt_1',
      };
    }
  }

  class PaymentIntentRepository {}

  function createQuery(table: string) {
    const query = {
      innerJoin() {
        return query;
      },
      select() {
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
        if (table === 'notification_templates as template') return dbState.templateVersion;
        return undefined;
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
  };
});

const { sendConfirmationEmailActivity } = await import('../activities/checkout.js');

describe('sendConfirmationEmailActivity', () => {
  beforeEach(() => {
    dbState.existingJob = undefined;
    dbState.providerRoute = undefined;
    dbState.templateVersion = { id: 'ntv_default' };
    dbState.createdJobs = [];
    dbState.destroy.mockClear();
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
    expect(dbState.destroy).toHaveBeenCalledTimes(1);
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
  });
});
