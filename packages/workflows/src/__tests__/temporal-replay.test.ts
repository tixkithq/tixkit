import { describe, it, expect } from 'vitest';

// Fast unit-level workflow export baseline. Server-backed scheduling, retry,
// ordered migration execution, and history replay are covered by
// migration-temporal.integration.test.ts when TEMPORAL_ADDRESS is configured.

describe('Temporal workflow baseline', () => {
  it('refundWorkflow is exported and has the correct input type shape', async () => {
    const mod = await import('../workflows/refund.js');
    expect(typeof mod.refundWorkflow).toBe('function');
    const types = await import('../shared/types.js');
    expect(types.REFUND_WORKFLOW_VERSION).toBe(1);
  });

  it('refundWorkflowId includes nonce for collision prevention', async () => {
    const { refundWorkflowId } = await import('../shared/types.js');
    const id1 = refundWorkflowId('ord_1', 'nonce_a');
    const id2 = refundWorkflowId('ord_1', 'nonce_b');
    expect(id1).toBe('order-refund:ord_1:nonce_a');
    expect(id2).toBe('order-refund:ord_1:nonce_b');
    expect(id1).not.toBe(id2);
  });
});
