import { describe, expect, it } from 'vitest';
import { DiscountCodeRepository } from '../../repositories/pricing.js';
import type { Database } from '../../client.js';

function createDiscountCodeDb() {
  const insertedRows: Record<string, unknown>[] = [];
  const whereCalls: unknown[][] = [];

  const db = {
    insertInto: (table: string) => ({
      values(values: Record<string, unknown>) {
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              if (table === 'discount_codes') insertedRows.push(values);
              return values;
            },
          }),
        };
      },
    }),
    selectFrom: (table: string) => {
      const query = {
        selectAll: () => query,
        where: (...args: unknown[]) => {
          whereCalls.push(args);
          return query;
        },
        executeTakeFirst: async () => {
          if (table !== 'discount_codes') return undefined;
          return insertedRows.find((row) =>
            whereCalls.every(([field, operator, value]) =>
              operator === '=' ? row[String(field)] === value : true,
            ),
          );
        },
      };
      return query;
    },
  };

  return { db: db as unknown as Database, insertedRows, whereCalls };
}

describe('DiscountCodeRepository', () => {
  it('normalizes discount codes on create and lookup', async () => {
    const { db, insertedRows, whereCalls } = createDiscountCodeDb();
    const repo = new DiscountCodeRepository(db);

    await repo.create({
      eventId: 'evt_1',
      code: ' save10 ',
      type: 'percentage',
      value: 1000,
      currency: 'USD',
      maxUses: 10,
    });

    expect(insertedRows[0]).toMatchObject({
      event_id: 'evt_1',
      code: 'SAVE10',
    });

    const found = await repo.findByEventAndCode('evt_1', ' Save10 ');

    expect(found).toMatchObject({ code: 'SAVE10' });
    expect(whereCalls).toContainEqual(['code', '=', 'SAVE10']);
  });
});
