'use client';

import { type ColumnDef } from '@tanstack/react-table';
import { Pencil } from 'lucide-react';
import { type AdminAttendeeListItem } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DataTableColumnHeader } from '@/components/data-table/column-header';
import { AttendeeStatusBadge, CheckInStatusBadge } from '@/features/events/event-status-badge';

export function getAttendeeColumns(
  onEdit?: (attendee: AdminAttendeeListItem) => void,
): ColumnDef<AdminAttendeeListItem>[] {
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
      accessorKey: 'name',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="text-sm font-medium">{row.original.name}</span>
          {row.original.email && (
            <span className="text-xs text-muted-foreground">{row.original.email}</span>
          )}
        </div>
      ),
      meta: { title: 'Name' },
    },
    {
      accessorKey: 'eventTitle',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Event" />,
      cell: ({ row }) => row.original.eventTitle,
      meta: { title: 'Event' },
    },
    {
      accessorKey: 'ticketTypeName',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Ticket Type" />,
      cell: ({ row }) => row.original.ticketTypeName,
      meta: { title: 'Ticket Type' },
    },
    {
      accessorKey: 'status',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <AttendeeStatusBadge status={row.original.status} />,
      meta: { title: 'Status' },
    },
    {
      accessorKey: 'checkInStatus',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Check-in" />,
      cell: ({ row }) => <CheckInStatusBadge status={row.original.checkInStatus} />,
      meta: { title: 'Check-in' },
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) => <DataTableColumnHeader column={column} title="Registered" />,
      cell: ({ row }) => formatDate(row.original.createdAt),
      meta: { title: 'Registered' },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      enableHiding: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => onEdit?.(row.original)}
        >
          <Pencil className="size-4" />
          <span className="sr-only">Edit attendee</span>
        </Button>
      ),
    },
  ];
}
