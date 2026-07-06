import { describe, it, expect } from 'vitest';
import {
  col,
  defineTable,
  getColumn,
  getSortableFields,
  getFilterableColumns,
  getFacetedColumns,
  getSheetColumns,
  getServerFieldMap,
  validateSortField,
  validateFilterField,
} from '../src/index.js';

describe('col factories', () => {
  it('creates a text column with text filter type', () => {
    const c = col.text('buyerEmail').build();
    expect(c.id).toBe('buyerEmail');
    expect(c.type).toBe('text');
    expect(c.filterType).toBe('text');
  });

  it('creates a money column with number_range filter type', () => {
    const c = col.money('totalCents').build();
    expect(c.type).toBe('money');
    expect(c.filterType).toBe('number_range');
  });

  it('creates a number column with number_range filter type', () => {
    const c = col.number('quantity').build();
    expect(c.type).toBe('number');
    expect(c.filterType).toBe('number_range');
  });

  it('creates a boolean column with boolean filter type', () => {
    const c = col.boolean('refundState').build();
    expect(c.type).toBe('boolean');
    expect(c.filterType).toBe('boolean');
  });

  it('creates a status column with select filter type and presets', () => {
    const presets = ['pending', 'paid', 'failed'];
    const c = col.status('status', presets).build();
    expect(c.type).toBe('status');
    expect(c.filterType).toBe('select');
    expect(c.options).toEqual(presets);
  });

  it('creates an enum column with select filter type and options', () => {
    const options = ['online', 'box_office'];
    const c = col.enum('salesChannel', options).build();
    expect(c.type).toBe('enum');
    expect(c.filterType).toBe('select');
    expect(c.options).toEqual(options);
  });

  it('creates a dateTime column with date_range filter type', () => {
    const c = col.dateTime('createdAt').build();
    expect(c.type).toBe('dateTime');
    expect(c.filterType).toBe('date_range');
  });

  it('creates a relativeTime column with date_range filter type', () => {
    const c = col.relativeTime('checkedInAt').build();
    expect(c.type).toBe('relativeTime');
    expect(c.filterType).toBe('date_range');
  });

  it('creates an id column without a filter type', () => {
    const c = col.id('id').build();
    expect(c.type).toBe('id');
    expect(c.filterType).toBeUndefined();
  });

  it('creates an email column with text filter type', () => {
    const c = col.email('buyerEmail').build();
    expect(c.type).toBe('email');
    expect(c.filterType).toBe('text');
  });

  it('creates a url column', () => {
    const c = col.url('downloadUrl').build();
    expect(c.type).toBe('url');
  });
});

describe('chainable metadata', () => {
  it('sets label', () => {
    const c = col.text('buyerEmail').label('Buyer Email').build();
    expect(c.label).toBe('Buyer Email');
  });

  it('sets description', () => {
    const c = col.text('buyerEmail').description('The buyer email').build();
    expect(c.description).toBe('The buyer email');
  });

  it('sets sortable', () => {
    const c = col.dateTime('createdAt').sortable().build();
    expect(c.sortable).toBe(true);
  });

  it('sets filterable', () => {
    const c = col.text('buyerEmail').filterable().build();
    expect(c.filterable).toBe(true);
  });

  it('facet implies filterable', () => {
    const c = col.status('status', ['paid']).facet().build();
    expect(c.facet).toBe(true);
    expect(c.filterable).toBe(true);
  });

  it('sets sheet', () => {
    const c = col.text('buyerEmail').sheet().build();
    expect(c.sheet).toBe(true);
  });

  it('sets hiddenByDefault', () => {
    const c = col.text('buyerEmail').hiddenByDefault().build();
    expect(c.hiddenByDefault).toBe(true);
  });

  it('sets permission', () => {
    const c = col.text('buyerEmail').permission('orders.read').build();
    expect(c.permission).toBe('orders.read');
  });

  it('sets width', () => {
    const c = col.text('buyerEmail').width(200).build();
    expect(c.width).toBe(200);
  });

  it('sets align', () => {
    const c = col.money('totalCents').align('right').build();
    expect(c.align).toBe('right');
  });

  it('sets serverField', () => {
    const c = col.text('buyerEmail').serverField('buyer_email').build();
    expect(c.serverField).toBe('buyer_email');
  });

  it('sets paramAlias', () => {
    const c = col.text('buyerEmail').paramAlias('search').build();
    expect(c.paramAlias).toBe('search');
  });
});

