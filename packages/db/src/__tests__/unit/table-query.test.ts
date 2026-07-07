import { describe, it, expect } from 'vitest';
import { col, defineTable, encodeCursor } from '@tixkit/admin-table-core';
import { assertServerField, executeTableQuery } from '../../repositories/table-query.js';

const testSchema = defineTable('test', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id').serverField('id'),
    col.text('buyerEmail').serverField('buyer_email').filterable(),
    col.status('status', ['paid', 'failed']).serverField('status').facet(),
    col.money('totalCents').serverField('total_cents').filterable().facet(),
    col.dateTime('createdAt').serverField('created_at').sortable().filterable().facet(),
  ],
});

describe('assertServerField', () => {
  it('returns the server field for a valid schema field', () => {
    expect(assertServerField(testSchema, 'buyerEmail')).toBe('buyer_email');
    expect(assertServerField(testSchema, 'status')).toBe('status');
    expect(assertServerField(testSchema, 'totalCents')).toBe('total_cents');
  });

  it('returns the field id as server field when no serverField is set', () => {
    const schema = defineTable('simple', {
      primaryKey: 'id',
      columns: [col.id('id'), col.text('name').filterable()],
    });
    expect(assertServerField(schema, 'name')).toBe('name');
  });

  it('throws for unknown fields (SQL injection prevention)', () => {
    expect(() => assertServerField(testSchema, 'unknown_field')).toThrow('Unknown field');
    expect(() => assertServerField(testSchema, 'tenant_id')).toThrow('Unknown field');
    expect(() => assertServerField(testSchema, '')).toThrow('Unknown field');
  });

  it('throws for fields with invalid server field names', () => {
    const badSchema = defineTable('bad', {
      primaryKey: 'id',
      columns: [
        col.id('id'),
        col.text('hack').serverField("'; DROP TABLE orders; --").filterable(),
      ],
    });
    expect(() => assertServerField(badSchema, 'hack')).toThrow('Invalid server field name');
  });

  it('rejects server field names with special characters', () => {
    const badSchema = defineTable('bad2', {
      primaryKey: 'id',
      columns: [col.id('id'), col.text('inject').serverField('name; DROP').filterable()],
    });
    expect(() => assertServerField(badSchema, 'inject')).toThrow('Invalid server field name');
  });

  it('accepts server field names with underscores and numbers', () => {
    expect(assertServerField(testSchema, 'createdAt')).toBe('created_at');
    expect(assertServerField(testSchema, 'totalCents')).toBe('total_cents');
  });
});

describe('table query schema validation', () => {
  it('validates that schema has correct structure', () => {
    expect(testSchema.id).toBe('test');
    expect(testSchema.primaryKey).toBe('id');
    expect(testSchema.defaultSort).toEqual({ field: 'createdAt', direction: 'desc' });
    expect(testSchema.maxPageSize).toBe(100);
    expect(testSchema.defaultPageSize).toBe(50);
  });

  it('schema facetFields are correctly derived', () => {
    expect(testSchema.facetFields).toEqual(['status', 'totalCents', 'createdAt']);
  });

  it('schema searchableFields are correctly derived', () => {
    expect(testSchema.searchableFields).toEqual(['buyerEmail']);
  });
});

function createRecordingDb() {
  type QueryRecord = {
    orderBy: Array<[string, string]>;
    whereExpressions: unknown[];
    selectedFields: unknown[];
    selectAllCalled: boolean;
  };
  const queries: QueryRecord[] = [];

  const makeExpressionBuilder = () => {
    const eb = ((field: string, op: string, value: unknown) => ({ field, op, value })) as {
      (field: string, op: string, value: unknown): unknown;
      or: (items: unknown[]) => unknown;
      and: (items: unknown[]) => unknown;
    };
    eb.or = (items) => ({ type: 'or', items });
    eb.and = (items) => ({ type: 'and', items });
    return eb;
  };

  const db = {
    selectFrom: () => {
      const record: QueryRecord = {
        orderBy: [],
        whereExpressions: [],
        selectedFields: [],
        selectAllCalled: false,
      };
      queries.push(record);
      const query = {
        selectAll: () => {
          record.selectAllCalled = true;
          return query;
        },
        select: (fields: unknown) => {
          record.selectedFields.push(fields);
          return query;
        },
        where: (...args: unknown[]) => {
          if (typeof args[0] === 'function') {
            record.whereExpressions.push(args[0](makeExpressionBuilder()));
          } else {
            record.whereExpressions.push(args);
          }
          return query;
        },
        orderBy: (field: string, direction: string) => {
          record.orderBy.push([field, direction]);
          return query;
        },
        limit: () => query,
        groupBy: () => query,
        execute: async () => [],
        executeTakeFirst: async () => ({ total: 0 }),
      };
      return query;
    },
  };

  return { db, queries };
}

describe('executeTableQuery cursor validation', () => {
  it('rejects malformed cursors as validation errors', async () => {
    const { db } = createRecordingDb();

    await expect(
      executeTableQuery(
        db as never,
        {
          tableName: 'orders',
          schema: testSchema,
          tenantId: 'tnt_1',
          serialize: (row) => row,
        },
        { cursor: 'bad-cursor' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: { field: 'cursor' },
    });
  });

  it('reverses sort order and cursor comparison for previous pages', async () => {
    const { db, queries } = createRecordingDb();
    const cursor = encodeCursor(
      [{ field: 'createdAt', direction: 'desc', value: '2026-01-03T00:00:00.000Z' }],
      'ord_3',
    );

    await executeTableQuery(
      db as never,
      {
        tableName: 'orders',
        schema: testSchema,
        tenantId: 'tnt_1',
        serialize: (row) => row,
      },
      { cursor, direction: 'prev', limit: 2 },
    );

    expect(queries[0]?.orderBy).toEqual([
      ['created_at', 'asc'],
      ['id', 'asc'],
    ]);
    expect(JSON.stringify(queries[0]?.whereExpressions)).toContain('">"');
  });

  it('uses a schema projection for data rows instead of selecting full records', async () => {
    const { db, queries } = createRecordingDb();

    await executeTableQuery(
      db as never,
      {
        tableName: 'orders',
        schema: testSchema,
        tenantId: 'tnt_1',
        serialize: (row) => row,
      },
      { limit: 2 },
    );

    expect(queries[0]?.selectAllCalled).toBe(false);
    expect(queries[0]?.selectedFields[0]).toEqual([
      'id',
      'buyer_email',
      'status',
      'total_cents',
      'created_at',
    ]);
  });
});
