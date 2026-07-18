import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
  signals: {} as Record<string, (...args: any[]) => void>,
  conditionResult: true as boolean,
  patchedResult: true as boolean,
  sleeps: [] as Array<string | number>,
  childStarts: [] as Array<{ workflow: unknown; options: Record<string, unknown> }>,
  continueAsNewInputs: [] as unknown[],
  proxyActivityOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@temporalio/workflow', () => ({
  ActivityFailure: class ActivityFailure extends Error {},
  ParentClosePolicy: {
    PARENT_CLOSE_POLICY_ABANDON: 'PARENT_CLOSE_POLICY_ABANDON',
  },
  proxyActivities: (options: Record<string, unknown>) => {
    mockState.proxyActivityOptions.push(options);
    return new Proxy(
      {},
      {
        get:
          (_t, prop: string) =>
          async (...args: any[]) => {
            const fn = mockState.activities[prop];
            if (fn) return fn(...args);
            return { ok: true, value: {} };
          },
      },
    );
  },
  defineSignal: (name: string) => name,
  defineQuery: (name: string) => name,
  setHandler: (signal: string, handler: (...args: any[]) => void) => {
    mockState.signals[signal] = handler;
  },
  condition: async (fn: () => boolean, _timeout?: string) => fn() || mockState.conditionResult,
  patched: () => mockState.patchedResult,
  isCancellation: (error: unknown) => error instanceof Error && error.name === 'CancelledFailure',
  sleep: async (duration: string | number) => {
    mockState.sleeps.push(duration);
  },
  startChild: async (workflow: unknown, options: Record<string, unknown>) => {
    mockState.childStarts.push({ workflow, options });
    return { workflowId: 'child-mock' };
  },
  continueAsNew: async (input: unknown) => {
    mockState.continueAsNewInputs.push(input);
  },
  workflowInfo: () => ({
    workflowId: 'test-workflow',
    runId: 'test-run',
  }),
}));

import { checkoutSessionWorkflow } from '../workflows/checkout.js';
import { ActivityFailure } from '@temporalio/workflow';
import { refundWorkflow } from '../workflows/refund.js';
import { exportWorkflow } from '../workflows/export.js';
import { webhookDeliveryWorkflow } from '../workflows/webhook-delivery.js';
import { holdExpirationWorkflow } from '../workflows/hold-expiration.js';
import { providerEventRecoveryWorkflow } from '../workflows/provider-event-recovery.js';
import { notificationDeliveryWorkflow, smsDeliveryWorkflow } from '../workflows/notification.js';
import { paymentReconciliationWorkflow } from '../workflows/payment-reconciliation.js';
import { clerkIdentitySyncWorkflow } from '../workflows/clerk-identity-sync.js';
import { privacyRequestWorkflow } from '../workflows/privacy.js';
import {
  CHECKOUT_WORKFLOW_VERSION,
  PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
  CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
  okResult,
  errResult,
  privacyRequestWorkflowId,
  webhookDeliveryWorkflowId,
  webhookDeliveryReplayWorkflowId,
} from '../shared/types.js';

function setActivity(name: string, impl: (...args: any[]) => any) {
  mockState.activities[name] = impl;
}

function resetState() {
  for (const key of Object.keys(mockState.activities)) delete mockState.activities[key];
  for (const key of Object.keys(mockState.signals)) delete mockState.signals[key];
  mockState.conditionResult = true;
  mockState.patchedResult = true;
  mockState.sleeps = [];
  mockState.childStarts = [];
  mockState.continueAsNewInputs = [];
}

function exhaustedActivityFailure(message: string): ActivityFailure {
  const error = new Error(message);
  Object.setPrototypeOf(error, ActivityFailure.prototype);
  return error as ActivityFailure;
}

function makeCheckoutInput(overrides: Record<string, unknown> = {}) {
  return {
    version: CHECKOUT_WORKFLOW_VERSION,
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

function makeNotificationDeliveryInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    jobId: 'emj_test_1',
    tenantId: 'tnt_1',
    brandId: 'brd_1',
    templateKey: 'tickets-issued',
    templateVersionId: 'ntv_1',
    toEmail: 'buyer@test.com',
    variables: { orderId: 'ord_1', notificationType: 'transactional' },
    providerRouteId: 'epr_1',
    notificationType: 'transactional' as const,
    ...overrides,
  };
}

function makeSmsDeliveryInput(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    jobId: 'sms_test_1',
    tenantId: 'tnt_1',
    brandId: 'brd_1',
    providerRouteId: 'spr_1',
    notificationType: 'transactional' as const,
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
    version: PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
    providerEventId: 'evt_stripe_1',
    provider: 'stripe',
    eventType: 'payment_intent.succeeded',
    data: { id: 'pi_1', status: 'succeeded' },
    ...overrides,
  };
}

