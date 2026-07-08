'use client';

import * as React from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import type { TableSchema, AdminTableQuery } from '@tixkit/admin-table-core';
import { paramsToQuery, queryToParams, resetAdminTableCursor } from '@tixkit/admin-table-core';

export type UrlAdapterResult = {
  query: AdminTableQuery;
  rejectedParams: string[];
  updateQuery: (updater: (prev: AdminTableQuery) => AdminTableQuery) => void;
  setQuery: (query: AdminTableQuery) => void;
  resetFilters: () => void;
  hasRejectedParams: boolean;
};

/**
 * URL state adapter for server-backed data tables.
 *
 * Serializes table query state as flat URL query parameters using
 * schema-defined param names. Invalid params are ignored individually
 * with a visible reset path.
 *
 * See Decision 9 in the implementation plan.
 */
export function useUrlTableState(schema: TableSchema): UrlAdapterResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isRouterReady = pathname !== null;

  // Parse current URL params into query state
  const { query, rejected } = React.useMemo(() => {
    if (!isRouterReady) return { query: {} as AdminTableQuery, rejected: [] as string[] };
    return paramsToQuery(schema, new URLSearchParams(searchParams.toString()));
  }, [schema, searchParams, isRouterReady]);

  const updateUrl = React.useCallback(
    (newQuery: AdminTableQuery) => {
      const params = queryToParams(schema, newQuery);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, schema],
  );

  const setQuery = React.useCallback(
    (newQuery: AdminTableQuery) => {
      updateUrl(newQuery);
    },
    [updateUrl],
  );

  const updateQuery = React.useCallback(
    (updater: (prev: AdminTableQuery) => AdminTableQuery) => {
      const newQuery = updater(query);
      updateUrl(newQuery);
    },
    [query, updateUrl],
  );

  const resetFilters = React.useCallback(() => {
    const cleared: AdminTableQuery = {
      ...resetAdminTableCursor(query),
      filters: undefined,
      search: undefined,
      sort: undefined,
    };
    updateUrl(cleared);
  }, [query, updateUrl]);

  return {
    query,
    rejectedParams: rejected,
    updateQuery,
    setQuery,
    resetFilters,
    hasRejectedParams: rejected.length > 0,
  };
}
