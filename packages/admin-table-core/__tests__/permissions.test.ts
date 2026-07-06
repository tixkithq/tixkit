import { describe, it, expect } from 'vitest';
import {
  col,
  defineTable,
  filterSchemaByPermissions,
  getPermissionGatedFields,
  getDisallowedFields,
} from '../src/index.js';

const schema = defineTable('orders', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.text('buyerEmail').filterable(),
    col.status('status', ['paid', 'failed']).facet(),
    col.money('totalCents').permission('orders.read.finance').facet(),
    col.text('internalNote').permission('orders.read.internal'),
  ],
});

describe('filterSchemaByPermissions', () => {
  it('includes all columns when actor has all permissions', () => {
    const filtered = filterSchemaByPermissions(schema, [
      'orders.read.finance',
      'orders.read.internal',
    ]);
    expect(filtered.columns.map((c) => c.id)).toEqual([
      'id',
      'buyerEmail',
      'status',
      'totalCents',
      'internalNote',
    ]);
  });

  it('removes permission-gated columns the actor lacks', () => {
    const filtered = filterSchemaByPermissions(schema, []);
    expect(filtered.columns.map((c) => c.id)).toEqual(['id', 'buyerEmail', 'status']);
  });

  it('removes only the columns the actor lacks permission for', () => {
    const filtered = filterSchemaByPermissions(schema, ['orders.read.finance']);
    expect(filtered.columns.map((c) => c.id)).toEqual([
      'id',
      'buyerEmail',
      'status',
      'totalCents',
    ]);
    expect(filtered.columns.find((c) => c.id === 'internalNote')).toBeUndefined();
  });

  it('updates searchableFields after filtering', () => {
    const schemaWithSearch = defineTable('orders2', {
      primaryKey: 'id',
      columns: [
        col.id('id'),
        col.text('buyerEmail').filterable(),
        col.text('internalSearch').permission('internal').filterable(),
      ],
    });
    const filtered = filterSchemaByPermissions(schemaWithSearch, []);
    expect(filtered.searchableFields).toEqual(['buyerEmail']);
  });

  it('updates facetFields after filtering', () => {
    const filtered = filterSchemaByPermissions(schema, []);
    expect(filtered.facetFields).toEqual(['status']);
  });
});

describe('getPermissionGatedFields', () => {
  it('returns fields with permission requirements', () => {
    const gated = getPermissionGatedFields(schema);
    expect(gated).toEqual([
      { field: 'totalCents', permission: 'orders.read.finance' },
      { field: 'internalNote', permission: 'orders.read.internal' },
    ]);
  });

  it('returns empty array when no fields are gated', () => {
    const plainSchema = defineTable('plain', {
      primaryKey: 'id',
      columns: [col.id('id'), col.text('name')],
    });
    expect(getPermissionGatedFields(plainSchema)).toEqual([]);
  });
});

describe('getDisallowedFields', () => {
  it('returns fields the actor lacks permission for', () => {
    const disallowed = getDisallowedFields(schema, ['totalCents', 'internalNote', 'status'], []);
    expect(disallowed).toEqual(['totalCents', 'internalNote']);
  });

  it('returns empty array when actor has all permissions', () => {
    const disallowed = getDisallowedFields(
      schema,
      ['totalCents', 'internalNote'],
      ['orders.read.finance', 'orders.read.internal'],
    );
    expect(disallowed).toEqual([]);
  });

  it('returns empty array for fields without permission requirements', () => {
    const disallowed = getDisallowedFields(schema, ['id', 'buyerEmail', 'status'], []);
    expect(disallowed).toEqual([]);
  });
});
