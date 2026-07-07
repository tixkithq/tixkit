/**
 * Flat URL query parameter serialization for admin table queries.
 *
 * Each filter field maps to one or more flat query params. Multi-value select
 * filters use comma-separated values in a single param. Invalid params are
 * ignored individually with a visible reset path.
 *
 * See Decision 7 and Decision 9 in the implementation plan.
 */

import type { TableSchema, ColumnSpec } from './schema.js';
import type {
  AdminTableQuery,
  AdminTableSort,
  AdminTableFilterValue,
  SortDirection,
} from './query.js';
import { getColumn } from './schema.js';

// ---------------------------------------------------------------------------
// Serialization: AdminTableQuery -> URLSearchParams
// ---------------------------------------------------------------------------

export function queryToParams(schema: TableSchema, query: AdminTableQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.limit !== undefined) {
    params.set('limit', String(query.limit));
  }
  if (query.cursor) {
    params.set('cursor', query.cursor);
  }
  if (query.direction) {
    params.set('direction', query.direction);
  }
  if (query.search) {
    params.set('search', query.search);
  }
  if (query.sort && query.sort.length > 0) {
    params.set('sort', query.sort.map((s) => `${s.field}:${s.direction}`).join(','));
  }
  if (query.includeFacets) {
    params.set('includeFacets', 'true');
  }
  if (query.includeTotal) {
    params.set('includeTotal', 'true');
  }

  if (query.filters) {
    for (const [field, value] of Object.entries(query.filters)) {
      const column = getColumn(schema, field);
      if (!column) continue;
      const paramName = column.paramAlias ?? field;
      serializeFilterValue(params, paramName, value);
    }
  }

  return params;
}

export function queryToSearchString(schema: TableSchema, query: AdminTableQuery): string {
  return queryToParams(schema, query).toString();
}

function serializeFilterValue(
  params: URLSearchParams,
  paramName: string,
  value: AdminTableFilterValue,
): void {
  switch (value.type) {
    case 'text':
      if (value.value.trim()) {
        params.set(paramName, value.value);
      }
      break;
    case 'select':
      if (value.values.length > 0) {
        params.set(paramName, value.values.join(','));
      }
      break;
    case 'boolean':
      params.set(paramName, String(value.value));
      break;
    case 'date_range':
      if (value.from) params.set(`${paramName}From`, value.from);
      if (value.to) params.set(`${paramName}To`, value.to);
      break;
    case 'number_range':
      if (value.min !== undefined) params.set(`${paramName}Min`, String(value.min));
      if (value.max !== undefined) params.set(`${paramName}Max`, String(value.max));
      break;
  }
}

// ---------------------------------------------------------------------------
// Deserialization: URLSearchParams -> AdminTableQuery
// ---------------------------------------------------------------------------

export type ParseResult = {
  query: AdminTableQuery;
  /** Param names that were present but invalid (for visible reset path). */
  rejected: string[];
};

type FilterParseResult =
  | { status: 'absent' }
  | { status: 'invalid'; rejected: string[] }
  | { status: 'valid'; value: AdminTableFilterValue };
type SortParseResult = { status: 'invalid' } | { status: 'valid'; value: AdminTableSort[] };

export function paramsToQuery(schema: TableSchema, params: URLSearchParams): ParseResult {
  const rejected: string[] = [];
  const query: AdminTableQuery = {};
  const filters: Record<string, AdminTableFilterValue> = {};
  const allowedParams = allowedQueryParams(schema);

  for (const key of params.keys()) {
    if (!allowedParams.has(key) && !rejected.includes(key)) {
      rejected.push(key);
    }
  }

  // Pagination
  if (params.has('limit')) {
    const raw = params.get('limit')!;
    const limit = Number(raw);
    if (Number.isSafeInteger(limit) && limit > 0 && limit <= schema.maxPageSize) {
      query.limit = limit;
    } else {
      rejected.push('limit');
    }
  }
  if (params.has('cursor')) {
    query.cursor = params.get('cursor')!;
  }
  if (params.has('direction')) {
    const dir = params.get('direction');
    if (dir === 'next' || dir === 'prev') {
      query.direction = dir;
    } else {
      rejected.push('direction');
    }
  }

  // Search (backward-compatible with existing ?search=... param)
  if (params.has('search')) {
    query.search = params.get('search')!;
  }

  // Sort
  if (params.has('sort')) {
    const sortRaw = params.get('sort')!;
    const sortResult = parseSortParam(sortRaw, schema);
    if (sortResult.status === 'valid') {
      query.sort = sortResult.value;
    } else {
      rejected.push('sort');
    }
  }

  // includeFacets
  if (params.has('includeFacets')) {
    query.includeFacets = params.get('includeFacets') === 'true';
  }
  if (params.has('includeTotal')) {
    query.includeTotal = params.get('includeTotal') === 'true';
  }

  // Filters - iterate schema filterable columns to find matching params
  for (const column of schema.columns) {
    if (!column.filterable || !column.filterType) continue;
    const paramName = column.paramAlias ?? column.id;
    const filterResult = parseFilterParam(params, paramName, column);
    if (filterResult.status === 'valid') {
      filters[column.id] = filterResult.value;
    }
    if (filterResult.status === 'invalid') {
      for (const rejectedParam of filterResult.rejected) {
        if (!rejected.includes(rejectedParam)) rejected.push(rejectedParam);
      }
    }
  }

  // Also check for text filters using paramAlias that might not match a column id
  // (e.g., ?search=... maps to a text filter with paramAlias 'search')
  for (const column of schema.columns) {
    if (!column.filterable || column.filterType !== 'text') continue;
    if (column.paramAlias && params.has(column.paramAlias)) {
      const value = params.get(column.paramAlias)!;
      if (value.trim()) {
        filters[column.id] = { type: 'text', value };
      }
    }
  }

  if (Object.keys(filters).length > 0) {
    query.filters = filters;
  }

  return { query, rejected };
}

