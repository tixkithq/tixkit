'use client';

import * as React from 'react';
import {
  type ColumnDef,
  type SortingState,
  type Table as TanstackTable,
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { TableSchema, AdminTableQuery, AdminTablePage } from '@tixkit/admin-table-core';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTableToolbar } from './data-table-toolbar';
import { DataTablePagination } from './data-table-pagination';
import { DataTableRowSheet } from './data-table-row-sheet';

type DataTableProps<TData> = {
  schema: TableSchema;
  columns: ColumnDef<TData>[];
  data: AdminTablePage<TData> | undefined;
  query: AdminTableQuery;
  onQueryChange: (updater: (prev: AdminTableQuery) => AdminTableQuery) => void;
  loading: boolean;
  error?: { message: string } | undefined;
  onRetry?: () => void;
  getRowId: (row: TData) => string;
  emptyState?: React.ReactNode;
  toolbarActions?: React.ReactNode;
  /** When provided, clicking a row opens a detail sheet. */
  renderRowSheet?: (row: TData | null) => React.ReactNode;
  showPagination?: boolean;
  showToolbar?: boolean;
  /** Extra deps that affect data fetching (e.g. organizationId). */
  totalCount?: number;
  filterTotal?: number;
};

export function DataTable<TData>({
  schema,
  columns,
  data,
  query,
  onQueryChange,
  loading,
  error,
  onRetry,
  getRowId,
  emptyState,
  toolbarActions,
  renderRowSheet,
  showPagination = true,
  showToolbar = true,
}: DataTableProps<TData>) {
  const [rowSheetOpen, setRowSheetOpen] = React.useState(false);
  const [selectedRow, setSelectedRow] = React.useState<TData | null>(null);
  const rowClickRef = React.useRef<HTMLElement | null>(null);

  const items = data?.items ?? [];
  const sortableFields = React.useMemo(
    () => new Set(schema.columns.filter((column) => column.sortable).map((column) => column.id)),
    [schema],
  );
  const sorting = React.useMemo<SortingState>(
    () =>
      (query.sort ?? [])
        .filter((sort) => sortableFields.has(sort.field))
        .map((sort) => ({ id: sort.field, desc: sort.direction === 'desc' })),
    [query.sort, sortableFields],
  );

  const table = useReactTable({
    data: items,
    columns,
    state: { sorting },
    manualSorting: true,
    onSortingChange: (updater) => {
      const nextSorting = functionalUpdate(updater, sorting).filter((sort) =>
        sortableFields.has(sort.id),
      );
      onQueryChange((prev) => ({
        ...prev,
        cursor: undefined,
        direction: undefined,
        sort:
          nextSorting.length > 0
            ? nextSorting.map((sort) => ({
                field: sort.id,
                direction: sort.desc ? 'desc' : 'asc',
              }))
            : undefined,
      }));
    },
    getRowId,
    getCoreRowModel: getCoreRowModel(),
  });

  const handleRowClick = React.useCallback(
    (row: TData, event: React.MouseEvent) => {
      if (!renderRowSheet) return;
      // Don't open sheet if clicking a link or button inside the row
      const target = event.target as HTMLElement;
      if (target.closest('a, button, [role="button"], [data-no-row-click]')) return;
      rowClickRef.current = event.currentTarget as HTMLElement;
      setSelectedRow(row);
      setRowSheetOpen(true);
    },
    [renderRowSheet],
  );

  const handleRowKeyDown = React.useCallback(
    (row: TData, event: React.KeyboardEvent) => {
      if (!renderRowSheet) return;
      if (event.key === 'Enter') {
        const target = event.target as HTMLElement;
        if (target.closest('a, button, [role="button"], [data-no-row-click]')) return;
        setSelectedRow(row);
        setRowSheetOpen(true);
      }
    },
    [renderRowSheet],
  );

  const showEmptyState = !loading && !error && items.length === 0;

  return (
    <div className="space-y-4">
      {showToolbar && (
        <DataTableToolbar
          schema={schema}
          query={query}
          onQueryChange={onQueryChange}
          facets={data?.facets}
          loading={loading}
        >
          {toolbarActions}
        </DataTableToolbar>
      )}

      {error && items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border p-8 text-center">
          <AlertCircle className="size-8 text-destructive" />
          <div>
            <p className="font-medium">Failed to load data</p>
            <p className="text-sm text-muted-foreground">{error.message}</p>
          </div>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="size-4" />
              Try again
            </Button>
          )}
        </div>
      ) : loading && items.length === 0 ? (
        <DataTableSkeleton columnCount={columns.length} />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => {
                    const headerDef = header.column.columnDef.header;
                    const hasFallback =
                      header.isPlaceholder ||
                      headerDef === null ||
                      headerDef === undefined ||
                      headerDef === '';
                    const headerContent = header.isPlaceholder
                      ? null
                      : flexRender(headerDef, header.getContext());
                    const needsFallback =
                      hasFallback ||
                      headerContent === null ||
                      headerContent === undefined ||
                      headerContent === false ||
                      headerContent === '';
                    const fallback = header.column.id === 'actions' ? 'Actions' : header.column.id;

                    return (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        aria-label={needsFallback ? fallback : undefined}
                      >
                        {needsFallback ? (
                          <span className="sr-only">{fallback}</span>
                        ) : (
                          headerContent
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {showEmptyState ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="h-24 text-center">
                    {emptyState ?? 'No results.'}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow
                    key={row.id}
                    onClick={(e) => handleRowClick(row.original, e)}
                    onKeyDown={(e) => handleRowKeyDown(row.original, e)}
                    tabIndex={renderRowSheet ? 0 : undefined}
                    className={renderRowSheet ? 'cursor-pointer' : undefined}
                    aria-label={renderRowSheet ? 'View details' : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {loading && items.length > 0 && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Updating…
        </div>
      )}

      {showPagination && !showEmptyState && (
        <DataTablePagination
          query={query}
          onQueryChange={onQueryChange}
          data={data}
          loading={loading}
          schema={schema}
        />
      )}

      {renderRowSheet && (
        <DataTableRowSheet
          open={rowSheetOpen}
          onOpenChange={setRowSheetOpen}
          focusReturnRef={rowClickRef}
        >
          {renderRowSheet(selectedRow)}
        </DataTableRowSheet>
      )}
    </div>
  );
}

function DataTableSkeleton({ columnCount }: { columnCount: number }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b p-2">
        <Skeleton className="h-9 w-[180px]" />
        <Skeleton className="h-9 w-[100px]" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center border-b last:border-0">
          {Array.from({ length: Math.min(columnCount, 6) }).map((_, j) => (
            <Skeleton key={j} className="m-2 h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export type { TanstackTable };