function makeReconciledOrderWebhookEvent(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    eventId: 'evt_1',
    orderId: 'ord_1',
    checkoutSessionId: 'cs_1',
    eventType: 'order.paid',
    payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
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
  createPaymentIntentActivity: async () =>
    okResult({ providerIntentId: 'pi_test_1', clientSecret: 'cs_test_1', provider: 'stripe' }),
  finalizeOrderActivity: async () => okResult({ orderId: 'ord_test_1' }),
  compensateOrphanPaymentActivity: async () =>
    okResult({ status: 'succeeded', action: 'refund', compensationId: 'pcmp_1' }),
  sendConfirmationEmailActivity: async () => okResult({ jobId: 'emj_1', status: 'queued' }),
  issueTicketsActivity: async () => okResult({ issued: 2, jobId: 'emj_2' }),
  releaseHoldActivity: async () => okResult({ released: true }),
  emitWebhookEventActivity: async () => okResult({ eventId: 'evt_1', deliveries: [] }),
  processRefundActivity: async () => okResult({ providerRefundId: 'rfd_1', status: 'succeeded' }),
  updateLedgerActivity: async () => okResult({ balanced: true }),
  voidTicketsActivity: async () =>
    okResult({ voidedCount: 2, voidedTicketIds: ['tkt_1', 'tkt_2'] }),
  restoreInventoryActivity: async () => okResult({ restored: 2 }),
  notifyRefundActivity: async () => okResult({ notified: true, jobId: 'emj_3' }),
  checkSuppressionActivity: async () => okResult({ suppressed: false }),
  checkConsentActivity: async () => okResult({ allowed: true }),
  markEmailJobSuppressedActivity: async () => okResult({ suppressed: true }),
  markEmailJobFailedActivity: async () =>
    okResult({ failed: true, errorCode: 'EMAIL_FAILURE', message: 'Email failed' }),
  renderTemplateActivity: async () =>
    okResult({
      subject: 'Your tickets',
      html: '<p>Your tickets are attached.</p>',
      text: 'Your tickets are attached.',
    }),
  sendEmailActivity: async () => okResult({ deliveryId: 'emd_1', provider: 'capture' }),
  sendSmsActivity: async () => okResult({ deliveryId: 'smd_1', provider: 'capture' }),
  generateExportActivity: async () => okResult({ data: 'id\n1', rowCount: 1 }),
  generateAndUploadExportActivity: async () =>
    okResult({ fileUrl: 'https://exports.example.test/exp_1.csv', rowCount: 1 }),
  uploadFileActivity: async () => okResult({ fileUrl: 'https://exports.example.test/exp_1.csv' }),
  markExportFailedActivity: async () => okResult({ failed: true }),
  notifyExportCompleteActivity: async () => okResult({ notified: true }),
  processPrivacyRequestActivity: async () => okResult({ requestId: 'prv_1', status: 'completed' }),
  deliverWebhookActivity: async () => okResult({ statusCode: 200, response: 'ok' }),
  expireStaleHoldsActivity: async () => okResult({ expiredCount: 0 }),
  expireStaleSessionsActivity: async () => okResult({ expiredCount: 0 }),
  processWaitlistOffersActivity: async () =>
    okResult({ expiredCount: 0, offeredCount: 0, queuedEmailCount: 0 }),
  recoverQueuedMessageHandoffsActivity: async () =>
    okResult({ recoveredEmailCount: 0, recoveredSmsCount: 0 }),
  enforcePrivacyRetentionActivity: async () =>
    okResult({ inspectedCount: 0, repairedCount: 0, skippedCount: 0 }),
  eraseExpiredAgentMemoryActivity: async () => ({ erasedCount: 0 }),
  eraseExpiredProviderIncidentEvidenceActivity: async () => ({ erasedCount: 0 }),
  processProviderAccountCleanupActivity: async () =>
    okResult({ completed: 0, retried: 0, manualReview: 0 }),
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

  it('completes a test checkout without fulfillment side effects', async () => {
    let fulfillmentCalls = 0;
    setActivity('sendConfirmationEmailActivity', async () => {
      fulfillmentCalls += 1;
      return okResult({ jobId: 'emj_test', status: 'queued' });
    });
    setActivity('issueTicketsActivity', async () => {
      fulfillmentCalls += 1;
      return okResult({ issued: 1, jobId: 'emj_ticket' });
    });
    setActivity('emitWebhookEventActivity', async () => {
      fulfillmentCalls += 1;
      return okResult({ eventId: 'evt_test', deliveries: [] });
    });

    const result = await checkoutSessionWorkflow(
      makeCheckoutInput({ isFreeOrder: false, paymentMode: 'free', isTest: true }),
    );

    expect(result).toEqual({ orderId: 'ord_test_1', status: 'completed' });
    expect(fulfillmentCalls).toBe(0);
  });

  it('completes an offline box-office order without creating a payment intent', async () => {
    let finalizeInput: Record<string, unknown> | undefined;
    setActivity('createPaymentIntentActivity', async () => {
      throw new Error('offline orders must not create payment intents');
    });
    setActivity('finalizeOrderActivity', async (input) => {
      finalizeInput = input;
      return okResult({ orderId: 'ord_box' });
    });

    const result = await checkoutSessionWorkflow(
      makeCheckoutInput({
        isFreeOrder: false,
        paymentMode: 'offline',
        salesChannel: 'box_office',
        operatorId: 'usr_box',
        tenderType: 'cash',
      }),
    );

    expect(result).toEqual({ orderId: 'ord_box', status: 'completed' });
    expect(finalizeInput).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      tenantId: 'tnt_1',
      paymentMode: 'offline',
      salesChannel: 'box_office',
      operatorId: 'usr_box',
      tenderType: 'cash',
    });
  });

  it('fails when finalize fails for free order and releases hold', async () => {
    let released = false;
    setActivity('finalizeOrderActivity', async () =>
      errResult('FINALIZE_FAILED', 'Already exists', false),
    );
    setActivity('releaseHoldActivity', async () => {
      released = true;
      return okResult({ released: true });
    });
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));
    expect(result.status).toBe('failed');
    expect(released).toBe(true);
  });

  it('preserves the v1 retryable free-finalization history', async () => {
    let released = false;
    setActivity('finalizeOrderActivity', async () =>
      errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true),
    );
    setActivity('releaseHoldActivity', async () => {
      released = true;
      return okResult({ released: true });
    });

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ version: 1, isFreeOrder: true })),
    ).rejects.toThrow(
      'Checkout finalization failed (ORDER_FINALIZE_FAILED): database lock timeout',
    );
    expect(released).toBe(false);
  });

  it('retries free checkout finalization with stable input and releases after exhaustion', async () => {
    const finalizeInputs: unknown[] = [];
    let released = false;
    setActivity('finalizeOrderActivity', async (input) => {
      finalizeInputs.push(input);
      return errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true);
    });
    setActivity('releaseHoldActivity', async () => {
      released = true;
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result).toEqual({ status: 'failed' });
    expect(finalizeInputs).toHaveLength(5);
    expect(finalizeInputs.every((input) => input === finalizeInputs[0])).toBe(true);
    expect(mockState.sleeps).toEqual(['5 seconds', '5 seconds', '5 seconds', '5 seconds']);
    expect(released).toBe(true);
  });

  it('releases free checkout after the activity retry policy is exhausted', async () => {
    let released = false;
    setActivity('finalizeOrderActivity', async () => {
      throw exhaustedActivityFailure('database deadlock attempts exhausted');
    });
    setActivity('releaseHoldActivity', async () => {
      released = true;
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result).toEqual({ status: 'failed' });
    expect(released).toBe(true);
  });

  it('completes free checkout when a retryable finalization succeeds on retry', async () => {
    const finalizeInputs: unknown[] = [];
    setActivity('finalizeOrderActivity', async (input) => {
      finalizeInputs.push(input);
      return finalizeInputs.length === 1
        ? errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true)
        : okResult({ orderId: 'ord_retry_1' });
    });

    const result = await checkoutSessionWorkflow(
      makeCheckoutInput({ isFreeOrder: true, isTest: true }),
    );

    expect(result).toEqual({ orderId: 'ord_retry_1', status: 'completed' });
    expect(finalizeInputs).toHaveLength(2);
    expect(finalizeInputs[1]).toBe(finalizeInputs[0]);
    expect(mockState.sleeps).toEqual(['5 seconds']);
  });

  it('stops free finalization retries and releases when checkout is cancelled', async () => {
    let finalizeCalls = 0;
    let releaseInput: unknown;
    setActivity('finalizeOrderActivity', async () => {
      finalizeCalls += 1;
      mockState.signals.cancelCheckout();
      return errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true);
    });
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result).toEqual({ status: 'cancelled' });
    expect(finalizeCalls).toBe(1);
    expect(mockState.sleeps).toEqual([]);
    expect(releaseInput).toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutSessionStatus: 'cancelled',
    });
  });

  it('retries free checkout confirmation email before ticket issuance and webhook delivery', async () => {
    let emailCalls = 0;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('sendConfirmationEmailActivity', async () => {
      emailCalls += 1;
      if (emailCalls === 1) {
        return errResult('EMAIL_QUEUE_FAILED', 'database temporarily unavailable', true);
      }
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

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result).toEqual({ orderId: 'ord_test_1', status: 'completed' });
    expect(emailCalls).toBe(2);
    expect(mockState.sleeps).toEqual(['5 seconds']);
    expect(issueTicketsCalled).toBe(true);
    expect(webhookCalled).toBe(true);
  });

  it('completes a paid order when payment succeeds', async () => {
    mockState.conditionResult = true; // Payment succeeded
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('completed');
    expect(result.orderId).toBe('ord_test_1');
  });

  it('retries paid checkout ticket issuance before webhook delivery', async () => {
    let ticketCalls = 0;
    let webhookCalled = false;

    setActivity('issueTicketsActivity', async () => {
      ticketCalls += 1;
      if (ticketCalls === 1) {
        return errResult('TICKET_ISSUE_FAILED', 'database temporarily unavailable', true);
      }
      return okResult({ issued: 2, jobId: 'emj_2' });
    });
    setActivity('emitWebhookEventActivity', async () => {
      webhookCalled = true;
      return okResult({ eventId: 'evt_1', deliveries: [] });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result).toEqual({ orderId: 'ord_test_1', status: 'completed' });
    expect(ticketCalls).toBe(2);
    expect(mockState.sleeps).toEqual(['5 seconds']);
    expect(webhookCalled).toBe(true);
  });

  it('passes quoted fee cents to payment intent creation', async () => {
    let paymentInput: Record<string, unknown> | undefined;
    setActivity('createPaymentIntentActivity', async (input) => {
      paymentInput = input;
      return okResult({
        providerIntentId: 'pi_test_1',
        clientSecret: 'cs_test_1',
        provider: 'stripe',
      });
    });

    const result = await checkoutSessionWorkflow(
      makeCheckoutInput({ isFreeOrder: false, feeCents: 725 }),
    );

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
      okResult({
        providerIntentId: 'pi_capture_cs_test_1',
        clientSecret: 'pi_capture_cs_test_1_secret',
      }),
    );

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result.status).toBe('completed');
    expect(result.orderId).toBe('ord_test_1');
  });

  it('schedules webhook delivery children without secret material', async () => {
    let webhookInput: Record<string, unknown> | undefined;
    setActivity('emitWebhookEventActivity', async (input) => {
      webhookInput = input;
      return okResult({
        eventId: 'whe_1',
        deliveries: [{ endpointId: 'wh_1', eventId: 'whe_1', url: 'https://example.test/webhook' }],
      });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result.status).toBe('completed');
    expect(webhookInput).toEqual({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      eventType: 'order.paid',
      payload: { orderId: 'ord_test_1', eventId: 'evt_1', checkoutSessionId: 'cs_test_1' },
      idempotencyKey: 'checkout-order-paid:ord_test_1',
    });
    expect(mockState.childStarts).toHaveLength(1);
    expect(mockState.childStarts[0]?.options).toEqual({
      workflowId: 'webhook-delivery:whe_1:wh_1',
      parentClosePolicy: 'PARENT_CLOSE_POLICY_ABANDON',
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

  it('retries retryable checkout webhook event creation with the same fulfillment key', async () => {
    let webhookCalls = 0;
    const idempotencyKeys: unknown[] = [];

    setActivity('emitWebhookEventActivity', async (input) => {
      webhookCalls += 1;
      idempotencyKeys.push(input.idempotencyKey);
      if (webhookCalls === 1) {
        return errResult('WEBHOOK_EVENT_CREATE_FAILED', 'database temporarily unavailable', true);
      }
      return okResult({ eventId: 'whe_1', deliveries: [] });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: true }));

    expect(result).toEqual({ orderId: 'ord_test_1', status: 'completed' });
    expect(webhookCalls).toBe(2);
    expect(idempotencyKeys).toEqual([
      'checkout-order-paid:ord_test_1',
      'checkout-order-paid:ord_test_1',
    ]);
    expect(mockState.sleeps).toEqual(['5 seconds']);
  });

  it('fails when payment intent creation fails and releases hold', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    setActivity('createPaymentIntentActivity', async () =>
      errResult('PAYMENT_FAILED', 'Stripe error', false),
    );
    setActivity('releaseHoldActivity', async (input) => {
      releaseInput = input;
      return okResult({ released: true });
    });
    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));
    expect(result.status).toBe('failed');
    expect(releaseInput).toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutSessionStatus: 'expired',
    });
  });

  it('rejects when releasing a terminal checkout hold returns an error result', async () => {
    setActivity('createPaymentIntentActivity', async () =>
      errResult('PAYMENT_FAILED', 'Stripe error', false),
    );
    setActivity('releaseHoldActivity', async () =>
      errResult('HOLD_RELEASE_FAILED', 'database write failed', true),
    );

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false })),
    ).rejects.toThrow('Checkout hold release failed (HOLD_RELEASE_FAILED): database write failed');
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
    expect(releaseInput).toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutSessionStatus: 'expired',
    });
  });

  it('compensates and releases when checkout is cancelled after payment intent creation', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;

    setActivity('createPaymentIntentActivity', async () => {
      mockState.signals.cancelCheckout?.();
      return okResult({
        providerIntentId: 'pi_test_1',
        clientSecret: 'cs_test_1',
        provider: 'stripe',
      });
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
    expect(releaseInput).toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutSessionStatus: 'cancelled',
    });
  });

  it('compensates and releases when the provider reports payment failure', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;

    setActivity('createPaymentIntentActivity', async () => {
      mockState.signals.paymentFailed?.('card_declined');
      return okResult({
        providerIntentId: 'pi_test_1',
        clientSecret: 'cs_test_1',
        provider: 'stripe',
      });
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
    expect(releaseInput).toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutSessionStatus: 'expired',
    });
  });

  it('compensates paid checkout when finalize fails after payment success', async () => {
    let releaseInput: Record<string, unknown> | undefined;
    let compensationInput: Record<string, unknown> | undefined;
    let emailCalled = false;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('finalizeOrderActivity', async () =>
      errResult('HOLD_EXPIRED', 'Checkout hold hld_1 has expired', false),
    );
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
    expect(releaseInput).toEqual({
      checkoutSessionId: 'cs_test_1',
      checkoutSessionStatus: 'expired',
    });
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

  it('preserves the v1 retryable paid-finalization history before compensation', async () => {
    let releaseCalled = false;
    let compensationCalled = false;
    let emailCalled = false;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('finalizeOrderActivity', async () =>
      errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true),
    );
    setActivity('releaseHoldActivity', async () => {
      releaseCalled = true;
      return okResult({ released: true });
    });
    setActivity('compensateOrphanPaymentActivity', async () => {
      compensationCalled = true;
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

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ version: 1, isFreeOrder: false })),
    ).rejects.toThrow(
      'Checkout finalization failed (ORDER_FINALIZE_FAILED): database lock timeout',
    );
    expect(releaseCalled).toBe(false);
    expect(compensationCalled).toBe(false);
    expect(emailCalled).toBe(false);
    expect(issueTicketsCalled).toBe(false);
    expect(webhookCalled).toBe(false);
  });

  it('compensates once and releases after retryable paid finalization is exhausted', async () => {
    const finalizeInputs: unknown[] = [];
    const compensationInputs: unknown[] = [];
    const operations: string[] = [];
    let releaseCalled = false;
    setActivity('finalizeOrderActivity', async (input) => {
      finalizeInputs.push(input);
      return errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true);
    });
    setActivity('compensateOrphanPaymentActivity', async (input) => {
      operations.push('compensate');
      compensationInputs.push(input);
      return okResult({ status: 'succeeded', action: 'refund', compensationId: 'pcmp_retry_1' });
    });
    setActivity('releaseHoldActivity', async () => {
      operations.push('release');
      releaseCalled = true;
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result).toEqual({ status: 'failed' });
    expect(finalizeInputs).toHaveLength(5);
    expect(finalizeInputs.every((input) => input === finalizeInputs[0])).toBe(true);
    expect(compensationInputs).toHaveLength(1);
    expect(compensationInputs[0]).toMatchObject({
      checkoutSessionId: 'cs_test_1',
      tenantId: 'tnt_1',
      provider: 'stripe',
      providerIntentId: 'pi_test_1',
      source: 'checkout_finalize_failed',
      metadata: {
        eventId: 'evt_1',
        brandId: 'brd_1',
        errorCode: 'ORDER_FINALIZE_FAILED',
      },
    });
    expect(releaseCalled).toBe(true);
    expect(operations).toEqual(['compensate', 'release']);
  });

  it('compensates before release when the paid finalize activity policy is exhausted', async () => {
    const operations: string[] = [];
    setActivity('finalizeOrderActivity', async () => {
      throw exhaustedActivityFailure('database deadlock attempts exhausted');
    });
    setActivity('compensateOrphanPaymentActivity', async (input) => {
      operations.push('compensate');
      expect(input).toMatchObject({
        providerIntentId: 'pi_test_1',
        source: 'checkout_finalize_failed',
        metadata: { errorCode: 'ORDER_FINALIZE_ACTIVITY_EXHAUSTED' },
      });
      return okResult({ status: 'succeeded', action: 'refund', compensationId: 'pcmp_throw_1' });
    });
    setActivity('releaseHoldActivity', async () => {
      operations.push('release');
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

    expect(result).toEqual({ status: 'failed' });
    expect(operations).toEqual(['compensate', 'release']);
  });

  it('completes without release when compensation resolves ambiguous finalize as already ordered', async () => {
    let releaseCalled = false;
    setActivity('finalizeOrderActivity', async () => {
      throw exhaustedActivityFailure('database connection lost after commit');
    });
    setActivity('compensateOrphanPaymentActivity', async () =>
      okResult({
        status: 'already_ordered',
        action: 'local_noop',
        orderId: 'ord_committed_1',
      }),
    );
    setActivity('releaseHoldActivity', async () => {
      releaseCalled = true;
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(
      makeCheckoutInput({ isFreeOrder: false, isTest: true }),
    );

    expect(result).toEqual({ orderId: 'ord_committed_1', status: 'completed' });
    expect(releaseCalled).toBe(false);
  });

  it.each([
    ['cancelCheckout', []],
    ['paymentFailed', ['provider failed during finalization']],
  ] as const)(
    'treats a committed order as authoritative when %s arrives with finalization success',
    async (signalName, signalArgs) => {
      let compensationCalled = false;
      let releaseCalled = false;
      setActivity('finalizeOrderActivity', async () => {
        mockState.signals[signalName](...signalArgs);
        return okResult({ orderId: 'ord_committed_1' });
      });
      setActivity('compensateOrphanPaymentActivity', async () => {
        compensationCalled = true;
        return okResult({ status: 'already_ordered', action: 'local_noop' });
      });
      setActivity('releaseHoldActivity', async () => {
        releaseCalled = true;
        return okResult({ released: true });
      });

      const result = await checkoutSessionWorkflow(
        makeCheckoutInput({ isFreeOrder: false, isTest: true }),
      );

      expect(result).toEqual({ orderId: 'ord_committed_1', status: 'completed' });
      expect(compensationCalled).toBe(false);
      expect(releaseCalled).toBe(false);
    },
  );

  it.each([
    {
      expectedStatus: 'cancelled',
      releaseStatus: 'cancelled',
      signalName: 'cancelCheckout',
      signalArgs: [] as string[],
      source: 'checkout_cancelled_during_finalize',
    },
    {
      expectedStatus: 'failed',
      releaseStatus: 'expired',
      signalName: 'paymentFailed',
      signalArgs: ['provider failed during finalization'],
      source: 'checkout_payment_failed_during_finalize',
    },
  ])(
    'compensates and stops paid retries when $signalName interrupts a failed attempt',
    async ({ expectedStatus, releaseStatus, signalName, signalArgs, source }) => {
      const operations: string[] = [];
      let finalizeCalls = 0;
      setActivity('finalizeOrderActivity', async () => {
        finalizeCalls += 1;
        mockState.signals[signalName](...signalArgs);
        return errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true);
      });
      setActivity('compensateOrphanPaymentActivity', async (input) => {
        operations.push('compensate');
        expect(input).toMatchObject({ source });
        return okResult({ status: 'succeeded', action: 'refund', compensationId: 'pcmp_signal_1' });
      });
      setActivity('releaseHoldActivity', async (input) => {
        operations.push('release');
        expect(input).toMatchObject({ checkoutSessionStatus: releaseStatus });
        return okResult({ released: true });
      });

      const result = await checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false }));

      expect(result).toEqual({ status: expectedStatus });
      expect(finalizeCalls).toBe(1);
      expect(mockState.sleeps).toEqual([]);
      expect(operations).toEqual(['compensate', 'release']);
    },
  );

  it('does not release after exhausted finalization when compensation is incomplete', async () => {
    let releaseCalled = false;
    setActivity('finalizeOrderActivity', async () =>
      errResult('ORDER_FINALIZE_FAILED', 'database lock timeout', true),
    );
    setActivity('compensateOrphanPaymentActivity', async () =>
      okResult({ status: 'manual_review', action: 'refund', compensationId: 'pcmp_retry_1' }),
    );
    setActivity('releaseHoldActivity', async () => {
      releaseCalled = true;
      return okResult({ released: true });
    });

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false })),
    ).rejects.toThrow('Orphan payment compensation blocked with status manual_review');
    expect(releaseCalled).toBe(false);
  });

  it('does not silently close when finalize-failure compensation returns a retryable error', async () => {
    let emailCalled = false;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('finalizeOrderActivity', async () =>
      errResult('HOLD_EXPIRED', 'Checkout hold hld_1 has expired', false),
    );
    setActivity('compensateOrphanPaymentActivity', async () =>
      errResult('PAYMENT_COMPENSATION_FAILED', 'Stripe refund failed', true),
    );
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

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false })),
    ).rejects.toThrow(
      'Orphan payment compensation failed (PAYMENT_COMPENSATION_FAILED): Stripe refund failed',
    );
    expect(emailCalled).toBe(false);
    expect(issueTicketsCalled).toBe(false);
    expect(webhookCalled).toBe(false);
  });

  it('does not silently close when finalize-failure compensation returns manual_review', async () => {
    let releaseCalled = false;
    let emailCalled = false;
    let issueTicketsCalled = false;
    let webhookCalled = false;

    setActivity('finalizeOrderActivity', async () =>
      errResult('HOLD_EXPIRED', 'Checkout hold hld_1 has expired', false),
    );
    setActivity('compensateOrphanPaymentActivity', async () =>
      okResult({ status: 'manual_review', action: 'refund', compensationId: 'pcmp_1' }),
    );
    setActivity('releaseHoldActivity', async () => {
      releaseCalled = true;
      return okResult({ released: true });
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

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false })),
    ).rejects.toThrow('Orphan payment compensation blocked with status manual_review');
    expect(releaseCalled).toBe(false);
    expect(emailCalled).toBe(false);
    expect(issueTicketsCalled).toBe(false);
    expect(webhookCalled).toBe(false);
  });

  it('preserves v1 checkout histories when manual-review compensation was already recorded', async () => {
    mockState.patchedResult = false;
    let releaseCalled = false;

    setActivity('finalizeOrderActivity', async () =>
      errResult('HOLD_EXPIRED', 'Checkout hold hld_1 has expired', false),
    );
    setActivity('compensateOrphanPaymentActivity', async () =>
      okResult({ status: 'manual_review', action: 'refund', compensationId: 'pcmp_1' }),
    );
    setActivity('releaseHoldActivity', async () => {
      releaseCalled = true;
      return okResult({ released: true });
    });

    const result = await checkoutSessionWorkflow(
      makeCheckoutInput({ version: 1, isFreeOrder: false }),
    );

    expect(result).toEqual({ status: 'failed' });
    expect(releaseCalled).toBe(true);
  });

  it('does not silently close when timeout compensation returns a retryable error', async () => {
    mockState.conditionResult = false;
    setActivity('compensateOrphanPaymentActivity', async () =>
      errResult('PAYMENT_COMPENSATION_FAILED', 'Stripe cancel failed', true),
    );

    await expect(
      checkoutSessionWorkflow(makeCheckoutInput({ isFreeOrder: false })),
    ).rejects.toThrow(
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
    setActivity('voidTicketsActivity', async () => {
      voidCalled = true;
      return okResult({ voidedCount: 3 });
    });
    const result = await refundWorkflow(makeRefundInput({ voidTickets: true }));
    expect(result.status).toBe('completed');
    expect(voidCalled).toBe(true);
  });

  it('does not void tickets when voidTickets is false', async () => {
    let voidCalled = false;
    setActivity('voidTicketsActivity', async () => {
      voidCalled = true;
      return okResult({ voidedCount: 0 });
    });
    const result = await refundWorkflow(makeRefundInput({ voidTickets: false }));
    expect(result.status).toBe('completed');
    expect(voidCalled).toBe(false);
  });

  it('restores inventory when configured', async () => {
    let restoreCalled = false;
    setActivity('restoreInventoryActivity', async () => {
      restoreCalled = true;
      return okResult({ restored: 2 });
    });
    const result = await refundWorkflow(makeRefundInput({ restoreInventory: true }));
    expect(result.status).toBe('completed');
    expect(restoreCalled).toBe(true);
  });

  it('does not restore inventory when not configured', async () => {
    let restoreCalled = false;
    setActivity('restoreInventoryActivity', async () => {
      restoreCalled = true;
      return okResult({ restored: 2 });
    });
    const result = await refundWorkflow(makeRefundInput({ restoreInventory: false }));
    expect(result.status).toBe('completed');
    expect(restoreCalled).toBe(false);
  });

  it('throws when refund processing returns a retryable error', async () => {
    setActivity('processRefundActivity', async () =>
      errResult('REFUND_RETRYABLE', 'Provider timeout', true),
    );

    await expect(refundWorkflow(makeRefundInput())).rejects.toThrow(
      'Refund processing failed (REFUND_RETRYABLE): Provider timeout',
    );
  });

  it('fails when refund processing returns a non-retryable provider error', async () => {
    setActivity('processRefundActivity', async () =>
      errResult('REFUND_FAILED', 'Provider rejected refund', false),
    );

    const result = await refundWorkflow(makeRefundInput());

    expect(result.status).toBe('failed');
  });

  it('throws when ledger update returns a retryable error', async () => {
    setActivity('updateLedgerActivity', async () =>
      errResult('LEDGER_RETRYABLE', 'Database unavailable', true),
    );

    await expect(refundWorkflow(makeRefundInput())).rejects.toThrow(
      'Refund ledger update failed (LEDGER_RETRYABLE): Database unavailable',
    );
  });

  it('fails when ledger update returns a non-retryable error', async () => {
    setActivity('updateLedgerActivity', async () =>
      errResult('LEDGER_INVALID', 'Invalid ledger state', false),
    );

    const result = await refundWorkflow(makeRefundInput());

    expect(result.status).toBe('failed');
  });

  it('throws when ticket voiding returns a retryable error', async () => {
    setActivity('voidTicketsActivity', async () =>
      errResult('VOID_RETRYABLE', 'Ticket service unavailable', true),
    );

    await expect(refundWorkflow(makeRefundInput({ voidTickets: true }))).rejects.toThrow(
      'Refund ticket voiding failed (VOID_RETRYABLE): Ticket service unavailable',
    );
  });

  it('fails when ticket voiding returns a non-retryable error', async () => {
    setActivity('voidTicketsActivity', async () =>
      errResult('VOID_INVALID', 'Tickets already transferred', false),
    );

    const result = await refundWorkflow(makeRefundInput({ voidTickets: true }));

    expect(result.status).toBe('failed');
  });

  it('throws when inventory restore returns a retryable error', async () => {
    setActivity('restoreInventoryActivity', async () =>
      errResult('INVENTORY_RETRYABLE', 'Inventory lock timeout', true),
    );

    await expect(refundWorkflow(makeRefundInput({ restoreInventory: true }))).rejects.toThrow(
      'Refund inventory restore failed (INVENTORY_RETRYABLE): Inventory lock timeout',
    );
  });

  it('fails when inventory restore returns a non-retryable error', async () => {
    setActivity('restoreInventoryActivity', async () =>
      errResult('INVENTORY_INVALID', 'Inventory already restored', false),
    );

    const result = await refundWorkflow(makeRefundInput({ restoreInventory: true }));

    expect(result.status).toBe('failed');
  });

  it('completes when refund notification returns a retryable error after refund side effects', async () => {
    setActivity('notifyRefundActivity', async () =>
      errResult('NOTIFY_RETRYABLE', 'Email queue unavailable', true),
    );

    const result = await refundWorkflow(makeRefundInput());

    expect(result).toEqual({
      status: 'completed',
      notificationStatus: 'failed',
      notificationErrorCode: 'NOTIFY_RETRYABLE',
      notificationErrorMessage: 'Email queue unavailable',
      notificationRetryable: true,
    });
  });

  it('completes when refund notification returns a non-retryable error after refund side effects', async () => {
    setActivity('notifyRefundActivity', async () =>
      errResult('NOTIFY_INVALID', 'Invalid recipient', false),
    );

    const result = await refundWorkflow(makeRefundInput());

    expect(result).toEqual({
      status: 'completed',
      notificationStatus: 'failed',
      notificationErrorCode: 'NOTIFY_INVALID',
      notificationErrorMessage: 'Invalid recipient',
      notificationRetryable: false,
    });
  });

  it('completes when refund notification is gracefully skipped', async () => {
    setActivity('notifyRefundActivity', async () => okResult({ notified: false }));

    const result = await refundWorkflow(makeRefundInput());

    expect(result.status).toBe('completed');
  });

  it('always notifies buyer regardless of void/restore config', async () => {
    let notifyCalled = false;
    setActivity('notifyRefundActivity', async () => {
      notifyCalled = true;
      return okResult({ notified: true });
    });
    await refundWorkflow(makeRefundInput({ voidTickets: true, restoreInventory: true }));
    expect(notifyCalled).toBe(true);
  });
});

