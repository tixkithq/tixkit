'use client';

import * as React from 'react';
import { Search, X, Filter } from 'lucide-react';
import type {
  TableSchema,
  AdminTableQuery,
  AdminTableFilterValue,
  AdminTableFacet,
} from '@tixkit/admin-table-core';
import { hasActiveFilters, isFilterEmpty } from '@tixkit/admin-table-core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTableFilterPopover } from './data-table-filter-popover';
import { DataTableViewOptions } from './data-table-view-options';
import { useReactTable } from '@tanstack/react-table';

type DataTableToolbarProps = {
  schema: TableSchema;
  query: AdminTableQuery;
  onQueryChange: (updater: (prev: AdminTableQuery) => AdminTableQuery) => void;
  facets?: Record<string, AdminTableFacet>;
  loading?: boolean;
  children?: React.ReactNode;
  /** Pass the TanStack table instance for view options (column visibility). */
  table?: ReturnType<typeof useReactTable>;
};

export function DataTableToolbar({
  schema,
  query,
  onQueryChange,
  facets,
  loading,
  children,
  table,
}: DataTableToolbarProps) {
  const filters = query.filters ?? {};
  const hasFilters = hasActiveFilters(query);

  const setFilter = React.useCallback(
    (field: string, value: AdminTableFilterValue | undefined) => {
      onQueryChange((prev) => {
        const prevFilters = prev.filters ?? {};
        if (!value || isFilterEmpty(value)) {
          const { [field]: _removed, ...rest } = prevFilters;
          void _removed;
          return { ...prev, filters: Object.keys(rest).length > 0 ? rest : undefined };
        }
        return { ...prev, filters: { ...prevFilters, [field]: value } };
      });
    },
    [onQueryChange],
  );

  const setSearch = React.useCallback(
    (value: string) => {
      onQueryChange((prev) => ({
        ...prev,
        search: value.trim() || undefined,
      }));
    },
    [onQueryChange],
  );

  const resetFilters = React.useCallback(() => {
    onQueryChange((prev) => ({
      ...prev,
      filters: undefined,
      search: undefined,
      sort: undefined,
    }));
  }, [onQueryChange]);

  // Find text filter columns for search input
  const searchColumn = schema.columns.find(
    (c) => c.filterable && c.filterType === 'text',
  );

  // Non-text filterable columns for popover filters
  const popoverFilters = schema.columns.filter(
    (c) => c.filterable && c.filterType !== 'text',
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {searchColumn && (
          <SearchInput
            placeholder={`Search by ${searchColumn.label.toLowerCase()}…`}
            value={query.search ?? ''}
            onChange={setSearch}
            loading={loading}
          />
        )}

        {popoverFilters.map((column) => (
          <DataTableFilterPopover
            key={column.id}
            schema={schema}
            column={column}
            value={filters[column.id]}
            onChange={(value) => setFilter(column.id, value)}
            facet={facets?.[column.id]}
          />
        ))}

        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-9" onClick={resetFilters}>
            Reset
            <X className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-2">
        {children}
        {table && <DataTableViewOptions table={table} />}
      </div>
    </div>
  );
}

function SearchInput({
  placeholder,
  value,
  onChange,
  loading,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
}) {
  const [localValue, setLocalValue] = React.useState(value);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onChange(newValue), 300);
  };

  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        placeholder={placeholder}
        value={localValue}
        onChange={handleChange}
        className="h-9 w-[180px] ps-8 lg:w-[250px]"
        aria-label={placeholder}
      />
      {loading && (
        <div className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      )}
    </div>
  );
}

export { Filter };
