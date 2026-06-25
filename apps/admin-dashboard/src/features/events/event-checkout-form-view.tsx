'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FileX2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  type AdminCheckoutQuestion,
  type AdminQuestionType,
  type CreateCheckoutQuestionInput,
  adminApi,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Input } from '@/components/ui/input'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAdminData } from '@/hooks/use-admin-data'
import { toast } from 'sonner'

const allTicketsValue = '__all__'
const noneValue = '__none__'

const fieldTypes = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'select', label: 'Single choice' },
  { value: 'multiselect', label: 'Multiple choice' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'waiver', label: 'Waiver / consent' },
] satisfies { value: Exclude<AdminQuestionType, 'file'>; label: string }[]

export const questionFormSchema = z
  .object({
    type: z.enum([
      'text',
      'textarea',
      'email',
      'phone',
      'select',
      'multiselect',
      'checkbox',
      'date',
      'waiver',
    ]),
    label: z.string().trim().min(1, 'Label is required'),
    description: z.string().trim().optional(),
    required: z.boolean(),
    appliesTo: z.enum(['buyer', 'attendee', 'both']),
    ticketTypeId: z.string(),
    optionsText: z.string().trim().optional(),
    placeholder: z.string().trim().optional(),
    validationPattern: z.string().trim().optional(),
    conditionalField: z.string(),
    conditionalOperator: z.enum(['equals', 'not_equals', 'contains']),
    conditionalValue: z.string().trim().optional(),
    sortOrder: z.number().int(),
    isConsentField: z.boolean(),
    consentText: z.string().trim().optional(),
    consentVersion: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    const options = parseOptions(data.optionsText)
    if ((data.type === 'select' || data.type === 'multiselect') && options.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['optionsText'],
        message: 'At least one option is required',
      })
    }

    if (data.conditionalField !== noneValue && !data.conditionalValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conditionalValue'],
        message: 'Condition value is required',
      })
    }

    if (data.isConsentField && data.type !== 'checkbox' && data.type !== 'waiver') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isConsentField'],
        message: 'Consent snapshots require checkbox or waiver fields',
      })
    }

    if (data.isConsentField || data.type === 'waiver') {
      if (!data.consentText) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['consentText'],
          message: 'Consent text is required',
        })
      }
      if (!data.consentVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['consentVersion'],
          message: 'Consent version is required',
        })
      }
    }
  })

export type CheckoutQuestionFormValues = z.infer<typeof questionFormSchema>

function parseOptions(value?: string): string[] {
  return Array.from(
    new Set(
      (value ?? '')
        .split('\n')
        .map((option) => option.trim())
        .filter(Boolean)
    )
  )
}

function nextSortOrder(questions: AdminCheckoutQuestion[]): number {
  if (questions.length === 0) return 10
  return Math.max(...questions.map((question) => question.sortOrder)) + 10
}

function formatScope(question: AdminCheckoutQuestion): string {
  if (question.appliesTo === 'both') return 'Buyer and attendee'
  return question.appliesTo === 'buyer' ? 'Buyer' : 'Attendee'
}

function formatType(type: AdminQuestionType): string {
  return fieldTypes.find((fieldType) => fieldType.value === type)?.label ?? 'Unsupported'
}

function questionToValues(
  question: AdminCheckoutQuestion | undefined,
  questions: AdminCheckoutQuestion[]
): CheckoutQuestionFormValues {
  return {
    type: question?.type === 'file' ? 'text' : question?.type ?? 'text',
    label: question?.label ?? '',
    description: question?.description ?? '',
    required: question?.required ?? false,
    appliesTo: question?.appliesTo ?? 'attendee',
    ticketTypeId: question?.ticketTypeId ?? allTicketsValue,
    optionsText: question?.options?.join('\n') ?? '',
    placeholder: question?.placeholder ?? '',
    validationPattern: question?.validationPattern ?? '',
    conditionalField: question?.conditionalVisibility?.field ?? noneValue,
    conditionalOperator: question?.conditionalVisibility?.operator ?? 'equals',
    conditionalValue: question?.conditionalVisibility?.value ?? '',
    sortOrder: question?.sortOrder ?? nextSortOrder(questions),
    isConsentField: question?.isConsentField ?? question?.type === 'waiver',
    consentText: question?.consentText ?? '',
    consentVersion: question?.consentVersion ?? '1',
  }
}