describe('defineTable', () => {
  const ordersSchema = defineTable('orders', {
    primaryKey: 'id',
    defaultSort: { field: 'createdAt', direction: 'desc' },
    columns: [
      col.id('id'),
      col.text('buyerEmail').label('Buyer').filterable().paramAlias('search'),
      col.status('status', ['pending', 'paid', 'failed']).sortable().facet(),
      col.money('totalCents').sortable().filterable().facet().align('right'),
      col.dateTime('createdAt').sortable().filterable().facet(),
      col.enum('salesChannel', ['online', 'box_office']).facet(),
      col.boolean('refundState').facet(),
    ],
  });

  it('creates a table schema with correct id', () => {
    expect(ordersSchema.id).toBe('orders');
  });

  it('sets default page sizes', () => {
    expect(ordersSchema.maxPageSize).toBe(100);
    expect(ordersSchema.defaultPageSize).toBe(50);
  });

  it('sets default sort', () => {
    expect(ordersSchema.defaultSort).toEqual({ field: 'createdAt', direction: 'desc' });
  });

  it('derives searchableFields from text filterable columns', () => {
    expect(ordersSchema.searchableFields).toEqual(['buyerEmail']);
  });

  it('derives facetFields from faceted columns', () => {
    expect(ordersSchema.facetFields).toEqual([
      'status',
      'totalCents',
      'createdAt',
      'salesChannel',
      'refundState',
    ]);
  });

  it('allows default sort field that is not in columns (server-side sort)', () => {
    expect(() =>
      defineTable('ok', {
        primaryKey: 'id',
        defaultSort: { field: 'created_at', direction: 'desc' },
        columns: [col.id('id')],
      }),
    ).not.toThrow();
  });

  it('throws if default sort field exists but is not sortable', () => {
    expect(() =>
      defineTable('bad', {
        primaryKey: 'id',
        defaultSort: { field: 'id', direction: 'desc' },
        columns: [col.id('id')],
      }),
    ).toThrow('not sortable');
  });

  it('throws if primary key does not exist', () => {
    expect(() =>
      defineTable('bad', {
        primaryKey: 'nonexistent',
        columns: [col.id('id')],
      }),
    ).toThrow('primary key');
  });

  it('allows custom page sizes', () => {
    const schema = defineTable('custom', {
      primaryKey: 'id',
      columns: [col.id('id')],
      maxPageSize: 200,
      defaultPageSize: 25,
    });
    expect(schema.maxPageSize).toBe(200);
    expect(schema.defaultPageSize).toBe(25);
  });
});

describe('schema selectors', () => {
  const schema = defineTable('test', {
    primaryKey: 'id',
    columns: [
      col.id('id'),
      col.text('name').filterable(),
      col.status('status', ['active', 'inactive']).sortable().facet(),
      col.money('amount').sortable().filterable().facet().sheet(),
      col.dateTime('createdAt').sortable().filterable().facet().sheet(),
    ],
  });

  it('getColumn finds by id', () => {
    expect(getColumn(schema, 'status')?.type).toBe('status');
    expect(getColumn(schema, 'nonexistent')).toBeUndefined();
  });

  it('getSortableFields returns sortable column ids', () => {
    expect(getSortableFields(schema)).toEqual(['status', 'amount', 'createdAt']);
  });

  it('getFilterableColumns returns filterable columns', () => {
    const filterable = getFilterableColumns(schema);
    expect(filterable.map((c) => c.id)).toEqual(['name', 'status', 'amount', 'createdAt']);
  });

  it('getFacetedColumns returns faceted columns', () => {
    const faceted = getFacetedColumns(schema);
    expect(faceted.map((c) => c.id)).toEqual(['status', 'amount', 'createdAt']);
  });

  it('getSheetColumns returns sheet columns', () => {
    const sheet = getSheetColumns(schema);
    expect(sheet.map((c) => c.id)).toEqual(['amount', 'createdAt']);
  });

  it('getServerFieldMap maps column ids to serverField', () => {
    const schemaWithServerFields = defineTable('test2', {
      primaryKey: 'id',
      columns: [
        col.id('id').serverField('id'),
        col.text('buyerEmail').serverField('buyer_email'),
      ],
    });
    const map = getServerFieldMap(schemaWithServerFields);
    expect(map).toEqual({ id: 'id', buyerEmail: 'buyer_email' });
  });

  it('getServerFieldMap defaults to column id when no serverField', () => {
    const map = getServerFieldMap(schema);
    expect(map.name).toBe('name');
    expect(map.status).toBe('status');
  });
});

describe('validateSortField', () => {
  const schema = defineTable('test', {
    primaryKey: 'id',
    columns: [
      col.id('id'),
      col.dateTime('createdAt').sortable(),
      col.text('name'),
    ],
  });

  it('returns true for sortable fields', () => {
    expect(validateSortField(schema, 'createdAt')).toBe(true);
  });

  it('returns false for non-sortable fields', () => {
    expect(validateSortField(schema, 'name')).toBe(false);
  });

  it('returns false for unknown fields', () => {
    expect(validateSortField(schema, 'nonexistent')).toBe(false);
  });
});

describe('validateFilterField', () => {
  const schema = defineTable('test', {
    primaryKey: 'id',
    columns: [
      col.id('id'),
      col.text('name').filterable(),
      col.status('status', ['active']).facet(),
      col.money('amount').filterable(),
    ],
  });

  it('returns true when filter type matches', () => {
    expect(validateFilterField(schema, 'name', 'text')).toBe(true);
    expect(validateFilterField(schema, 'status', 'select')).toBe(true);
    expect(validateFilterField(schema, 'amount', 'number_range')).toBe(true);
  });

  it('returns false when filter type does not match', () => {
    expect(validateFilterField(schema, 'name', 'select')).toBe(false);
    expect(validateFilterField(schema, 'status', 'text')).toBe(false);
  });

  it('returns false for non-filterable fields', () => {
    expect(validateFilterField(schema, 'id', 'text')).toBe(false);
  });

  it('returns false for unknown fields', () => {
    expect(validateFilterField(schema, 'nonexistent', 'text')).toBe(false);
  });
});
