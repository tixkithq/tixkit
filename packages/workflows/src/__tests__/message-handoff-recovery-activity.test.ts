import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emailRows: [] as Array<Record<string, unknown>>,
  smsRows: [] as Array<Record<string, unknown>>,
  restartEmail: vi.fn(async () => undefined),
  restartSms: vi.fn(async () => undefined),
}));

function queryFor(table: string) {
  const query = {
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    execute: vi.fn(async () => (table === 'email_jobs' ? mocks.emailRows : mocks.smsRows)),
  };
  return query;
}

vi.mock('../activities/activity-clients.js', () => ({
  getActivityDb: () => ({ selectFrom: (table: string) => queryFor(table) }),
  restartQueuedNotificationDeliveryWorkflow: mocks.restartEmail,
  restartQueuedSmsDeliveryWorkflow: mocks.restartSms,
}));

import { recoverQueuedMessageHandoffsActivity } from '../activities/hold-expiration.js';

describe('recoverQueuedMessageHandoffsActivity', () => {
  beforeEach(() => {
    mocks.emailRows = [];
    mocks.smsRows = [];
    vi.clearAllMocks();
  });

  it('hands every eligible email and SMS job to its deterministic recovery client', async () => {
    const emailJob = { id: 'emj_1', status: 'queued', workflow_id: null };
    const smsJob = { id: 'smj_1', status: 'start_failed', workflow_id: null };
    mocks.emailRows = [emailJob];
    mocks.smsRows = [smsJob];

    await expect(recoverQueuedMessageHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredEmailCount: 1, recoveredSmsCount: 1 },
    });
    expect(mocks.restartEmail).toHaveBeenCalledWith(expect.any(Object), emailJob);
    expect(mocks.restartSms).toHaveBeenCalledWith(expect.any(Object), smsJob);
  });

  it('attempts the full batch and returns a retryable failure without exposing provider data', async () => {
    mocks.emailRows = [
      { id: 'emj_1', status: 'queued', workflow_id: null },
      { id: 'emj_2', status: 'queued', workflow_id: null },
    ];
    mocks.smsRows = [{ id: 'smj_1', status: 'queued', workflow_id: null }];
    mocks.restartEmail.mockRejectedValueOnce(new Error('provider body containing secret'));
    mocks.restartSms.mockRejectedValueOnce(new Error('phone +15555550100'));

    const result = await recoverQueuedMessageHandoffsActivity();

    expect(mocks.restartEmail).toHaveBeenCalledTimes(2);
    expect(mocks.restartSms).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      errorCode: 'MESSAGE_HANDOFF_RECOVERY_FAILED',
      retryable: true,
      message: '2 queued message handoff(s) could not reach Temporal',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('+15555550100');
  });
});
