'use client'

import * as React from 'react'
import { type AdminEventListItem } from '@/lib/api'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { EventForm } from './event-form'

type CreateEventDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  event?: AdminEventListItem
  onSuccess?: () => void
}

export function CreateEventDrawer({
  open,
  onOpenChange,
  event,
  onSuccess,
}: CreateEventDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='w-full overflow-y-auto sm:max-w-lg'
      >
        <SheetHeader>
          <SheetTitle>{event ? 'Edit Event' : 'Create Event'}</SheetTitle>
          <SheetDescription>
            {event
              ? 'Update the event details below.'
              : 'Fill in the details below to create a new event.'}
          </SheetDescription>
        </SheetHeader>
        <div className='px-4 pb-4'>
          <EventForm
            event={event}
            onSuccess={() => {
              onOpenChange(false)
              onSuccess?.()
            }}
            onCancel={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
