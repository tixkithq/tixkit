import { afterEach, describe, expect, it } from 'vitest';
import {
  EventOccurrenceRepository,
  EventRepository,
  ProductCategoryRepository,
  ProductRepository,
} from '../../repositories/event.js';
import type { Database } from '../../client.js';

function createSelectDb() {
  const orderByCalls: Array<[string, string]> = [];
  const whereCalls: Array<[string, string, unknown]> = [];
  const query = {
    selectAll() {
      return query;
    },
    where(column: string, op: string, value: unknown) {
      whereCalls.push([column, op, value]);
      return query;
    },
    orderBy(column: string, direction: string) {
      orderByCalls.push([column, direction]);
      return query;
    },
    limit() {
      return query;
    },
    execute() {
      return Promise.resolve([]);
    },
  };

  return {
    orderByCalls,
    whereCalls,
    db: {
      selectFrom() {
        return query;
      },
    } as unknown as Database,
  };
}

describe('event product repositories', () => {
  it('uses occurrence id as the deterministic final ordering key', async () => {
    const { db, orderByCalls, whereCalls } = createSelectDb();

    await new EventOccurrenceRepository(db).findByEvent('evt_1');

    expect(orderByCalls).toEqual([
      ['starts_at', 'asc'],
      ['sort_order', 'asc'],
      ['id', 'asc'],
    ]);
    expect(whereCalls).toEqual([['event_id', '=', 'evt_1']]);
  });

  it('aligns product category pagination ordering with the id cursor contract', async () => {
    const { db, orderByCalls, whereCalls } = createSelectDb();

    await new ProductCategoryRepository(db).findByEvent('evt_1', 2, 'pcat_1');

    expect(orderByCalls).toEqual([['id', 'asc']]);
    expect(whereCalls).toEqual([
      ['event_id', '=', 'evt_1'],
      ['id', '>', 'pcat_1'],
    ]);
  });

  it('aligns product pagination ordering with the id cursor contract', async () => {
    const { db, orderByCalls, whereCalls } = createSelectDb();

    await new ProductRepository(db).findByEvent('evt_1', 2, 'prd_1');

    expect(orderByCalls).toEqual([['id', 'asc']]);
    expect(whereCalls).toEqual([
      ['event_id', '=', 'evt_1'],
      ['id', '>', 'prd_1'],
    ]);
  });
});

describe('event public revision expressions', () => {
  const previousDriver = process.env.DB_DRIVER;

  afterEach(() => {
    if (previousDriver === undefined) delete process.env.DB_DRIVER;
    else process.env.DB_DRIVER = previousDriver;
  });

  function captureUpdateExpressions() {
    const updates: Array<Record<string, unknown>> = [];
    const row = {
      id: 'evt_revision',
      title: 'Revision proof',
      version: 1,
      public_revision: new Date('2026-07-17T12:00:00.000Z'),
    };
    const update = {
      set(values: Record<string, unknown>) {
        updates.push(values);
        return update;
      },
      where() {
        return update;
      },
      execute: async () => ({ numUpdatedRows: 1n }),
      executeTakeFirst: async () => ({ numUpdatedRows: 1n }),
      returningAll() {
        return update;
      },
      executeTakeFirstOrThrow: async () => row,
    };
    const select = {
      selectAll() {
        return select;
      },
      where() {
        return select;
      },
      executeTakeFirst: async () => row,
      executeTakeFirstOrThrow: async () => row,
    };
    const db = {
      updateTable: () => update,
      selectFrom: () => select,
    } as unknown as Database;
    return { repo: new EventRepository(db), updates };
  }

  function revisionSql(values: Record<string, unknown>): string {
    const expression = values.public_revision as {
      toOperationNode(): unknown;
    };
    return JSON.stringify(expression.toOperationNode());
  }

  it.each([
    ['postgres', "interval '1 millisecond'"],
    ['mysql', 'timestampadd(second, 1, public_revision)'],
    ['mssql', 'dateadd(millisecond, 1, public_revision)'],
    ['sqlserver', 'dateadd(millisecond, 1, public_revision)'],
  ] as const)(
    'compiles every %s update path with its monotonic revision expression',
    async (driver, fragment) => {
      process.env.DB_DRIVER = driver;
      const { repo, updates } = captureUpdateExpressions();

      await repo.update('evt_revision', { title: 'Updated' });
      await repo.updateStatus('evt_revision', 'paused');
      await repo.updateIfVersion('evt_revision', 1, { title: 'Versioned' });
      await repo.publishIfVersion('evt_revision', 1);

      expect(updates).toHaveLength(4);
      for (const values of updates) {
        expect(revisionSql(values)).toContain(fragment);
        expect(values.version).toBeDefined();
      }
    },
  );
});