function parseSortParam(raw: string, schema: TableSchema): SortParseResult {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { status: 'invalid' };

  const result: AdminTableSort[] = [];
  for (const part of parts) {
    const colonIndex = part.lastIndexOf(':');
    if (colonIndex === -1) return { status: 'invalid' };
    const field = part.slice(0, colonIndex);
    const direction = part.slice(colonIndex + 1) as SortDirection;
    if (direction !== 'asc' && direction !== 'desc') return { status: 'invalid' };
    if (!schema.columns.some((c) => c.id === field && c.sortable)) {
      return { status: 'invalid' };
    }
    result.push({ field, direction });
  }
  return { status: 'valid', value: result };
}

function parseFilterParam(
  params: URLSearchParams,
  paramName: string,
  column: ColumnSpec,
): FilterParseResult {
  switch (column.filterType) {
    case 'text': {
      const value = params.get(paramName);
      if (value === null) return { status: 'absent' };
      if (!value.trim()) return { status: 'absent' };
      return { status: 'valid', value: { type: 'text', value } };
    }
    case 'select': {
      const value = params.get(paramName);
      if (value === null) return { status: 'absent' };
      const values = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length === 0) return { status: 'invalid', rejected: [paramName] };
      // Validate against options if defined
      if (column.options && column.options.length > 0) {
        const valid = values.filter((v) => column.options!.includes(v));
        if (valid.length !== values.length) return { status: 'invalid', rejected: [paramName] };
        return { status: 'valid', value: { type: 'select', values: valid } };
      }
      return { status: 'valid', value: { type: 'select', values } };
    }
    case 'boolean': {
      const value = params.get(paramName);
      if (value === null) return { status: 'absent' };
      if (value === 'true') return { status: 'valid', value: { type: 'boolean', value: true } };
      if (value === 'false') return { status: 'valid', value: { type: 'boolean', value: false } };
      return { status: 'invalid', rejected: [paramName] };
    }
    case 'date_range': {
      const from = params.get(`${paramName}From`) ?? undefined;
      const to = params.get(`${paramName}To`) ?? undefined;
      if (!from && !to) return { status: 'absent' };
      // Basic date validation
      const rejected = [
        from && !isValidDateString(from) ? `${paramName}From` : undefined,
        to && !isValidDateString(to) ? `${paramName}To` : undefined,
      ].filter((param): param is string => Boolean(param));
      if (rejected.length > 0) return { status: 'invalid', rejected };
      return {
        status: 'valid',
        value: { type: 'date_range', from: from || undefined, to: to || undefined },
      };
    }
    case 'number_range': {
      const minRaw = params.get(`${paramName}Min`);
      const maxRaw = params.get(`${paramName}Max`);
      if (minRaw === null && maxRaw === null) return { status: 'absent' };
      const min = minRaw !== null ? Number(minRaw) : undefined;
      const max = maxRaw !== null ? Number(maxRaw) : undefined;
      const rejected = [
        min !== undefined && !Number.isFinite(min) ? `${paramName}Min` : undefined,
        max !== undefined && !Number.isFinite(max) ? `${paramName}Max` : undefined,
      ].filter((param): param is string => Boolean(param));
      if (rejected.length > 0) return { status: 'invalid', rejected };
      return { status: 'valid', value: { type: 'number_range', min, max } };
    }
    default:
      return { status: 'absent' };
  }
}

function isValidDateString(value: string): boolean {
  // Accept ISO date or date-time
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

// ---------------------------------------------------------------------------
// Query object from a search string (convenience)
// ---------------------------------------------------------------------------

export function searchToQuery(schema: TableSchema, searchString: string): ParseResult {
  return paramsToQuery(schema, new URLSearchParams(searchString));
}

function allowedQueryParams(schema: TableSchema): Set<string> {
  const allowed = new Set([
    'limit',
    'cursor',
    'direction',
    'search',
    'sort',
    'includeFacets',
    'includeTotal',
  ]);

  for (const column of schema.columns) {
    if (!column.filterable || !column.filterType) continue;
    const paramName = column.paramAlias ?? column.id;
    switch (column.filterType) {
      case 'date_range':
        allowed.add(`${paramName}From`);
        allowed.add(`${paramName}To`);
        break;
      case 'number_range':
        allowed.add(`${paramName}Min`);
        allowed.add(`${paramName}Max`);
        break;
      default:
        allowed.add(paramName);
        break;
    }
  }

  return allowed;
}
