'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { TableSchema, AdminTableQuery, AdminTablePage } from '@tixkit/admin-table-core';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type DataTablePaginationProps = {
  schema: TableSchema;
  query: AdminTableQuery;
  onQueryChange: (updater: (prev: AdminTableQuery) => AdminTableQuery) => void;
  data: AdminTablePage<unknown> | undefined;
  loading?: boolean;
  className?: string;
};

export function DataTablePagination({
  schema,
  query,
  onQueryChange,
  data,
  loading,
  className,
}: DataTablePaginationProps) {
  const limit = query.limit ?? schema.defaultPageSize;
  const hasNext = Boolean(data?.nextCursor);
  const hasPrev = Boolean(data?.prevCursor) || Boolean(query.cursor);
  const total = data?.total;
  const filterTotal = data?.filterTotal;

  const goToNext = React.useCallback(() => {
    if (!data?.nextCursor) return;
    onQueryChange((prev) => ({
      ...prev,
      cursor: data.nextCursor,
      direction: 'next',
    }));
  }, [data?.nextCursor, onQueryChange]);

  const goToPrev = React.useCallback(() => {
    if (!data?.prevCursor) return;
    onQueryChange((prev) => ({
      ...prev,
      cursor: data.prevCursor,
      direction: 'prev',
    }));
  }, [data?.prevCursor, onQueryChange]);

  const setPageSize = React.useCallback(
    (size: number) => {
      onQueryChange((prev) => ({ ...prev, limit: size, cursor: undefined, direction: undefined }));
    },
    [onQueryChange],
  );

  const rowCount = filterTotal ?? total ?? data?.items.length ?? 0;

  return (
    <div
      className={cn(
        'flex flex-col-reverse items-center justify-between gap-4 sm:flex-row sm:gap-6',
        className,
      )}
    >
      <div className="text-sm text-muted-foreground">
        {loading ? (
          'Loading…'
        ) : total !== undefined ? (
          filterTotal !== undefined && filterTotal !== total ? (
            `${filterTotal} of ${total} rows`
          ) : (
            `${total} row${total === 1 ? '' : 's'}`
          )
        ) : (
          `${rowCount} row${rowCount === 1 ? '' : 's'}`
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 sm:gap-6 lg:gap-8">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Rows per page</p>
          <Select value={String(limit)} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger size="sm" className="h-8 w-[70px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent side="top">
              {[10, 25, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={goToPrev}
            disabled={!hasPrev || loading}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={goToNext}
            disabled={!hasNext || loading}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
