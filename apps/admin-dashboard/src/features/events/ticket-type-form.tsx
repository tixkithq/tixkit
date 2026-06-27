'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  type CreateTicketTypeInput,
  type UpdateTicketTypeInput,
  type AdminTicketType,
  type AdminEventOccurrence,
  type AdminInventoryPool,
  type AdminAccessRule,
  adminApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { toast } from 'sonner'
import { isoToLocalDatetimeInput, localDatetimeInputToIso } from '@/lib/datetime'

export const ticketSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    kind: z.enum(['free', 'paid', 'donation']),
    visibility: z.enum(['public', 'hidden', 'locked']),
    status: z.enum(['draft', 'active', 'paused', 'sold_out', 'ended']).optional(),
    priceCents: z.number().min(0, 'Price must be zero or positive'),
    minimumPriceCents: z.number().min(0, 'Minimum donation must be zero or positive').optional(),
    currency: z.string().min(1, 'Currency is required'),
    quantityTotal: z.number().int().positive().optional(),
    salesStartAt: z.string().optional(),
    salesEndAt: z.string().optional(),
    minPerOrder: z.number().int().min(1, 'Minimum per order must be at least 1').optional(),
    maxPerOrder: z.number().int().min(1, 'Maximum per order must be at least 1').optional(),
    requiresAccessCode: z.boolean().optional(),
    accessCodeHint: z.string().optional(),
    eventOccurrenceId: z.string().optional(),
    accessCodes: z.string().optional(),
    inventoryPoolMode: z.enum(['new', 'existing']),
    inventoryPoolId: z.string().optional(),
    // Inventory pool fields (create mode only). The live API requires an
    // inventoryPoolId to create a ticket type, so the form creates a pool
    // first and attaches its id.
    inventoryPoolName: z.string().optional(),
    inventoryPoolCapacity: z.number().int().min(1, 'Capacity must be at least 1').optional(),
  })
  .superRefine((data, ctx) => {
    // Sales end must be after sales start when both are present.
    if (
      data.salesStartAt &&
      data.salesEndAt &&
      data.salesStartAt.trim() !== '' &&
      data.salesEndAt.trim() !== ''
    ) {
      const start = new Date(data.salesStartAt).getTime()
      const end = new Date(data.salesEndAt).getTime()
      if (Number.isNaN(start) || Number.isNaN(end)) return
      if (end <= start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['salesEndAt'],
          message: 'Sales end must be after sales start',
        })
      }
    }
    if (data.kind === 'donation' && data.minimumPriceCents === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minimumPriceCents'],
        message: 'Minimum donation is required for donation tickets',
      })
    }
    if (data.visibility === 'locked' && !data.requiresAccessCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresAccessCode'],
        message: 'Locked tickets require access-code validation',
      })
    }
    if (data.minPerOrder && data.maxPerOrder && data.maxPerOrder < data.minPerOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxPerOrder'],
        message: 'Maximum per order must be greater than or equal to minimum per order',
      })
    }
    if (data.inventoryPoolMode === 'existing' && !data.inventoryPoolId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inventoryPoolId'],
        message: 'Choose an inventory pool',
      })
    }
  })

type TicketFormValues = z.infer<typeof ticketSchema>

export function buildTicketSalesWindowPayload(
  values: Pick<TicketFormValues, 'salesStartAt' | 'salesEndAt'>,
) {
  return {
    salesStartAt: localDatetimeInputToIso(values.salesStartAt),
    salesEndAt: localDatetimeInputToIso(values.salesEndAt),
  }
}

type TicketTypeFormDrawerProps = {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
  /** Existing ticket type to edit. Omit for create mode. */
  ticketType?: AdminTicketType
}

function buildAccessRuleInputs(accessCodes: string | undefined) {
  return [
    ...new Set(
      (accessCodes ?? '')
        .split(/\r?\n|,/)
        .map((code) => code.trim())
        .filter(Boolean)
    ),
  ].map((value) => ({ type: 'code' as const, value }))
}

