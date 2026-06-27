import { describe, expect, it, vi } from 'vitest';
import { TemporalClient } from '../services/temporal.js';

describe('TemporalClient payment reconciliation', () => {
  it('returns the existing workflow handle when reconciliation was already started', async () => {
    const existingHandle = { workflowId: 'payment-reconciliation:evt_1' };
    const client = {
      workflow: {
        start: vi.fn(async () => {
          const err = new Error('Workflow execution already started');
          err.name = 'WorkflowExecutionAlreadyStartedError';
          throw err;
        }),
        getHandle: vi.fn(() => existingHandle),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    const result = await temporalClient.startPaymentReconciliation({
      providerEventId: 'evt_1',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: 'pi_1' },
    });

    expect(result).toBe(existingHandle);
    expect(client.workflow.getHandle).toHaveBeenCalledWith('payment-reconciliation:evt_1');
  });
});

describe('TemporalClient webhook delivery', () => {
  it('starts replay webhook deliveries with a replay-scoped workflow id', async () => {
    const handle = { workflowId: 'webhook-delivery:whe_1:wh_1:replay:rpl_1' };
    const client = {
      workflow: {
        start: vi.fn(async () => handle),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    const result = await temporalClient.startWebhookDelivery({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      replayNonce: 'rpl_1',
      payload: { orderId: 'ord_1' },
      secret: 'secret_1',
      maxAttempts: 5,
    });

    expect(result).toBe(handle);
    expect(client.workflow.start).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      workflowId: 'webhook-delivery:whe_1:wh_1:replay:rpl_1',
    }));
  });
});