describe('notificationDeliveryWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('throws retryable render failures so ticket fulfillment can be retried', async () => {
    setActivity('renderTemplateActivity', async () =>
      errResult('RENDER_TRANSIENT', 'Template renderer unavailable', true),
    );

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).rejects.toThrow(
      'Email render failed (RENDER_TRANSIENT): Template renderer unavailable',
    );
  });

  it('throws retryable send failures so queued ticket emails can drain on retry', async () => {
    const sendAttempts: Array<Record<string, unknown>> = [];
    setActivity('sendEmailActivity', async (input) => {
      sendAttempts.push(input);
      return errResult('EMAIL_SEND_FAILED', 'Capture route temporarily unavailable', true);
    });

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).rejects.toThrow(
      'Email delivery failed (EMAIL_SEND_FAILED): Capture route temporarily unavailable',
    );
    expect(sendAttempts).toHaveLength(1);
  });

  it('keeps non-retryable send failures failed without throwing', async () => {
    const markAttempts: Array<Record<string, unknown>> = [];
    setActivity('sendEmailActivity', async () =>
      errResult('EMAIL_SENDER_NOT_VERIFIED', 'Sender identity is not verified', false),
    );
    setActivity('markEmailJobFailedActivity', async (input) => {
      markAttempts.push(input);
      return okResult({
        failed: true,
        errorCode: String(input.errorCode),
        message: String(input.message),
      });
    });

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).resolves.toEqual({
      status: 'failed',
    });
    expect(markAttempts).toEqual([
      {
        jobId: 'emj_test_1',
        tenantId: 'tnt_1',
        activityContext: 'Email delivery',
        errorCode: 'EMAIL_SENDER_NOT_VERIFIED',
        message: 'Sender identity is not verified',
      },
    ]);
  });

  it('marks non-retryable render failures failed before returning failed', async () => {
    const markAttempts: Array<Record<string, unknown>> = [];
    setActivity('renderTemplateActivity', async () =>
      errResult('EMAIL_TEMPLATE_INVALID', 'Published email template is invalid', false),
    );
    setActivity('markEmailJobFailedActivity', async (input) => {
      markAttempts.push(input);
      return okResult({
        failed: true,
        errorCode: String(input.errorCode),
        message: String(input.message),
      });
    });

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).resolves.toEqual({
      status: 'failed',
    });
    expect(markAttempts).toEqual([
      {
        jobId: 'emj_test_1',
        tenantId: 'tnt_1',
        activityContext: 'Email render',
        errorCode: 'EMAIL_TEMPLATE_INVALID',
        message: 'Published email template is invalid',
      },
    ]);
  });

  it('throws retryable failed-job update failures instead of leaving queued jobs silent', async () => {
    setActivity('renderTemplateActivity', async () =>
      errResult('EMAIL_TEMPLATE_INVALID', 'Published email template is invalid', false),
    );
    setActivity('markEmailJobFailedActivity', async () =>
      errResult('EMAIL_JOB_FAILURE_UPDATE_FAILED', 'database timeout', true),
    );

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).rejects.toThrow(
      'Email failure status update failed (EMAIL_JOB_FAILURE_UPDATE_FAILED): database timeout',
    );
  });

  it('throws retryable suppression check failures so temporary lookup errors are retried', async () => {
    setActivity('checkSuppressionActivity', async () =>
      errResult('SUPPRESSION_LOOKUP_FAILED', 'Suppression database unavailable', true),
    );

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).rejects.toThrow(
      'Email suppression check failed (SUPPRESSION_LOOKUP_FAILED): Suppression database unavailable',
    );
  });

  it('keeps non-retryable suppression check failures failed without throwing', async () => {
    setActivity('checkSuppressionActivity', async () =>
      errResult('SUPPRESSION_LOOKUP_INVALID', 'Suppression lookup is invalid', false),
    );

    await expect(notificationDeliveryWorkflow(makeNotificationDeliveryInput())).resolves.toEqual({
      status: 'failed',
    });
  });

  it('marks non-transactional suppressed email jobs before returning suppressed', async () => {
    const markAttempts: Array<Record<string, unknown>> = [];
    const sendAttempts: Array<Record<string, unknown>> = [];
    setActivity('checkSuppressionActivity', async () => okResult({ suppressed: true }));
    setActivity('markEmailJobSuppressedActivity', async (input) => {
      markAttempts.push(input);
      return okResult({ suppressed: true });
    });
    setActivity('sendEmailActivity', async (input) => {
      sendAttempts.push(input);
      return okResult({ deliveryId: 'emd_1', provider: 'capture' });
    });

    await expect(
      notificationDeliveryWorkflow(makeNotificationDeliveryInput({ notificationType: 'bulk' })),
    ).resolves.toEqual({
      status: 'suppressed',
    });
    expect(markAttempts).toEqual([
      {
        jobId: 'emj_test_1',
        tenantId: 'tnt_1',
        reason: 'suppression',
      },
    ]);
    expect(sendAttempts).toHaveLength(0);
  });

  it('throws retryable consent check failures so temporary lookup errors are retried', async () => {
    setActivity('checkConsentActivity', async () =>
      errResult('CONSENT_LOOKUP_FAILED', 'Consent database unavailable', true),
    );

    await expect(
      notificationDeliveryWorkflow(makeNotificationDeliveryInput({ notificationType: 'bulk' })),
    ).rejects.toThrow(
      'Email consent check failed (CONSENT_LOOKUP_FAILED): Consent database unavailable',
    );
  });

  it('keeps non-retryable consent check failures failed without throwing', async () => {
    setActivity('checkConsentActivity', async () =>
      errResult('CONSENT_LOOKUP_INVALID', 'Consent lookup is invalid', false),
    );

    await expect(
      notificationDeliveryWorkflow(makeNotificationDeliveryInput({ notificationType: 'bulk' })),
    ).resolves.toEqual({
      status: 'failed',
    });
  });

  it('suppresses non-transactional emails when consent is denied', async () => {
    const markAttempts: Array<Record<string, unknown>> = [];
    const sendAttempts: Array<Record<string, unknown>> = [];
    setActivity('checkConsentActivity', async () => okResult({ allowed: false }));
    setActivity('markEmailJobSuppressedActivity', async (input) => {
      markAttempts.push(input);
      return okResult({ suppressed: true });
    });
    setActivity('sendEmailActivity', async (input) => {
      sendAttempts.push(input);
      return okResult({ deliveryId: 'emd_1', provider: 'capture' });
    });

    await expect(
      notificationDeliveryWorkflow(makeNotificationDeliveryInput({ notificationType: 'bulk' })),
    ).resolves.toEqual({
      status: 'suppressed',
    });
    expect(markAttempts).toEqual([
      {
        jobId: 'emj_test_1',
        tenantId: 'tnt_1',
        reason: 'consent',
      },
    ]);
    expect(sendAttempts).toHaveLength(0);
  });

  it('throws retryable suppressed-job update failures instead of leaving queued jobs silent', async () => {
    setActivity('checkSuppressionActivity', async () => okResult({ suppressed: true }));
    setActivity('markEmailJobSuppressedActivity', async () =>
      errResult('EMAIL_JOB_SUPPRESSION_UPDATE_FAILED', 'database timeout', true),
    );

    await expect(
      notificationDeliveryWorkflow(makeNotificationDeliveryInput({ notificationType: 'bulk' })),
    ).rejects.toThrow(
      'Email suppression status update failed (EMAIL_JOB_SUPPRESSION_UPDATE_FAILED): database timeout',
    );
  });

  it('waits until scheduledAt before delivering scheduled notification jobs', async () => {
    const sendAttempts: Array<Record<string, unknown>> = [];
    setActivity('sendEmailActivity', async (input) => {
      sendAttempts.push(input);
      return okResult({ deliveryId: 'emd_1', provider: 'capture' });
    });

    await expect(
      notificationDeliveryWorkflow(
        makeNotificationDeliveryInput({
          scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    ).resolves.toEqual({ status: 'sent' });

    expect(mockState.sleeps).toHaveLength(1);
    expect(typeof mockState.sleeps[0]).toBe('number');
    expect(Number(mockState.sleeps[0])).toBeGreaterThan(0);
    expect(sendAttempts).toHaveLength(1);
  });
});

describe('smsDeliveryWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('throws retryable SMS send failures so provider outages are retried', async () => {
    const sendAttempts: Array<Record<string, unknown>> = [];
    setActivity('sendSmsActivity', async (input) => {
      sendAttempts.push(input);
      return errResult('SMS_SEND_FAILED', 'All SMS providers failed', true);
    });

    await expect(smsDeliveryWorkflow(makeSmsDeliveryInput())).rejects.toThrow(
      'SMS delivery failed (SMS_SEND_FAILED): All SMS providers failed',
    );
    expect(sendAttempts).toHaveLength(1);
  });

  it('suppresses SMS sends when consent is required', async () => {
    setActivity('sendSmsActivity', async () =>
      errResult('SMS_CONSENT_REQUIRED', 'SMS consent is required before sending', false),
    );

    await expect(smsDeliveryWorkflow(makeSmsDeliveryInput())).resolves.toEqual({
      status: 'suppressed',
    });
  });

  it('keeps non-retryable SMS send failures failed without throwing', async () => {
    setActivity('sendSmsActivity', async () =>
      errResult('SMS_RECIPIENT_INVALID', 'Recipient phone number is invalid', false),
    );

    await expect(smsDeliveryWorkflow(makeSmsDeliveryInput())).resolves.toEqual({
      status: 'failed',
    });
  });
});

