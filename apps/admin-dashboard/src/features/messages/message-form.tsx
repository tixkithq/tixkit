'use client'

import * as React from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { type MessageRecipientPreview, type SendMessageInput, adminApi } from '@/lib/api'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

const messageSchema = z.object({
  channel: z.enum(['email', 'sms', 'both']),
  templateKey: z.string().min(1, 'Template key is required'),
  body: z.string().min(1, 'Message body is required'),
  audience: z.enum([
    'all',
    'checked_in',
    'not_checked_in',
  ]),
})

type MessageFormValues = z.infer<typeof messageSchema>

type MessageFormDialogProps = {
  eventId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function MessageFormDialog({
  eventId,
  open,
  onOpenChange,
  onSuccess,
}: MessageFormDialogProps) {
  const [submitting, setSubmitting] = React.useState(false)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<MessageRecipientPreview | null>(null)

  const form = useForm<MessageFormValues>({
    resolver: zodResolver(messageSchema),
    defaultValues: {
      channel: 'email',
      templateKey: 'admin-campaign',
      body: '',
      audience: 'all',
    },
  })
  const audience = form.watch('audience')
  const channel = form.watch('channel')
  const templateKey = form.watch('templateKey')

  React.useEffect(() => {
    if (!open || !eventId) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    void adminApi.previewMessageRecipients(eventId, {
      audience,
      channel,
      templateKey,
    }).then((result) => {
      if (cancelled) return
      setPreviewLoading(false)
      if (!result.ok) {
        setPreviewError(result.error.message)
        setPreview(null)
        return
      }
      setPreview(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [audience, channel, eventId, open, templateKey])

  const onSubmit = async (values: MessageFormValues) => {
    if (!eventId) {
      toast.error('Select an event first')
      return
    }
    setSubmitting(true)
    const input: SendMessageInput = {
      channel: values.channel,
      templateKey: values.templateKey,
      audience: values.audience,
      variables: { body: values.body },
    }
    const result = await adminApi.sendMessage(eventId, input)
    setSubmitting(false)
    if (result.ok) {
      toast.success('Campaign queued')
      onOpenChange(false)
      form.reset()
      onSuccess?.()
    } else {
      toast.error(result.error.message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>New Campaign</DialogTitle>
          <DialogDescription>
            Send an email or SMS message to attendees.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <FormField
                control={form.control}
                name='channel'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Channel</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value='email'>Email</SelectItem>
                        <SelectItem value='sms'>SMS</SelectItem>
                        <SelectItem value='both'>Email and SMS</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='audience'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Audience</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value='all'>All Attendees</SelectItem>
                        <SelectItem value='checked_in'>Checked In</SelectItem>
                        <SelectItem value='not_checked_in'>Not Checked In</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name='templateKey'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Template key</FormLabel>
                  <FormControl>
                    <Input placeholder='admin-campaign' {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='body'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder='Type your message...'
                      className='min-h-[100px] resize-none'
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Sent as template variables through the configured notification provider route.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className='rounded-md border p-3 text-sm'>
              <div className='flex items-center justify-between gap-3'>
                <p className='font-medium'>Recipient preview</p>
                <span className='text-muted-foreground'>
                  {previewLoading ? 'Loading...' : previewError ? 'Unavailable' : `${preview?.eligibleCount ?? 0} recipients`}
                </span>
              </div>
              {previewError ? (
                <p className='mt-2 text-destructive'>{previewError}</p>
              ) : preview && preview.eligibleCount > 0 ? (
                <div className='mt-2 max-h-28 space-y-1 overflow-y-auto text-xs text-muted-foreground'>
                  {preview.recipients.slice(0, 5).map((attendee) => (
                    <p key={attendee.id}>
                      {attendee.name} · {attendee.email ?? 'no email'}
                    </p>
                  ))}
                  {preview.eligibleCount > preview.recipients.length && <p>+{preview.eligibleCount - preview.recipients.length} more eligible</p>}
                  {(preview.suppressedRecipients > 0 || preview.consentExclusions > 0 || preview.skippedRecipients > 0) && (
                    <p>
                      {preview.suppressedRecipients} suppressed · {preview.consentExclusions} consent excluded · {preview.skippedRecipients} missing contact
                    </p>
                  )}
                </div>
              ) : !previewLoading ? (
                <p className='mt-2 text-muted-foreground'>No eligible recipients for the selected audience.</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type='submit' disabled={submitting}>
                {submitting ? 'Sending...' : 'Send Campaign'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
