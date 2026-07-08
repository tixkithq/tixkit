/**
 * @tixkit/admin-table-core
 *
 * Shared table schema primitives, query types, cursor utilities, facet
 * helpers, permission filtering, and URL param serialization.
 *
 * This package has no React/UI dependencies. It is shared by the API server
 * (`packages/api`) and the admin client (`apps/admin-dashboard`).
 */

// Schema factories and types
export {
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
} from './schema.js';
export type { ColumnType, FilterType, Align, ColumnSpec, TableSchema } from './schema.js';

// Query types and helpers
export { isFilterEmpty, hasActiveFilters, resetAdminTableCursor } from './query.js';
export type {
  SortDirection,
  AdminTableSort,
  AdminTableFilterValue,
  AdminTableQuery,
  AdminTableFacetRow,
  AdminTableFacet,
  AdminTablePage,
} from './query.js';

// Cursor utilities
export {
  encodeCursor,
  decodeCursor,
  base64urlEncode,
  base64urlDecode,
  CursorError,
  isCursorError,
  DEFAULT_CURSOR_VERSION,
} from './cursor.js';
export type { CursorSortEntry, CursorPayload } from './cursor.js';

// Facet helpers
export {
  computeSelectFacet,
  computeBooleanFacet,
  computeRangeFacet,
  computeDateRangeFacet,
} from './facets.js';

// Permission filtering
export {
  filterSchemaByPermissions,
  getPermissionGatedFields,
  getDisallowedFields,
} from './permissions.js';

// URL param serialization
export { queryToParams, queryToSearchString, paramsToQuery, searchToQuery } from './url-params.js';
export type { ParseResult } from './url-params.js';

// Zod validation schemas
export {
  adminTableSortSchema,
  adminTableFilterValueSchema,
  adminTableQuerySchema,
} from './validation.js';
export type { AdminTableQuerySchema } from './validation.js';