describe('paymentReconciliationWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('marks the provider event processed after durable webhook event creation', async () => {
    let webhookEventInput: Record<string, unknown> | undefined;
    let markInput: Record<string, unknown> | undefined;

    setActivity('reconcilePaymentActivity', async () =>
      okResult({
        orderId: 'ord_1',
        status: 'paid',
        webhookEvent: makeReconciledOrderWebhookEvent(),
      }),
    );
    setActivity('emitWebhookEventActivity', async (input) => {
      webhookEventInput = input;
      return okResult({
        eventId: 'whe_1',
        deliveries: [{ endpointId: 'wh_1', eventId: 'whe_1', url: 'https://example.test/hook' }],
      });
    });
    setActivity('markProviderEventProcessedActivity', async (input) => {
      markInput = input;
      return okResult({ processed: true });
    });

    const result = await paymentReconciliationWorkflow(makePaymentReconciliationInput());

    expect(result).toEqual({ status: 'paid' });
    expect(webhookEventInput).toEqual({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      eventType: 'order.paid',
      payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
      idempotencyKey: 'payment-reconciliation:stripe:evt_stripe_1:order.paid',
    });
    expect(mockState.childStarts).toEqual([
      {
        workflow: webhookDeliveryWorkflow,
        options: {
          workflowId: 'webhook-delivery:whe_1:wh_1',
          parentClosePolicy: 'PARENT_CLOSE_POLICY_ABANDON',
          args: [
            {
              version: 1,
              endpointId: 'wh_1',
              eventId: 'whe_1',
              eventType: 'order.paid',
              payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
              maxAttempts: 5,
            },
          ],
        },
      },
    ]);
    expect(markInput).toEqual({ provider: 'stripe', providerEventId: 'evt_stripe_1' });
  });

  it('retries retryable payment reconciliation before emitting and marking processed', async () => {
    let reconcileCalls = 0;
    let webhookEventInput: Record<string, unknown> | undefined;
    let markInput: Record<string, unknown> | undefined;

    setActivity('reconcilePaymentActivity', async () => {
      reconcileCalls += 1;
      if (reconcileCalls === 1) {
        return errResult(
          'ORDER_NOT_FINALIZED_YET',
          'Checkout session is still finalizing for this successful payment',
          true,
        );
      }
      return okResult({
        orderId: 'ord_1',
        status: 'paid',
        webhookEvent: makeReconciledOrderWebhookEvent(),
      });
    });
    setActivity('emitWebhookEventActivity', async (input) => {
      webhookEventInput = input;
      return okResult({ eventId: 'whe_1', deliveries: [] });
    });
    setActivity('markProviderEventProcessedActivity', async (input) => {
      markInput = input;
      return okResult({ processed: true });
    });

    const result = await paymentReconciliationWorkflow(makePaymentReconciliationInput());

    expect(result).toEqual({ status: 'paid' });
    expect(reconcileCalls).toBe(2);
    expect(mockState.sleeps).toEqual(['5 seconds']);
    expect(webhookEventInput).toEqual({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      eventType: 'order.paid',
      payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
      idempotencyKey: 'payment-reconciliation:stripe:evt_stripe_1:order.paid',
    });
    expect(markInput).toEqual({ provider: 'stripe', providerEventId: 'evt_stripe_1' });
  });

  it('uses a stable webhook idempotency key before provider mark-processed retries', async () => {
    let webhookEventInput: Record<string, unknown> | undefined;

    setActivity('reconcilePaymentActivity', async () =>
      okResult({
        orderId: 'ord_1',
        status: 'paid',
        webhookEvent: makeReconciledOrderWebhookEvent(),
      }),
    );
    setActivity('emitWebhookEventActivity', async (input) => {
      webhookEventInput = input;
      return okResult({
        eventId: 'whe_stable',
        deliveries: [
          { endpointId: 'wh_1', eventId: 'whe_stable', url: 'https://example.test/hook' },
        ],
      });
    });
    setActivity('markProviderEventProcessedActivity', async () =>
      errResult('PROVIDER_EVENT_UPDATE_FAILED', 'database unavailable', true),
    );

    await expect(paymentReconciliationWorkflow(makePaymentReconciliationInput())).rejects.toThrow(
      'Payment provider event mark-processed failed (PROVIDER_EVENT_UPDATE_FAILED): database unavailable',
    );

    expect(webhookEventInput).toEqual({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      eventType: 'order.paid',
      payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
      idempotencyKey: 'payment-reconciliation:stripe:evt_stripe_1:order.paid',
    });
    expect(mockState.childStarts[0]?.options).toMatchObject({
      workflowId: 'webhook-delivery:whe_stable:wh_1',
      parentClosePolicy: 'PARENT_CLOSE_POLICY_ABANDON',
    });
  });

  it('does not mark provider events processed when webhook event creation fails retryably', async () => {
    let marked = false;

    setActivity('reconcilePaymentActivity', async () =>
      okResult({
        orderId: 'ord_1',
        status: 'paid',
        webhookEvent: makeReconciledOrderWebhookEvent(),
      }),
    );
    setActivity('emitWebhookEventActivity', async () =>
      errResult('WEBHOOK_EVENT_CREATE_FAILED', 'database unavailable', true),
    );
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(paymentReconciliationWorkflow(makePaymentReconciliationInput())).rejects.toThrow(
      'Payment reconciliation webhook event failed (WEBHOOK_EVENT_CREATE_FAILED): database unavailable',
    );
    expect(marked).toBe(false);
  });

  it('emits refund and dispute webhook events before marking processed', async () => {
    const emittedWebhookInputs: unknown[] = [];
    const markedProviderEvents: unknown[] = [];

    setActivity('emitWebhookEventActivity', async (input) => {
      emittedWebhookInputs.push(input);
      return okResult({ eventId: `whe_${emittedWebhookInputs.length}`, deliveries: [] });
    });
    setActivity('markProviderEventProcessedActivity', async (input) => {
      markedProviderEvents.push(input);
      return okResult({ processed: true });
    });
    setActivity('reconcileRefundActivity', async () =>
      okResult({
        orderId: 'ord_1',
        status: 'refunded',
        webhookEvent: makeReconciledOrderWebhookEvent({ eventType: 'order.refunded' }),
      }),
    );

    await expect(
      paymentReconciliationWorkflow(
        makePaymentReconciliationInput({ eventType: 'refund.created' }),
      ),
    ).resolves.toEqual({ status: 'refunded' });

    setActivity('reconcileDisputeActivity', async () =>
      okResult({
        orderId: 'ord_1',
        status: 'disputed',
        webhookEvent: makeReconciledOrderWebhookEvent({ eventType: 'order.disputed' }),
      }),
    );

    await expect(
      paymentReconciliationWorkflow(
        makePaymentReconciliationInput({ eventType: 'charge.dispute.created' }),
      ),
    ).resolves.toEqual({ status: 'disputed' });

    expect(emittedWebhookInputs).toEqual([
      {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        eventType: 'order.refunded',
        payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
        idempotencyKey: 'payment-reconciliation:stripe:evt_stripe_1:order.refunded',
      },
      {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        eventType: 'order.disputed',
        payload: { orderId: 'ord_1', eventId: 'evt_1', checkoutSessionId: 'cs_1' },
        idempotencyKey: 'payment-reconciliation:stripe:evt_stripe_1:order.disputed',
      },
    ]);
    expect(markedProviderEvents).toHaveLength(2);
  });

  it('keeps v1 retryable reconciliation failures as immediate workflow retries without marking processed', async () => {
    let reconcileCalls = 0;
    let marked = false;

    setActivity('reconcilePaymentActivity', async () => {
      reconcileCalls += 1;
      return errResult('PAYMENT_RECONCILE_FAILED', 'database unavailable', true);
    });
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(
      paymentReconciliationWorkflow(makePaymentReconciliationInput({ version: 1 })),
    ).rejects.toThrow(
      'Payment reconciliation failed (PAYMENT_RECONCILE_FAILED): database unavailable',
    );
    expect(reconcileCalls).toBe(1);
    expect(mockState.sleeps).toEqual([]);
    expect(marked).toBe(false);
  });

  it('exhausts retryable checkout finalization attempts without marking the provider event processed', async () => {
    let reconcileCalls = 0;
    let marked = false;

    setActivity('reconcilePaymentActivity', async () => {
      reconcileCalls += 1;
      return errResult(
        'ORDER_NOT_FINALIZED_YET',
        'Checkout session is still finalizing for this successful payment',
        true,
      );
    });
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(paymentReconciliationWorkflow(makePaymentReconciliationInput())).rejects.toThrow(
      'Payment reconciliation failed (ORDER_NOT_FINALIZED_YET): Checkout session is still finalizing for this successful payment (attempts exhausted after 5 attempts)',
    );
    expect(reconcileCalls).toBe(5);
    expect(mockState.sleeps).toEqual(['5 seconds', '5 seconds', '5 seconds', '5 seconds']);
    expect(marked).toBe(false);
  });

  it('does not mark provider events processed when orphan compensation needs manual review', async () => {
    let emitted = false;
    let marked = false;

    setActivity('reconcilePaymentActivity', async () =>
      okResult({ orderId: undefined, status: 'compensated:manual_review' }),
    );
    setActivity('emitDomainEventActivity', async () => {
      emitted = true;
      return okResult({ emitted: true });
    });
    setActivity('markProviderEventProcessedActivity', async () => {
      marked = true;
      return okResult({ processed: true });
    });

    await expect(paymentReconciliationWorkflow(makePaymentReconciliationInput())).rejects.toThrow(
      'Payment reconciliation compensation blocked with status compensated:manual_review',
    );
    expect(emitted).toBe(false);
    expect(marked).toBe(false);
  });
});

