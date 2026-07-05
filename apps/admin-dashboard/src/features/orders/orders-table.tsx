'use client';

import * as React from 'react';
import { ShoppingCart } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/data-table/data-table';
import { type DataTableFilter } from '@/components/data-table/toolbar';
import { usePermissions } from '@/context/permission-provider';
import { useAdminData } from '@/hooks/use-admin-data';
import { useDebouncedValue } from '@/hooks/use-debounced-search';
import { getOrderColumns } from './columns';

const statusFilters: DataTableFilter = {
  columnId: 'status',
  title: 'Status',
  options: [
    { label: 'Pending', value: 'pending' },
    { label: 'Paid', value: 'paid' },
    { label: 'Failed', value: 'failed' },
    { label: 'Cancelled', value: 'cancelled' },
    { label: 'Refunded', value: 'refunded' },
    { label: 'Partially Refunded', value: 'partially_refunded' },
  ],
};

export function OrdersTable() {
  const [searchInput, setSearchInput] = React.useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const { can } = usePermissions();
  const { data, loading, error, refetch } = useAdminData(
    () => adminApi.listOrders(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : undefined),
    [debouncedSearch],
  );

  const orders = data?.items ?? [];
  const canCancelOrders = can('orders.write');
  const canRefundOrders = can('refunds.write');

  const columns = React.useMemo(
    () => getOrderColumns(() => refetch(), { canCancelOrders, canRefundOrders }),
    [canCancelOrders, canRefundOrders, refetch],
  );

  if (loading && orders.length === 0) return <OrdersTableSkeleton />;

  if (error && orders.length === 0) {
    return (
      <EmptyState
        icon={ShoppingCart}
        title="Failed to load orders"
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  return (
    <DataTable
      columns={columns}
      data={orders}
      getRowId={(row) => row.id}
      searchPlaceholder="Search orders by buyer email..."
      onServerSearch={setSearchInput}
      serverSearchValue={searchInput}
      serverSearchLoading={loading}
      filters={[statusFilters]}
      emptyState={
        <EmptyState
          icon={ShoppingCart}
          title={searchInput ? 'No matching orders' : 'No orders yet'}
          description={
            searchInput
              ? 'Try a different search term.'
              : 'Orders will appear here once attendees start buying tickets.'
          }
        />
      }
    />
  );
}

function OrdersTableSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-9 w-[250px]" />
      <div className="rounded-md border">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
