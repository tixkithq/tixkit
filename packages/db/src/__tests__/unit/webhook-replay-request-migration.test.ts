import { describe, expect, it, vi } from 'vitest';
import { WebhookReplayRequestsMigration } from '../../migrations/0090_webhook_replay_requests.js';

function rollbackDb(existing: { id: string } | undefined) {
  const executeTakeFirst = vi.fn(async () => existing);
  const dropExecute = vi.fn(async () => undefined);
  return {
    executeTakeFirst,
    dropExecute,
    db: {
      selectFrom: vi.fn(() => ({
        select: vi.fn(() => ({
          limit: vi.fn(() => ({ executeTakeFirst })),
        })),
      })),
      schema: {
        dropTable: vi.fn(() => ({ execute: dropExecute })),
        alterTable: vi.fn(() => ({
          dropConstraint: vi.fn(() => ({ execute: vi.fn(async () => undefined) })),
        })),
      },
    },
  };
}

describe('WebhookReplayRequestsMigration rollback safety', () => {
  it('refuses to erase durable replay evidence', async () => {
    const fixture = rollbackDb({ id: 'whr_existing' });
    await expect(WebhookReplayRequestsMigration.down!(fixture.db as never)).rejects.toThrow(
      'Cannot roll back webhook replay requests while durable replay evidence exists',
    );
    expect(fixture.dropExecute).not.toHaveBeenCalled();
  });

  it('drops the table only when no durable replay evidence remains', async () => {
    const fixture = rollbackDb(undefined);
    await expect(
      WebhookReplayRequestsMigration.down!(fixture.db as never),
    ).resolves.toBeUndefined();
    expect(fixture.dropExecute).toHaveBeenCalledTimes(1);
  });
});
