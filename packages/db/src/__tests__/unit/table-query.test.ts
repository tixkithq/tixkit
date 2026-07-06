import { describe, it, expect } from 'vitest';
import { col, defineTable } from '@tixkit/admin-table-core';
import { assertServerField } from '../../repositories/table-query.js';

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
      columns: [
        col.id('id'),
        col.text('inject').serverField('name; DROP').filterable(),
      ],
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
