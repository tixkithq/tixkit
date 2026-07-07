import { describe, it, expect } from 'vitest';
import {
  col,
  defineTable,
  queryToParams,
  queryToSearchString,
  paramsToQuery,
  searchToQuery,
} from '../src/index.js';

const schema = defineTable('orders', {
  primaryKey: 'id',
  defaultSort: { field: 'createdAt', direction: 'desc' },
  columns: [
    col.id('id'),
    col.text('buyerEmail').filterable(),
    col.status('status', ['pending', 'paid', 'failed', 'cancelled', 'refunded']).facet(),
    col.enum('salesChannel', ['online', 'box_office']).facet(),
    col.boolean('refundState').facet(),
    col.money('totalCents').sortable().filterable().facet(),
    col.dateTime('createdAt').sortable().filterable().facet(),
  ],
});

describe('queryToParams / paramsToQuery round-trip', () => {
  it('round-trips a query with select filter', () => {
    const query = {
      filters: {
        status: { type: 'select' as const, values: ['paid', 'failed'] },
      },
    };
    const params = queryToParams(schema, query);
    expect(params.get('status')).toBe('paid,failed');

    const result = paramsToQuery(schema, params);
    expect(result.query.filters?.status).toEqual({ type: 'select', values: ['paid', 'failed'] });
    expect(result.rejected).toEqual([]);
  });

  it('round-trips a query with boolean filter', () => {
    const query = {
      filters: {
        refundState: { type: 'boolean' as const, value: true },
      },
    };
    const params = queryToParams(schema, query);
    expect(params.get('refundState')).toBe('true');

    const result = paramsToQuery(schema, params);
    expect(result.query.filters?.refundState).toEqual({ type: 'boolean', value: true });
  });

  it('round-trips a query with date_range filter', () => {
    const query = {
      filters: {
        createdAt: { type: 'date_range' as const, from: '2026-01-01', to: '2026-02-01' },
      },
    };
    const params = queryToParams(schema, query);
    expect(params.get('createdAtFrom')).toBe('2026-01-01');
    expect(params.get('createdAtTo')).toBe('2026-02-01');

    const result = paramsToQuery(schema, params);
    expect(result.query.filters?.createdAt).toEqual({
      type: 'date_range',
      from: '2026-01-01',
      to: '2026-02-01',
    });
  });

  it('round-trips a query with number_range filter', () => {
    const query = {
      filters: {
        totalCents: { type: 'number_range' as const, min: 1000, max: 5000 },
      },
    };
    const params = queryToParams(schema, query);
    expect(params.get('totalCentsMin')).toBe('1000');
    expect(params.get('totalCentsMax')).toBe('5000');

    const result = paramsToQuery(schema, params);
    expect(result.query.filters?.totalCents).toEqual({
      type: 'number_range',
      min: 1000,
      max: 5000,
    });
  });

  it('round-trips a query with text filter', () => {
    const query = {
      filters: {
        buyerEmail: { type: 'text' as const, value: 'test@example.com' },
      },
    };
    const params = queryToParams(schema, query);
    expect(params.get('buyerEmail')).toBe('test@example.com');

    const result = paramsToQuery(schema, params);
    expect(result.query.filters?.buyerEmail).toEqual({
      type: 'text',
      value: 'test@example.com',
    });
  });

  it('round-trips sort', () => {
    const query = {
      sort: [{ field: 'createdAt', direction: 'desc' as const }],
    };
    const params = queryToParams(schema, query);
    expect(params.get('sort')).toBe('createdAt:desc');

    const result = paramsToQuery(schema, params);
    expect(result.query.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
  });

  it('round-trips multiple sort entries', () => {
    const query = {
      sort: [
        { field: 'createdAt', direction: 'desc' as const },
        { field: 'totalCents', direction: 'asc' as const },
      ],
    };
    const params = queryToParams(schema, query);
    expect(params.get('sort')).toBe('createdAt:desc,totalCents:asc');

    const result = paramsToQuery(schema, params);
    expect(result.query.sort).toEqual(query.sort);
  });

  it('round-trips pagination', () => {
    const query = {
      limit: 25,
      cursor: 'v1.abc',
      direction: 'next' as const,
    };
    const params = queryToParams(schema, query);
    expect(params.get('limit')).toBe('25');
    expect(params.get('cursor')).toBe('v1.abc');
    expect(params.get('direction')).toBe('next');

    const result = paramsToQuery(schema, params);
    expect(result.query.limit).toBe(25);
    expect(result.query.cursor).toBe('v1.abc');
    expect(result.query.direction).toBe('next');
  });

  it('round-trips a complex query with everything', () => {
    const query = {
      limit: 50,
      cursor: 'v1.test',
      direction: 'next' as const,
      search: 'buyer@test.com',
      sort: [{ field: 'createdAt', direction: 'desc' as const }],
      filters: {
        status: { type: 'select' as const, values: ['paid'] },
        totalCents: { type: 'number_range' as const, min: 100 },
        createdAt: { type: 'date_range' as const, from: '2026-01-01' },
      },
      includeFacets: true,
    };
    const params = queryToParams(schema, query);
    const result = paramsToQuery(schema, params);
    expect(result.rejected).toEqual([]);
    expect(result.query.limit).toBe(50);
    expect(result.query.cursor).toBe('v1.test');
    expect(result.query.direction).toBe('next');
    expect(result.query.search).toBe('buyer@test.com');
    expect(result.query.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
    expect(result.query.filters?.status).toEqual({ type: 'select', values: ['paid'] });
    expect(result.query.filters?.totalCents).toEqual({ type: 'number_range', min: 100 });
    expect(result.query.filters?.createdAt).toEqual({
      type: 'date_range',
      from: '2026-01-01',
    });
    expect(result.query.includeFacets).toBe(true);
  });
});

describe('queryToSearchString', () => {
  it('produces a valid URL search string', () => {
    const query = {
      filters: {
        status: { type: 'select' as const, values: ['paid', 'failed'] },
      },
    };
    const qs = queryToSearchString(schema, query);
    expect(qs).toBe('status=paid%2Cfailed');
  });
});

describe('searchToQuery', () => {
  it('parses a search string', () => {
    const result = searchToQuery(schema, 'status=paid,failed&sort=createdAt:desc');
    expect(result.query.filters?.status).toEqual({ type: 'select', values: ['paid', 'failed'] });
    expect(result.query.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
  });
});

describe('invalid param handling', () => {
  it('rejects invalid limit (not a number)', () => {
    const result = paramsToQuery(schema, new URLSearchParams('limit=abc'));
    expect(result.query.limit).toBeUndefined();
    expect(result.rejected).toContain('limit');
  });

  it('rejects limit exceeding max page size', () => {
    const result = paramsToQuery(schema, new URLSearchParams('limit=999'));
    expect(result.query.limit).toBeUndefined();
    expect(result.rejected).toContain('limit');
  });

  it('rejects invalid direction', () => {
    const result = paramsToQuery(schema, new URLSearchParams('direction=sideways'));
    expect(result.query.direction).toBeUndefined();
    expect(result.rejected).toContain('direction');
  });

  it('rejects invalid sort field', () => {
    const result = paramsToQuery(schema, new URLSearchParams('sort=nonexistent:desc'));
    expect(result.query.sort).toBeUndefined();
    expect(result.rejected).toContain('sort');
  });

  it('rejects invalid sort direction', () => {
    const result = paramsToQuery(schema, new URLSearchParams('sort=createdAt:up'));
    expect(result.query.sort).toBeUndefined();
    expect(result.rejected).toContain('sort');
  });

  it('rejects mixed valid and unknown sort fields', () => {
    const result = paramsToQuery(schema, new URLSearchParams('sort=createdAt:desc,unknown:asc'));

    expect(result.query.sort).toBeUndefined();
    expect(result.rejected).toContain('sort');
  });

  it('rejects mixed valid and malformed sort directions', () => {
    const result = paramsToQuery(
      schema,
      new URLSearchParams('sort=createdAt:desc,totalCents:sideways'),
    );

    expect(result.query.sort).toBeUndefined();
    expect(result.rejected).toContain('sort');
  });

  it('rejects unknown table query params', () => {
    const result = paramsToQuery(schema, new URLSearchParams('badField=test&status=paid'));
    expect(result.rejected).toContain('badField');
    expect(result.query.filters?.status).toEqual({ type: 'select', values: ['paid'] });
  });

  it('rejects invalid select option values', () => {
    const result = paramsToQuery(schema, new URLSearchParams('status=invalid_option'));
    expect(result.query.filters?.status).toBeUndefined();
    expect(result.rejected).toContain('status');
  });

  it('rejects mixed valid and invalid select option values', () => {
    const result = paramsToQuery(schema, new URLSearchParams('status=paid,invalid_option'));
    expect(result.query.filters?.status).toBeUndefined();
    expect(result.rejected).toContain('status');
  });

  it('rejects malformed boolean filter values', () => {
    const result = paramsToQuery(schema, new URLSearchParams('refundState=yes'));
    expect(result.query.filters?.refundState).toBeUndefined();
    expect(result.rejected).toContain('refundState');
  });

  it('rejects malformed date range filter values', () => {
    const result = paramsToQuery(schema, new URLSearchParams('createdAtFrom=not-a-date'));
    expect(result.query.filters?.createdAt).toBeUndefined();
    expect(result.rejected).toContain('createdAtFrom');
  });

  it('rejects malformed number range filter values', () => {
    const result = paramsToQuery(schema, new URLSearchParams('totalCentsMin=not-a-number'));
    expect(result.query.filters?.totalCents).toBeUndefined();
    expect(result.rejected).toContain('totalCentsMin');
  });

  it('ignores one bad param without breaking others', () => {
    const result = paramsToQuery(
      schema,
      new URLSearchParams('limit=abc&status=paid&sort=createdAt:desc'),
    );
    expect(result.rejected).toContain('limit');
    expect(result.query.filters?.status).toEqual({ type: 'select', values: ['paid'] });
    expect(result.query.sort).toEqual([{ field: 'createdAt', direction: 'desc' }]);
  });

  it('handles empty params gracefully', () => {
    const result = paramsToQuery(schema, new URLSearchParams());
    expect(result.query).toEqual({});
    expect(result.rejected).toEqual([]);
  });

  it('handles partial date range (from only)', () => {
    const result = paramsToQuery(schema, new URLSearchParams('createdAtFrom=2026-01-01'));
    expect(result.query.filters?.createdAt).toEqual({
      type: 'date_range',
      from: '2026-01-01',
    });
  });

  it('handles partial number range (max only)', () => {
    const result = paramsToQuery(schema, new URLSearchParams('totalCentsMax=5000'));
    expect(result.query.filters?.totalCents).toEqual({
      type: 'number_range',
      min: undefined,
      max: 5000,
    });
  });
});

describe('backward compatibility', () => {
  it('preserves search param', () => {
    const result = paramsToQuery(schema, new URLSearchParams('search=buyer@test.com'));
    expect(result.query.search).toBe('buyer@test.com');
  });

  it('preserves eventId-style params through paramAlias', () => {
    const eventSchema = defineTable('attendees', {
      primaryKey: 'id',
      columns: [col.id('id'), col.enum('eventId', []).facet()],
    });
    const result = paramsToQuery(eventSchema, new URLSearchParams('eventId=evt_123'));
    expect(result.query.filters?.eventId).toEqual({ type: 'select', values: ['evt_123'] });
  });
});
