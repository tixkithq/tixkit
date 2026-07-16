import { describe, expect, it, vi } from 'vitest';

const mockedPostgres = vi.hoisted(() => ({ pools: [] as unknown[] }));

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  class Pool extends EventEmitter {
    constructor() {
      super();
      mockedPostgres.pools.push(this);
    }

    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { Pool };
});

import { createDb } from '../../client.js';

describe('PostgreSQL background pool error policy', () => {
  it('preserves fail-loud EventEmitter behavior unless a caller explicitly handles errors', async () => {
    const db = createDb('postgres://tixkit:tixkit@localhost:5432/tixkit');
    const pool = mockedPostgres.pools.at(-1) as NodeJS.EventEmitter;

    expect(pool.listenerCount('error')).toBe(0);
    await db.destroy();
  });

  it('delivers background errors to the explicit caller callback', async () => {
    const errors: Error[] = [];
    const db = createDb('postgres://tixkit:tixkit@localhost:5432/tixkit', {
      onPoolError(error) {
        errors.push(error);
      },
    });
    const pool = mockedPostgres.pools.at(-1) as NodeJS.EventEmitter;
    const failure = new Error('controlled idle-client disconnect');

    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', failure);
    expect(errors).toEqual([failure]);
    await db.destroy();
  });
});
