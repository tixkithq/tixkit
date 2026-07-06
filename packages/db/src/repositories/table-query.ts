/* eslint-disable @typescript-eslint/no-explicit-any */
import { sql, type Selectable } from 'kysely';
import type { Database } from '../client.js';
import { getDriver } from '../client.js';
import type {
  TableSchema,
  ColumnSpec,
  AdminTableQuery,
  AdminTablePage,
  AdminTableFilterValue,
  AdminTableFacet,
  AdminTableSort,
} from '@tixkit/admin-table-core';
import {
  encodeCursor,
  decodeCursor,
  CursorError,
  DEFAULT_CURSOR_VERSION,
  getColumn,
  getServerFieldMap,
  validateSortField,
  validateFilterField,
  hasActiveFilters,
} from '@tixkit/admin-table-core';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type TableQueryConfig<T> = {
  /** Kysely table name (e.g. 'orders', 'attendees'). */
  tableName: string;
  /** Server-owned table schema defining allowed filter/sort/sheet fields. */
  schema: TableSchema;
  /** Tenant ID for scope isolation. */
  tenantId: string;
  /** Additional scope filters applied BEFORE everything else. */
  scope?: Record<string, string | string[] | undefined>;
  /** Serialize raw DB rows into the response type. */
  serialize: (row: Record<string, unknown>) => T;
  /** Custom filter handlers for computed/virtual fields (e.g. refundState). */
  customFilters?: Record<string, (q: any, value: AdminTableFilterValue, driver: string) => any>;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeTableQuery<T>(
  db: Database,
  config: TableQueryConfig<T>,
  query: AdminTableQuery,
): Promise<AdminTablePage<T>> {
  const { schema, tableName, tenantId, scope = {}, serialize, customFilters } = config;
  const driver = getDriver();
  const serverFieldMap = getServerFieldMap(schema);
  const limit = Math.min(query.limit ?? schema.defaultPageSize, schema.maxPageSize);

  // Validate sort fields against schema whitelist
  const sort = validateSort(query, schema);

  // Validate filter fields against schema whitelist
  const filters = validateFilters(query, schema);

  // Apply search to searchable fields
  const search = query.search?.trim() || undefined;

  // Build the base query builder factory (tenant scope + scope filters)
  const buildBaseQuery = () => {
    let q = (db as any).selectFrom(tableName).where('tenant_id', '=', tenantId);
    for (const [field, value] of Object.entries(scope)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        q = q.where(field, 'in', value);
      } else {
        q = q.where(field, '=', value);
      }
    }
    return q;
  };

  // Apply filters to a query builder
  const applyFilters = (
    q: any,
    skipField?: string,
  ): any => {
    if (search) {
      q = applyTextSearch(q, schema, serverFieldMap, search, driver);
    }
    if (filters) {
      for (const [field, value] of Object.entries(filters)) {
        if (field === skipField) continue;
        // Check for custom filter handler first
        if (customFilters?.[field]) {
          q = customFilters[field](q, value, driver);
        } else {
          const serverField = serverFieldMap[field] ?? field;
          q = applyFilter(q, serverField, value, driver);
        }
      }
    }
    return q;
  };

  // Apply sorting to a query builder
  const applySorting = (q: any): any => {
    for (const s of sort) {
      const serverField = serverFieldMap[s.field] ?? s.field;
      q = q.orderBy(serverField, s.direction);
    }
    // Always add primary key as tie-breaker
    const pkServer = serverFieldMap[schema.primaryKey] ?? schema.primaryKey;
    const lastSort = sort[sort.length - 1];
    q = q.orderBy(pkServer, lastSort?.direction ?? 'desc');
    return q;
  };

  // Apply cursor pagination
  const applyCursor = (q: any): any => {
    if (!query.cursor) return q;
    try {
      const payload = decodeCursor(query.cursor, DEFAULT_CURSOR_VERSION);
      return applyKeysetPagination(q, payload, sort, schema, serverFieldMap);
    } catch (e) {
      if (e instanceof CursorError) {
        throw new Error(`Invalid cursor: ${e.message}`);
      }
      throw e;
    }
  };

  // --- Data query ---
  let dataQuery = buildBaseQuery().selectAll();
  dataQuery = applyFilters(dataQuery);
  dataQuery = applySorting(dataQuery);
  dataQuery = applyCursor(dataQuery);
  dataQuery = dataQuery.limit(limit + 1);

  if (query.direction === 'prev') {
    // Reverse the sort for prev direction, then reverse results
    dataQuery = reverseSort(dataQuery, sort, schema, serverFieldMap);
  }

  const rows: Selectable<any>[] = await dataQuery.execute();

  let hasMore = rows.length > limit;
  let pageRows = hasMore ? rows.slice(0, limit) : rows;

  if (query.direction === 'prev') {
    pageRows = pageRows.reverse();
    hasMore = rows.length > limit;
  }

  // --- Build cursors ---
  const nextCursor = hasMore && query.direction !== 'prev'
    ? buildCursorFromRow(pageRows[pageRows.length - 1], sort, schema, serverFieldMap)
    : undefined;
  const prevCursor = query.cursor
    ? buildCursorFromRow(pageRows[0], sort, schema, serverFieldMap)
    : undefined;

  // --- Count queries (SQL COUNT(*) via executeTakeFirst, not in-memory .length) ---
  const [total, filterTotal] = await Promise.all([
    buildBaseQuery()
      .select((eb: any) => eb.fn.countAll().as('total'))
      .executeTakeFirst()
      .then((r: any) => Number(r?.total ?? 0)),
    hasActiveFilters({ ...query, filters })
      ? applyFilters(buildBaseQuery())
          .select((eb: any) => eb.fn.countAll().as('total'))
          .executeTakeFirst()
          .then((r: any) => Number(r?.total ?? 0))
      : Promise.resolve(undefined),
  ]);

  // --- Facet queries (three-pass strategy) ---
  let facets: Record<string, AdminTableFacet> | undefined;
  if (query.includeFacets) {
    facets = {};
    for (const facetField of schema.facetFields) {
      const column = getColumn(schema, facetField);
      if (!column || !column.facet) continue;
      const serverField = serverFieldMap[facetField] ?? facetField;

      // Build facet query with all filters EXCEPT this field's own filter
      const facetQuery = applyFilters(buildBaseQuery(), facetField);

      if (column.filterType === 'select' || column.filterType === 'boolean') {
        const facetRows = await facetQuery
          .select([serverField, sql`count(*)`.as('total')])
          .groupBy(serverField)
          .execute();
        facets[facetField] = {
          rows: facetRows.map((r: any) => ({
            value: r[serverField],
            total: Number(r.total),
          })),
        };
      } else if (column.filterType === 'number_range' || column.filterType === 'date_range') {
        const rangeRow = await facetQuery
          .select([
            sql`min(${sql.ref(serverField)})`.as('min'),
            sql`max(${sql.ref(serverField)})`.as('max'),
          ])
          .executeTakeFirst();
        facets[facetField] = {
          min: rangeRow?.min != null ? Number(rangeRow.min) : undefined,
          max: rangeRow?.max != null ? Number(rangeRow.max) : undefined,
        };
      }
    }
  }

  return {
    items: pageRows.map((row) => serialize(row as Record<string, unknown>)),
    nextCursor,
    prevCursor,
    total,
    filterTotal,
    facets,
    applied: {
      search,
      sort,
      filters: filters ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSort(query: AdminTableQuery, schema: TableSchema): AdminTableSort[] {
  if (!query.sort || query.sort.length === 0) {
    return [schema.defaultSort];
  }
  const valid: AdminTableSort[] = [];
  for (const s of query.sort) {
    if (validateSortField(schema, s.field)) {
      valid.push(s);
    }
  }
  return valid.length > 0 ? valid : [schema.defaultSort];
}

function validateFilters(
  query: AdminTableQuery,
  schema: TableSchema,
): Record<string, AdminTableFilterValue> | undefined {
  if (!query.filters) return undefined;
  const valid: Record<string, AdminTableFilterValue> = {};
  for (const [field, value] of Object.entries(query.filters)) {
    if (validateFilterField(schema, field, value.type)) {
      valid[field] = value;
    }
  }
  return Object.keys(valid).length > 0 ? valid : undefined;
}

function applyTextSearch(
  q: any,
  schema: TableSchema,
  serverFieldMap: Record<string, string>,
  search: string,
  driver: string,
): any {
  const searchFields = schema.searchableFields;
  if (searchFields.length === 0) return q;

  if (driver === 'mysql') {
    // MySQL: LOWER(column) LIKE LOWER(%value%)
    return q.where((eb: any) =>
      eb.or(
        searchFields.map((field) => {
          const serverField = serverFieldMap[field] ?? field;
          return sql`LOWER(${sql.ref(serverField)}) LIKE ${`%${search.toLowerCase()}%`}`;
        }),
      ),
    );
  }

  // Postgres: ilike
  return q.where((eb: any) =>
    eb.or(
      searchFields.map((field) => {
        const serverField = serverFieldMap[field] ?? field;
        return eb(serverField, 'ilike', `%${search}%`);
      }),
    ),
  );
}

function applyFilter(
  q: any,
  serverField: string,
  value: AdminTableFilterValue,
  _driver: string,
): any {
  switch (value.type) {
    case 'text': {
      const text = value.value.trim();
      if (!text) return q;
      if (_driver === 'mysql') {
        return q.where(sql`LOWER(${sql.ref(serverField)}) LIKE ${`%${text.toLowerCase()}%`}`);
      }
      return q.where(serverField, 'ilike', `%${text}%`);
    }
    case 'select':
      if (value.values.length === 0) return q;
      return q.where(serverField, 'in', value.values);

    case 'boolean':
      return q.where(serverField, '=', value.value);

    case 'date_range': {
      if (value.from) {
        q = q.where(serverField, '>=', new Date(value.from));
      }
      if (value.to) {
        q = q.where(serverField, '<=', new Date(value.to));
      }
      return q;
    }

    case 'number_range': {
      if (value.min !== undefined) {
        q = q.where(serverField, '>=', value.min);
      }
      if (value.max !== undefined) {
        q = q.where(serverField, '<=', value.max);
      }
      return q;
    }

    default:
      return q;
  }
}

function applyKeysetPagination(
  q: any,
  payload: { s: Array<{ f: string; d: 'asc' | 'desc'; v: string | number }>; id: string },
  sort: AdminTableSort[],
  schema: TableSchema,
  serverFieldMap: Record<string, string>,
): any {
  // For the common case of single sort field + PK tie-breaker
  const firstSort = sort[0];
  if (!firstSort) return q;

  const sortServerField = serverFieldMap[firstSort.field] ?? firstSort.field;
  const pkServer = serverFieldMap[schema.primaryKey] ?? schema.primaryKey;
  const cursorSortValue = payload.s[0]?.v;
  const cursorId = payload.id;

  if (cursorSortValue === undefined || !cursorId) return q;

  const sortOp = firstSort.direction === 'desc' ? '<' : '>';
  const tieOp = firstSort.direction === 'desc' ? '<' : '>';

  return q.where((eb: any) =>
    eb.or([
      eb(sortServerField, sortOp, cursorSortValue),
      eb.and([
        eb(sortServerField, '=', cursorSortValue),
        eb(pkServer, tieOp, cursorId),
      ]),
    ]),
  );
}

function reverseSort(
  q: any,
  sort: AdminTableSort[],
  schema: TableSchema,
  serverFieldMap: Record<string, string>,
): any {
  // Reverse sort direction for prev cursor
  for (const s of sort) {
    const serverField = serverFieldMap[s.field] ?? s.field;
    q = q.orderBy(serverField, s.direction === 'asc' ? 'desc' : 'asc');
  }
  const pkServer = serverFieldMap[schema.primaryKey] ?? schema.primaryKey;
  const lastSort = sort[sort.length - 1];
  q = q.orderBy(pkServer, lastSort?.direction === 'asc' ? 'desc' : 'asc');
  return q;
}

function buildCursorFromRow(
  row: Record<string, unknown> | undefined,
  sort: AdminTableSort[],
  schema: TableSchema,
  serverFieldMap: Record<string, string>,
): string | undefined {
  if (!row) return undefined;
  const pkServer = serverFieldMap[schema.primaryKey] ?? schema.primaryKey;
  const id = row[pkServer];
  if (typeof id !== 'string') return undefined;

  const sortEntries = sort.map((s) => {
    const serverField = serverFieldMap[s.field] ?? s.field;
    const value = row[serverField];
    return {
      field: s.field,
      direction: s.direction,
      value: value instanceof Date ? value.toISOString() : (value as string | number),
    };
  });

  return encodeCursor(sortEntries, id);
}

// ---------------------------------------------------------------------------
// SQL injection prevention: server field validation
// ---------------------------------------------------------------------------

/**
 * Assert that a field name is in the server schema whitelist.
 * This prevents client-provided field names from becoming SQL identifiers.
 */
export function assertServerField(
  schema: TableSchema,
  field: string,
): string {
  const column = getColumn(schema, field);
  if (!column) {
    throw new Error(`Unknown field: ${field}`);
  }
  const serverField = column.serverField ?? field;
  // Validate that serverField only contains safe identifier characters
  if (!/^[a-z_][a-z0-9_]*$/i.test(serverField)) {
    throw new Error(`Invalid server field name: ${serverField}`);
  }
  return serverField;
}

export type { ColumnSpec };
