'use client';

import * as React from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  type AdminContentDocument,
  type MessageRecipientPreview,
  type SendMessageInput,
  adminApi,
} from '@/lib/api';
import { routes } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';

const MAX_MESSAGE_BODY_LENGTH = 5_000;

const messageSchema = z
  .object({
    channel: z.enum(['email', 'sms', 'both']),
    emailTemplateKey: z.string().trim(),
    smsTemplateKey: z.string().trim(),
    body: z
      .string()
      .trim()
      .min(1, 'Message body is required')
      .max(MAX_MESSAGE_BODY_LENGTH, 'Message body is too long'),
    audience: z.enum(['all', 'checked_in', 'not_checked_in']),
  })
  .superRefine((values, ctx) => {
    if ((values.channel === 'email' || values.channel === 'both') && !values.emailTemplateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['emailTemplateKey'],
        message: 'Choose a published email template',
      });
    }
    if ((values.channel === 'sms' || values.channel === 'both') && !values.smsTemplateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smsTemplateKey'],
        message: 'Choose a published SMS template',
      });
    }
  });

type MessageFormValues = z.infer<typeof messageSchema>;

const defaultMessageFormValues: MessageFormValues = {
  channel: 'email',
  emailTemplateKey: '',
  smsTemplateKey: '',
  body: '',
  audience: 'all',
};

type MessageFormDialogProps = {
  eventId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
};

type TemplateChannel = 'email' | 'sms';

function templateScopeLabel(template: AdminContentDocument, eventId: string) {
  return template.eventId === eventId ? 'Event' : 'Brand';
}

function templateOptionLabel(template: AdminContentDocument, eventId: string) {
  return `${template.name} · Published · ${templateScopeLabel(template, eventId)}`;
}

function publishedTemplates(
  documents: AdminContentDocument[],
  channel: TemplateChannel,
  eventId: string,
) {
  const seen = new Set<string>();
  const templates: AdminContentDocument[] = [];
  for (const document of documents) {
    if (
      document.channel !== channel ||
      document.status !== 'published' ||
      !document.publishedVersionId ||
      (document.eventId && document.eventId !== eventId) ||
      seen.has(document.key)
    ) {
      continue;
    }
    seen.add(document.key);
    templates.push(document);
  }
  return templates;
}

function chooseTemplateKey(currentKey: string, templates: AdminContentDocument[]) {
  if (templates.some((template) => template.key === currentKey)) return currentKey;
  return templates[0]?.key ?? '';
}

