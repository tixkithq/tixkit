import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  privacyRows: [] as Array<Record<string, unknown>>,
  auditedRequestIds: new Set<string>(),
  startPrivacyRequest: vi.fn(async (_requestId: string) => 'privacy-request:test'),
}));

function queryFor(table: string) {
  const predicates: Array<{ column: string; value: unknown }> = [];
  const query = {
    select: vi.fn(() => query),
    selectAll: vi.fn(() => query),
    where: vi.fn((column: string, _operator: string, value: unknown) => {
      predicates.push({ column, value });
      return query;
    }),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    execute: vi.fn(async () =>
      table === 'privacy_requests'
        ? mocks.privacyRows.filter((row) => mocks.auditedRequestIds.has(String(row.id)))
        : [],
    ),
    executeTakeFirst: vi.fn(async () => {
      if (table !== 'audit_logs') return undefined;
      const requestId = predicates.find((entry) => entry.column === 'resource_id')?.value;
      return typeof requestId === 'string' && mocks.auditedRequestIds.has(requestId)
        ? { id: `aud_${requestId}` }
        : undefined;
    }),
  };
  return query;
}

vi.mock('../activities/activity-clients.js', () => ({
  closeActivityClients: vi.fn(async () => undefined),
  getActivityDb: () => ({ selectFrom: (table: string) => queryFor(table) }),
  restartQueuedNotificationDeliveryWorkflow: vi.fn(),
  restartQueuedSmsDeliveryWorkflow: vi.fn(),
  startPrivacyRequestWorkflow: mocks.startPrivacyRequest,
}));

import { recoverPendingPrivacyRequestHandoffsActivity } from '../activities/hold-expiration.js';

describe('recoverPendingPrivacyRequestHandoffsActivity', () => {
  beforeEach(() => {
    mocks.privacyRows = [];
    mocks.auditedRequestIds = new Set();
    vi.clearAllMocks();
  });

  it('starts only audited pending intents through deterministic workflow clients', async () => {
    mocks.privacyRows = [
      { id: 'prv_audited', tenant_id: 'tnt_1', request_type: 'erasure' },
      { id: 'prv_unaudited', tenant_id: 'tnt_1', request_type: 'export' },
    ];
    mocks.auditedRequestIds.add('prv_audited');

    await expect(recoverPendingPrivacyRequestHandoffsActivity()).resolves.toEqual({
      ok: true,
      value: { recoveredCount: 1, skippedUnauditedCount: 0 },
    });
    expect(mocks.startPrivacyRequest).toHaveBeenCalledOnce();
    expect(mocks.startPrivacyRequest).toHaveBeenCalledWith('prv_audited');
  });

  it('fails retryably without exposing request or provider details', async () => {
    mocks.privacyRows = [{ id: 'prv_private', tenant_id: 'tnt_private', request_type: 'erasure' }];
    mocks.auditedRequestIds.add('prv_private');
    mocks.startPrivacyRequest.mockRejectedValueOnce(
      new Error('provider response contained private@example.test'),
    );

    const result = await recoverPendingPrivacyRequestHandoffsActivity();

    expect(result).toEqual({
      ok: false,
      errorCode: 'PRIVACY_HANDOFF_RECOVERY_FAILED',
      retryable: true,
      message: '1 audited privacy handoff(s) could not reach Temporal',
    });
    expect(JSON.stringify(result)).not.toContain('private@example.test');
    expect(JSON.stringify(result)).not.toContain('prv_private');
  });
});
