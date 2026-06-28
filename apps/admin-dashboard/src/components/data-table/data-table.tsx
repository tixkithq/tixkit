'use client';

import * as React from 'react';
import {
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
  type Table as TanstackTable,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DataTablePagination } from './pagination';
import { DataTableToolbar, type DataTableFilter } from './toolbar';

type DataTableProps<TData, TValue> = {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  searchPlaceholder?: string;
  searchKey?: string;
  filters?: DataTableFilter[];
  toolbarActions?: React.ReactNode;
  emptyState?: React.ReactNode;
  getRowId?: (row: TData) => string;
  /** When provided, the external toolbar/pagination are used instead of the built-in ones. */
  renderToolbar?: (table: TanstackTable<TData>) => React.ReactNode;
  renderPagination?: (table: TanstackTable<TData>) => React.ReactNode;
  showPagination?: boolean;
};

export function DataTable<TData, TValue>({
  columns,
  data,
  searchPlaceholder,
  searchKey,
  filters,
  toolbarActions,
  emptyState,
  getRowId,
  renderToolbar,
  renderPagination,
  showPagination = true,
}: DataTableProps<TData, TValue>) {
  const [rowSelection, setRowSelection] = React.useState({});
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({});
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnVisibility,
      rowSelection,
      columnFilters,
    },
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const showToolbar =
    renderToolbar || searchKey || (filters && filters.length > 0) || toolbarActions;

  return (
    <div className="space-y-4">
      {showToolbar &&
        (renderToolbar ? (
          renderToolbar(table)
        ) : (
          <DataTableToolbar
            table={table}
            searchPlaceholder={searchPlaceholder}
            searchKey={searchKey}
            filters={filters}
          >
            {toolbarActions}
          </DataTableToolbar>
        ))}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent">
                {headerGroup.headers.map((header) => {
                  const headerDefinition = header.column.columnDef.header;
                  const hasFallbackHeader =
                    header.isPlaceholder ||
                    headerDefinition === null ||
                    headerDefinition === undefined ||
                    headerDefinition === '';
                  const headerContent = header.isPlaceholder
                    ? null
                    : flexRender(headerDefinition, header.getContext());
                  const needsFallbackHeader =
                    hasFallbackHeader ||
                    headerContent === null ||
                    headerContent === undefined ||
                    headerContent === false ||
                    headerContent === '';
                  const fallbackHeader =
                    header.column.id === 'actions' ? 'Actions' : header.column.id;

                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-label={needsFallbackHeader ? fallbackHeader : undefined}
                    >
                      {needsFallbackHeader ? (
                        <span className="sr-only">{fallbackHeader}</span>
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {emptyState ?? 'No results.'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {showPagination &&
        (renderPagination ? renderPagination(table) : <DataTablePagination table={table} />)}
    </div>
  );
}

export type { TanstackTable };
