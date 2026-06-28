import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
  signals: {} as Record<string, (...args: any[]) => void>,
  conditionResult: true as boolean,
  sleeps: [] as string[],
  childStarts: [] as Array<{ workflow: unknown; options: Record<string, unknown> }>,
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
  condition: async (fn: () => boolean, _timeout?: string) => fn() || mockState.conditionResult,
  sleep: async (duration: string) => {
    mockState.sleeps.push(duration);
  },
  startChild: async (workflow: unknown, options: Record<string, unknown>) => {
    mockState.childStarts.push({ workflow, options });
    return { workflowId: 'child-mock' };
  },
}));

import { checkoutSessionWorkflow } from '../workflows/checkout.js';
import { refundWorkflow } from '../workflows/refund.js';
import { exportWorkflow } from '../workflows/export.js';
import { webhookDeliveryWorkflow } from '../workflows/webhook-delivery.js';
import { holdExpirationWorkflow } from '../workflows/hold-expiration.js';
import { paymentReconciliationWorkflow } from '../workflows/payment-reconciliation.js';
import { clerkIdentitySyncWorkflow } from '../workflows/clerk-identity-sync.js';
import { privacyRequestWorkflow } from '../workflows/privacy.js';
import { okResult, errResult, privacyRequestWorkflowId, webhookDeliveryWorkflowId, webhookDeliveryReplayWorkflowId } from '../shared/types.js';

function setActivity(name: string, impl: (...args: any[]) => any) {
  mockState.activities[name] = impl;
}

function resetState() {
  for (const key of Object.keys(mockState.activities)) delete mockState.activities[key];
  for (const key of Object.keys(mockState.signals)) delete mockState.signals[key];
  mockState.conditionResult = true;
  mockState.sleeps = [];
  mockState.childStarts = [];
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

function makeWebhookDeliveryInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    apiVersion: '2026-01-01',
    endpointId: 'wh_1',
    eventId: 'whe_1',
    eventType: 'order.paid',
    payload: { orderId: 'ord_1' },
    maxAttempts: 3,
    ...overrides,
  };
}

function makePaymentReconciliationInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    providerEventId: 'evt_stripe_1',
    provider: 'stripe',
    eventType: 'payment_intent.succeeded',
    data: { id: 'pi_1', status: 'succeeded' },
    ...overrides,
  };
}

function makeClerkIdentitySyncInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    providerEventId: 'msg_clerk_1',
    eventType: 'user.updated',
    clerkUserId: 'user_1',
    email: 'user@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    avatarUrl: 'https://example.com/avatar.png',
    ...overrides,
  };
}

