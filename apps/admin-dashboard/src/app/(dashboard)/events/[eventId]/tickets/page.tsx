import { EventTicketsView } from '@/features/events/event-tickets-view'

export default async function Page({
  params,
}: {
  params: Promise<{ eventId: string }>
}) {
  const { eventId } = await params
  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>Ticket Types</h1>
          <p className='text-sm text-muted-foreground'>
            Manage ticket types, pricing, and inventory
          </p>
        </div>
      </div>
      <EventTicketsView eventId={eventId} />
    </div>
  )
}