export function TicketTypeFormDrawer({
  eventId,
  open,
  onOpenChange,
  onSuccess,
  ticketType,
}: TicketTypeFormDrawerProps) {
  const [submitting, setSubmitting] = React.useState(false)
  const isEditing = Boolean(ticketType)
  const [inventoryPools, setInventoryPools] = React.useState<AdminInventoryPool[]>([])
  const [eventOccurrences, setEventOccurrences] = React.useState<AdminEventOccurrence[]>([])
  const [accessRules, setAccessRules] = React.useState<AdminAccessRule[]>([])
  const [deletingRuleId, setDeletingRuleId] = React.useState<string | null>(null)

  const form = useForm<TicketFormValues>({
    resolver: zodResolver(ticketSchema),
    defaultValues: {
      name: '',
      description: '',
      kind: 'paid',
      visibility: 'public',
      status: 'active',
      priceCents: 0,
      minimumPriceCents: undefined,
      currency: 'USD',
      quantityTotal: undefined,
      salesStartAt: '',
      salesEndAt: '',
      minPerOrder: 1,
      maxPerOrder: 10,
      requiresAccessCode: false,
      accessCodeHint: '',
      eventOccurrenceId: '',
      accessCodes: '',
      inventoryPoolMode: 'new',
      inventoryPoolId: '',
      inventoryPoolName: '',
      inventoryPoolCapacity: undefined,
    },
  })

  React.useEffect(() => {
    if (open) {
      void adminApi.listInventoryPools(eventId).then((result) => {
        if (result.ok) setInventoryPools(result.data)
      })
      void adminApi.listEventOccurrences(eventId).then((result) => {
        if (result.ok) setEventOccurrences(result.data)
      })
      if (ticketType?.id) {
        void adminApi.listAccessRules(ticketType.id).then((result) => {
          if (result.ok) setAccessRules(result.data)
        })
      } else {
        setAccessRules([])
      }
      form.reset({
        name: ticketType?.name ?? '',
        description: ticketType?.description ?? '',
        kind: ticketType?.kind ?? (ticketType && ticketType.priceCents === 0 ? 'free' : 'paid'),
        visibility: ticketType?.visibility ?? 'public',
        status: ticketType?.status ?? 'active',
        priceCents: ticketType?.priceCents ?? 0,
        minimumPriceCents: ticketType?.minimumPriceCents ?? undefined,
        currency: ticketType?.currency ?? 'USD',
        quantityTotal: ticketType?.quantityTotal,
        salesStartAt: isoToLocalDatetimeInput(ticketType?.salesStartAt),
        salesEndAt: isoToLocalDatetimeInput(ticketType?.salesEndAt),
        minPerOrder: ticketType?.minPerOrder ?? 1,
        maxPerOrder: ticketType?.maxPerOrder ?? 10,
        requiresAccessCode: ticketType?.requiresAccessCode ?? false,
        accessCodeHint: ticketType?.accessCodeHint ?? '',
        eventOccurrenceId: ticketType?.eventOccurrenceId ?? '',
        accessCodes: '',
        inventoryPoolMode: ticketType?.inventoryPoolId ? 'existing' : 'new',
        inventoryPoolId: ticketType?.inventoryPoolId ?? '',
        // Pool fields are only used in create mode; default the pool name to
        // the ticket type name and capacity to the quantityTotal.
        inventoryPoolName: '',
        inventoryPoolCapacity: ticketType?.quantityTotal,
      })
    }
  }, [eventId, open, ticketType, form])

  const kind = form.watch('kind')
  const visibility = form.watch('visibility')
  const inventoryPoolMode = form.watch('inventoryPoolMode')

  const deleteAccessRule = async (rule: AdminAccessRule) => {
    setDeletingRuleId(rule.id)
    const result = await adminApi.deleteAccessRule(rule.id)
    setDeletingRuleId(null)
    if (result.ok) {
      setAccessRules((rules) => rules.filter((candidate) => candidate.id !== rule.id))
      toast.success('Access rule removed')
    } else {
      toast.error(result.error.message)
    }
  }

  const onSubmit = async (values: TicketFormValues) => {
    setSubmitting(true)
    const hasNewAccessCodes = Boolean(values.accessCodes?.trim())
    if (values.visibility === 'locked' && accessRules.length === 0 && !hasNewAccessCodes) {
      setSubmitting(false)
      form.setError('accessCodes', { message: 'Add at least one access code for locked tickets' })
      return
    }

    const baseInput: CreateTicketTypeInput = {
      name: values.name,
      description: values.description || undefined,
      kind: values.kind,
      visibility: values.visibility,
      priceCents: values.kind === 'free' ? 0 : values.priceCents,
      minimumPriceCents: values.kind === 'donation' ? values.minimumPriceCents ?? 0 : null,
      currency: values.currency,
      quantityTotal: values.quantityTotal || undefined,
      ...buildTicketSalesWindowPayload(values),
      minPerOrder: values.minPerOrder,
      maxPerOrder: values.maxPerOrder,
      requiresAccessCode: values.requiresAccessCode,
      accessCodeHint: values.accessCodeHint?.trim() || null,
      eventOccurrenceId: values.eventOccurrenceId || null,
      inventoryPoolId: values.inventoryPoolMode === 'existing' ? values.inventoryPoolId : undefined,
    }

    if (isEditing && ticketType) {
      const result = await adminApi.updateTicketTypeBatch(
        ticketType.id,
        {
          ticketType: {
            ...baseInput,
            status: values.status,
          } as UpdateTicketTypeInput,
          accessRules: buildAccessRuleInputs(values.accessCodes),
        }
      )
      setSubmitting(false)
      if (result.ok) {
        setAccessRules(result.data.accessRules)
        toast.success('Ticket type updated')
        onOpenChange(false)
        onSuccess?.()
      } else {
        toast.error(result.error.message)
      }
      return
    }

    const result = await adminApi.createTicketTypeBatch(eventId, {
      ticketType: {
        ...baseInput,
        inventoryPoolId: values.inventoryPoolMode === 'existing' ? values.inventoryPoolId : undefined,
      },
      inventoryPool:
        values.inventoryPoolMode === 'new'
          ? {
              name: values.inventoryPoolName?.trim() || `${values.name} Pool`,
              totalCapacity: values.inventoryPoolCapacity ?? values.quantityTotal ?? 100,
            }
          : undefined,
      accessRules: buildAccessRuleInputs(values.accessCodes),
    })
    setSubmitting(false)
    if (result.ok) {
      setAccessRules(result.data.accessRules)
      toast.success('Ticket type created')
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
            {isEditing ? 'Edit Ticket Type' : 'Create Ticket Type'}
          </SheetTitle>
          <SheetDescription>
            {isEditing
              ? 'Update the ticket type details below.'
              : 'Define a new ticket type for this event.'}
          </SheetDescription>
        </SheetHeader>
        <div className='px-4 pb-4'>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
              <FormField
                control={form.control}
                name='name'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder='General Admission' {...field} />
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
                        placeholder='Optional description'
                        className='resize-none'
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className='grid gap-4 sm:grid-cols-3'>
                <FormField
                  control={form.control}
                  name='kind'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value='free'>Free</SelectItem>
                          <SelectItem value='paid'>Paid</SelectItem>
                          <SelectItem value='donation'>Donation</SelectItem>
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
                      <Select
                        onValueChange={(value) => {
                          field.onChange(value)
                          if (value === 'locked') form.setValue('requiresAccessCode', true)
                        }}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value='public'>Public</SelectItem>
                          <SelectItem value='hidden'>Hidden</SelectItem>
                          <SelectItem value='locked'>Locked</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isEditing && (
                  <FormField
                    control={form.control}
                    name='status'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Status</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value='draft'>Draft</SelectItem>
                            <SelectItem value='active'>Active</SelectItem>
                            <SelectItem value='paused'>Paused</SelectItem>
                            <SelectItem value='sold_out'>Sold out</SelectItem>
                            <SelectItem value='ended'>Ended</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>
              <FormField
                control={form.control}
                name='eventOccurrenceId'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Occurrence</FormLabel>
                    <Select
                      onValueChange={(value) => field.onChange(value === 'event' ? '' : value)}
                      value={field.value || 'event'}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value='event'>All occurrences</SelectItem>
                        {eventOccurrences.map((occurrence) => (
                          <SelectItem key={occurrence.id} value={occurrence.id}>
                            {occurrence.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Scope this ticket type to one scheduled session, or leave it shared.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className='grid gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='priceCents'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Price (cents)</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          disabled={kind === 'free'}
                          value={field.value ?? 0}
                          onChange={(e) =>
                            field.onChange(Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormDescription>
                        {kind === 'free' ? 'Free tickets are always 0.' : 'Amount charged per ticket.'}
                      </FormDescription>
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
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'].map((c) => (
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
              {kind === 'donation' && (
                <FormField
                  control={form.control}
                  name='minimumPriceCents'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimum Donation (cents)</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormDescription>Checkout rejects donations below this amount.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name='quantityTotal'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Quantity (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type='number'
                        placeholder='Unlimited'
                        value={field.value ?? ''}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value
                              ? Number(e.target.value)
                              : undefined
                          )
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Total available tickets. Leave empty for unlimited.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className='grid gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='salesStartAt'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sales Start</FormLabel>
                      <FormControl>
                        <Input type='datetime-local' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='salesEndAt'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sales End</FormLabel>
                      <FormControl>
                        <Input type='datetime-local' {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className='grid gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='minPerOrder'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Min Per Order</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='maxPerOrder'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Max Per Order</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name='requiresAccessCode'
                render={({ field }) => (
                  <FormItem className='flex flex-row items-start gap-3 space-y-0 rounded-lg border p-3'>
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className='space-y-1 leading-none'>
                      <FormLabel>Requires Access Code</FormLabel>
                      <FormDescription>
                        Only buyers with a valid access code can purchase this
                        ticket type.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
              {(visibility === 'locked' || form.watch('requiresAccessCode')) && (
                <div className='space-y-3 rounded-lg border p-3'>
                  <FormField
                    control={form.control}
                    name='accessCodeHint'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Access Code Hint</FormLabel>
                        <FormControl>
                          <Input placeholder='VIP list, sponsor code, or member code' {...field} />
                        </FormControl>
                        <FormDescription>
                          Stored as metadata for operators; redemption rules are enforced by access-code records.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {accessRules.length > 0 && (
                    <div className='space-y-2'>
                      <p className='text-sm font-medium'>Existing Access Rules</p>
                      <div className='space-y-2'>
                        {accessRules.map((rule) => (
                          <div key={rule.id} className='flex items-center justify-between rounded-md border px-3 py-2 text-sm'>
                            <div>
                              <p className='font-medium'>{rule.value}</p>
                              <p className='text-xs text-muted-foreground'>
                                {rule.type === 'code' ? 'Access code' : 'Email domain'} · {rule.usesCount} uses
                              </p>
                            </div>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              disabled={deletingRuleId === rule.id}
                              onClick={() => void deleteAccessRule(rule)}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <FormField
                    control={form.control}
                    name='accessCodes'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{isEditing ? 'Add Access Codes' : 'Access Codes'}</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder='VIP123&#10;SPONSOR2026'
                            className='min-h-24 resize-none'
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Add one code per line or comma. Codes are saved as access-rule records and validated by checkout.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}
              <div className='space-y-3 rounded-lg border p-3'>
                <div className='space-y-1'>
                  <p className='text-sm font-medium'>Inventory Pool</p>
                  <p className='text-xs text-muted-foreground'>
                    Reuse a shared pool when multiple ticket types draw from the same capacity.
                  </p>
                </div>
                <FormField
                  control={form.control}
                  name='inventoryPoolMode'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Pool Behavior</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value='new'>Create new pool</SelectItem>
                          <SelectItem value='existing'>Use existing pool</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {inventoryPoolMode === 'existing' && (
                  <FormField
                    control={form.control}
                    name='inventoryPoolId'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Existing Pool</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder='Choose pool' />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {inventoryPools.map((pool) => (
                              <SelectItem key={pool.id} value={pool.id}>
                                {pool.name} ({pool.soldCount + pool.reservedCount}/{pool.totalCapacity})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
                <div className='rounded-md bg-muted p-3 text-xs text-muted-foreground'>
                  Product and add-on management now lives on the event Products page. Checkout product purchasing is tracked separately from this ticket form.
                </div>
              </div>
              {inventoryPoolMode === 'new' && (
                <div className='space-y-3 rounded-lg border p-3'>
                  <div className='space-y-1'>
                    <p className='text-sm font-medium'>New Pool Details</p>
                    <p className='text-xs text-muted-foreground'>
                      A shared inventory pool is created for this ticket type.
                      The pool controls how many tickets can be held or sold.
                    </p>
                  </div>
                  <FormField
                    control={form.control}
                    name='inventoryPoolName'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Pool Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={`${form.getValues('name') || 'General Admission'} Pool`}
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          Defaults to the ticket type name + &ldquo;Pool&rdquo;.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name='inventoryPoolCapacity'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Pool Capacity</FormLabel>
                        <FormControl>
                          <Input
                            type='number'
                            placeholder='100'
                            value={field.value ?? ''}
                            onChange={(e) =>
                              field.onChange(
                                e.target.value
                                  ? Number(e.target.value)
                                  : undefined
                              )
                            }
                          />
                        </FormControl>
                        <FormDescription>
                          Total tickets this pool can hold. Defaults to the
                          quantity above or 100.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}
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
                    : isEditing
                      ? 'Save Changes'
                      : 'Create Ticket Type'}
                </Button>
              </SheetFooter>
            </form>
          </Form>
        </div>
      </SheetContent>
    </Sheet>
  )
}
