import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
  signals: {} as Record<string, (...args: any[]) => void>,
  conditionResult: true as boolean,
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () =>
    new Proxy({}, {
      get: (_t, prop: string) =>
        async (...args: any[]) => {
          const fn = mockState.activities[prop];
          if (fn) return fn(...args);
          return { ok: true, value: {} };
        },
    }),
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: (signal: string, handler: (...args: any[]) => void) => {
    mockState.signals[signal] = handler;
  },
  condition: async (_fn: () => boolean, _timeout?: string) => mockState.conditionResult,
  startChild: async () => ({ workflowId: 'child-mock' }),
}));

import { checkoutSessionWorkflow } from '../workflows/checkout.js';
import { refundWorkflow } from '../workflows/refund.js';
import { exportWorkflow } from '../workflows/export.js';
import { okResult, errResult, webhookDeliveryWorkflowId } from '../shared/types.js';

function setActivity(name: string, impl: (...args: any[]) => any) {
  mockState.activities[name] = impl;
}

function resetState() {
  for (const key of Object.keys(mockState.activities)) delete mockState.activities[key];
  for (const key of Object.keys(mockState.signals)) delete mockState.signals[key];
  mockState.conditionResult = true;
}

function makeCheckoutInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    checkoutSessionId: 'cs_test_1',
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    eventId: 'evt_1',
    brandId: 'brd_1',
    holdId: 'hld_1',
    currency: 'USD',
    amountCents: 10000,
    feeCents: 500,
    buyerEmail: 'buyer@test.com',
    isFreeOrder: false,
    ...overrides,
  };
}

function makeRefundInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    orderId: 'ord_test_1',
    amountCents: 5000,
    reason: 'Customer requested',
    buyerEmail: 'buyer@test.com',
    voidTickets: false,
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
  createPaymentIntentActivity: async () => okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1' }),
  finalizeOrderActivity: async () => okResult({ orderId: 'ord_test_1' }),
  sendConfirmationEmailActivity: async () => okResult({ jobId: 'emj_1', status: 'queued' }),
  issueTicketsActivity: async () => okResult({ issued: 2, jobId: 'emj_2' }),
  releaseHoldActivity: async () => okResult({ released: true }),
  emitWebhookEventActivity: async () => okResult({ eventId: 'evt_1', deliveries: [] }),
  processRefundActivity: async () => okResult({ providerRefundId: 'rfd_1', status: 'succeeded' }),
  updateLedgerActivity: async () => okResult({ balanced: true }),
  voidTicketsActivity: async () => okResult({ voidedCount: 2, voidedTicketIds: ['tkt_1', 'tkt_2'] }),
  restoreInventoryActivity: async () => okResult({ restored: 2 }),
  notifyRefundActivity: async () => okResult({ notified: true, jobId: 'emj_3' }),
  generateExportActivity: async () => okResult({ data: 'id\n1', rowCount: 1 }),
  uploadFileActivity: async () => okResult({ fileUrl: 'https://exports.example.test/exp_1.csv' }),
  markExportFailedActivity: async () => okResult({ failed: true }),
  notifyExportCompleteActivity: async () => okResult({ notified: true }),
};

describe('checkoutSessionWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('completes a free order without payment', async () => {
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));
    expect(result.status).toBe('completed');
    expect(result.orderId).toBe('ord_test_1');
  });

  it('fails when finalize fails for free order and releases hold', async () => {
    let released = false;
    setActivity('finalizeOrderActivity', async () => errResult('FINALIZE_FAILED', 'Already exists', false));
    setActivity('releaseHoldActivity', async () => { released = true; return okResult({ released: true }); });
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));
    expect(result.status).toBe('failed');
    expect(released).toBe(true);
  });

  it('completes a paid order when payment succeeds', async () => {
    mockState.conditionResult = true; // Payment succeeded
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('completed');
    expect(result.orderId).toBe('ord_test_1');
  });

  it('passes quoted fee cents to payment intent creation', async () => {
    let paymentInput: Record<string, unknown> | undefined;
    setActivity('createPaymentIntentActivity', async (input) => {
      paymentInput = input;
      return okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1' });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false, feeCents: 725 }));

    expect(result.status).toBe('completed');
    expect(paymentInput).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      amountCents: 10000,
      currency: 'USD',
      feeCents: 725,
    });
  });

  it('fails when payment intent creation fails and releases hold', async () => {
    let released = false;
    setActivity('createPaymentIntentActivity', async () => errResult('PAYMENT_FAILED', 'Stripe error', false));
    setActivity('releaseHoldActivity', async () => { released = true; return okResult({ released: true }); });
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('failed');
    expect(released).toBe(true);
  });

  it('fails on payment timeout and releases hold', async () => {
    let released = false;
    setActivity('releaseHoldActivity', async () => { released = true; return okResult({ released: true }); });
    mockState.conditionResult = false; // Timeout
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('failed');
    expect(released).toBe(true);
  });
});

