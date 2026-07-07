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
  getFilterableColumns,
  getSortableFields,
  validateSortField,
  validateFilterField,
  hasActiveFilters,
} from '@tixkit/admin-table-core';
import { ValidationError } from '@tixkit/domain';

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
  /** Explicit DB columns needed by the serializer. Defaults to schema columns. */
  selectFields?: readonly string[];
  /** Custom filter handlers for computed/virtual fields (e.g. refundState). */
  customFilters?: Record<string, (q: any, value: AdminTableFilterValue, driver: string) => any>;
  /** Custom facet handlers for computed/virtual fields (e.g. refundState, checkInStatus). */
  customFacets?: Record<string, (q: any, driver: string) => Promise<AdminTableFacet>>;
  /** When true, unknown filter/sort fields cause a 400 instead of being silently dropped. */
  strictValidation?: boolean;
};

function projectionFieldsForDataQuery(
  schema: TableSchema,
  serverFieldMap: Record<string, string>,
  sort: AdminTableSort[],
  selectFields?: readonly string[],
): string[] {
  const fields = new Set<string>();
  if (selectFields) {
    for (const field of selectFields) {
      assertSafeServerFieldName(field);
      fields.add(field);
    }
  } else {
    for (const column of schema.columns) {
      fields.add(column.serverField ?? column.id);
    }
  }

  fields.add(serverFieldMap[schema.primaryKey] ?? schema.primaryKey);
  for (const sortEntry of sort) {
    fields.add(serverFieldMap[sortEntry.field] ?? sortEntry.field);
  }

  return [...fields];
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = Array.from<TOutput>({ length: inputs.length });
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, inputs.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(inputs[index]);
      }
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeTableQuery<T>(
  db: Database,
  config: TableQueryConfig<T>,
  query: AdminTableQuery,
): Promise<AdminTablePage<T>> {
  const {
    schema,
    tableName,
    tenantId,
    scope = {},
    serialize,
    selectFields,
    customFilters,
    customFacets,
    strictValidation = false,
  } = config;
  const driver = getDriver();
  const serverFieldMap = getServerFieldMap(schema);
  const limit = Math.min(query.limit ?? schema.defaultPageSize, schema.maxPageSize);

  // Validate sort fields against schema whitelist
  const { sort, rejected: rejectedSort } = validateSort(query, schema, strictValidation);

  // Validate filter fields against schema whitelist
  const { filters, rejected: rejectedFilters } = validateFilters(query, schema, strictValidation);

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
  const applyFilters = (q: any, skipField?: string): any => {
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
  const applySorting = (q: any, sortOrder: AdminTableSort[]): any => {
    for (const s of sortOrder) {
      const serverField = serverFieldMap[s.field] ?? s.field;
      q = q.orderBy(serverField, s.direction);
    }
    // Always add primary key as tie-breaker
    const pkServer = serverFieldMap[schema.primaryKey] ?? schema.primaryKey;
    const lastSort = sortOrder[sortOrder.length - 1];
    q = q.orderBy(pkServer, lastSort?.direction ?? 'desc');
    return q;
  };

  // Apply cursor pagination
  const applyCursor = (
    q: any,
    executionSortOrder: AdminTableSort[],
    requestedSortOrder: AdminTableSort[],
  ): any => {
    if (!query.cursor) return q;
    try {
      const payload = decodeCursor(query.cursor, DEFAULT_CURSOR_VERSION);
      validateCursorSort(payload.s, requestedSortOrder);
      return applyKeysetPagination(q, payload, executionSortOrder, schema, serverFieldMap);
    } catch (e) {
      if (e instanceof CursorError) {
        throw new ValidationError(`Invalid cursor: ${e.message}`, { field: 'cursor' });
      }
      throw e;
    }
  };

  // --- Data query ---
  const effectiveSort = query.direction === 'prev' ? reverseSort(sort) : sort;
  let dataQuery = buildBaseQuery().select(
    projectionFieldsForDataQuery(schema, serverFieldMap, sort, selectFields),
  );
  dataQuery = applyFilters(dataQuery);
  dataQuery = applySorting(dataQuery, effectiveSort);
  dataQuery = applyCursor(dataQuery, effectiveSort, sort);
  dataQuery = dataQuery.limit(limit + 1);

  const rows: Selectable<any>[] = await dataQuery.execute();

  let hasMore = rows.length > limit;
  let pageRows = hasMore ? rows.slice(0, limit) : rows;

  if (query.direction === 'prev') {
    pageRows = pageRows.reverse();
    hasMore = rows.length > limit;
  }

  // --- Build cursors ---
  const nextCursor =
    pageRows.length > 0 && (query.direction === 'prev' || hasMore)
      ? buildCursorFromRow(pageRows[pageRows.length - 1], sort, schema, serverFieldMap)
      : undefined;
  const prevCursor =
    pageRows.length > 0 && query.cursor && (query.direction !== 'prev' || hasMore)
      ? buildCursorFromRow(pageRows[0], sort, schema, serverFieldMap)
      : undefined;

  // --- Count queries (SQL COUNT(*) via executeTakeFirst, not in-memory .length) ---
  const [total, filterTotal] =
    query.includeTotal === true
      ? await Promise.all([
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
        ])
      : [undefined, undefined];

  // --- Facet queries (three-pass strategy) ---
  let facets: Record<string, AdminTableFacet> | undefined;
  if (query.includeFacets) {
    facets = {};
    const customFacetFields = customFacets ? Object.keys(customFacets) : [];
    const facetTasks: Array<{ field: string; run: () => Promise<AdminTableFacet> }> = [];

    // Process custom facets first (may overlap with schema facetFields or be additional)
    for (const facetField of customFacetFields) {
      if (!customFacets?.[facetField]) continue;
      // Build facet query with all filters EXCEPT this field's own filter
      facetTasks.push({
        field: facetField,
        run: () => customFacets[facetField](applyFilters(buildBaseQuery(), facetField), driver),
      });
    }

    // Process remaining schema facet fields that don't have custom handlers
    for (const facetField of schema.facetFields) {
      if (customFacets?.[facetField]) continue; // already handled above
      const column = getColumn(schema, facetField);
      if (!column || !column.facet) continue;
      const serverField = serverFieldMap[facetField] ?? facetField;

      if (column.filterType === 'select' || column.filterType === 'boolean') {
        facetTasks.push({
          field: facetField,
          run: async () => {
            const facetRows = await applyFilters(buildBaseQuery(), facetField)
              .select([serverField, sql`count(*)`.as('total')])
              .groupBy(serverField)
              .execute();
            return {
              rows: facetRows.map((r: any) => ({
                value: r[serverField],
                total: Number(r.total),
              })),
            };
          },
        });
      } else if (column.filterType === 'number_range' || column.filterType === 'date_range') {
        facetTasks.push({
          field: facetField,
          run: async () => {
            const rangeRow = await applyFilters(buildBaseQuery(), facetField)
              .select([
                sql`min(${sql.ref(serverField)})`.as('min'),
                sql`max(${sql.ref(serverField)})`.as('max'),
              ])
              .executeTakeFirst();
            return {
              min: rangeRow?.min != null ? Number(rangeRow.min) : undefined,
              max: rangeRow?.max != null ? Number(rangeRow.max) : undefined,
            };
          },
        });
      }
    }

    const facetResults = await mapWithConcurrency(facetTasks, 3, async (task) => ({
      field: task.field,
      facet: await task.run(),
    }));
    for (const { field, facet } of facetResults) {
      facets[field] = facet;
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
      ...(rejectedFilters.length > 0 ? { rejectedFilters } : {}),
      ...(rejectedSort.length > 0 ? { rejectedSort } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateSort(
  query: AdminTableQuery,
  schema: TableSchema,
  strict?: boolean,
): { sort: AdminTableSort[]; rejected: string[] } {
  if (!query.sort || query.sort.length === 0) {
    return { sort: [schema.defaultSort], rejected: [] };
  }
  const valid: AdminTableSort[] = [];
  const rejected: string[] = [];
  for (const s of query.sort) {
    if (validateSortField(schema, s.field)) {
      valid.push(s);
    } else {
      rejected.push(s.field);
    }
  }
  if (strict && rejected.length > 0) {
    const allowed = getSortableFields(schema).join(', ') || '(none)';
    throw new ValidationError(
      `Unknown or non-sortable fields: ${rejected.join(', ')}. Allowed sort fields: ${allowed}`,
    );
  }
  return { sort: valid.length > 0 ? valid : [schema.defaultSort], rejected };
}

function validateFilters(
  query: AdminTableQuery,
  schema: TableSchema,
  strict?: boolean,
): { filters: Record<string, AdminTableFilterValue> | undefined; rejected: string[] } {
  if (!query.filters) return { filters: undefined, rejected: [] };
  const valid: Record<string, AdminTableFilterValue> = {};
  const rejected: string[] = [];
  for (const [field, value] of Object.entries(query.filters)) {
    if (validateFilterField(schema, field, value.type)) {
      valid[field] = value;
    } else {
      rejected.push(field);
    }
  }
  if (strict && rejected.length > 0) {
    const allowed =
      getFilterableColumns(schema)
        .map((c) => `${c.id}(${c.filterType})`)
        .join(', ') || '(none)';
    throw new ValidationError(
      `Unknown or type-mismatched filter fields: ${rejected.join(', ')}. Allowed filter fields: ${allowed}`,
    );
  }
  return { filters: Object.keys(valid).length > 0 ? valid : undefined, rejected };
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

function validateCursorSort(
  cursorSort: Array<{ f: string; d: 'asc' | 'desc'; v: string | number }>,
  requestedSort: AdminTableSort[],
): void {
  if (cursorSort.length !== requestedSort.length) {
    throw new CursorError('sort entries do not match requested sort');
  }

  for (let index = 0; index < requestedSort.length; index += 1) {
    const cursorEntry = cursorSort[index];
    const requestedEntry = requestedSort[index];
    if (
      !cursorEntry ||
      cursorEntry.f !== requestedEntry.field ||
      cursorEntry.d !== requestedEntry.direction
    ) {
      throw new CursorError('sort entries do not match requested sort');
    }
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
      eb.and([eb(sortServerField, '=', cursorSortValue), eb(pkServer, tieOp, cursorId)]),
    ]),
  );
}

function reverseSort(sort: AdminTableSort[]): AdminTableSort[] {
  return sort.map((s) => ({
    ...s,
    direction: s.direction === 'asc' ? 'desc' : 'asc',
  }));
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

function assertSafeServerFieldName(serverField: string): void {
  // Validate that serverField only contains safe identifier characters
  if (!/^[a-z_][a-z0-9_]*$/i.test(serverField)) {
    throw new Error(`Invalid server field name: ${serverField}`);
  }
}

/**
 * Assert that a field name is in the server schema whitelist.
 * This prevents client-provided field names from becoming SQL identifiers.
 */
export function assertServerField(schema: TableSchema, field: string): string {
  const column = getColumn(schema, field);
  if (!column) {
    throw new Error(`Unknown field: ${field}`);
  }
  const serverField = column.serverField ?? field;
  assertSafeServerFieldName(serverField);
  return serverField;
}

export type { ColumnSpec };
