import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
  proxyActivityOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (options: Record<string, unknown>) => {
    mockState.proxyActivityOptions.push(options);
    return new Proxy(
      {},
      {
        get:
          (_target, prop: string) =>
          async (...args: any[]) => {
            const fn = mockState.activities[prop];
            if (fn) return fn(...args);
            return { ok: true, value: {} };
          },
      },
    );
  },
}));

import { refundWorkflow } from '../workflows/refund.js';
import { errResult, okResult } from '../shared/types.js';

function setActivity(name: string, impl: (...args: any[]) => any) {
  mockState.activities[name] = impl;
}

function resetActivities() {
  for (const key of Object.keys(mockState.activities)) delete mockState.activities[key];
}

function makeRefundInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    orderId: 'ord_test_1',
    amountCents: 5000,
    reason: 'Customer requested',
    buyerEmail: 'buyer@test.com',
    voidTickets: true,
    restoreInventory: true,
    idempotencyKey: 'idem-key-1',
    tenantId: 'tnt_1',
    brandId: 'brd_1',
    orderTotalCents: 10000,
    alreadyRefundedCents: 0,
    nonce: 'test-nonce',
    ...overrides,
  };
}

const defaultActivities = {
  processRefundActivity: async () => okResult({ providerRefundId: 'rfd_1', status: 'succeeded' }),
  updateLedgerActivity: async () => okResult({ balanced: true }),
  voidTicketsActivity: async () =>
    okResult({ voidedCount: 2, voidedTicketIds: ['tkt_1', 'tkt_2'] }),
  restoreInventoryActivity: async () => okResult({ restored: 2 }),
  notifyRefundActivity: async () => okResult({ notified: true, jobId: 'emj_3' }),
};

describe('refundWorkflow notification failure policy', () => {
  beforeEach(() => {
    resetActivities();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('does not fail the completed refund when notification queueing has a retryable failure', async () => {
    setActivity('notifyRefundActivity', async () =>
      errResult('REFUND_NOTIFY_FAILED', 'Email queue unavailable', true),
    );

    const result = await refundWorkflow(makeRefundInput());

    expect(result).toEqual({
      status: 'completed',
      notificationStatus: 'failed',
      notificationErrorCode: 'REFUND_NOTIFY_FAILED',
      notificationErrorMessage: 'Email queue unavailable',
      notificationRetryable: true,
    });
  });

  it('records non-retryable notification failures without failing completed refund side effects', async () => {
    setActivity('notifyRefundActivity', async () =>
      errResult('REFUND_NOTIFY_INVALID_RECIPIENT', 'Invalid recipient', false),
    );

    const result = await refundWorkflow(makeRefundInput());

    expect(result).toEqual({
      status: 'completed',
      notificationStatus: 'failed',
      notificationErrorCode: 'REFUND_NOTIFY_INVALID_RECIPIENT',
      notificationErrorMessage: 'Invalid recipient',
      notificationRetryable: false,
    });
  });

  it('still throws retryable failures before refund side effects are committed', async () => {
    setActivity('processRefundActivity', async () =>
      errResult('REFUND_RETRYABLE', 'Provider timeout', true),
    );

    await expect(refundWorkflow(makeRefundInput())).rejects.toThrow(
      'Refund processing failed (REFUND_RETRYABLE): Provider timeout',
    );
  });
});
