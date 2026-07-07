'use client';

import * as React from 'react';
import type { AdminTableQuery } from '@tixkit/admin-table-core';
import { hasActiveFilters } from '@tixkit/admin-table-core';

export type MemoryAdapterResult = {
  query: AdminTableQuery;
  setQuery: (query: AdminTableQuery) => void;
  updateQuery: (updater: (prev: AdminTableQuery) => AdminTableQuery) => void;
  resetFilters: () => void;
  hasActiveFilters: boolean;
};

/**
 * Memory state adapter for embedded/simple tables.
 *
 * Table query state lives in React useState, not the URL.
 * Suitable for small tables where URL sharing is not needed.
 */
export function useMemoryTableState(initialQuery?: AdminTableQuery): MemoryAdapterResult {
  const [query, setQueryState] = React.useState<AdminTableQuery>(initialQuery ?? {});

  const setQuery = React.useCallback((newQuery: AdminTableQuery) => {
    setQueryState(newQuery);
  }, []);

  const updateQuery = React.useCallback((updater: (prev: AdminTableQuery) => AdminTableQuery) => {
    setQueryState((prev) => updater(prev));
  }, []);

  const resetFilters = React.useCallback(() => {
    setQueryState((prev) => ({
      ...prev,
      filters: undefined,
      search: undefined,
      sort: undefined,
    }));
  }, []);

  return {
    query,
    setQuery,
    updateQuery,
    resetFilters,
    hasActiveFilters: hasActiveFilters(query),
  };
}