export function MessageFormDialog({
  eventId,
  open,
  onOpenChange,
  onSuccess,
}: MessageFormDialogProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<MessageRecipientPreview | null>(null);
  const [templateLoading, setTemplateLoading] = React.useState(false);
  const [templateError, setTemplateError] = React.useState<string | null>(null);
  const [emailTemplates, setEmailTemplates] = React.useState<AdminContentDocument[]>([]);
  const [smsTemplates, setSmsTemplates] = React.useState<AdminContentDocument[]>([]);

  const form = useForm<MessageFormValues>({
    resolver: zodResolver(messageSchema),
    defaultValues: defaultMessageFormValues,
  });
  const audience = form.watch('audience');
  const channel = form.watch('channel');
  const emailTemplateKey = form.watch('emailTemplateKey');
  const smsTemplateKey = form.watch('smsTemplateKey');
  const messageBody = form.watch('body');
  const requiresEmail = channel === 'email' || channel === 'both';
  const requiresSms = channel === 'sms' || channel === 'both';
  const selectedEmailTemplate = emailTemplates.find(
    (template) => template.key === emailTemplateKey,
  );
  const selectedSmsTemplate = smsTemplates.find((template) => template.key === smsTemplateKey);
  const templatesReady =
    !templateLoading &&
    !templateError &&
    (!requiresEmail || Boolean(selectedEmailTemplate)) &&
    (!requiresSms || Boolean(selectedSmsTemplate));
  const eligibleRecipients = preview?.eligibleCount ?? 0;
  const canSendCampaign =
    Boolean(eventId) &&
    templatesReady &&
    messageBody.trim().length > 0 &&
    !submitting &&
    !previewLoading &&
    !previewError &&
    eligibleRecipients > 0;

  React.useEffect(() => {
    if (!open) {
      form.reset(defaultMessageFormValues);
      setTemplateLoading(false);
      setTemplateError(null);
      setEmailTemplates([]);
      setSmsTemplates([]);
    }
  }, [form, open]);

  React.useEffect(() => {
    if (!open || !eventId) {
      setTemplateLoading(false);
      setTemplateError(null);
      setEmailTemplates([]);
      setSmsTemplates([]);
      return;
    }

    const currentEventId = eventId;
    let cancelled = false;
    setTemplateLoading(true);
    setTemplateError(null);

    async function loadTemplates() {
      const eventResult = await adminApi.getEvent(currentEventId);
      if (!eventResult.ok) {
        throw new Error(eventResult.error.message);
      }

      const eventBrandId = eventResult.data.brandId;
      const [eventEmailResult, eventSmsResult] = await Promise.all([
        adminApi.listContentDocuments({ channel: 'email', eventId: currentEventId, limit: 50 }),
        adminApi.listContentDocuments({ channel: 'sms', eventId: currentEventId, limit: 50 }),
      ]);
      if (!eventEmailResult.ok) throw new Error(eventEmailResult.error.message);
      if (!eventSmsResult.ok) throw new Error(eventSmsResult.error.message);

      let brandEmailDocuments: AdminContentDocument[] = [];
      let brandSmsDocuments: AdminContentDocument[] = [];
      if (eventBrandId) {
        const [brandEmailResult, brandSmsResult] = await Promise.all([
          adminApi.listContentDocuments({ channel: 'email', brandId: eventBrandId, limit: 50 }),
          adminApi.listContentDocuments({ channel: 'sms', brandId: eventBrandId, limit: 50 }),
        ]);
        if (!brandEmailResult.ok) throw new Error(brandEmailResult.error.message);
        if (!brandSmsResult.ok) throw new Error(brandSmsResult.error.message);
        brandEmailDocuments = brandEmailResult.data.items;
        brandSmsDocuments = brandSmsResult.data.items;
      }

      const nextEmailTemplates = publishedTemplates(
        [...eventEmailResult.data.items, ...brandEmailDocuments],
        'email',
        currentEventId,
      );
      const nextSmsTemplates = publishedTemplates(
        [...eventSmsResult.data.items, ...brandSmsDocuments],
        'sms',
        currentEventId,
      );

      if (cancelled) return;
      setEmailTemplates(nextEmailTemplates);
      setSmsTemplates(nextSmsTemplates);
      setTemplateLoading(false);
    }

    void loadTemplates().catch((error: unknown) => {
      if (cancelled) return;
      setTemplateLoading(false);
      setEmailTemplates([]);
      setSmsTemplates([]);
      setTemplateError(error instanceof Error ? error.message : 'Unable to load templates.');
    });

    return () => {
      cancelled = true;
    };
  }, [eventId, form, open]);

  React.useEffect(() => {
    if (!open || emailTemplates.length === 0) return;
    const nextKey = chooseTemplateKey(emailTemplateKey, emailTemplates);
    if (nextKey !== emailTemplateKey) {
      form.setValue('emailTemplateKey', nextKey, { shouldValidate: true });
    }
  }, [emailTemplateKey, emailTemplates, form, open]);

  React.useEffect(() => {
    if (!open || smsTemplates.length === 0) return;
    const nextKey = chooseTemplateKey(smsTemplateKey, smsTemplates);
    if (nextKey !== smsTemplateKey) {
      form.setValue('smsTemplateKey', nextKey, { shouldValidate: true });
    }
  }, [form, open, smsTemplateKey, smsTemplates]);

  React.useEffect(() => {
    if (!open || !eventId) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    void adminApi
      .previewMessageRecipients(eventId, {
        audience,
        channel,
      })
      .then((result) => {
        if (cancelled) return;
        setPreviewLoading(false);
        if (!result.ok) {
          setPreviewError(result.error.message);
          setPreview(null);
          return;
        }
        setPreview(result.data);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewLoading(false);
        setPreview(null);
        setPreviewError(
          error instanceof Error ? error.message : 'Unable to load recipient preview.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [audience, channel, eventId, open]);

  const onSubmit = async (values: MessageFormValues) => {
    if (!eventId) {
      toast.error('Select an event first');
      return;
    }
    if (!templatesReady) {
      toast.error('Choose the required published templates before sending this campaign');
      return;
    }
    if (previewLoading || previewError || !preview || preview.eligibleCount === 0) {
      toast.error('Resolve the recipient preview before sending this campaign');
      return;
    }
    setSubmitting(true);
    const input: SendMessageInput =
      values.channel === 'email'
        ? {
            channel: 'email',
            emailTemplateKey: values.emailTemplateKey,
            audience: values.audience,
            variables: { body: values.body },
          }
        : values.channel === 'sms'
          ? {
              channel: 'sms',
              smsTemplateKey: values.smsTemplateKey,
              audience: values.audience,
              variables: { body: values.body },
            }
          : {
              channel: 'both',
              emailTemplateKey: values.emailTemplateKey,
              smsTemplateKey: values.smsTemplateKey,
              audience: values.audience,
              variables: { body: values.body },
            };
    try {
      const result = await adminApi.sendMessage(eventId, input);
      if (result.ok) {
        toast.success('Campaign queued');
        onOpenChange(false);
        form.reset(defaultMessageFormValues);
        onSuccess?.();
      } else {
        toast.error(result.error.message);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to send campaign');
    } finally {
      setSubmitting(false);
    }
  };

  const templateReadinessMessage = templateLoading
    ? 'Loading published templates...'
    : templateError
      ? templateError
      : channel === 'both' && (!selectedEmailTemplate || !selectedSmsTemplate)
        ? 'Email and SMS requires one published template for each channel.'
        : requiresEmail && !selectedEmailTemplate
          ? 'Publish an email template before sending email campaigns.'
          : requiresSms && !selectedSmsTemplate
            ? 'Publish an SMS template before sending SMS campaigns.'
            : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Campaign</DialogTitle>
          <DialogDescription>Send an email or SMS message to attendees.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="channel"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Channel</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="sms">SMS</SelectItem>
                        <SelectItem value="both">Email and SMS</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="audience"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Audience</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="all">All Attendees</SelectItem>
                        <SelectItem value="checked_in">Checked In</SelectItem>
                        <SelectItem value="not_checked_in">Not Checked In</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3 rounded-md border p-3">
              {requiresEmail && (
                <FormField
                  control={form.control}
                  name="emailTemplateKey"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FormLabel>Email template</FormLabel>
                        <Button asChild size="sm" variant="outline" className="h-8">
                          <Link href={eventId ? routes.eventContentEmail(eventId) : routes.events}>
                            Create/edit email template
                          </Link>
                        </Button>
                      </div>
                      <Select
                        disabled={templateLoading || emailTemplates.length === 0}
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue
                              placeholder={
                                templateLoading
                                  ? 'Loading published email templates'
                                  : 'Choose published email template'
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {emailTemplates.map((template) => (
                            <SelectItem key={template.id} value={template.key}>
                              {templateOptionLabel(template, eventId ?? '')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {emailTemplates.length === 0 && !templateLoading && (
                        <FormDescription>
                          Publish an email template before sending email campaigns.
                        </FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {requiresSms && (
                <FormField
                  control={form.control}
                  name="smsTemplateKey"
                  render={({ field }) => (
                    <FormItem>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <FormLabel>SMS template</FormLabel>
                        <Button asChild size="sm" variant="outline" className="h-8">
                          <Link href={eventId ? routes.eventContentSms(eventId) : routes.events}>
                            Create/edit SMS template
                          </Link>
                        </Button>
                      </div>
                      <Select
                        disabled={templateLoading || smsTemplates.length === 0}
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue
                              placeholder={
                                templateLoading
                                  ? 'Loading published SMS templates'
                                  : 'Choose published SMS template'
                              }
                            />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {smsTemplates.map((template) => (
                            <SelectItem key={template.id} value={template.key}>
                              {templateOptionLabel(template, eventId ?? '')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {smsTemplates.length === 0 && !templateLoading && (
                        <FormDescription>
                          Publish an SMS template before sending SMS campaigns.
                        </FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {templateReadinessMessage && (
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {templateReadinessMessage}
                </p>
              )}
            </div>

            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Type your message..."
                      className="min-h-[100px] resize-none"
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
            <div className="rounded-md border p-3 text-sm" aria-busy={previewLoading}>
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">Recipient preview</p>
                <output className="text-muted-foreground" aria-live="polite">
                  {previewLoading
                    ? 'Loading...'
                    : previewError
                      ? 'Unavailable'
                      : preview
                        ? `${preview.eligibleCount} recipients`
                        : 'Pending'}
                </output>
              </div>
              {previewError ? (
                <p className="mt-2 text-destructive">{previewError}</p>
              ) : preview && preview.eligibleCount > 0 ? (
                <div className="mt-2 max-h-28 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {preview.recipients.slice(0, 5).map((attendee) => (
                    <p key={attendee.id}>
                      {attendee.name} · {attendee.email ?? attendee.phone ?? 'no contact'}
                    </p>
                  ))}
                  {preview.eligibleCount > preview.recipients.length && (
                    <p>+{preview.eligibleCount - preview.recipients.length} more eligible</p>
                  )}
                  {(preview.suppressedRecipients > 0 ||
                    preview.consentExclusions > 0 ||
                    preview.skippedRecipients > 0) && (
                    <p>
                      {preview.suppressedRecipients} suppressed · {preview.consentExclusions}{' '}
                      consent excluded · {preview.skippedRecipients} missing contact
                    </p>
                  )}
                </div>
              ) : !previewLoading ? (
                <p className="mt-2 text-muted-foreground">
                  No eligible recipients match this channel and audience.
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSendCampaign}>
                {submitting ? 'Sending...' : 'Send Campaign'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
