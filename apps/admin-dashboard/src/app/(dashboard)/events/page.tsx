import { EventsTable } from '@/features/events/events-table'

export default function Page() {
  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>Events</h1>
          <p className='text-sm text-muted-foreground'>
            Create and manage your ticketed events
          </p>
        </div>
      </div>
      <EventsTable />
    </div>
  )
}
