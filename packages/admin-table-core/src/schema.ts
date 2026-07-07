/**
 * Table schema primitives for Tixkit admin tables.
 *
 * Inspired by the OpenStatus `data-table-schema` block and adapted to Tixkit's
 * conventions: server-owned field whitelists, permission gating, and
 * serializable specs.
 *
 * The `col.*` factories create column definitions with chainable metadata.
 * A `TableSchema` is built via `defineTable()` and serves as the single source
 * of truth for allowed filter/sort/sheet fields on both client and server.
 */

import type { AdminTableSort, AdminTableFilterValue, SortDirection } from './query.js';

// ---------------------------------------------------------------------------
// Column types and filter types
// ---------------------------------------------------------------------------

export type ColumnType =
  | 'text'
  | 'email'
  | 'money'
  | 'number'
  | 'boolean'
  | 'status'
  | 'enum'
  | 'dateTime'
  | 'relativeTime'
  | 'id'
  | 'url';

export type FilterType = 'text' | 'select' | 'boolean' | 'date_range' | 'number_range';

export type Align = 'left' | 'center' | 'right';

// ---------------------------------------------------------------------------
// Column specification (serializable, framework-agnostic)
// ---------------------------------------------------------------------------

export interface ColumnSpec {
  id: string;
  type: ColumnType;
  label: string;
  description?: string;
  sortable: boolean;
  filterable: boolean;
  filterType?: FilterType;
  facet: boolean;
  sheet: boolean;
  hiddenByDefault: boolean;
  permission?: string;
  width?: number;
  align?: Align;
  options?: readonly string[];
  /** Maps the column id to the server-side DB column name. */
  serverField?: string;
  /** For text filters: the URL param name to use (defaults to column id). */
  paramAlias?: string;
}

export interface TableSchema {
  id: string;
  primaryKey: string;
  defaultSort: AdminTableSort;
  columns: ColumnSpec[];
  maxPageSize: number;
  defaultPageSize: number;
  searchableFields: readonly string[];
  /** Facet fields to compute when includeFacets is true. */
  facetFields: readonly string[];
}

// ---------------------------------------------------------------------------
// Column builder (chainable)
// ---------------------------------------------------------------------------

class ColumnBuilder {
  private readonly spec: ColumnSpec;

  constructor(id: string, type: ColumnType, filterType?: FilterType) {
    this.spec = {
      id,
      type,
      label: id,
      sortable: false,
      filterable: false,
      facet: false,
      sheet: false,
      hiddenByDefault: false,
    };
    if (filterType) {
      this.spec.filterType = filterType;
    }
  }

  label(label: string): this {
    this.spec.label = label;
    return this;
  }

  description(description: string): this {
    this.spec.description = description;
    return this;
  }

  sortable(): this {
    this.spec.sortable = true;
    return this;
  }

  filterable(): this {
    this.spec.filterable = true;
    return this;
  }

  facet(): this {
    this.spec.facet = true;
    this.spec.filterable = true;
    return this;
  }

  sheet(): this {
    this.spec.sheet = true;
    return this;
  }

  hiddenByDefault(): this {
    this.spec.hiddenByDefault = true;
    return this;
  }

  permission(permission: string): this {
    this.spec.permission = permission;
    return this;
  }

  width(width: number): this {
    this.spec.width = width;
    return this;
  }

  align(align: Align): this {
    this.spec.align = align;
    return this;
  }

  options(options: readonly string[]): this {
    this.spec.options = options;
    return this;
  }

  serverField(serverField: string): this {
    this.spec.serverField = serverField;
    return this;
  }

  paramAlias(alias: string): this {
    this.spec.paramAlias = alias;
    return this;
  }

  build(): ColumnSpec {
    return { ...this.spec };
  }
}

// ---------------------------------------------------------------------------
// col.* factories
// ---------------------------------------------------------------------------

