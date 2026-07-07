'use client';

import * as React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { TableSchema, AdminTableQuery, AdminTablePage } from '@tixkit/admin-table-core';

const LIVE_SURFACE_STALE_TIME_MS = 10_000;
const REPORT_STALE_TIME_MS = 15_000;
const DEFAULT_ADMIN_STALE_TIME_MS = 30_000;
const STATIC_METADATA_STALE_TIME_MS = 5 * 60_000;

const LIVE_QUERY_PREFIXES = new Set(['getOrder', 'listOrders', 'listAttendees']);
const REPORT_QUERY_PREFIXES = new Set([
  'getSalesReport',
  'getTaxReport',
  'getAttendanceReport',
  'getPromoReport',
  'getConversionReport',
  'getAffiliateReport',
]);
const STATIC_METADATA_QUERY_PREFIXES = new Set([
  'getEvent',
  'getResalePolicy',
  'listCheckInLists',
  'listCheckoutQuestions',
  'listEventOccurrences',
  'listMarketingIntegrations',
  'listOrganizations',
  'listProductCategories',
  'listProducts',
  'listTicketTypes',
  'listWaitlist',
]);

export function adminTableStaleTime(tableId: string): number {
  if (tableId === 'orders' || tableId === 'attendees') return LIVE_SURFACE_STALE_TIME_MS;
  if (tableId === 'events') return STATIC_METADATA_STALE_TIME_MS;
  return DEFAULT_ADMIN_STALE_TIME_MS;
}

export function adminQueryStaleTime(queryKey: readonly unknown[]): number {
  const prefix = typeof queryKey[0] === 'string' ? queryKey[0] : undefined;
  if (!prefix) return DEFAULT_ADMIN_STALE_TIME_MS;
  if (LIVE_QUERY_PREFIXES.has(prefix)) return LIVE_SURFACE_STALE_TIME_MS;
  if (REPORT_QUERY_PREFIXES.has(prefix)) return REPORT_STALE_TIME_MS;
  if (STATIC_METADATA_QUERY_PREFIXES.has(prefix)) return STATIC_METADATA_STALE_TIME_MS;
  return DEFAULT_ADMIN_STALE_TIME_MS;
}

type UseAdminTableDataOptions<TData> = {
  schema: TableSchema;
  query: AdminTableQuery;
  /** Fetcher that calls the admin API with the table query. */
  fetcher: (
    query: AdminTableQuery,
  ) => Promise<
    | { ok: true; data: AdminTablePage<TData> }
    | { ok: false; error: { code: string; message: string; status?: number } }
  >;
  enabled?: boolean;
};

export type UseAdminTableDataResult<TData> = {
  data: AdminTablePage<TData> | undefined;
  items: TData[];
  loading: boolean;
  error: { code: string; message: string; status?: number } | undefined;
  refetch: () => void;
  isFetching: boolean;
  isPlaceholderData: boolean;
};

/**
 * React Query hook for fetching admin table data.
 *
 * Query keys include the table schema ID and the serialized query state,
 * so cache invalidation works correctly when filters/sort/cursor change.
 *
 * See TBL-033 in the implementation plan.
 */
export function useAdminTableData<TData>({
  schema,
  query,
  fetcher,
  enabled = true,
}: UseAdminTableDataOptions<TData>): UseAdminTableDataResult<TData> {
  const queryKey = React.useMemo(() => [schema.id, query] as const, [schema.id, query]);

  const result = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetcher(query);
      if (!res.ok) {
        throw res.error;
      }
      return res.data;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: adminTableStaleTime(schema.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return {
    data: result.data,
    items: result.data?.items ?? [],
    loading: result.isLoading,
    error: result.error
      ? result.error instanceof Error
        ? { code: 'fetch_error', message: result.error.message }
        : (result.error as { code: string; message: string; status?: number })
      : undefined,
    refetch: () => result.refetch(),
    isFetching: result.isFetching,
    isPlaceholderData: result.isPlaceholderData,
  };
}

/**
 * Generic React Query hook for non-table admin data fetching.
 * Replaces useAdminData for detail views and other non-table screens.
 */
export function useAdminQuery<TData>(
  queryKey: unknown[],
  fetcher: () => Promise<
    | { ok: true; data: TData }
    | { ok: false; error: { code: string; message: string; status?: number } }
  >,
  options?: { enabled?: boolean; staleTime?: number },
): {
  data: TData | undefined;
  loading: boolean;
  error: { code: string; message: string; status?: number } | undefined;
  refetch: () => void;
} {
  const result = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetcher();
      if (!res.ok) {
        throw res.error;
      }
      return res.data;
    },
    enabled: options?.enabled,
    staleTime: options?.staleTime ?? adminQueryStaleTime(queryKey),
  });

  return {
    data: result.data,
    loading: result.isLoading,
    error: result.error
      ? result.error instanceof Error
        ? { code: 'fetch_error', message: result.error.message }
        : (result.error as { code: string; message: string; status?: number })
      : undefined,
    refetch: () => result.refetch(),
  };
}