const defaultActivities = {
  createPaymentIntentActivity: async () => okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1', provider: 'stripe' }),
  finalizeOrderActivity: async () => okResult({ orderId: 'ord_test_1' }),
  compensateOrphanPaymentActivity: async () => okResult({ status: 'succeeded', action: 'refund', compensationId: 'pcmp_1' }),
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
  processPrivacyRequestActivity: async () => okResult({ requestId: 'prv_1', status: 'completed' }),
  deliverWebhookActivity: async () => okResult({ statusCode: 200, response: 'ok' }),
  expireStaleHoldsActivity: async () => okResult({ expiredCount: 0 }),
  expireStaleSessionsActivity: async () => okResult({ expiredCount: 0 }),
  processWaitlistOffersActivity: async () => okResult({ expiredCount: 0, offeredCount: 0, queuedEmailCount: 0 }),
  reconcilePaymentActivity: async () => okResult({ orderId: 'ord_1', status: 'paid' }),
  reconcileRefundActivity: async () => okResult({ orderId: 'ord_1', status: 'refunded' }),
  reconcileDisputeActivity: async () => okResult({ orderId: 'ord_1', status: 'disputed' }),
  emitDomainEventActivity: async () => okResult({ emitted: true }),
  syncUserActivity: async () => okResult({ userId: 'usr_1', created: false }),
  syncOrganizationActivity: async () => okResult({ orgId: 'org_1', created: false }),
  deleteUserActivity: async () => okResult({ suspended: true }),
  markProviderEventProcessedActivity: async () => okResult({ processed: true }),
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
      return okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1', provider: 'stripe' });
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

  it('auto-completes local capture paid checkout without an external payment signal', async () => {
    mockState.conditionResult = false;
    setActivity('createPaymentIntentActivity', async () =>
      okResult({ providerIntentId: 'pi_capture_cs_test_1', clientSecret: 'pi_capture_cs_test_1_secret' }),
    );

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result.status).toBe('completed');
    expect(result.orderId).toBe('ord_test_1');
  });

  it('schedules webhook delivery children without secret material', async () => {
    setActivity('emitWebhookEventActivity', async () =>
      okResult({
        eventId: 'whe_1',
        deliveries: [{ endpointId: 'wh_1', eventId: 'whe_1', url: 'https://example.test/webhook' }],
      }),
    );

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result.status).toBe('completed');
    expect(mockState.childStarts).toHaveLength(1);
    expect(mockState.childStarts[0]?.options).toEqual({
      workflowId: 'webhook-delivery:whe_1:wh_1',
      args: [
        {
          version: 1,
          endpointId: 'wh_1',
          eventId: 'whe_1',
          payload: { orderId: 'ord_test_1', eventId: 'evt_1', checkoutSessionId: 'cs_test_1' },
          maxAttempts: 5,
        },
      ],
    });
    expect(JSON.stringify(mockState.childStarts[0]?.options)).not.toContain('secret');
  });

  it('fails when payment intent creation fails and releases hold', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    setActivity('createPaymentIntentActivity', async () => errResult('PAYMENT_FAILED', 'Stripe error', false));
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('failed');
    expect(releaseInput).toEqual({ checkoutSessionId: 'cs_test_1', checkoutSessionStatus: 'expired' });
  });

  it('rejects when releasing a terminal checkout hold returns an error result', async () => {
    setActivity('createPaymentIntentActivity', async () => errResult('PAYMENT_FAILED', 'Stripe error', false));
    setActivity('releaseHoldActivity', async () => errResult('HOLD_RELEASE_FAILED', 'database write failed', true));

    await expect(checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }))).rejects.toThrow(
      'Checkout hold release failed (HOLD_RELEASE_FAILED): database write failed',
    );
  });

  it('compensates and releases on payment timeout after payment intent creation', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });
    setActivity('compensateOrphanPaymentActivity', async (input) => {
      compensationInput = input;
      return okResult({ status: 'succeeded', action: 'cancel', compensationId: 'pcmp_1' });
    });
    mockState.conditionResult = false; // Timeout
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('failed');
    expect(compensationInput).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_test_1',
      amountCents: 10000,
      currency: 'USD',
      reason: 'Payment timed out before checkout completion',
      source: 'checkout_payment_timeout',
      metadata: { eventId: 'evt_1', brandId: 'brd_1' },
    });
    expect(releaseInput).toEqual({ checkoutSessionId: 'cs_test_1', checkoutSessionStatus: 'expired' });
  });

  it('compensates and releases when checkout is cancelled after payment intent creation', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;

    setActivity('createPaymentIntentActivity', async () => {
      mockState.signals.cancelCheckout?.();
      return okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1', provider: 'stripe' });
    });
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });
    setActivity('compensateOrphanPaymentActivity', async (input) => {
      compensationInput = input;
      return okResult({ status: 'succeeded', action: 'cancel', compensationId: 'pcmp_1' });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result.status).toBe('cancelled');
    expect(compensationInput).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_test_1',
      amountCents: 10000,
      currency: 'USD',
      reason: 'Checkout was cancelled before payment completion',
      source: 'checkout_cancelled',
      metadata: { eventId: 'evt_1', brandId: 'brd_1' },
    });
    expect(releaseInput).toEqual({ checkoutSessionId: 'cs_test_1', checkoutSessionStatus: 'cancelled' });
  });

  it('compensates and releases when the provider reports payment failure', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;

    setActivity('createPaymentIntentActivity', async () => {
      mockState.signals.paymentFailed?.('card_declined');
      return okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1', provider: 'stripe' });
    });
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });
    setActivity('compensateOrphanPaymentActivity', async (input) => {
      compensationInput = input;
      return okResult({ status: 'succeeded', action: 'cancel', compensationId: 'pcmp_1' });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result.status).toBe('failed');
    expect(compensationInput).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_test_1',
      amountCents: 10000,
      currency: 'USD',
      reason: 'card_declined',
      source: 'checkout_payment_failed',
      metadata: { eventId: 'evt_1', brandId: 'brd_1' },
    });
    expect(releaseInput).toEqual({ checkoutSessionId: 'cs_test_1', checkoutSessionStatus: 'expired' });
  });

  it('compensates paid checkout when finalize fails after payment success', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;
    let emailCalled = false;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('finalizeOrderActivity', async () => errResult('HOLD_EXPIRED', 'Checkout hold hld_1 has expired', false));
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });
    setActivity('compensateOrphanPaymentActivity', async (input) => {
      compensationInput = input;
      return okResult({ status: 'succeeded', action: 'refund', compensationId: 'pcmp_1' });
    });
    setActivity('sendConfirmationEmailActivity', async () => {
      emailCalled = true;
      return okResult({ jobId: 'emj_1', status: 'queued' });
    });
    setActivity('issueTicketsActivity', async () => {
      issueTicketsCalled = true;
      return okResult({ issued: 2, jobId: 'emj_2' });
    });
    setActivity('emitWebhookEventActivity', async () => {
      webhookCalled = true;
      return okResult({ eventId: 'evt_1', deliveries: [] });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result.status).toBe('failed');
    expect(releaseInput).toEqual({ checkoutSessionId: 'cs_test_1', checkoutSessionStatus: 'expired' });
    expect(compensationInput).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_test_1',
      amountCents: 10000,
      currency: 'USD',
      reason: 'Checkout hold hld_1 has expired',
      source: 'checkout_finalize_failed',
      metadata: { eventId: 'evt_1', brandId: 'brd_1', errorCode: 'HOLD_EXPIRED' },
    });
    expect(emailCalled).toBe(false);
    expect(issueTicketsCalled).toBe(false);
    expect(webhookCalled).toBe(false);
  });

  it('does not silently close when finalize-failure compensation returns a retryable error', async () => {
    let emailCalled = false;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('finalizeOrderActivity', async () => errResult('HOLD_EXPIRED', 'Checkout hold hld_1 has expired', false));
    setActivity('compensateOrphanPaymentActivity', async () => errResult('PAYMENT_COMPENSATION_FAILED', 'Stripe refund failed', true));
    setActivity('sendConfirmationEmailActivity', async () => {
      emailCalled = true;
      return okResult({ jobId: 'emj_1', status: 'queued' });
    });
    setActivity('issueTicketsActivity', async () => {
      issueTicketsCalled = true;
      return okResult({ issued: 2, jobId: 'emj_2' });
    });
    setActivity('emitWebhookEventActivity', async () => {
      webhookCalled = true;
      return okResult({ eventId: 'evt_1', deliveries: [] });
    });

    await expect(checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }))).rejects.toThrow(
      'Orphan payment compensation failed (PAYMENT_COMPENSATION_FAILED): Stripe refund failed',
    );
    expect(emailCalled).toBe(false);
    expect(issueTicketsCalled).toBe(false);
    expect(webhookCalled).toBe(false);
  });

  it('does not silently close when timeout compensation returns a retryable error', async () => {
    mockState.conditionResult = false;
    setActivity('compensateOrphanPaymentActivity', async () => errResult('PAYMENT_COMPENSATION_FAILED', 'Stripe cancel failed', true));

    await expect(checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }))).rejects.toThrow(
      'Orphan payment compensation failed (PAYMENT_COMPENSATION_FAILED): Stripe cancel failed',
    );
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

