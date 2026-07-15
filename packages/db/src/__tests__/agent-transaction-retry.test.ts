import { describe, expect, it, vi } from 'vitest';
import {
  executeAgentTransactionWithRetry,
  isRetryableAgentTransactionConflict,
} from '../repositories/agent-transaction-retry.js';

describe('agent transaction retry policy', () => {
  it.each([
    [{ code: '40001' }, 'PostgreSQL serialization'],
    [{ cause: { code: '40P01' } }, 'PostgreSQL nested deadlock'],
    [{ code: 'ER_LOCK_DEADLOCK' }, 'MySQL symbolic deadlock'],
    [{ cause: { errno: 1213 } }, 'MySQL nested numeric deadlock'],
    [{ number: 1205 }, 'MSSQL deadlock victim'],
    [{ cause: { number: 1205 } }, 'MSSQL nested deadlock victim'],
  ])('recognizes %s as %s', (error, _database) => {
    expect(isRetryableAgentTransactionConflict(error)).toBe(true);
  });

  it.each([{ code: '23505' }, { errno: 1062 }, { number: 2627 }, new Error('network')])(
    'does not retry non-deadlock errors: %s',
    (error) => {
      expect(isRetryableAgentTransactionConflict(error)).toBe(false);
    },
  );

  it('retries the complete operation and returns the successful attempt', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { code: '40P01' });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(deadlock)
      .mockRejectedValueOnce(deadlock)
      .mockResolvedValue('committed');

    await expect(
      executeAgentTransactionWithRetry(operation, 'AGENT_TRANSACTION_RETRY_EXHAUSTED'),
    ).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('fails immediately for non-retryable errors', async () => {
    const error = Object.assign(new Error('unique violation'), { code: '23505' });
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(
      executeAgentTransactionWithRetry(operation, 'AGENT_TRANSACTION_RETRY_EXHAUSTED'),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('exposes a stable bounded exhaustion error with the last driver error as its cause', async () => {
    const deadlock = Object.assign(new Error('deadlock victim'), { number: 1205 });
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(deadlock);

    await expect(
      executeAgentTransactionWithRetry(operation, 'AGENT_TRANSACTION_RETRY_EXHAUSTED'),
    ).rejects.toMatchObject({
      message: 'AGENT_TRANSACTION_RETRY_EXHAUSTED',
      cause: deadlock,
    });
    expect(operation).toHaveBeenCalledTimes(5);
  });
});
