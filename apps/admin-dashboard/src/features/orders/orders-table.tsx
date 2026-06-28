'use client';

import * as React from 'react';
import { ShoppingCart } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { DataTable } from '@/components/data-table/data-table';
import { type DataTableFilter } from '@/components/data-table/toolbar';
import { useAdminData } from '@/hooks/use-admin-data';
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
  const { data, loading, error, refetch } = useAdminData(() => adminApi.listOrders());

  const orders = data?.items ?? [];

  const columns = React.useMemo(() => getOrderColumns(() => refetch()), [refetch]);

  if (loading) return <OrdersTableSkeleton />;

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
      searchPlaceholder="Search orders..."
      searchKey="buyerEmail"
      filters={[statusFilters]}
      emptyState={
        <EmptyState
          icon={ShoppingCart}
          title="No orders yet"
          description="Orders will appear here once attendees start buying tickets."
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