describe('refundWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('completes a standard refund', async () => {
    const result = await refundWorkflow(makeRefundInput());
    expect(result.status).toBe('completed');
  });

  it('voids tickets when configured', async () => {
    let voidCalled = false;
    setActivity('voidTicketsActivity', async () => { voidCalled = true; return okResult({ voidedCount: 3 }); });
    const result = await refundWorkflow(makeRefundInput({ voidTickets: true }));
    expect(result.status).toBe('completed');
    expect(voidCalled).toBe(true);
  });

  it('does not void tickets when voidTickets is false', async () => {
    let voidCalled = false;
    setActivity('voidTicketsActivity', async () => { voidCalled = true; return okResult({ voidedCount: 0 }); });
    const result = await refundWorkflow(makeRefundInput({ voidTickets: false }));
    expect(result.status).toBe('completed');
    expect(voidCalled).toBe(false);
  });

  it('restores inventory when configured', async () => {
    let restoreCalled = false;
    setActivity('restoreInventoryActivity', async () => { restoreCalled = true; return okResult({ restored: 2 }); });
    const result = await refundWorkflow(makeRefundInput({ restoreInventory: true }));
    expect(result.status).toBe('completed');
    expect(restoreCalled).toBe(true);
  });

  it('does not restore inventory when not configured', async () => {
    let restoreCalled = false;
    setActivity('restoreInventoryActivity', async () => { restoreCalled = true; return okResult({ restored: 2 }); });
    const result = await refundWorkflow(makeRefundInput({ restoreInventory: false }));
    expect(result.status).toBe('completed');
    expect(restoreCalled).toBe(false);
  });

  it('fails when refund processing fails', async () => {
    setActivity('processRefundActivity', async () => errResult('REFUND_FAILED', 'Provider error', true));
    const result = await refundWorkflow(makeRefundInput());
    expect(result.status).toBe('failed');
  });

  it('always notifies buyer regardless of void/restore config', async () => {
    let notifyCalled = false;
    setActivity('notifyRefundActivity', async () => { notifyCalled = true; return okResult({ notified: true }); });
    await refundWorkflow(makeRefundInput({ voidTickets: true, restoreInventory: true }));
    expect(notifyCalled).toBe(true);
  });
});

describe('exportWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  const input = {
    version: 1,
    exportId: 'exp_1',
    type: 'attendees',
    format: 'csv',
    requestedBy: 'usr_1',
    tenantId: 'tnt_1',
  };

  it('completes and returns the generated file URL', async () => {
    const result = await exportWorkflow(input);
    expect(result).toEqual({
      status: 'completed',
      fileUrl: 'https://exports.example.test/exp_1.csv',
    });
  });

  it('marks the export failed when generation fails', async () => {
    let failedInput: Record<string, unknown> | undefined;
    setActivity('generateExportActivity', async () => errResult('EXPORT_FAILED', 'Generation failed', true));
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'Generation failed',
    });
  });

  it('marks the export failed when upload fails', async () => {
    let failedInput: Record<string, unknown> | undefined;
    setActivity('uploadFileActivity', async () => errResult('UPLOAD_FAILED', 'Upload failed', true));
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'Upload failed',
    });
  });
});

describe('workflow id conventions', () => {
  it('scopes webhook delivery workflows by event and endpoint', () => {
    expect(webhookDeliveryWorkflowId('whe_1', 'wh_1')).toBe('webhook-delivery:whe_1:wh_1');
  });
});
