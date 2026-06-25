import { EventMessagesView } from '@/features/events/event-messages-view'

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
          <h1 className='text-2xl font-bold tracking-tight'>Messages</h1>
          <p className='text-sm text-muted-foreground'>
            Send campaigns to attendees of this event
          </p>
        </div>
      </div>
      <EventMessagesView eventId={eventId} />
    </div>
  )
}
