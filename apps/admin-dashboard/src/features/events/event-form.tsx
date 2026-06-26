'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { type CreateEventInput, type UpdateEventInput, type AdminEventListItem, adminApi } from '@/lib/api'
import { isoToLocalDatetimeInput, localDatetimeInputToIso } from '@/lib/datetime'
import { useBootstrap } from '@/context/bootstrap-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'

export const eventSchema = z
  .object({
    title: z.string().min(1, 'Title is required'),
    slug: z
      .string()
      .optional()
      .refine(
        (val) => !val || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(val),
        'Slug must be URL-safe (lowercase, hyphens only)'
      ),
    description: z.string().optional(),
    startsAt: z.string().min(1, 'Start date is required'),
    endsAt: z.string().optional(),
    timezone: z.string().min(1, 'Timezone is required'),
    venueName: z.string().optional(),
    address: z.string().optional(),
    currency: z.string().min(1, 'Currency is required'),
  })
  .superRefine((data, ctx) => {
    // End date must be after start date when both are present.
    if (
      data.startsAt &&
      data.endsAt &&
      data.endsAt.trim() !== ''
    ) {
      const start = new Date(data.startsAt).getTime()
      const end = new Date(data.endsAt).getTime()
      if (Number.isNaN(start) || Number.isNaN(end)) return
      if (end <= start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endsAt'],
          message: 'End date must be after start date',
        })
      }
    }
  })

type EventFormValues = z.infer<typeof eventSchema>

export function buildEventDatePayload(values: Pick<EventFormValues, 'startsAt' | 'endsAt'>) {
  const startsAt = localDatetimeInputToIso(values.startsAt)
  const endsAt = localDatetimeInputToIso(values.endsAt)
  return startsAt ? { startsAt, endsAt } : null
}

const commonTimezones = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
  'UTC',
]

const commonCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD']

type EventFormProps = {
  event?: AdminEventListItem
  onSuccess?: (event: AdminEventListItem) => void
  onCancel?: () => void
}

export function EventForm({ event, onSuccess, onCancel }: EventFormProps) {
  const [submitting, setSubmitting] = React.useState(false)
  const { organizationId, brandId, loading: bootstrapLoading } = useBootstrap()

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema),
    defaultValues: event
      ? {
          title: event.title,
          slug: event.slug ?? '',
          description: '',
          startsAt: isoToLocalDatetimeInput(event.startsAt),
          endsAt: isoToLocalDatetimeInput(event.endsAt),
          timezone: event.timezone,
          venueName: event.venueName ?? '',
          address: '',
          currency: event.currency,
        }
      : {
          title: '',
          slug: '',
          description: '',
          startsAt: '',
          endsAt: '',
          timezone: 'America/New_York',
          venueName: '',
          address: '',
          currency: 'USD',
        },
  })

  const onSubmit = async (values: EventFormValues) => {
    if (!event && (!organizationId || !brandId)) {
      toast.error('Organization and brand context are required to create an event. Please ensure your account is properly configured.')
      return
    }
    setSubmitting(true)
    try {
      const datePayload = buildEventDatePayload(values)
      if (!datePayload) {
        toast.error('Start date must be a valid date and time')
        return
      }

      const createInput: CreateEventInput = {
        organizationId: organizationId,
        brandId: brandId,
        title: values.title,
        slug: values.slug || undefined,
        description: values.description || undefined,
        startsAt: datePayload.startsAt,
        endsAt: datePayload.endsAt,
        timezone: values.timezone,
        venueName: values.venueName || undefined,
        address: values.address || undefined,
        currency: values.currency,
      }

      const result = event
        ? await adminApi.updateEvent(event.id, {
            title: values.title,
            description: values.description || undefined,
            startsAt: datePayload.startsAt,
            endsAt: datePayload.endsAt,
            timezone: values.timezone,
            currency: values.currency,
          } satisfies UpdateEventInput)
        : await adminApi.createEvent(createInput)

      if (result.ok) {
        toast.success(event ? 'Event updated' : 'Event created')
        onSuccess?.(result.data)
      } else {
        toast.error(result.error.message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
        <FormField
          control={form.control}
          name='title'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input placeholder='My Awesome Event' {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className='grid gap-4 sm:grid-cols-2'>
          <FormField
            control={form.control}
            name='slug'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Slug</FormLabel>
                <FormControl>
                  <Input placeholder='my-awesome-event' {...field} />
                </FormControl>
                <FormDescription>URL-safe, auto-generated if empty</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='currency'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Currency</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder='Select currency' />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {commonCurrencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name='description'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea
                  placeholder='Describe your event...'
                  className='resize-none'
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className='grid gap-4 sm:grid-cols-2'>
          <FormField
            control={form.control}
            name='startsAt'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start Date</FormLabel>
                <FormControl>
                  <Input type='datetime-local' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='endsAt'
            render={({ field }) => (
              <FormItem>
                <FormLabel>End Date</FormLabel>
                <FormControl>
                  <Input type='datetime-local' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name='timezone'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Timezone</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder='Select timezone' />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {commonTimezones.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className='grid gap-4 sm:grid-cols-2'>
          <FormField
            control={form.control}
            name='venueName'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Venue Name</FormLabel>
                <FormControl>
                  <Input placeholder='Venue Hall' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='address'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Address</FormLabel>
                <FormControl>
                  <Input placeholder='123 Main St' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className='flex justify-end gap-2 pt-2'>
          {onCancel && (
            <Button type='button' variant='outline' onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type='submit' disabled={submitting || (!event && bootstrapLoading)}>
            {submitting ? 'Saving...' : event ? 'Save Changes' : 'Create Event'}
          </Button>
        </div>
      </form>
    </Form>
  )
}
