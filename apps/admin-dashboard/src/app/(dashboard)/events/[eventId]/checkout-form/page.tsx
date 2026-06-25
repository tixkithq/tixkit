import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { routes } from '@/lib/routes'
import { Button } from '@/components/ui/button'
import { EventCheckoutFormView } from '@/features/events/event-checkout-form-view'

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
          <h1 className='text-2xl font-bold tracking-tight'>Checkout Form</h1>
          <p className='text-sm text-muted-foreground'>
            Configure buyer, attendee, and consent fields for this event
          </p>
        </div>
        <Button asChild variant='outline'>
          <Link href={routes.eventDetail(eventId)}>
            <ArrowLeft className='size-4' />
            Event detail
          </Link>
        </Button>
      </div>

      <EventCheckoutFormView eventId={eventId} />
    </div>
  )
}
