'use client';

import * as React from 'react';
import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Eye, Ban, RotateCcw } from 'lucide-react';
import { type AdminOrderListItem, adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { formatCurrency, formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTableColumnHeader } from '@/components/data-table/column-header';
import { OrderStatusBadge } from '@/features/events/event-status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RefundDialog } from './refund-dialog';
import { toast } from 'sonner';

export function getOrderColumns(onRefetch?: () => void): ColumnDef<AdminOrderListItem>[] {
  return [
    {
      id: 'select',
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
    {
      id: 'id',
      accessorKey: 'id',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Order" />,
      cell: ({ row }) => (
        <Link
          href={routes.orderDetail(row.original.id)}
          prefetch={false}
          className="font-mono text-sm font-medium hover:underline"
        >
          {row.original.id}
        </Link>
      ),
      meta: { title: 'Order' },
    },
    {
      accessorKey: 'eventTitle',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Event" />,
      cell: ({ row }) => row.original.eventTitle,
      meta: { title: 'Event' },
    },
    {
      accessorKey: 'buyerEmail',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Buyer" />,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="text-sm">{row.original.buyerName ?? '—'}</span>
          <span className="text-xs text-muted-foreground">{row.original.buyerEmail}</span>
        </div>
      ),
      meta: { title: 'Buyer' },
    },
    {
      accessorKey: 'status',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <OrderStatusBadge status={row.original.status} />,
      meta: { title: 'Status' },
    },
    {
      accessorKey: 'totalCents',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Total" />,
      cell: ({ row }) => formatCurrency(row.original.totalCents, row.original.currency),
      meta: { title: 'Total' },
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Date" />,
      cell: ({ row }) => formatDate(row.original.createdAt),
      meta: { title: 'Date' },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      cell: function OrderRowActions({ row }) {
        const order = row.original;
        const [cancelOpen, setCancelOpen] = React.useState(false);
        const [refundOpen, setRefundOpen] = React.useState(false);
        const [pending, setPending] = React.useState(false);

        const canCancel = order.status === 'pending' || order.status === 'paid';
        const canRefund = order.status === 'paid' || order.status === 'partially_refunded';

        const handleCancel = async () => {
          setPending(true);
          const result = await adminApi.cancelOrder(order.id);
          setPending(false);
          setCancelOpen(false);
          if (result.ok) {
            toast.success('Order cancelled successfully');
            onRefetch?.();
          } else {
            toast.error(result.error.message);
          }
        };

        return (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href={routes.orderDetail(order.id)} prefetch={false}>
                    <Eye className="size-4" />
                    View
                  </Link>
                </DropdownMenuItem>
                {canCancel && (
                  <DropdownMenuItem onClick={() => setCancelOpen(true)}>
                    <Ban className="size-4" />
                    Cancel
                  </DropdownMenuItem>
                )}
                {canRefund && (
                  <DropdownMenuItem variant="destructive" onClick={() => setRefundOpen(true)}>
                    <RotateCcw className="size-4" />
                    Refund
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              title="Cancel order"
              description={`Are you sure you want to cancel order ${order.id}? This cannot be undone.`}
              confirmText="Cancel order"
              variant="destructive"
              pending={pending}
              onConfirm={handleCancel}
            />
            {canRefund && (
              <RefundDialog
                order={order}
                open={refundOpen}
                onOpenChange={setRefundOpen}
                onSuccess={onRefetch}
              />
            )}
          </>
        );
      },
    },
  ];
}