describe('paymentReconciliationWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('marks the provider event processed after successful reconciliation work', async () => {
    let domainEventInput: Record<string, unknown> | undefined;
    let markInput: Record<string, unknown> | undefined;

    setActivity('reconcilePaymentActivity', async () => okResult({ orderId: 'ord_1', status: 'paid' }));
    setActivity('emitDomainEventActivity', async (input) => {
      domainEventInput = input;
      return okResult({ emitted: true });
    });
    setActivity('markProviderEventProcessedActivity', async (input) => {
      markInput = input;
      return okResult({ processed: true });
    });

    const result = await paymentReconciliationWorkflow(makePaymentReconciliationInput());

    expect(result).toEqual({ status: 'paid' });
    expect(domainEventInput).toEqual({ orderId: 'ord_1', eventType: 'payment_intent.succeeded' });
    expect(markInput).toEqual({ provider: 'stripe', providerEventId: 'evt_stripe_1' });
  });

  it('throws retryable reconciliation failures without marking the provider event processed', async () => {
    let marked = false;

    setActivity('reconcilePaymentActivity', async () => errResult('PAYMENT_RECONCILE_FAILED', 'database unavailable', true));
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(paymentReconciliationWorkflow(makePaymentReconciliationInput())).rejects.toThrow(
      'Payment reconciliation failed (PAYMENT_RECONCILE_FAILED): database unavailable',
    );
    expect(marked).toBe(false);
  });

  it('does not mark the provider event processed when checkout finalization is still retryable', async () => {
    let marked = false;

    setActivity('reconcilePaymentActivity', async () =>
      errResult(
        'ORDER_NOT_FINALIZED_YET',
        'Checkout session is still finalizing for this successful payment',
        true,
      ),
    );
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(paymentReconciliationWorkflow(makePaymentReconciliationInput())).rejects.toThrow(
      'Payment reconciliation failed (ORDER_NOT_FINALIZED_YET): Checkout session is still finalizing for this successful payment',
    );
    expect(marked).toBe(false);
  });
});

