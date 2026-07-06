/**
 * Permission-based field filtering.
 *
 * Permission-gated fields are omitted from columns, filters, AND sheets,
 * not just hidden in the UI. This ensures the server whitelist, the client
 * schema, and the UI all agree on what fields the actor can access.
 *
 * See TBL-010 and Security Contract 3 in the implementation plan.
 */

import type { TableSchema, ColumnSpec } from './schema.js';

/**
 * Filter a table schema to only include columns the actor has permission for.
 *
 * Columns without a `.permission()` requirement are always included.
 * Columns with a `.permission('x')` requirement are included only if the
 * actor's permission set contains 'x'.
 */
export function filterSchemaByPermissions(
  schema: TableSchema,
  permissions: readonly string[],
): TableSchema {
  const permSet = new Set(permissions);
  const columns = schema.columns.filter(
    (c) => c.permission === undefined || permSet.has(c.permission),
  );
  return {
    ...schema,
    columns,
    searchableFields: columns
      .filter((c) => c.filterable && c.filterType === 'text')
      .map((c) => c.id),
    facetFields: columns.filter((c) => c.facet).map((c) => c.id),
  };
}

/**
 * Get the list of column ids that require a specific permission.
 */
export function getPermissionGatedFields(schema: TableSchema): Array<{
  field: string;
  permission: string;
}> {
  return schema.columns
    .filter((c): c is ColumnSpec & { permission: string } => c.permission !== undefined)
    .map((c) => ({ field: c.id, permission: c.permission }));
}

/**
 * Check if the actor has permission for all fields in a query.
 *
 * Returns the list of fields the actor does NOT have permission for.
 */
export function getDisallowedFields(
  schema: TableSchema,
  fields: readonly string[],
  permissions: readonly string[],
): string[] {
  const permSet = new Set(permissions);
  const disallowed: string[] = [];
  for (const field of fields) {
    const column = schema.columns.find((c) => c.id === field);
    if (column?.permission && !permSet.has(column.permission)) {
      disallowed.push(field);
    }
  }
  return disallowed;
}
