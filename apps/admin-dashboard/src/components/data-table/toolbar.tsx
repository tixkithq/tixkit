'use client';

import * as React from 'react';
import { type Table } from '@tanstack/react-table';
import { Search, SlidersHorizontal, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTableFacetedFilter } from './faceted-filter';
import { DataTableViewOptions } from './view-options';

export type DataTableFilterOption = {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
};

export type DataTableFilter = {
  columnId: string;
  title: string;
  options: DataTableFilterOption[];
};

type DataTableToolbarProps<TData> = {
  table: Table<TData>;
  searchPlaceholder?: string;
  searchKey?: string;
  filters?: DataTableFilter[];
  children?: React.ReactNode;
  /** When provided, the search input calls this callback instead of client-side filtering. */
  onServerSearch?: (value: string) => void;
  /** Controlled search value for server-side search mode. */
  serverSearchValue?: string;
  /** Shows a loading spinner in the search input during server-side search. */
  serverSearchLoading?: boolean;
};

const EMPTY_FILTERS: DataTableFilter[] = [];

export function DataTableToolbar<TData>({
  table,
  searchPlaceholder = 'Search...',
  searchKey,
  filters = EMPTY_FILTERS,
  children,
  onServerSearch,
  serverSearchValue,
  serverSearchLoading,
}: DataTableToolbarProps<TData>) {
  const isFiltered = table.getState().columnFilters.length > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        <div className="relative">
          {onServerSearch ? (
            <>
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              {serverSearchLoading && (
                <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
              <Input
                placeholder={searchPlaceholder}
                value={serverSearchValue ?? ''}
                onChange={(e) => onServerSearch(e.target.value)}
                className="h-9 w-[180px] ps-8 pe-8 lg:w-[250px]"
                aria-busy={serverSearchLoading}
              />
            </>
          ) : (
            <>
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={searchPlaceholder}
                value={
                  searchKey
                    ? (table.getColumn(searchKey)?.getFilterValue() as string)
                    : ((table.getState().globalFilter as string) ?? '')
                }
                onChange={(e) => {
                  const value = e.target.value;
                  if (searchKey) {
                    table.getColumn(searchKey)?.setFilterValue(value);
                  } else {
                    table.setGlobalFilter(value);
                  }
                }}
                className="h-9 w-[180px] ps-8 lg:w-[250px]"
              />
            </>
          )}
        </div>
        {filters.map((filter) => {
          const column = table.getColumn(filter.columnId);
          if (!column) return null;
          return (
            <DataTableFacetedFilter
              key={filter.columnId}
              column={column}
              title={filter.title}
              options={filter.options}
            />
          );
        })}
        {isFiltered && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => table.resetColumnFilters()}
          >
            Reset
            <X className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {children}
        <DataTableViewOptions table={table} />
      </div>
    </div>
  );
}

export { SlidersHorizontal };
