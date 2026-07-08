'use client';

import { create } from 'zustand';
import { resetAdminTableCursor, type AdminTableQuery } from '@tixkit/admin-table-core';

type TableStateStore = {
  query: AdminTableQuery;
  setQuery: (query: AdminTableQuery) => void;
  updateQuery: (updater: (prev: AdminTableQuery) => AdminTableQuery) => void;
  resetFilters: () => void;
};

/**
 * Create a Zustand-backed table state store for persistent in-session state.
 *
 * Each table schema gets its own store instance. The store can be used
 * standalone or hydrated from URL params.
 */
export function createTableStore(initialQuery: AdminTableQuery = {}) {
  return create<TableStateStore>((set) => ({
    query: initialQuery,
    setQuery: (query) => set({ query }),
    updateQuery: (updater) => set((state) => ({ query: updater(state.query) })),
    resetFilters: () =>
      set((state) => ({
        query: {
          ...resetAdminTableCursor(state.query),
          filters: undefined,
          search: undefined,
          sort: undefined,
        },
      })),
  }));
}

export type { TableStateStore };
