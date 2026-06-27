import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () =>
    new Proxy(
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
    ),
}));

import { privacyRequestWorkflow } from '../workflows/privacy.js';
import { errResult, okResult, privacyRequestWorkflowId } from '../shared/types.js';

function setActivity(name: string, impl: (...args: any[]) => any) {
  mockState.activities[name] = impl;
}

describe('privacyRequestWorkflow', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockState.activities)) delete mockState.activities[key];
  });

  it('completes when the privacy activity completes', async () => {
    setActivity('processPrivacyRequestActivity', async () =>
      okResult({ requestId: 'prv_1', status: 'completed' }),
    );

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

  it('uses a stable workflow id convention', () => {
    expect(privacyRequestWorkflowId('prv_1')).toBe('privacy-request:prv_1');
  });
});
