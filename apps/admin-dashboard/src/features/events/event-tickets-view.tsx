'use client'

import * as React from 'react'
import { Plus, Ticket, MoreHorizontal, Pencil } from 'lucide-react'
import { type AdminTicketType, adminApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatNumber, formatDateTime } from '@/lib/format'
import { TicketTypeStatusBadge } from './event-status-badge'
import { TicketTypeFormDrawer } from './ticket-type-form'

export function EventTicketsView({ eventId }: { eventId: string }) {
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [editingTicket, setEditingTicket] = React.useState<
    AdminTicketType | undefined
  >(undefined)
  const { data, loading, error, refetch } = useAdminData(
    () => adminApi.listTicketTypes(eventId),
    [eventId]
  )

  const ticketTypes = data ?? []

  const handleCreate = () => {
    setEditingTicket(undefined)
    setDrawerOpen(true)
  }

  const handleEdit = (ticket: AdminTicketType) => {
    setEditingTicket(ticket)
    setDrawerOpen(true)
  }

  if (loading) {
    return (
      <div className='space-y-3'>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className='h-16 w-full' />
        ))}
      </div>
    )
  }

  if (error && ticketTypes.length === 0) {
    return (
      <EmptyState
        icon={Ticket}
        title='Failed to load ticket types'
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    )
  }

  if (ticketTypes.length === 0) {
    return (
      <>
        <EmptyState
          icon={Ticket}
          title='No ticket types yet'
          description='Create a ticket type to start selling tickets for this event.'
          action={
            <Button onClick={handleCreate}>
              <Plus className='size-4' />
              Create ticket type
            </Button>
          }
        />
        <TicketTypeFormDrawer
          eventId={eventId}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          onSuccess={refetch}
          ticketType={editingTicket}
        />
      </>
    )
  }

  const totalSold = ticketTypes.reduce((s, t) => s + t.quantitySold, 0)
  const totalCapacity = ticketTypes.reduce((s, t) => s + (t.quantityTotal ?? 0), 0)

  return (
    <>
      <div className='grid gap-4 sm:grid-cols-3'>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Ticket Types</p>
            <p className='text-2xl font-bold'>{formatNumber(ticketTypes.length)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Tickets Sold</p>
            <p className='text-2xl font-bold'>{formatNumber(totalSold)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='p-4'>
            <p className='text-sm text-muted-foreground'>Total Capacity</p>
            <p className='text-2xl font-bold'>
              {totalCapacity > 0 ? formatNumber(totalCapacity) : '∞'}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className='flex justify-end'>
        <Button size='sm' onClick={handleCreate}>
          <Plus className='size-4' />
          Create ticket type
        </Button>
      </div>

      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow className='hover:bg-transparent'>
              <TableHead>Name</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sold</TableHead>
              <TableHead>Sales Window</TableHead>
              <TableHead>Access Code</TableHead>
              <TableHead className='w-[50px]' />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ticketTypes.map((tt) => (
              <TableRow key={tt.id}>
                <TableCell className='font-medium'>{tt.name}</TableCell>
                <TableCell>
                  {formatCurrency(tt.priceCents, tt.currency)}
                </TableCell>
                <TableCell>
                  <TicketTypeStatusBadge status={tt.status} />
                </TableCell>
                <TableCell>
                  {formatNumber(tt.quantitySold)}
                  {tt.quantityTotal
                    ? ` / ${formatNumber(tt.quantityTotal)}`
                    : ''}
                </TableCell>
                <TableCell className='text-sm text-muted-foreground'>
                  {tt.salesStartAt
                    ? `${formatDateTime(tt.salesStartAt)}`
                    : 'Now'}
                  {tt.salesEndAt ? ` – ${formatDateTime(tt.salesEndAt)}` : ''}
                </TableCell>
                <TableCell>
                  {tt.requiresAccessCode ? (
                    <Badge variant='secondary'>Required</Badge>
                  ) : (
                    <span className='text-muted-foreground'>No</span>
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant='ghost' size='icon' className='size-8'>
                        <MoreHorizontal className='size-4' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => handleEdit(tt)}>
                        <Pencil className='size-4' />
                        Edit
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <TicketTypeFormDrawer
        eventId={eventId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onSuccess={refetch}
        ticketType={editingTicket}
      />
    </>
  )
}
