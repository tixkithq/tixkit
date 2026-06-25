'use client'

import * as React from 'react'
import { type AdminAttendeeListItem, adminApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTable } from '@/components/data-table/data-table'
import { type DataTableFilter } from '@/components/data-table/toolbar'
import { useAdminData } from '@/hooks/use-admin-data'
import { getAttendeeColumns } from '@/features/attendees/columns'
import { AttendeeFormDialog } from '@/features/attendees/attendee-form'
import { Users } from 'lucide-react'

const checkInFilters: DataTableFilter = {
  columnId: 'checkInStatus',
  title: 'Check-in',
  options: [
    { label: 'Not Checked In', value: 'not_checked_in' },
    { label: 'Checked In', value: 'checked_in' },
    { label: 'Revoked', value: 'revoked' },
  ],
}

export function EventAttendeesView({ eventId }: { eventId: string }) {
  const [editingAttendee, setEditingAttendee] =
    React.useState<AdminAttendeeListItem | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const { data, loading, error, refetch } = useAdminData(
    () => adminApi.listAttendees({ eventId }),
    [eventId]
  )

  const attendees = data?.items ?? []

  const columns = React.useMemo(
    () =>
      getAttendeeColumns((attendee) => {
        setEditingAttendee(attendee)
        setDialogOpen(true)
      }),
    []
  )

  if (loading) {
    return (
      <div className='space-y-3'>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className='h-12 w-full' />
        ))}
      </div>
    )
  }

  if (error && attendees.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title='Failed to load attendees'
        description={error.message}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    )
  }

  return (
    <>
      <DataTable
        columns={columns}
        data={attendees}
        getRowId={(row) => row.id}
        searchPlaceholder='Search attendees...'
        searchKey='name'
        filters={[checkInFilters]}
        emptyState={
          <EmptyState
            icon={Users}
            title='No attendees yet'
            description='Attendees will appear here as orders are completed.'
          />
        }
      />
      <AttendeeFormDialog
        attendee={editingAttendee}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSuccess={refetch}
      />
    </>
  )
}
