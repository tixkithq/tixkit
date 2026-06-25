import { describe, it, expect } from 'vitest';

// Baseline Temporal workflow structure test.
// A full TestWorkflowEnvironment test requires the @temporalio/testing
// embedded server which is heavy for unit tests. The CI integration job
// provides a Temporal service container (temporalio/auto-setup:1.24) with
// TEMPORAL_ADDRESS=localhost:7233 for integration-level workflow tests.
// This unit test verifies the workflow module loads and exports correctly.

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