export const col = {
  /** Free-text searchable field. */
  text: (id: string): ColumnBuilder => new ColumnBuilder(id, 'text', 'text'),
  /** Email field (text search, displayed as email). */
  email: (id: string): ColumnBuilder => new ColumnBuilder(id, 'email', 'text'),
  /** Money in cents + currency. Filterable as number_range. */
  money: (id: string): ColumnBuilder => new ColumnBuilder(id, 'money', 'number_range'),
  /** Numeric field. Filterable as number_range. */
  number: (id: string): ColumnBuilder => new ColumnBuilder(id, 'number', 'number_range'),
  /** Boolean field. Filterable as boolean. */
  boolean: (id: string): ColumnBuilder => new ColumnBuilder(id, 'boolean', 'boolean'),
  /** Status field with known presets. Filterable as select. */
  status: (id: string, presets?: readonly string[]): ColumnBuilder =>
    new ColumnBuilder(id, 'status', 'select').options(presets ?? []),
  /** Enum field with fixed options. Filterable as select. */
  enum: (id: string, options: readonly string[]): ColumnBuilder =>
    new ColumnBuilder(id, 'enum', 'select').options(options),
  /** Date-time field. Filterable as date_range. */
  dateTime: (id: string): ColumnBuilder => new ColumnBuilder(id, 'dateTime', 'date_range'),
  /** Relative-time field (displayed relative to now). Filterable as date_range. */
  relativeTime: (id: string): ColumnBuilder => new ColumnBuilder(id, 'relativeTime', 'date_range'),
  /** ID field (monospace, non-filterable by default). */
  id: (id: string): ColumnBuilder => new ColumnBuilder(id, 'id'),
  /** URL field. */
  url: (id: string): ColumnBuilder => new ColumnBuilder(id, 'url'),
};

// ---------------------------------------------------------------------------
// Table schema builder
// ---------------------------------------------------------------------------

export function defineTable(
  id: string,
  config: {
    primaryKey: string;
    defaultSort?: AdminTableSort;
    columns: ColumnBuilder[];
    maxPageSize?: number;
    defaultPageSize?: number;
  },
): TableSchema {
  const columns = config.columns.map((c) => c.build());
  const defaultSort = config.defaultSort ?? {
    field: 'createdAt',
    direction: 'desc' as SortDirection,
  };

  // Validate default sort field: if it exists in columns, it must be sortable.
  // If it doesn't exist, it may be a server-side sort field (e.g. created_at).
  const sortCol = columns.find((c) => c.id === defaultSort.field);
  if (sortCol && !sortCol.sortable) {
    throw new Error(
      `defineTable("${id}"): default sort field "${defaultSort.field}" is not sortable`,
    );
  }

  // Validate primary key exists
  if (!columns.some((c) => c.id === config.primaryKey)) {
    throw new Error(`defineTable("${id}"): primary key "${config.primaryKey}" does not exist`);
  }

  const searchableFields = columns
    .filter((c) => c.filterable && c.filterType === 'text')
    .map((c) => c.id);
  const facetFields = columns.filter((c) => c.facet).map((c) => c.id);

  return {
    id,
    primaryKey: config.primaryKey,
    defaultSort,
    columns,
    maxPageSize: config.maxPageSize ?? 100,
    defaultPageSize: config.defaultPageSize ?? 50,
    searchableFields,
    facetFields,
  };
}

// ---------------------------------------------------------------------------
// Schema selectors (used by both client and server)
// ---------------------------------------------------------------------------

export function getColumn(schema: TableSchema, fieldId: string): ColumnSpec | undefined {
  return schema.columns.find((c) => c.id === fieldId);
}

export function getSortableFields(schema: TableSchema): string[] {
  return schema.columns.filter((c) => c.sortable).map((c) => c.id);
}

export function getFilterableColumns(schema: TableSchema): ColumnSpec[] {
  return schema.columns.filter((c) => c.filterable);
}

export function getFacetedColumns(schema: TableSchema): ColumnSpec[] {
  return schema.columns.filter((c) => c.facet);
}

export function getSheetColumns(schema: TableSchema): ColumnSpec[] {
  return schema.columns.filter((c) => c.sheet);
}

export function getServerFieldMap(schema: TableSchema): Record<string, string> {
  const map: Record<string, string> = {};
  for (const c of schema.columns) {
    map[c.id] = c.serverField ?? c.id;
  }
  return map;
}

/**
 * Validate that a sort field is allowed by the schema.
 */
export function validateSortField(schema: TableSchema, field: string): boolean {
  return getSortableFields(schema).includes(field);
}

/**
 * Validate that a filter field is allowed by the schema and the filter type matches.
 */
export function validateFilterField(
  schema: TableSchema,
  field: string,
  filterType: AdminTableFilterValue['type'],
): boolean {
  const column = getColumn(schema, field);
  if (!column || !column.filterable) return false;
  return column.filterType === filterType;
}
