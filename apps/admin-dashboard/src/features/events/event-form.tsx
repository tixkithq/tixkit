'use client'

import * as React from 'react'
import { type Resolver, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { type CreateEventInput, type UpdateEventInput, type AdminEventDetail, adminApi } from '@/lib/api'
import { isoToTimezoneDatetimeInput, timezoneDatetimeInputToIso } from '@/lib/datetime'
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
    status: z.enum(['draft', 'published', 'paused', 'archived']).optional(),
    visibility: z.enum(['public', 'unlisted', 'private']),
    venueName: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
    capacity: z.number().int().positive().optional(),
    coverImageUrl: z.string().url('Cover image must be a valid URL').optional().or(z.literal('')),
    externalUrl: z.string().url('External URL must be a valid URL').optional().or(z.literal('')),
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),
    seoImageUrl: z.string().url('SEO image must be a valid URL').optional().or(z.literal('')),
    currency: z.string().min(1, 'Currency is required'),
  })
  .superRefine((data, ctx) => {
    // End date must be after start date when both are present.
    if (
      data.startsAt &&
      data.endsAt &&
      data.endsAt.trim() !== ''
    ) {
      const startIso = timezoneDatetimeInputToIso(data.startsAt, data.timezone)
      const endIso = timezoneDatetimeInputToIso(data.endsAt, data.timezone)
      const start = startIso ? new Date(startIso).getTime() : Number.NaN
      const end = endIso ? new Date(endIso).getTime() : Number.NaN
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
type EventFormDirtyFields = Partial<Record<keyof EventFormValues, unknown>>

export function buildEventDatePayload(values: Pick<EventFormValues, 'startsAt' | 'endsAt' | 'timezone'>) {
  const startsAt = timezoneDatetimeInputToIso(values.startsAt, values.timezone)
  const endsAt = timezoneDatetimeInputToIso(values.endsAt, values.timezone)
  return startsAt ? { startsAt, endsAt } : null
}

const emptyStringToUndefined = (value?: string) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const emptyStringToNull = (value?: string) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function buildVenuePayload(values: EventFormValues): AdminEventDetail['venue'] {
  const venue = {
    name: emptyStringToUndefined(values.venueName),
    address: emptyStringToUndefined(values.address),
    city: emptyStringToUndefined(values.city),
    region: emptyStringToUndefined(values.region),
    postalCode: emptyStringToUndefined(values.postalCode),
    country: emptyStringToUndefined(values.country),
  }
  return Object.values(venue).some(Boolean) ? venue : null
}

function buildSeoPayload(values: EventFormValues) {
  return {
    title: emptyStringToUndefined(values.seoTitle),
    description: emptyStringToUndefined(values.seoDescription),
    imageUrl: emptyStringToUndefined(values.seoImageUrl),
  }
}

function hasDirtyField(dirtyFields: EventFormDirtyFields, fields: Array<keyof EventFormValues>) {
  return fields.some((field) => Boolean(dirtyFields[field]))
}

export function buildEventUpdatePayload(
  values: EventFormValues,
  dirtyFields: EventFormDirtyFields
): UpdateEventInput | null {
  const payload: UpdateEventInput = {}
  if (dirtyFields.title) payload.title = values.title
  if (dirtyFields.description) payload.description = values.description
  if (dirtyFields.currency) payload.currency = values.currency
  if (dirtyFields.status) payload.status = values.status
  if (dirtyFields.visibility) payload.visibility = values.visibility

  if (hasDirtyField(dirtyFields, ['startsAt', 'endsAt', 'timezone'])) {
    const datePayload = buildEventDatePayload(values)
    if (!datePayload) return null
    payload.startsAt = datePayload.startsAt
    payload.endsAt = values.endsAt?.trim() ? datePayload.endsAt : null
    payload.timezone = values.timezone
  }

  if (hasDirtyField(dirtyFields, ['venueName', 'address', 'city', 'region', 'postalCode', 'country'])) {
    payload.venue = buildVenuePayload(values)
  }

  if (hasDirtyField(dirtyFields, ['seoTitle', 'seoDescription', 'seoImageUrl'])) {
    payload.seo = buildSeoPayload(values)
  }

  if (dirtyFields.capacity) payload.capacity = values.capacity ?? null
  if (dirtyFields.coverImageUrl) payload.coverImageUrl = emptyStringToNull(values.coverImageUrl)
  if (dirtyFields.externalUrl) payload.externalUrl = emptyStringToNull(values.externalUrl)

  return payload
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
  event?: AdminEventDetail
  onSuccess?: (event: AdminEventDetail) => void
  onCancel?: () => void
}

export function EventForm({ event, onSuccess, onCancel }: EventFormProps) {
  const [submitting, setSubmitting] = React.useState(false)
  const { organizationId, brandId, loading: bootstrapLoading } = useBootstrap()

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema) as Resolver<EventFormValues>,
    defaultValues: event
      ? {
          title: event.title,
          slug: event.slug ?? '',
          description: event.description ?? '',
          startsAt: isoToTimezoneDatetimeInput(event.startsAt, event.timezone),
          endsAt: isoToTimezoneDatetimeInput(event.endsAt, event.timezone),
          timezone: event.timezone,
          status: event.status,
          visibility: event.visibility,
          venueName: event.venue?.name ?? event.venueName ?? '',
          address: event.venue?.address ?? '',
          city: event.venue?.city ?? event.city ?? '',
          region: event.venue?.region ?? '',
          postalCode: event.venue?.postalCode ?? '',
          country: event.venue?.country ?? '',
          capacity: event.capacity ?? undefined,
          coverImageUrl: event.coverImageUrl ?? '',
          externalUrl: event.externalUrl ?? '',
          seoTitle: event.seo.title ?? '',
          seoDescription: event.seo.description ?? '',
          seoImageUrl: event.seo.imageUrl ?? '',
          currency: event.currency,
        }
      : {
          title: '',
          slug: '',
          description: '',
          startsAt: '',
          endsAt: '',
          timezone: 'America/New_York',
          status: 'draft',
          visibility: 'public',
          venueName: '',
          address: '',
          city: '',
          region: '',
          postalCode: '',
          country: '',
          capacity: undefined,
          coverImageUrl: '',
          externalUrl: '',
          seoTitle: '',
          seoDescription: '',
          seoImageUrl: '',
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

      const venue = buildVenuePayload(values) ?? undefined
      const seo = buildSeoPayload(values)

      const createInput: CreateEventInput = {
        organizationId: organizationId,
        brandId: brandId,
        title: values.title,
        slug: values.slug || undefined,
        description: values.description || undefined,
        startsAt: datePayload.startsAt,
        endsAt: datePayload.endsAt,
        timezone: values.timezone,
        venue,
        visibility: values.visibility,
        seo,
        capacity: values.capacity,
        coverImageUrl: emptyStringToUndefined(values.coverImageUrl),
        externalUrl: emptyStringToUndefined(values.externalUrl),
        currency: values.currency,
      }

      const updateInput = event
        ? buildEventUpdatePayload(values, form.formState.dirtyFields as EventFormDirtyFields)
        : null
      if (event && !updateInput) {
        toast.error('Start date must be a valid date and time')
        return
      }

      const result = event
        ? await adminApi.updateEvent(event.id, updateInput as UpdateEventInput)
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
        <div className='grid gap-4 sm:grid-cols-3'>
          <FormField
            control={form.control}
            name='status'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder='Select status' />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value='draft'>Draft</SelectItem>
                    <SelectItem value='published'>Published</SelectItem>
                    <SelectItem value='paused'>Paused</SelectItem>
                    <SelectItem value='archived'>Archived</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='visibility'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Visibility</FormLabel>
                <Select onValueChange={field.onChange} defaultValue={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder='Select visibility' />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value='public'>Public</SelectItem>
                    <SelectItem value='unlisted'>Unlisted</SelectItem>
                    <SelectItem value='private'>Private</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='capacity'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Capacity</FormLabel>
                <FormControl>
                  <Input
                    type='number'
                    placeholder='Unlimited'
                    value={field.value ?? ''}
                    onChange={(e) =>
                      field.onChange(e.target.value ? Number(e.target.value) : undefined)
                    }
                  />
                </FormControl>
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
        <div className='grid gap-4 sm:grid-cols-3'>
          <FormField
            control={form.control}
            name='city'
            render={({ field }) => (
              <FormItem>
                <FormLabel>City</FormLabel>
                <FormControl>
                  <Input placeholder='Austin' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='region'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Region</FormLabel>
                <FormControl>
                  <Input placeholder='TX' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='postalCode'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Postal Code</FormLabel>
                <FormControl>
                  <Input placeholder='78701' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name='country'
          render={({ field }) => (
            <FormItem>
              <FormLabel>Country</FormLabel>
              <FormControl>
                <Input placeholder='US' {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className='grid gap-4 sm:grid-cols-2'>
          <FormField
            control={form.control}
            name='coverImageUrl'
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cover Image URL</FormLabel>
                <FormControl>
                  <Input placeholder='https://cdn.example.com/cover.jpg' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='externalUrl'
            render={({ field }) => (
              <FormItem>
                <FormLabel>External URL</FormLabel>
                <FormControl>
                  <Input placeholder='https://example.com/event' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className='space-y-3 rounded-lg border p-3'>
          <div className='space-y-1'>
            <p className='text-sm font-medium'>SEO</p>
            <p className='text-xs text-muted-foreground'>
              Optional page metadata used by hosted event pages and previews.
            </p>
          </div>
          <FormField
            control={form.control}
            name='seoTitle'
            render={({ field }) => (
              <FormItem>
                <FormLabel>SEO Title</FormLabel>
                <FormControl>
                  <Input placeholder='Summer Music Festival tickets' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='seoDescription'
            render={({ field }) => (
              <FormItem>
                <FormLabel>SEO Description</FormLabel>
                <FormControl>
                  <Textarea className='resize-none' placeholder='Short search/social summary' {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='seoImageUrl'
            render={({ field }) => (
              <FormItem>
                <FormLabel>SEO Image URL</FormLabel>
                <FormControl>
                  <Input placeholder='https://cdn.example.com/social.jpg' {...field} />
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
