'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { type AdminWebhookEndpoint, type CreateWebhookEndpointInput, type UpdateWebhookEndpointInput, adminApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { toast } from 'sonner'

const webhookEvents = [
  'order.created',
  'order.paid',
  'order.refunded',
  'ticket.issued',
  'ticket.checked_in',
  'attendee.updated',
  'event.published',
  'event.cancelled',
]

const webhookSchema = z.object({
  url: z.string().url('Enter a valid URL'),
  description: z.string().optional(),
  events: z.array(z.string()).min(1, 'Select at least one event'),
})

type WebhookFormValues = z.infer<typeof webhookSchema>

type WebhookFormDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpoint?: AdminWebhookEndpoint
  onSuccess?: () => void
}

export function WebhookFormDrawer({
  open,
  onOpenChange,
  endpoint,
  onSuccess,
}: WebhookFormDrawerProps) {
  const [submitting, setSubmitting] = React.useState(false)

  const form = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
    defaultValues: {
      url: endpoint?.url ?? '',
      description: endpoint?.description ?? '',
      events: endpoint?.events ?? [],
    },
  })

  React.useEffect(() => {
    if (open) {
      form.reset({
        url: endpoint?.url ?? '',
        description: endpoint?.description ?? '',
        events: endpoint?.events ?? [],
      })
    }
  }, [open, endpoint, form])

  const watchedEvents = form.watch('events')

  const toggleEvent = (event: string) => {
    const current = form.getValues('events')
    const updated = current.includes(event)
      ? current.filter((e) => e !== event)
      : [...current, event]
    form.setValue('events', updated)
  }

  const onSubmit = async (values: WebhookFormValues) => {
    setSubmitting(true)
    const input: CreateWebhookEndpointInput = {
      url: values.url,
      description: values.description || undefined,
      events: values.events,
    }
    const result = endpoint
      ? await adminApi.updateWebhookEndpoint(endpoint.id, input as UpdateWebhookEndpointInput)
      : await adminApi.createWebhookEndpoint(input)
    setSubmitting(false)
    if (result.ok) {
      toast.success(endpoint ? 'Webhook updated' : 'Webhook created')
      onOpenChange(false)
      onSuccess?.()
    } else {
      toast.error(result.error.message)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='w-full overflow-y-auto sm:max-w-lg'>
        <SheetHeader>
          <SheetTitle>
            {endpoint ? 'Edit Endpoint' : 'Add Endpoint'}
          </SheetTitle>
          <SheetDescription>
            Register a webhook endpoint to receive event notifications.
          </SheetDescription>
        </SheetHeader>
        <div className='px-4 pb-4'>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
              <FormField
                control={form.control}
                name='url'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder='https://example.com/webhooks/gatekit'
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='description'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder='What is this endpoint used for?'
                        className='resize-none'
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='events'
                render={() => (
                  <FormItem>
                    <FormLabel>Events</FormLabel>
                    <FormDescription>
                      Select which events to subscribe to
                    </FormDescription>
                    <div className='grid gap-2 sm:grid-cols-2'>
                      {webhookEvents.map((event) => (
                        <div
                          key={event}
                          className='flex items-center gap-2 rounded-md border p-2'
                        >
                          <Checkbox
                            id={`evt-${event}`}
                            checked={watchedEvents.includes(event)}
                            onCheckedChange={() => toggleEvent(event)}
                          />
                          <Label
                            htmlFor={`evt-${event}`}
                            className='text-sm font-normal cursor-pointer'
                          >
                            {event}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <SheetFooter>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type='submit' disabled={submitting}>
                  {submitting
                    ? 'Saving...'
                    : endpoint
                      ? 'Save Changes'
                      : 'Add Endpoint'}
                </Button>
              </SheetFooter>
            </form>
          </Form>
        </div>
      </SheetContent>
    </Sheet>
  )
}
