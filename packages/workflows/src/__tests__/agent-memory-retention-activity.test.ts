import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sweepExpired: vi.fn(), db: {} }));

vi.mock('@tixkit/db', () => ({
  AgentMemoryRepository: class {
    constructor(db: unknown) {
      expect(db).toBe(state.db);
    }

    sweepExpired(limit: number) {
      return state.sweepExpired(limit);
    }
  },
}));

vi.mock('../activities/activity-clients.js', () => ({
  getActivityDb: () => state.db,
  closeActivityClients: vi.fn(async () => undefined),
}));

const { eraseExpiredAgentMemoryActivity } = await import('../activities/agent-memory-retention.js');

describe('eraseExpiredAgentMemoryActivity', () => {
  beforeEach(() => state.sweepExpired.mockReset());

  it('runs a bounded idempotent retention batch', async () => {
    state.sweepExpired.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    await expect(eraseExpiredAgentMemoryActivity()).resolves.toEqual({ erasedCount: 3 });
    await expect(eraseExpiredAgentMemoryActivity()).resolves.toEqual({ erasedCount: 0 });
    expect(state.sweepExpired).toHaveBeenNthCalledWith(1, 100);
    expect(state.sweepExpired).toHaveBeenNthCalledWith(2, 100);
  });

  it('throws database failures so Temporal performs an activity retry', async () => {
    state.sweepExpired.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(eraseExpiredAgentMemoryActivity()).rejects.toThrow('database unavailable');
  });
});