describe('clerkIdentitySyncWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('marks the Clerk provider event processed after successful user sync', async () => {
    let syncInput: Record<string, unknown> | undefined;
    let markInput: Record<string, unknown> | undefined;

    setActivity('syncUserActivity', async (input) => {
      syncInput = input;
      return okResult({ userId: 'usr_1', created: false });
    });
    setActivity('markProviderEventProcessedActivity', async (input) => {
      markInput = input;
      return okResult({ processed: true });
    });

    const result = await clerkIdentitySyncWorkflow(makeClerkIdentitySyncInput());

    expect(result).toEqual({ status: 'synced' });
    expect(syncInput).toMatchObject({ clerkUserId: 'user_1', email: 'user@example.com' });
    expect(markInput).toEqual({ provider: 'clerk', providerEventId: 'msg_clerk_1' });
  });

  it('marks skipped Clerk provider events processed when no activity work is required', async () => {
    let syncCalled = false;
    let markInput: Record<string, unknown> | undefined;

    setActivity('syncUserActivity', async () => {
      syncCalled = true;
      return okResult({ userId: 'usr_1', created: false });
    });
    setActivity('markProviderEventProcessedActivity', async (input) => {
      markInput = input;
      return okResult({ processed: true });
    });

    const result = await clerkIdentitySyncWorkflow(makeClerkIdentitySyncInput({ email: undefined }));

    expect(result).toEqual({ status: 'skipped' });
    expect(syncCalled).toBe(false);
    expect(markInput).toEqual({ provider: 'clerk', providerEventId: 'msg_clerk_1' });
  });

  it('marks unhandled Clerk provider events processed', async () => {
    let markInput: Record<string, unknown> | undefined;

    setActivity('markProviderEventProcessedActivity', async (input) => {
      markInput = input;
      return okResult({ processed: true });
    });

    const result = await clerkIdentitySyncWorkflow(makeClerkIdentitySyncInput({ eventType: 'session.created' }));

    expect(result).toEqual({ status: 'unhandled' });
    expect(markInput).toEqual({ provider: 'clerk', providerEventId: 'msg_clerk_1' });
  });

  it('throws retryable sync failures without marking the provider event processed', async () => {
    let marked = false;

    setActivity('syncUserActivity', async () => errResult('USER_SYNC_FAILED', 'database unavailable', true));
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(clerkIdentitySyncWorkflow(makeClerkIdentitySyncInput())).rejects.toThrow(
      'Clerk identity sync failed (USER_SYNC_FAILED): database unavailable',
    );
    expect(marked).toBe(false);
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

describe('privacyRequestWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('completes when the privacy activity completes', async () => {
    const result = await privacyRequestWorkflow({ version: 1, requestId: 'prv_1' });

    expect(result).toEqual({ status: 'completed' });
  });

  it('returns failed when the privacy activity fails', async () => {
    setActivity('processPrivacyRequestActivity', async () => errResult('privacy_request_failed', 'database unavailable', false));

    const result = await privacyRequestWorkflow({ version: 1, requestId: 'prv_1' });

    expect(result).toEqual({ status: 'failed' });
  });
});

