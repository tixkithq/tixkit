import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sweepExpired: vi.fn(), db: {} }));

vi.mock('@tixkit/db', () => ({
  ProviderIncidentEvidenceRepository: class {
    constructor(db: unknown) {
      expect(db).toBe(state.db);
    }

    sweepExpired(now: Date, limit: number) {
      return state.sweepExpired(now, limit);
    }
  },
}));

vi.mock('../activities/activity-clients.js', () => ({
  getActivityDb: () => state.db,
  closeActivityClients: vi.fn(async () => undefined),
}));

const { eraseExpiredProviderIncidentEvidenceActivity } =
  await import('../activities/provider-incident-retention.js');

describe('eraseExpiredProviderIncidentEvidenceActivity', () => {
  beforeEach(() => state.sweepExpired.mockReset());

  it('runs a bounded retention batch with activity-local time only', async () => {
    state.sweepExpired.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    await expect(eraseExpiredProviderIncidentEvidenceActivity()).resolves.toEqual({
      erasedCount: 3,
    });
    await expect(eraseExpiredProviderIncidentEvidenceActivity()).resolves.toEqual({
      erasedCount: 0,
    });
    expect(state.sweepExpired).toHaveBeenCalledTimes(2);
    expect(state.sweepExpired.mock.calls[0]?.[0]).toBeInstanceOf(Date);
    expect(state.sweepExpired.mock.calls[0]?.[1]).toBe(100);
  });

  it('throws database failures so Temporal retries the activity', async () => {
    state.sweepExpired.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(eraseExpiredProviderIncidentEvidenceActivity()).rejects.toThrow(
      'database unavailable',
    );
  });
});
