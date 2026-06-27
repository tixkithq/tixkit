import { describe, expect, it } from 'vitest';
import { ProductCategoryRepository, ProductRepository } from '../../repositories/event.js';
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