function valuesToInput(values: CheckoutQuestionFormValues): CreateCheckoutQuestionInput {
  const options = parseOptions(values.optionsText)
  const isConsentField =
    values.type === 'waiver' || (values.type === 'checkbox' && values.isConsentField)
  return {
    type: values.type,
    label: values.label.trim(),
    description: values.description?.trim() || undefined,
    required: values.required,
    appliesTo: values.appliesTo,
    ticketTypeId: values.ticketTypeId === allTicketsValue ? undefined : values.ticketTypeId,
    options: values.type === 'select' || values.type === 'multiselect' ? options : undefined,
    placeholder: values.placeholder?.trim() || undefined,
    validationPattern: values.validationPattern?.trim() || undefined,
    conditionalVisibility:
      values.conditionalField === noneValue
        ? undefined
        : {
            field: values.conditionalField,
            operator: values.conditionalOperator,
            value: values.conditionalValue?.trim() ?? '',
          },
    sortOrder: values.sortOrder,
    isConsentField,
    consentText: isConsentField ? values.consentText?.trim() : undefined,
    consentVersion: isConsentField ? values.consentVersion?.trim() || '1' : undefined,
  }
}

export function EventCheckoutFormView({ eventId }: { eventId: string }) {
  const {
    data: questions,
    loading,
    error,
    refetch,
  } = useAdminData(() => adminApi.listCheckoutQuestions(eventId), [eventId])
  const { data: ticketTypes } = useAdminData(
    () => adminApi.listTicketTypes(eventId),
    [eventId]
  )
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [editingQuestion, setEditingQuestion] = React.useState<AdminCheckoutQuestion>()
  const [submittingId, setSubmittingId] = React.useState<string>()

  const orderedQuestions = React.useMemo(
    () => [...(questions ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
    [questions]
  )

  const openCreate = () => {
    setEditingQuestion(undefined)
    setDrawerOpen(true)
  }

  const openEdit = (question: AdminCheckoutQuestion) => {
    setEditingQuestion(question)
    setDrawerOpen(true)
  }

  const deleteQuestion = async (question: AdminCheckoutQuestion) => {
    setSubmittingId(question.id)
    const result = await adminApi.deleteCheckoutQuestion(question.id)
    setSubmittingId(undefined)
    if (result.ok) {
      toast.success('Checkout field removed')
      await refetch()
    } else {
      toast.error(result.error.message)
    }
  }

  const duplicateQuestion = async (question: AdminCheckoutQuestion) => {
    setSubmittingId(question.id)
    const result = await adminApi.createCheckoutQuestion(eventId, {
      ticketTypeId: question.ticketTypeId,
      type: question.type,
      label: `${question.label} copy`,
      description: question.description,
      required: question.required,
      appliesTo: question.appliesTo,
      options: question.options,
      placeholder: question.placeholder,
      validationPattern: question.validationPattern,
      conditionalVisibility: question.conditionalVisibility,
      sortOrder: question.sortOrder + 1,
      isConsentField: question.isConsentField,
      consentText: question.consentText,
      consentVersion: question.consentVersion,
    })
    setSubmittingId(undefined)
    if (result.ok) {
      toast.success('Checkout field duplicated')
      await refetch()
    } else {
      toast.error(result.error.message)
    }
  }

  const moveQuestion = async (question: AdminCheckoutQuestion, direction: -1 | 1) => {
    const index = orderedQuestions.findIndex((item) => item.id === question.id)
    const swapWith = orderedQuestions[index + direction]
    if (!swapWith) return

    setSubmittingId(question.id)
    const first = await adminApi.updateCheckoutQuestion(question.id, {
      sortOrder: swapWith.sortOrder,
    })
    if (!first.ok) {
      setSubmittingId(undefined)
      toast.error(first.error.message)
      return
    }

    const second = await adminApi.updateCheckoutQuestion(swapWith.id, {
      sortOrder: question.sortOrder,
    })
    setSubmittingId(undefined)

    if (second.ok) {
      await refetch()
    } else {
      toast.error(second.error.message)
    }
  }

  if (loading) {
    return (
      <div className='space-y-4'>
        <Skeleton className='h-32 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    )
  }

  return (
    <div className='grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]'>
      <div className='space-y-4'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <div className='space-y-1'>
            <h2 className='text-lg font-semibold'>Fields</h2>
            <p className='text-sm text-muted-foreground'>
              {orderedQuestions.length} configured
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className='size-4' />
            Add Field
          </Button>
        </div>

        {error && (
          <div className='rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive'>
            {error.message}
          </div>
        )}

        {orderedQuestions.length === 0 ? (
          <Card>
            <CardContent className='flex min-h-40 items-center justify-center text-sm text-muted-foreground'>
              No checkout fields configured.
            </CardContent>
          </Card>
        ) : (
          <div className='space-y-3'>
            {orderedQuestions.map((question, index) => {
              const ticketName = question.ticketTypeId
                ? ticketTypes?.find((ticketType) => ticketType.id === question.ticketTypeId)?.name ?? 'Ticket scoped'
                : 'All tickets'
              return (
                <Card key={question.id}>
                  <CardContent className='flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between'>
                    <div className='min-w-0 space-y-2'>
                      <div className='flex flex-wrap items-center gap-2'>
                        <h3 className='truncate font-medium'>{question.label}</h3>
                        {question.required && <Badge variant='secondary'>Required</Badge>}
                        {question.isConsentField && <Badge variant='outline'>Consent</Badge>}
                        {question.type === 'file' && (
                          <Badge variant='destructive'>Unsupported</Badge>
                        )}
                      </div>
                      <div className='flex flex-wrap gap-2 text-xs text-muted-foreground'>
                        <span>{formatType(question.type)}</span>
                        <span>{formatScope(question)}</span>
                        <span>{ticketName}</span>
                        {question.conditionalVisibility && (
                          <span>
                            Conditional on {question.conditionalVisibility.field}
                          </span>
                        )}
                      </div>
                      {question.description && (
                        <p className='line-clamp-2 text-sm text-muted-foreground'>
                          {question.description}
                        </p>
                      )}
                    </div>
                    <div className='flex shrink-0 flex-wrap gap-2'>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        disabled={index === 0 || submittingId === question.id}
                        onClick={() => moveQuestion(question, -1)}
                        aria-label='Move field up'
                      >
                        <ArrowUp className='size-4' />
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        disabled={index === orderedQuestions.length - 1 || submittingId === question.id}
                        onClick={() => moveQuestion(question, 1)}
                        aria-label='Move field down'
                      >
                        <ArrowDown className='size-4' />
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        disabled={submittingId === question.id}
                        onClick={() => duplicateQuestion(question)}
                        aria-label='Duplicate field'
                      >
                        <Copy className='size-4' />
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        disabled={submittingId === question.id || question.type === 'file'}
                        onClick={() => openEdit(question)}
                        aria-label='Edit field'
                      >
                        <Pencil className='size-4' />
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        size='icon'
                        disabled={submittingId === question.id}
                        onClick={() => deleteQuestion(question)}
                        aria-label='Delete field'
                      >
                        <Trash2 className='size-4' />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <Card className='h-fit'>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
        </CardHeader>
        <CardContent className='space-y-4'>
          {orderedQuestions.length === 0 ? (
            <p className='text-sm text-muted-foreground'>No fields to preview.</p>
          ) : (
            orderedQuestions.map((question) => (
              <PreviewField key={question.id} question={question} />
            ))
          )}
          <div className='rounded-md border border-dashed p-3 text-sm text-muted-foreground'>
            <FileX2 className='mb-2 size-4' />
            File upload fields are blocked until upload storage and validation are available.
          </div>
        </CardContent>
      </Card>

      <QuestionFormDrawer
        eventId={eventId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        question={editingQuestion}
        questions={orderedQuestions}
        ticketTypes={ticketTypes ?? []}
        onSuccess={refetch}
      />
    </div>
  )
}

function PreviewField({ question }: { question: AdminCheckoutQuestion }) {
  const label = (
    <label className='text-sm font-medium'>
      {question.label}
      {question.required && <span className='text-destructive'> *</span>}
    </label>
  )

  if (question.type === 'checkbox' || question.type === 'waiver') {
    return (
      <div className='space-y-2'>
        <div className='flex items-start gap-2'>
          <Checkbox disabled />
          <div className='space-y-1'>
            {label}
            {question.consentText && (
              <p className='text-xs text-muted-foreground'>{question.consentText}</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='space-y-2'>
      {label}
      {question.type === 'textarea' ? (
        <Textarea disabled placeholder={question.placeholder} />
      ) : question.type === 'select' || question.type === 'multiselect' ? (
        <Select disabled>
          <SelectTrigger>
            <SelectValue placeholder={question.options?.[0] ?? 'Select'} />
          </SelectTrigger>
        </Select>
      ) : (
        <Input disabled type={question.type === 'date' ? 'date' : 'text'} placeholder={question.placeholder} />
      )}
      {question.description && (
        <p className='text-xs text-muted-foreground'>{question.description}</p>
      )}
    </div>
  )
}

function QuestionFormDrawer({
  eventId,
  open,
  onOpenChange,
  question,
  questions,
  ticketTypes,
  onSuccess,
}: {
  eventId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  question?: AdminCheckoutQuestion
  questions: AdminCheckoutQuestion[]
  ticketTypes: { id: string; name: string }[]
  onSuccess: () => void | Promise<void>
}) {
  const [submitting, setSubmitting] = React.useState(false)
  const isEditing = Boolean(question)
  const form = useForm<CheckoutQuestionFormValues>({
    resolver: zodResolver(questionFormSchema),
    defaultValues: questionToValues(undefined, questions),
  })

  React.useEffect(() => {
    if (open) {
      form.reset(questionToValues(question, questions))
    }
  }, [form, open, question, questions])

  const selectedType = form.watch('type')
  const conditionOptions = questions.filter((item) => item.id !== question?.id)
  const isConsentType = selectedType === 'waiver' || form.watch('isConsentField')

  const onSubmit = async (values: CheckoutQuestionFormValues) => {
    setSubmitting(true)
    const input = valuesToInput(values)
    const result = isEditing && question
      ? await adminApi.updateCheckoutQuestion(question.id, input)
      : await adminApi.createCheckoutQuestion(eventId, input)
    setSubmitting(false)

    if (result.ok) {
      toast.success(isEditing ? 'Checkout field updated' : 'Checkout field created')
      onOpenChange(false)
      await onSuccess()
    } else {
      toast.error(result.error.message)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='w-full overflow-y-auto sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>{isEditing ? 'Edit Checkout Field' : 'Add Checkout Field'}</SheetTitle>
          <SheetDescription>
            Event-level fields render in hosted checkout and embedded checkout.
          </SheetDescription>
        </SheetHeader>
        <div className='px-4 pb-4'>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-5'>
              <div className='grid gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='type'
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
                          {fieldTypes.map((fieldType) => (
                            <SelectItem key={fieldType.value} value={fieldType.value}>
                              {fieldType.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='appliesTo'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Scope</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value='buyer'>Buyer</SelectItem>
                          <SelectItem value='attendee'>Attendee</SelectItem>
                          <SelectItem value='both'>Both</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name='label'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Label</FormLabel>
                    <FormControl>
                      <Input placeholder='Dietary requirements' {...field} />
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
                      <Textarea className='resize-none' {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className='grid gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='ticketTypeId'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ticket Scope</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={allTicketsValue}>All tickets</SelectItem>
                          {ticketTypes.map((ticketType) => (
                            <SelectItem key={ticketType.id} value={ticketType.id}>
                              {ticketType.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='sortOrder'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sort Order</FormLabel>
                      <FormControl>
                        <Input
                          type='number'
                          value={field.value}
                          onChange={(event) => field.onChange(Number(event.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {(selectedType === 'select' || selectedType === 'multiselect') && (
                <FormField
                  control={form.control}
                  name='optionsText'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Options</FormLabel>
                      <FormControl>
                        <Textarea className='min-h-28 resize-none' {...field} />
                      </FormControl>
                      <FormDescription>One option per line.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {selectedType !== 'checkbox' && selectedType !== 'waiver' && (
                <FormField
                  control={form.control}
                  name='placeholder'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Placeholder</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <div className='grid gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='required'
                  render={({ field }) => (
                    <FormItem className='flex items-center gap-2 rounded-md border p-3'>
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className='m-0'>Required</FormLabel>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='isConsentField'
                  render={({ field }) => (
                    <FormItem className='flex items-center gap-2 rounded-md border p-3'>
                      <FormControl>
                        <Checkbox
                          checked={selectedType === 'waiver' || field.value}
                          disabled={selectedType === 'waiver'}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel className='m-0'>Consent snapshot</FormLabel>
                    </FormItem>
                  )}
                />
              </div>

              {isConsentType && (
                <div className='space-y-4 rounded-md border p-3'>
                  <FormField
                    control={form.control}
                    name='consentText'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Consent Text</FormLabel>
                        <FormControl>
                          <Textarea className='resize-none' {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name='consentVersion'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Consent Version</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              )}

              <div className='space-y-4 rounded-md border p-3'>
                <FormField
                  control={form.control}
                  name='conditionalField'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Conditional Field</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={noneValue}>Always show</SelectItem>
                          {conditionOptions.map((conditionQuestion) => (
                            <SelectItem key={conditionQuestion.id} value={conditionQuestion.id}>
                              {conditionQuestion.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {form.watch('conditionalField') !== noneValue && (
                  <div className='grid gap-4 sm:grid-cols-2'>
                    <FormField
                      control={form.control}
                      name='conditionalOperator'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Operator</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value='equals'>Equals</SelectItem>
                              <SelectItem value='not_equals'>Does not equal</SelectItem>
                              <SelectItem value='contains'>Contains</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name='conditionalValue'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Value</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}
              </div>

              <SheetFooter>
                <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type='submit' disabled={submitting}>
                  {submitting ? 'Saving...' : 'Save Field'}
                </Button>
              </SheetFooter>
            </form>
          </Form>
        </div>
      </SheetContent>
    </Sheet>
  )
}
