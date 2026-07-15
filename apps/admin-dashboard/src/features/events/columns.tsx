'use client';

import * as React from 'react';
import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Eye, Pencil, Globe, Pause, Archive } from 'lucide-react';
import { type AdminEventListItem, type EventStatus, adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { formatCurrency, formatDate, formatNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DataTableColumnHeader } from '@/components/data-table/column-header';
import { EventStatusBadge } from './event-status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { AuthenticatedEventImage } from './authenticated-event-image';

export type EventAction = {
  type: 'publish' | 'pause' | 'archive';
  eventId: string;
};

export function getEventColumns(
  onEdit?: (event: AdminEventListItem) => void,
  onAction?: (action: EventAction) => void,
  canWrite = false,
): ColumnDef<AdminEventListItem>[] {
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
      accessorKey: 'title',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Event" />,
      cell: ({ row }) => {
        const event = row.original;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <AuthenticatedEventImage
              source={event.thumbnail}
              className="size-10 rounded-md"
              fallbackClassName="size-10"
            />
            <Link
              href={routes.eventDetail(event.id)}
              prefetch={false}
              className="truncate font-medium hover:underline"
            >
              {event.title}
            </Link>
          </div>
        );
      },
      meta: { title: 'Event' },
    },
    {
      accessorKey: 'status',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <EventStatusBadge status={row.original.status} />,
      meta: { title: 'Status' },
    },
    {
      accessorKey: 'startsAt',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Start Date" />,
      cell: ({ row }) => formatDate(row.original.startsAt),
      meta: { title: 'Start Date' },
    },
    {
      accessorKey: 'venueName',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Venue" />,
      cell: ({ row }) => row.original.venueName ?? '—',
      meta: { title: 'Venue' },
    },
    {
      accessorKey: 'ticketsSold',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Tickets" />,
      cell: ({ row }) => {
        const { ticketsSold, capacity } = row.original;
        return capacity
          ? `${formatNumber(ticketsSold)} / ${formatNumber(capacity)}`
          : formatNumber(ticketsSold);
      },
      meta: { title: 'Tickets' },
    },
    {
      accessorKey: 'grossSalesCents',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Gross Sales" />,
      cell: ({ row }) => formatCurrency(row.original.grossSalesCents, row.original.currency),
      meta: { title: 'Gross Sales' },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      cell: function EventRowActions({ row }) {
        const event = row.original;
        const [confirmOpen, setConfirmOpen] = React.useState(false);
        const [pending, setPending] = React.useState(false);
        const [actionType, setActionType] = React.useState<EventAction['type']>('publish');

        const handleAction = async () => {
          setPending(true);
          let result;
          if (actionType === 'publish') result = await adminApi.publishEvent(event.id);
          else if (actionType === 'pause') result = await adminApi.pauseEvent(event.id);
          else result = await adminApi.archiveEvent(event.id);
          setPending(false);
          setConfirmOpen(false);
          if (result.ok) {
            toast.success(`Event ${actionType}d successfully`);
            onAction?.({ type: actionType, eventId: event.id });
          } else {
            toast.error(result.error.message);
          }
        };

        const statusActions = canWrite ? getAvailableStatusActions(event.status) : [];

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
                  <Link href={routes.eventDetail(event.id)} prefetch={false}>
                    <Eye className="size-4" />
                    View
                  </Link>
                </DropdownMenuItem>
                {canWrite && (
                  <>
                    <DropdownMenuItem onClick={() => onEdit?.(event)}>
                      <Pencil className="size-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {statusActions.map((action) => (
                      <DropdownMenuItem
                        key={action.type}
                        onClick={() => {
                          setActionType(action.type);
                          setConfirmOpen(true);
                        }}
                      >
                        {action.icon}
                        {action.label}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={`${actionType.charAt(0).toUpperCase() + actionType.slice(1)} event`}
              description={`Are you sure you want to ${actionType} "${event.title}"?`}
              confirmText={actionType.charAt(0).toUpperCase() + actionType.slice(1)}
              variant={actionType === 'archive' ? 'destructive' : 'default'}
              pending={pending}
              onConfirm={handleAction}
            />
          </>
        );
      },
    },
  ];
}

function getAvailableStatusActions(
  status: EventStatus,
): Array<{ type: EventAction['type']; label: string; icon: React.ReactNode }> {
  const actions: Array<{
    type: EventAction['type'];
    label: string;
    icon: React.ReactNode;
  }> = [];
  if (status === 'draft' || status === 'paused') {
    actions.push({
      type: 'publish',
      label: 'Publish',
      icon: <Globe className="size-4" />,
    });
  }
  if (status === 'published') {
    actions.push({
      type: 'pause',
      label: 'Pause',
      icon: <Pause className="size-4" />,
    });
  }
  if (status !== 'archived') {
    actions.push({
      type: 'archive',
      label: 'Archive',
      icon: <Archive className="size-4" />,
    });
  }
  return actions;
}