describe('workflow id conventions', () => {
  it('scopes webhook delivery workflows by event and endpoint', () => {
    expect(webhookDeliveryWorkflowId('whe_1', 'wh_1')).toBe('webhook-delivery:whe_1:wh_1');
  });

  it('scopes webhook replay workflows by event, endpoint, and replay nonce', () => {
    expect(webhookDeliveryReplayWorkflowId('whe_1', 'wh_1', 'rpl_1')).toBe('webhook-delivery:whe_1:wh_1:replay:rpl_1');
  });

  it('scopes GDPR privacy request workflows by request id', () => {
    expect(privacyRequestWorkflowId('prv_1')).toBe('privacy-request:prv_1');
  });
});

describe('holdExpirationWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('runs bounded expiration ticks with legacy-compatible input', async () => {
    const calls: string[] = [];
    setActivity('expireStaleHoldsActivity', async () => {
      calls.push('holds');
      return okResult({ expiredCount: 1 });
    });
    setActivity('expireStaleSessionsActivity', async () => {
      calls.push('sessions');
      return okResult({ expiredCount: 1 });
    });
    setActivity('processWaitlistOffersActivity', async () => {
      calls.push('waitlist');
      return okResult({ expiredCount: 1, offeredCount: 1, queuedEmailCount: 1 });
    });

    await holdExpirationWorkflow({ maxIterations: 2, tickIntervalSeconds: 15 });

    expect(calls).toEqual(['holds', 'sessions', 'waitlist', 'holds', 'sessions', 'waitlist']);
    expect(mockState.sleeps).toEqual(['15 seconds']);
  });
});

describe('webhookDeliveryWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('delivers successfully on the first attempt', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return okResult({ statusCode: 204, response: '' });
    });

    const result = await webhookDeliveryWorkflow(makeWebhookDeliveryInput());

    expect(result.status).toBe('delivered');
    expect(attempts).toEqual([
      {
        apiVersion: '2026-01-01',
        endpointId: 'wh_1',
        eventId: 'whe_1',
        eventType: 'order.paid',
        payload: JSON.stringify({ orderId: 'ord_1' }),
        attempt: 1,
        finalAttempt: false,
      },
    ]);
    expect(attempts[0]).not.toHaveProperty('secret');
    expect(mockState.sleeps).toEqual([]);
  });

  it('retries failed deliveries and marks the final attempt', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return okResult({ statusCode: 500, response: 'server error' });
    });

    const result = await webhookDeliveryWorkflow(makeWebhookDeliveryInput());

    expect(result.status).toBe('dead_lettered');
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(attempts.map((attempt) => attempt.finalAttempt)).toEqual([false, false, true]);
    expect(mockState.sleeps).toEqual(['5 seconds', '10 seconds']);
  });
});
