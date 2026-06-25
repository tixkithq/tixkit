'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  type CreateTicketTypeInput,
  type UpdateTicketTypeInput,
  type AdminTicketType,
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

export const ticketSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    priceCents: z.number().min(0, 'Price must be zero or positive'),
    currency: z.string().min(1, 'Currency is required'),
    quantityTotal: z.number().int().positive().optional(),
    salesStartAt: z.string().optional(),
    salesEndAt: z.string().optional(),
    requiresAccessCode: z.boolean().optional(),
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
  })

type TicketFormValues = z.infer<typeof ticketSchema>

type TicketTypeFormDrawerProps = {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
  /** Existing ticket type to edit. Omit for create mode. */
  ticketType?: AdminTicketType
}

function toLocalDatetimeInput(iso?: string): string {
  if (!iso) return ''
  // datetime-local inputs expect yyyy-MM-ddTHH:mm in local time.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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

  const form = useForm<TicketFormValues>({
    resolver: zodResolver(ticketSchema),
    defaultValues: {
      name: '',
      description: '',
      priceCents: 0,
      currency: 'USD',
      quantityTotal: undefined,
      salesStartAt: '',
      salesEndAt: '',
      requiresAccessCode: false,
    },
  })

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: ticketType?.name ?? '',
        description: '',
        priceCents: ticketType?.priceCents ?? 0,
        currency: ticketType?.currency ?? 'USD',
        quantityTotal: ticketType?.quantityTotal,
        salesStartAt: toLocalDatetimeInput(ticketType?.salesStartAt),
        salesEndAt: toLocalDatetimeInput(ticketType?.salesEndAt),
        requiresAccessCode: ticketType?.requiresAccessCode ?? false,
      })
    }
  }, [open, ticketType, form])

  const onSubmit = async (values: TicketFormValues) => {
    setSubmitting(true)
    const baseInput: CreateTicketTypeInput = {
      name: values.name,
      description: values.description || undefined,
      priceCents: values.priceCents,
      currency: values.currency,
      quantityTotal: values.quantityTotal || undefined,
      salesStartAt: values.salesStartAt || undefined,
      salesEndAt: values.salesEndAt || undefined,
      requiresAccessCode: values.requiresAccessCode,
    }
    const result = isEditing && ticketType
      ? await adminApi.updateTicketType(ticketType.id, baseInput as UpdateTicketTypeInput)
      : await adminApi.createTicketType(eventId, baseInput)
    setSubmitting(false)
    if (result.ok) {
      toast.success(isEditing ? 'Ticket type updated' : 'Ticket type created')
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
                          value={field.value ?? 0}
                          onChange={(e) =>
                            field.onChange(Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormDescription>0 for free tickets</FormDescription>
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
