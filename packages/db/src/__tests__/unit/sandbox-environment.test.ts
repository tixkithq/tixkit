import { describe, expect, it, vi } from 'vitest';
import { assertSandboxRuntimeBinding } from '../../sandbox.js';

function database(row: Record<string, unknown> | undefined) {
  const query = {
    select: vi.fn(() => query),
    where: vi.fn(() => query),
    executeTakeFirst: vi.fn().mockResolvedValue(row),
  };
  return { selectFrom: vi.fn(() => query) } as never;
}

describe('sandbox runtime binding', () => {
  it('rejects a marked sandbox database unless sandbox mode is explicit', async () => {
    const db = database({
      epoch: 'epoch_1',
      task_queue: 'tixkit-sandbox-epoch_1',
      fixture_version: 1,
      reset_at: new Date(),
    });
    await expect(
      assertSandboxRuntimeBinding(db, { runtimeMode: undefined, taskQueues: ['tixkit'] }),
    ).rejects.toThrow('requires TIXKIT_RUNTIME_MODE=sandbox');
  });

  it('allows an unmarked database in normal mode', async () => {
    await expect(
      assertSandboxRuntimeBinding(database(undefined), {
        runtimeMode: undefined,
        taskQueues: ['tixkit'],
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts only the persisted epoch and exact task queue', async () => {
    const db = database({
      epoch: 'epoch_1',
      task_queue: 'tixkit-sandbox-epoch_1',
      fixture_version: 1,
      reset_at: new Date(),
    });
    await expect(
      assertSandboxRuntimeBinding(db, {
        runtimeMode: 'sandbox',
        epoch: 'epoch_1',
        taskQueues: ['tixkit-sandbox-epoch_1'],
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSandboxRuntimeBinding(db, {
        runtimeMode: 'sandbox',
        epoch: 'stale',
        taskQueues: ['tixkit-sandbox-epoch_1'],
      }),
    ).rejects.toThrow('epoch does not match');
    await expect(
      assertSandboxRuntimeBinding(db, {
        runtimeMode: 'sandbox',
        epoch: 'epoch_1',
        taskQueues: ['tixkit'],
      }),
    ).rejects.toThrow('task queue does not match');
  });
});
