import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errResult, okResult } from '../shared/types.js';

const mockState = vi.hoisted(() => ({
  activities: {} as Record<string, (...args: any[]) => any>,
  sleeps: [] as Array<string | number>,
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
  sleep: async (duration: string | number) => {
    mockState.sleeps.push(duration);
  },
}));

const { exportWorkflow } = await import('../workflows/export.js');

function setActivity(name: string, impl: (...args: any[]) => any) {
  mockState.activities[name] = impl;
}

function resetState() {
  for (const key of Object.keys(mockState.activities)) delete mockState.activities[key];
  mockState.sleeps = [];
}

const input = {
  version: 1,
  exportId: 'exp_1',
  type: 'attendees',
  format: 'csv',
  requestedBy: 'usr_1',
  tenantId: 'tnt_1',
};

describe('exportWorkflow terminal failure recording', () => {
  beforeEach(() => {
    resetState();
    setActivity('generateAndUploadExportActivity', async () =>
      okResult({ fileUrl: 'https://exports.example.test/exp_1.csv', rowCount: 1 }),
    );
    setActivity('notifyExportCompleteActivity', async () => okResult({ notified: true }));
    setActivity('markExportFailedActivity', async () => okResult({ failed: true }));
  });

  it('throws instead of returning failed when retryable mark-failed writes are exhausted after generation failure', async () => {
    let markAttempts = 0;
    setActivity('generateAndUploadExportActivity', async () =>
      errResult('EXPORT_FAILED', 'Database unavailable', false),
    );
    setActivity('markExportFailedActivity', async () => {
      markAttempts += 1;
      return errResult('EXPORT_FAILURE_MARK_FAILED', 'Status table unavailable', true);
    });

    await expect(exportWorkflow(input)).rejects.toThrow(
      'Export failed status could not be recorded (EXPORT_FAILURE_MARK_FAILED): Status table unavailable',
    );
    expect(markAttempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
  });

  it('throws instead of returning failed when retryable mark-failed writes are exhausted after completion persistence failure', async () => {
    let markAttempts = 0;
    setActivity('notifyExportCompleteActivity', async () =>
      errResult('EXPORT_COMPLETION_FAILED', 'Completion event unavailable', false),
    );
    setActivity('markExportFailedActivity', async () => {
      markAttempts += 1;
      return errResult('EXPORT_FAILURE_MARK_FAILED', 'Status table unavailable', true);
    });

    await expect(exportWorkflow(input)).rejects.toThrow(
      'Export failed status could not be recorded (EXPORT_FAILURE_MARK_FAILED): Status table unavailable',
    );
    expect(markAttempts).toBe(3);
    expect(mockState.sleeps).toEqual(['10 seconds', '20 seconds']);
  });
});
