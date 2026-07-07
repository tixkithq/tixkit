/**
 * Admin table query, filter, sort, facet, and page types.
 *
 * These types form the shared contract between the API server
 * (`packages/api`) and the admin client (`apps/admin-dashboard`).
 *
 * See `docs/archive/openstatus-data-table-filters-implementation-plan.md` Decision 3
 * for the locked query envelope shape.
 */

export type SortDirection = 'asc' | 'desc';

export type AdminTableSort = {
  field: string;
  direction: SortDirection;
};

export type AdminTableFilterValue =
  | { type: 'text'; value: string }
  | { type: 'select'; values: string[] }
  | { type: 'boolean'; value: boolean }
  | { type: 'date_range'; from?: string; to?: string }
  | { type: 'number_range'; min?: number; max?: number };

export type AdminTableQuery = {
  limit?: number;
  cursor?: string;
  direction?: 'next' | 'prev';
  search?: string;
  sort?: AdminTableSort[];
  filters?: Record<string, AdminTableFilterValue>;
  includeTotal?: boolean;
  includeFacets?: boolean;
};

export type AdminTableFacetRow = {
  value: string | number | boolean;
  total: number;
};

export type AdminTableFacet = {
  rows?: AdminTableFacetRow[];
  total?: number;
  min?: number;
  max?: number;
};

export type AdminTablePage<T> = {
  items: T[];
  nextCursor?: string;
  prevCursor?: string;
  total?: number;
  filterTotal?: number;
  facets?: Record<string, AdminTableFacet>;
  applied?: {
    search?: string;
    sort: AdminTableSort[];
    filters: Record<string, AdminTableFilterValue>;
    rejectedFilters?: string[];
    rejectedSort?: string[];
  };
};

/**
 * Check whether a filter value is "empty" (no active constraint).
 */
export function isFilterEmpty(value: AdminTableFilterValue): boolean {
  switch (value.type) {
    case 'text':
      return value.value.trim().length === 0;
    case 'select':
      return value.values.length === 0;
    case 'boolean':
      return false;
    case 'date_range':
      return value.from === undefined && value.to === undefined;
    case 'number_range':
      return value.min === undefined && value.max === undefined;
  }
}

/**
 * Check whether a query has any active filters or search.
 */
export function hasActiveFilters(query: AdminTableQuery): boolean {
  if (query.search && query.search.trim().length > 0) return true;
  if (!query.filters) return false;
  return Object.values(query.filters).some((f) => !isFilterEmpty(f));
}
