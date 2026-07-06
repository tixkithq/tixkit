'use client';

import * as React from 'react';
import Link from 'next/link';
import { ShoppingCart } from 'lucide-react';
import { type AdminOrderListItem, adminApi } from '@/lib/api';
import { ordersTableSchema } from '@/lib/table-schemas';
import { EmptyState } from '@/components/empty-state';
import { DataTable, useUrlTableState } from '@/components/data-table';
import { StatusCell, MoneyCell, TimestampCell, TextCell } from '@/components/data-table/cells';
import { useAdminTableData } from '@/hooks/use-admin-table-data';
import { usePermissions } from '@/context/permission-provider';
import { useBootstrap } from '@/context/bootstrap-provider';
import { routes } from '@/lib/routes';
import { getOrderColumns } from './columns';

export function OrdersTable() {
  const { can } = usePermissions();
  const { organizationId, brandId } = useBootstrap();
  const { query, updateQuery } = useUrlTableState(ordersTableSchema);

  const { data, loading, error, refetch } = useAdminTableData<AdminOrderListItem>({
    schema: ordersTableSchema,
    query,
    fetcher: (tableQuery) =>
      adminApi.listOrders({
        ...tableQuery,
        organizationId: organizationId || undefined,
        brandId: brandId || undefined,
      }),
  });

  const canCancelOrders = can('orders.write');
  const canRefundOrders = can('refunds.write');

  const columns = React.useMemo(
    () => getOrderColumns(() => refetch(), { canCancelOrders, canRefundOrders }),
    [canCancelOrders, canRefundOrders, refetch],
  );

  return (
    <DataTable
      schema={ordersTableSchema}
      columns={columns}
      data={data}
      query={query}
      onQueryChange={updateQuery}
      loading={loading}
      error={error ? { message: error.message } : undefined}
      onRetry={() => refetch()}
      getRowId={(row) => row.id}
      emptyState={
        <EmptyState
          icon={ShoppingCart}
          title="No orders yet"
          description="Orders will appear here once attendees start buying tickets."
        />
      }
      renderRowSheet={(row) =>
        row ? <OrderRowSheetContent order={row} /> : null
      }
    />
  );
}

function OrderRowSheetContent({ order }: { order: AdminOrderListItem }) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Order {order.id}</h3>
        <Link
          href={routes.orderDetail(order.id)}
          prefetch={false}
          className="text-sm text-primary hover:underline"
        >
          View full order details →
        </Link>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Status</dt>
          <dd className="mt-1">
            <StatusCell value={order.status} domain="order" />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="mt-1">
            <MoneyCell cents={order.totalCents} currency={order.currency} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Buyer</dt>
          <dd className="mt-1">
            <TextCell value={order.buyerEmail} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Event</dt>
          <dd className="mt-1">
            <TextCell value={order.eventTitle} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Sales Channel</dt>
          <dd className="mt-1">
            <TextCell value={order.salesChannel} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Payment Provider</dt>
          <dd className="mt-1">
            <TextCell value={order.paymentProvider} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="mt-1">
            <TimestampCell value={order.createdAt} showTime />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Refunded</dt>
          <dd className="mt-1">
            {order.refundedCents > 0 ? (
              <MoneyCell cents={order.refundedCents} currency={order.currency} />
            ) : (
              <TextCell value={null} />
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