describe('providerEventRecoveryWorkflow', () => {
  beforeEach(() => {
    resetState();
  });

  it('claims unprocessed provider events and dispatches recovery child workflows', async () => {
    const dispatchMarks: unknown[] = [];

    setActivity('claimUnprocessedProviderEventsActivity', async () =>
      okResult({
        events: [
          {
            id: 'pevt_stripe_1',
            provider: 'stripe',
            providerEventId: 'evt_stripe_1',
            eventType: 'payment_intent.succeeded',
            recoveryAttempts: 3,
            workflow: 'payment_reconciliation',
            input: {
              providerEventId: 'evt_stripe_1',
              provider: 'stripe',
              eventType: 'payment_intent.succeeded',
              data: { id: 'pi_1', status: 'succeeded' },
            },
          },
          {
            id: 'pevt_clerk_1',
            provider: 'clerk',
            providerEventId: 'msg_1',
            eventType: 'user.created',
            recoveryAttempts: 2,
            workflow: 'clerk_identity_sync',
            input: {
              providerEventId: 'msg_1',
              eventType: 'user.created',
              clerkUserId: 'user_1',
              email: 'user@example.test',
            },
          },
        ],
      }),
    );
    setActivity('markProviderEventRecoveryDispatchedActivity', async (input) => {
      dispatchMarks.push(input);
      return okResult({ dispatched: true });
    });

    await providerEventRecoveryWorkflow({ maxIterations: 1, batchSize: 10, leaseMs: 30_000 });

    expect(mockState.childStarts).toEqual([
      {
        workflow: paymentReconciliationWorkflow,
        options: {
          workflowId: 'payment-reconciliation-recovery:evt_stripe_1:3',
          parentClosePolicy: 'PARENT_CLOSE_POLICY_ABANDON',
          args: [
            {
              version: PAYMENT_RECONCILIATION_WORKFLOW_VERSION,
              providerEventId: 'evt_stripe_1',
              provider: 'stripe',
              eventType: 'payment_intent.succeeded',
              data: { id: 'pi_1', status: 'succeeded' },
            },
          ],
        },
      },
      {
        workflow: clerkIdentitySyncWorkflow,
        options: {
          workflowId: 'clerk-identity-sync-recovery:msg_1:2',
          parentClosePolicy: 'PARENT_CLOSE_POLICY_ABANDON',
          args: [
            {
              version: CLERK_IDENTITY_SYNC_WORKFLOW_VERSION,
              providerEventId: 'msg_1',
              eventType: 'user.created',
              clerkUserId: 'user_1',
              email: 'user@example.test',
            },
          ],
        },
      },
    ]);
    expect(dispatchMarks).toEqual([
      {
        id: 'pevt_stripe_1',
        ownerId: 'provider-event-recovery:test-workflow:test-run:0',
        recoveryAttempts: 3,
      },
      {
        id: 'pevt_clerk_1',
        ownerId: 'provider-event-recovery:test-workflow:test-run:0',
        recoveryAttempts: 2,
      },
    ]);
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

    const result = await clerkIdentitySyncWorkflow(
      makeClerkIdentitySyncInput({ email: undefined }),
    );

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

    const result = await clerkIdentitySyncWorkflow(
      makeClerkIdentitySyncInput({ eventType: 'session.created' }),
    );

    expect(result).toEqual({ status: 'unhandled' });
    expect(markInput).toEqual({ provider: 'clerk', providerEventId: 'msg_clerk_1' });
  });

  it('throws retryable sync failures without marking the provider event processed', async () => {
    let marked = false;

    setActivity('syncUserActivity', async () =>
      errResult('USER_SYNC_FAILED', 'database unavailable', true),
    );
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

  it('completes without returning the internal file URL', async () => {
    const result = await exportWorkflow(input);
    expect(result).toEqual({
      status: 'completed',
    });
  });

  it('never passes raw export data between activities', async () => {
    const activityCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
    setActivity(
      'generateAndUploadExportActivity',
      async (activityInput: Record<string, unknown>) => {
        activityCalls.push({ name: 'generateAndUploadExportActivity', input: activityInput });
        return okResult({ fileUrl: 'https://exports.example.test/exp_1.csv', rowCount: 42 });
      },
    );
    setActivity('notifyExportCompleteActivity', async (activityInput: Record<string, unknown>) => {
      activityCalls.push({ name: 'notifyExportCompleteActivity', input: activityInput });
      return okResult({ notified: true });
    });

    const result = await exportWorkflow(input);
    expect(result.status).toBe('completed');

    const genCall = activityCalls.find((c) => c.name === 'generateAndUploadExportActivity');
    expect(genCall?.input).not.toHaveProperty('data');
    expect(genCall?.input).toMatchObject({ exportId: 'exp_1', type: 'attendees', format: 'csv' });

    const notifyCall = activityCalls.find((c) => c.name === 'notifyExportCompleteActivity');
    expect(notifyCall?.input).not.toHaveProperty('data');
    expect(notifyCall?.input).toMatchObject({
      exportId: 'exp_1',
      fileUrl: 'https://exports.example.test/exp_1.csv',
    });
  });

  it('marks the export failed when generation returns a non-retryable failure', async () => {
    let failedInput: Record<string, unknown> | undefined;
    setActivity('generateAndUploadExportActivity', async () =>
      errResult('EXPORT_FAILED', 'Invalid export filters', false),
    );
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'Invalid export filters',
    });
  });

  it('retries retryable generation failures before continuing', async () => {
    let attempts = 0;
    setActivity('generateAndUploadExportActivity', async () => {
      attempts += 1;
      if (attempts < 3) {
        return errResult('EXPORT_FAILED', 'Database unavailable', true);
      }
      return okResult({ fileUrl: 'https://exports.example.test/exp_1.csv', rowCount: 1 });
    });

    const result = await exportWorkflow(input);

    expect(result).toEqual({
      status: 'completed',
    });
    expect(attempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
  });

  it('marks the export failed after retryable generation failures are exhausted', async () => {
    let attempts = 0;
    let failedInput: Record<string, unknown> | undefined;
    setActivity('generateAndUploadExportActivity', async () => {
      attempts += 1;
      return errResult('EXPORT_FAILED', 'Database unavailable', true);
    });
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'Database unavailable',
    });
  });

  it('marks the export failed when upload returns a non-retryable failure', async () => {
    let failedInput: Record<string, unknown> | undefined;
    setActivity('generateAndUploadExportActivity', async () =>
      errResult('FILE_UPLOAD_FAILED', 'Invalid S3 credentials', false),
    );
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'Invalid S3 credentials',
    });
  });

  it('marks the export failed after retryable upload failures are exhausted', async () => {
    let attempts = 0;
    let failedInput: Record<string, unknown> | undefined;
    setActivity('generateAndUploadExportActivity', async () => {
      attempts += 1;
      return errResult('FILE_UPLOAD_FAILED', 'S3 timeout', true);
    });
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'S3 timeout',
    });
  });

  it('keeps completed exports completed after retryable notification failures are exhausted', async () => {
    let attempts = 0;
    let failedInput: Record<string, unknown> | undefined;
    setActivity('notifyExportCompleteActivity', async () => {
      attempts += 1;
      return errResult('EXPORT_NOTIFICATION_FAILED', 'Database unavailable', true);
    });
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('completed');
    expect(attempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
    expect(failedInput).toBeUndefined();
  });

  it('marks the export failed after retryable completion persistence failures are exhausted', async () => {
    let attempts = 0;
    let failedInput: Record<string, unknown> | undefined;
    setActivity('notifyExportCompleteActivity', async () => {
      attempts += 1;
      return errResult('EXPORT_COMPLETION_FAILED', 'Database unavailable', true);
    });
    setActivity('markExportFailedActivity', async (activityInput: Record<string, unknown>) => {
      failedInput = activityInput;
      return okResult({ failed: true });
    });

    const result = await exportWorkflow(input);

    expect(result.status).toBe('failed');
    expect(attempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
    expect(failedInput).toMatchObject({
      exportId: 'exp_1',
      reason: 'Database unavailable',
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
    setActivity('processPrivacyRequestActivity', async () =>
      errResult('privacy_request_failed', 'database unavailable', false),
    );

    const result = await privacyRequestWorkflow({ version: 1, requestId: 'prv_1' });

    expect(result).toEqual({ status: 'failed' });
  });
});

describe('workflow id conventions', () => {
  it('scopes webhook delivery workflows by event and endpoint', () => {
    expect(webhookDeliveryWorkflowId('whe_1', 'wh_1')).toBe('webhook-delivery:whe_1:wh_1');
  });

  it('scopes webhook replay workflows by event, endpoint, and replay nonce', () => {
    expect(webhookDeliveryReplayWorkflowId('whe_1', 'wh_1', 'rpl_1')).toBe(
      'webhook-delivery:whe_1:wh_1:replay:rpl_1',
    );
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
    setActivity('enforcePrivacyRetentionActivity', async () => {
      calls.push('privacy');
      return okResult({ inspectedCount: 1, repairedCount: 1, skippedCount: 0 });
    });
    setActivity('eraseExpiredAgentMemoryActivity', async () => {
      calls.push('memory');
      return { erasedCount: 1 };
    });
    setActivity('eraseExpiredProviderIncidentEvidenceActivity', async () => {
      calls.push('provider-incidents');
      return { erasedCount: 1 };
    });

    await holdExpirationWorkflow({ maxIterations: 2, tickIntervalSeconds: 15 });

    expect(calls).toEqual([
      'holds',
      'sessions',
      'waitlist',
      'privacy',
      'memory',
      'provider-incidents',
      'holds',
      'sessions',
      'waitlist',
      'privacy',
      'memory',
      'provider-incidents',
    ]);
    expect(mockState.sleeps).toEqual(['15 seconds']);
    expect(mockState.continueAsNewInputs).toEqual([]);
  });

  it('throws retryable stale-hold expiration failures before later maintenance runs', async () => {
    const calls: string[] = [];
    setActivity('expireStaleHoldsActivity', async () => {
      calls.push('holds');
      return errResult('stale_holds_failed', 'database unavailable', true);
    });
    setActivity('expireStaleSessionsActivity', async () => {
      calls.push('sessions');
      return okResult({ expiredCount: 1 });
    });
    setActivity('processWaitlistOffersActivity', async () => {
      calls.push('waitlist');
      return okResult({ expiredCount: 1, offeredCount: 1, queuedEmailCount: 1 });
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'Stale hold expiration failed (stale_holds_failed): database unavailable',
    );

    expect(calls).toEqual(['holds']);
    expect(mockState.sleeps).toEqual([]);
  });

  it('throws retryable stale-session expiration failures before waitlist maintenance runs', async () => {
    const calls: string[] = [];
    setActivity('expireStaleHoldsActivity', async () => {
      calls.push('holds');
      return okResult({ expiredCount: 1 });
    });
    setActivity('expireStaleSessionsActivity', async () => {
      calls.push('sessions');
      return errResult('stale_sessions_failed', 'database unavailable', true);
    });
    setActivity('processWaitlistOffersActivity', async () => {
      calls.push('waitlist');
      return okResult({ expiredCount: 1, offeredCount: 1, queuedEmailCount: 1 });
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'Stale session expiration failed (stale_sessions_failed): database unavailable',
    );

    expect(calls).toEqual(['holds', 'sessions']);
    expect(mockState.sleeps).toEqual([]);
  });

  it('throws retryable waitlist maintenance failures before privacy maintenance runs', async () => {
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
      return errResult('waitlist_offers_failed', 'database unavailable', true);
    });
    setActivity('enforcePrivacyRetentionActivity', async () => {
      calls.push('privacy');
      return okResult({ inspectedCount: 1, repairedCount: 1, skippedCount: 0 });
    });
    setActivity('eraseExpiredAgentMemoryActivity', async () => {
      calls.push('memory');
      return { erasedCount: 1 };
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'Waitlist offer processing failed (waitlist_offers_failed): database unavailable',
    );

    expect(calls).toEqual(['holds', 'sessions', 'waitlist']);
    expect(mockState.sleeps).toEqual([]);
  });

  it('fails the maintenance tick when queued message handoffs cannot reach Temporal', async () => {
    setActivity('recoverQueuedMessageHandoffsActivity', async () =>
      errResult('MESSAGE_HANDOFF_RECOVERY_FAILED', 'Temporal unavailable', true),
    );

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'Message handoff recovery failed (MESSAGE_HANDOFF_RECOVERY_FAILED): Temporal unavailable',
    );
  });

  it('keeps recurring maintenance alive when a privacy handoff misses one tick', async () => {
    let attempts = 0;
    setActivity('recoverPendingPrivacyRequestHandoffsActivity', async () => {
      attempts += 1;
      return attempts === 1
        ? errResult('PRIVACY_HANDOFF_RECOVERY_FAILED', 'Temporal unavailable', true)
        : okResult({ recoveredCount: 1, skippedUnauditedCount: 0 });
    });

    await expect(holdExpirationWorkflow({ maxIterations: 2 })).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('continues as new after the configured production rollover threshold', async () => {
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
    setActivity('enforcePrivacyRetentionActivity', async () => {
      calls.push('privacy');
      return okResult({ inspectedCount: 1, repairedCount: 1, skippedCount: 0 });
    });
    setActivity('eraseExpiredAgentMemoryActivity', async () => {
      calls.push('memory');
      return { erasedCount: 1 };
    });

    await holdExpirationWorkflow({
      version: 1,
      tickIntervalSeconds: 15,
      continueAsNewAfterIterations: 2,
    });

    expect(calls).toEqual([
      'holds',
      'sessions',
      'waitlist',
      'privacy',
      'memory',
      'holds',
      'sessions',
      'waitlist',
      'privacy',
      'memory',
    ]);
    expect(mockState.sleeps).toEqual(['15 seconds']);
    expect(mockState.continueAsNewInputs).toEqual([
      { version: 1, tickIntervalSeconds: 15, continueAsNewAfterIterations: 2 },
    ]);
  });

  it('skips privacy retention on pre-patch replay histories', async () => {
    const calls: string[] = [];
    mockState.patchedResult = false;
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
    setActivity('enforcePrivacyRetentionActivity', async () => {
      calls.push('privacy');
      return okResult({ inspectedCount: 1, repairedCount: 1, skippedCount: 0 });
    });

    await holdExpirationWorkflow({ maxIterations: 1 });

    expect(calls).toEqual(['holds', 'sessions', 'waitlist']);
  });

  it('throws retryable privacy retention failures', async () => {
    setActivity('enforcePrivacyRetentionActivity', async () =>
      errResult('privacy_retention_failed', 'database unavailable', true),
    );

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'Privacy retention repair failed (privacy_retention_failed): database unavailable',
    );
  });

  it('runs durable provider account cleanup on every patched maintenance tick', async () => {
    let attempts = 0;
    setActivity('processProviderAccountCleanupActivity', async () => {
      attempts += 1;
      return okResult({ completed: 1, retried: 0, manualReview: 0 });
    });

    await expect(
      holdExpirationWorkflow({ maxIterations: 2, tickIntervalSeconds: 15 }),
    ).resolves.toBeUndefined();

    expect(attempts).toBe(2);
  });

  it('fails the maintenance tick when durable provider cleanup infrastructure is unavailable', async () => {
    setActivity('processProviderAccountCleanupActivity', async () =>
      errResult('PROVIDER_ACCOUNT_CLEANUP_FAILED', 'database unavailable', true),
    );

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'Provider account cleanup failed (PROVIDER_ACCOUNT_CLEANUP_FAILED): database unavailable',
    );
  });

  it('survives exhausted memory activity retries and invokes retention on the next tick', async () => {
    let attempts = 0;
    setActivity('eraseExpiredAgentMemoryActivity', async () => {
      attempts += 1;
      if (attempts === 1) throw exhaustedActivityFailure('database unavailable');
      return { erasedCount: 1 };
    });

    await expect(
      holdExpirationWorkflow({ maxIterations: 2, tickIntervalSeconds: 15 }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(mockState.sleeps).toEqual(['15 seconds']);
  });

  it('propagates workflow cancellation during memory retention', async () => {
    setActivity('eraseExpiredAgentMemoryActivity', async () => {
      const error = new Error('cancelled');
      error.name = 'CancelledFailure';
      throw error;
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toMatchObject({
      name: 'CancelledFailure',
    });
  });

  it('propagates unexpected non-activity failures during memory retention', async () => {
    setActivity('eraseExpiredAgentMemoryActivity', async () => {
      throw new TypeError('unexpected workflow boundary failure');
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'unexpected workflow boundary failure',
    );
  });

  it('survives exhausted provider evidence retention retries and invokes deletion next tick', async () => {
    let attempts = 0;
    setActivity('eraseExpiredProviderIncidentEvidenceActivity', async () => {
      attempts += 1;
      if (attempts === 1) throw exhaustedActivityFailure('database unavailable');
      return { erasedCount: 1 };
    });

    await expect(
      holdExpirationWorkflow({ maxIterations: 2, tickIntervalSeconds: 15 }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('propagates workflow cancellation during provider evidence retention', async () => {
    setActivity('eraseExpiredProviderIncidentEvidenceActivity', async () => {
      const error = new Error('cancelled');
      error.name = 'CancelledFailure';
      throw error;
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toMatchObject({
      name: 'CancelledFailure',
    });
  });

  it('propagates unexpected provider evidence retention failures', async () => {
    setActivity('eraseExpiredProviderIncidentEvidenceActivity', async () => {
      throw new TypeError('unexpected provider retention boundary failure');
    });

    await expect(holdExpirationWorkflow({ maxIterations: 1 })).rejects.toThrow(
      'unexpected provider retention boundary failure',
    );
  });
});

describe('webhookDeliveryWorkflow', () => {
  beforeEach(() => {
    resetState();
    Object.entries(defaultActivities).forEach(([name, impl]) => setActivity(name, impl));
  });

  it('disables automatic activity retries for side-effecting webhook posts', () => {
    expect(mockState.proxyActivityOptions).toContainEqual(
      expect.objectContaining({
        startToCloseTimeout: '30 seconds',
        retry: { maximumAttempts: 1 },
      }),
    );
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

  it('passes replay nonce through to delivery activities', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return okResult({ statusCode: 204, response: '' });
    });

    const result = await webhookDeliveryWorkflow(
      makeWebhookDeliveryInput({ replayNonce: 'rpl_1' }),
    );

    expect(result.status).toBe('delivered');
    expect(attempts).toEqual([
      expect.objectContaining({
        endpointId: 'wh_1',
        eventId: 'whe_1',
        replayNonce: 'rpl_1',
        attempt: 1,
      }),
    ]);
  });

  it('dead-letters non-retryable delivery failures without sleeping for retries', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return errResult('ENDPOINT_INACTIVE', 'Webhook endpoint is not active', false);
    });

    const result = await webhookDeliveryWorkflow(makeWebhookDeliveryInput());

    expect(result.status).toBe('dead_lettered');
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1]);
    expect(mockState.sleeps).toEqual([]);
  });

  it('propagates delivery persistence failures instead of marking the workflow dead-lettered', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      throw new Error('Failed to persist webhook dead-letter delivery: database unavailable');
    });

    await expect(webhookDeliveryWorkflow(makeWebhookDeliveryInput())).rejects.toThrow(
      'Failed to persist webhook dead-letter delivery: database unavailable',
    );

    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1]);
    expect(mockState.sleeps).toEqual([]);
  });

  it('rechecks in-progress final attempts without marking dead-lettered', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return attempts.length === 1
        ? errResult(
            'WEBHOOK_DELIVERY_IN_PROGRESS',
            'Webhook delivery attempt is already in progress',
            true,
          )
        : okResult({ statusCode: 204, response: '' });
    });

    const result = await webhookDeliveryWorkflow(makeWebhookDeliveryInput({ maxAttempts: 1 }));

    expect(result.status).toBe('delivered');
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 1]);
    expect(attempts.map((attempt) => attempt.finalAttempt)).toEqual([true, true]);
    expect(mockState.sleeps).toEqual(['5 seconds']);
  });

  it('does not advance to a new logical attempt while the same webhook attempt is in progress', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return attempts.length === 1
        ? errResult(
            'WEBHOOK_DELIVERY_IN_PROGRESS',
            'Webhook delivery attempt is already in progress',
            true,
          )
        : okResult({ statusCode: 204, response: '' });
    });

    const result = await webhookDeliveryWorkflow(makeWebhookDeliveryInput());

    expect(result.status).toBe('delivered');
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 1]);
    expect(attempts.map((attempt) => attempt.finalAttempt)).toEqual([false, false]);
    expect(mockState.sleeps).toEqual(['5 seconds']);
  });

  it('fails after bounded in-progress rechecks', async () => {
    const attempts: Array<Record<string, unknown>> = [];
    setActivity('deliverWebhookActivity', async (input) => {
      attempts.push(input);
      return errResult(
        'WEBHOOK_DELIVERY_IN_PROGRESS',
        'Webhook delivery attempt is already in progress',
        true,
      );
    });

    await expect(webhookDeliveryWorkflow(makeWebhookDeliveryInput())).rejects.toThrow(
      'Webhook delivery attempt remained in progress (WEBHOOK_DELIVERY_IN_PROGRESS): Webhook delivery attempt is already in progress',
    );

    expect(attempts.map((attempt) => attempt.attempt)).toEqual(Array.from({ length: 13 }, () => 1));
    expect(mockState.sleeps).toEqual(Array.from({ length: 12 }, () => '5 seconds'));
  });
});
