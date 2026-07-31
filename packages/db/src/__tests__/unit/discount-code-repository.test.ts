import { describe, expect, it, vi } from 'vitest';
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

function compareDiscountReservationRow(
  row: Record<string, any>,
  field: string,
  operator: string,
  value: unknown,
) {
  const rowValue = row[field];
  if (operator === '<') return Number(rowValue) < Number(value);
  if (operator === '>') return Number(rowValue) > Number(value);
  if (operator === 'is') return value === null ? rowValue == null : rowValue === value;
  return rowValue === value;
}

function createDiscountReservationDb() {
  const tables: Record<string, Record<string, any>> = {
    discount_codes: {
      dc_1: {
        id: 'dc_1',
        event_id: 'evt_1',
        code: 'SAVE10',
        status: 'active',
        max_uses: 1,
        uses_count: 0,
        valid_from: null,
        valid_until: null,
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    },
    discount_redemptions: {},
  };
  const insertedRows: Record<string, unknown>[] = [];

  function rowsFor(table: string) {
    tables[table] ??= {};
    return tables[table];
  }

  function selectFrom(table: string) {
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const query = {
      selectAll: () => query,
      select: () => query,
      where(field: string, operator: string, value: unknown) {
        filters.push((row) => compareDiscountReservationRow(row, field, operator, value));
        return query;
      },
      forUpdate: () => query,
      async execute() {
        return Object.values(rowsFor(table)).filter((row) =>
          filters.every((filter) => filter(row)),
        );
      },
      async executeTakeFirst() {
        return (await query.execute())[0];
      },
    };
    return query;
  }

  function updateTable(table: string) {
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    let updates:
      | Record<string, unknown>
      | ((
          eb: (field: string, operator: string, value: unknown) => unknown,
        ) => Record<string, unknown>) = {};
    const query = {
      set(values: typeof updates) {
        updates = values;
        return query;
      },
      where(field: string, operator: string, value: unknown) {
        filters.push((row) => compareDiscountReservationRow(row, field, operator, value));
        return query;
      },
      async execute() {
        let updatedCount = 0;
        for (const row of Object.values(rowsFor(table))) {
          if (!filters.every((filter) => filter(row))) continue;
          const resolved =
            typeof updates === 'function'
              ? updates((field, operator, value) => {
                  if (operator === '+') return Number(row[field] ?? 0) + Number(value);
                  if (operator === '-') return Number(row[field] ?? 0) - Number(value);
                  return value;
                })
              : updates;
          Object.assign(row, resolved);
          updatedCount += 1;
        }
        return [{ numUpdatedRows: BigInt(updatedCount) }];
      },
      async executeTakeFirst() {
        return (await query.execute())[0];
      },
    };
    return query;
  }

  function insertInto(table: string) {
    let values: Record<string, any> = {};
    return {
      values(input: Record<string, any>) {
        values = input;
        return this;
      },
      async execute() {
        if (
          table === 'discount_redemptions' &&
          Object.values(rowsFor(table)).some(
            (row) => row.checkout_session_id === values.checkout_session_id,
          )
        ) {
          throw Object.assign(new Error('duplicate checkout session redemption'), {
            code: '23505',
          });
        }
        rowsFor(table)[values.id] = values;
        insertedRows.push(values);
      },
    };
  }

  function deleteFrom(table: string) {
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const query = {
      where(field: string, operator: string, value: unknown) {
        filters.push((row) => compareDiscountReservationRow(row, field, operator, value));
        return query;
      },
      async execute() {
        for (const [id, row] of Object.entries(rowsFor(table))) {
          if (filters.every((filter) => filter(row))) delete rowsFor(table)[id];
        }
      },
    };
    return query;
  }

  const transaction = vi.fn(() => ({
    execute: async <T>(fn: (trx: typeof db) => Promise<T>) => fn(db),
  }));
  const db = {
    selectFrom,
    updateTable,
    insertInto,
    deleteFrom,
    transaction,
  };

  return { db: db as unknown as Database, tables, insertedRows, transaction };
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

  it('reserves discount capacity before checkout payment', async () => {
    const { db, tables } = createDiscountReservationDb();
    const repo = new DiscountCodeRepository(db);

    const result = await repo.reserveForCheckout({
      eventId: 'evt_1',
      tenantId: 'tnt_1',
      checkoutSessionId: 'cs_1',
      code: ' save10 ',
      now: new Date('2026-01-02T00:00:00Z'),
    });

    expect(result).toEqual({ ok: true, discountCodeId: 'dc_1', existing: false });
    expect(tables.discount_codes.dc_1.uses_count).toBe(1);
    expect(Object.values(tables.discount_redemptions)).toMatchObject([
      {
        discount_code_id: 'dc_1',
        checkout_session_id: 'cs_1',
        order_id: null,
        tenant_id: 'tnt_1',
      },
    ]);
  });

  it('uses the caller transaction without opening a nested transaction', async () => {
    const { db, transaction } = createDiscountReservationDb();
    const repo = new DiscountCodeRepository(db);

    const result = await repo.reserveForCheckoutInTransaction({
      eventId: 'evt_1',
      tenantId: 'tnt_1',
      checkoutSessionId: 'cs_existing_transaction',
      code: 'SAVE10',
    });

    expect(result).toEqual({ ok: true, discountCodeId: 'dc_1', existing: false });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects exhausted discount capacity without inserting a redemption', async () => {
    const { db, tables } = createDiscountReservationDb();
    tables.discount_codes.dc_1.uses_count = 1;
    const repo = new DiscountCodeRepository(db);

    const result = await repo.reserveForCheckout({
      eventId: 'evt_1',
      tenantId: 'tnt_1',
      checkoutSessionId: 'cs_1',
      code: 'SAVE10',
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'DISCOUNT_EXHAUSTED' });
    expect(tables.discount_codes.dc_1.uses_count).toBe(1);
    expect(Object.values(tables.discount_redemptions)).toHaveLength(0);
  });

  it('releases only pending checkout discount reservations', async () => {
    const { db, tables } = createDiscountReservationDb();
    tables.discount_codes.dc_1.uses_count = 2;
    tables.discount_redemptions.dred_pending = {
      id: 'dred_pending',
      discount_code_id: 'dc_1',
      event_id: 'evt_1',
      checkout_session_id: 'cs_pending',
      order_id: null,
      tenant_id: 'tnt_1',
      created_at: new Date(),
    };
    tables.discount_redemptions.dred_attached = {
      id: 'dred_attached',
      discount_code_id: 'dc_1',
      event_id: 'evt_1',
      checkout_session_id: 'cs_attached',
      order_id: 'ord_1',
      tenant_id: 'tnt_1',
      created_at: new Date(),
    };
    const repo = new DiscountCodeRepository(db);

    await expect(repo.releasePendingCheckoutReservation('cs_pending')).resolves.toEqual({
      released: true,
    });
    await expect(repo.releasePendingCheckoutReservation('cs_attached')).resolves.toEqual({
      released: false,
    });

    expect(tables.discount_codes.dc_1.uses_count).toBe(1);
    expect(tables.discount_redemptions.dred_pending).toBeUndefined();
    expect(tables.discount_redemptions.dred_attached).toBeDefined();
  });
});
