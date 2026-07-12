'use client';

import * as React from 'react';
import { type Resolver, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  type CreateEventInput,
  type UpdateEventInput,
  type AdminEventDetail,
  adminApi,
} from '@/lib/api';
import { isoToTimezoneDatetimeInput, timezoneDatetimeInputToIso } from '@/lib/datetime';
import { useBootstrap } from '@/context/bootstrap-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { EventMarketingView } from './event-marketing-view';
import { EventScheduleView } from './event-schedule-view';
import { useAdminQuery } from '@/hooks/use-admin-table-data';

export const eventSchema = z
  .object({
    title: z.string().min(1, 'Title is required'),
    slug: z
      .string()
      .optional()
      .refine(
        (val) => !val || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(val),
        'Slug must be URL-safe (lowercase, hyphens only)',
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
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, 'Choose an ISO country code')
      .optional()
      .or(z.literal('')),
    capacity: z.number().int().positive().optional(),
    minimumAge: z.number().int().min(0).max(120).optional(),
    coverImageUrl: z.string().url('Cover image must be a valid URL').optional().or(z.literal('')),
    externalUrl: z.string().url('External URL must be a valid URL').optional().or(z.literal('')),
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),
    seoImageUrl: z.string().url('SEO image must be a valid URL').optional().or(z.literal('')),
    currency: z.string().min(1, 'Currency is required'),
  })
  .superRefine((data, ctx) => {
    // End date must be after start date when both are present.
    if (data.startsAt && data.endsAt && data.endsAt.trim() !== '') {
      const startIso = timezoneDatetimeInputToIso(data.startsAt, data.timezone);
      const endIso = timezoneDatetimeInputToIso(data.endsAt, data.timezone);
      const start = startIso ? new Date(startIso).getTime() : Number.NaN;
      const end = endIso ? new Date(endIso).getTime() : Number.NaN;
      if (Number.isNaN(start) || Number.isNaN(end)) return;
      if (end <= start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['endsAt'],
          message: 'End date must be after start date',
        });
      }
    }
  });

type EventFormValues = z.infer<typeof eventSchema>;
type EventFormDirtyFields = Partial<Record<keyof EventFormValues, unknown>>;

export function buildEventDatePayload(
  values: Pick<EventFormValues, 'startsAt' | 'endsAt' | 'timezone'>,
) {
  const startsAt = timezoneDatetimeInputToIso(values.startsAt, values.timezone);
  const endsAt = timezoneDatetimeInputToIso(values.endsAt, values.timezone);
  return startsAt ? { startsAt, endsAt } : null;
}

const emptyStringToUndefined = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const emptyStringToNull = (value?: string) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

function buildVenuePayload(values: EventFormValues): AdminEventDetail['venue'] {
  const venue = {
    name: emptyStringToUndefined(values.venueName),
    address: emptyStringToUndefined(values.address),
    city: emptyStringToUndefined(values.city),
    region: emptyStringToUndefined(values.region),
    postalCode: emptyStringToUndefined(values.postalCode),
    country: emptyStringToUndefined(values.country),
  };
  return Object.values(venue).some(Boolean) ? venue : null;
}

function buildSeoPayload(values: EventFormValues) {
  return {
    title: emptyStringToUndefined(values.seoTitle),
    description: emptyStringToUndefined(values.seoDescription),
    imageUrl: emptyStringToUndefined(values.seoImageUrl),
  };
}

function hasDirtyField(dirtyFields: EventFormDirtyFields, fields: Array<keyof EventFormValues>) {
  return fields.some((field) => Boolean(dirtyFields[field]));
}

function hasChangedField(
  values: EventFormValues,
  dirtyFields: EventFormDirtyFields,
  initialValues: EventFormValues | undefined,
  field: keyof EventFormValues,
) {
  return (
    Boolean(dirtyFields[field]) ||
    (initialValues !== undefined && values[field] !== initialValues[field])
  );
}

function hasChangedAnyField(
  values: EventFormValues,
  dirtyFields: EventFormDirtyFields,
  initialValues: EventFormValues | undefined,
  fields: Array<keyof EventFormValues>,
) {
  if (hasDirtyField(dirtyFields, fields)) return true;
  return fields.some((field) => hasChangedField(values, dirtyFields, initialValues, field));
}

export function buildEventUpdatePayload(
  values: EventFormValues,
  dirtyFields: EventFormDirtyFields,
  initialValues?: EventFormValues,
): UpdateEventInput | null {
  const payload: UpdateEventInput = {};
  if (hasChangedField(values, dirtyFields, initialValues, 'title')) payload.title = values.title;
  if (hasChangedField(values, dirtyFields, initialValues, 'slug')) payload.slug = values.slug;
  if (hasChangedField(values, dirtyFields, initialValues, 'description'))
    payload.description = values.description;
  if (hasChangedField(values, dirtyFields, initialValues, 'currency'))
    payload.currency = values.currency;
  // Status is intentionally excluded from the PATCH payload. The API requires
  // dedicated /publish, /pause, /archive endpoints for status transitions.
  // The form's onSubmit handler calls these endpoints separately after the PATCH.
  if (hasChangedField(values, dirtyFields, initialValues, 'visibility'))
    payload.visibility = values.visibility;

  if (hasChangedAnyField(values, dirtyFields, initialValues, ['startsAt', 'endsAt', 'timezone'])) {
    const datePayload = buildEventDatePayload(values);
    if (!datePayload) return null;
    payload.startsAt = datePayload.startsAt;
    payload.endsAt = values.endsAt?.trim() ? datePayload.endsAt : null;
    payload.timezone = values.timezone;
  }

  if (
    hasChangedAnyField(values, dirtyFields, initialValues, [
      'venueName',
      'address',
      'city',
      'region',
      'postalCode',
      'country',
    ])
  ) {
    payload.venue = buildVenuePayload(values);
  }

  if (
    hasChangedAnyField(values, dirtyFields, initialValues, [
      'seoTitle',
      'seoDescription',
      'seoImageUrl',
    ])
  ) {
    payload.seo = buildSeoPayload(values);
  }

  if (hasChangedField(values, dirtyFields, initialValues, 'capacity'))
    payload.capacity = values.capacity ?? null;
  if (hasChangedField(values, dirtyFields, initialValues, 'minimumAge'))
    payload.minimumAge = values.minimumAge ?? null;
  if (hasChangedField(values, dirtyFields, initialValues, 'coverImageUrl'))
    payload.coverImageUrl = emptyStringToNull(values.coverImageUrl);
  if (hasChangedField(values, dirtyFields, initialValues, 'externalUrl'))
    payload.externalUrl = emptyStringToNull(values.externalUrl);

  return payload;
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
];

const commonCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD'];
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const nonIsoRegionCodes = new Set(['EU', 'UN', 'XA', 'XB', 'ZZ']);
const countries = Array.from({ length: 26 * 26 }, (_, index) =>
  String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)),
)
  .filter((code) => !nonIsoRegionCodes.has(code) && regionNames.of(code) !== code)
  .map((code) => [code, regionNames.of(code) ?? code] as const)
  .sort((left, right) => left[1].localeCompare(right[1]));

type EventFormProps = {
  event?: AdminEventDetail;
  onSuccess?: (event: AdminEventDetail) => void;
  onCancel?: () => void;
  section?: 'all' | 'basics' | 'schedule' | 'sales' | 'marketing';
  autosave?: boolean;
};

type ScheduleMode = 'one-time' | 'multiple';

export function EventForm({
  event,
  onSuccess,
  onCancel,
  section = 'all',
  autosave = false,
}: EventFormProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const [saveState, setSaveState] = React.useState<
    'idle' | 'saving' | 'saved' | 'offline' | 'conflict'
  >('idle');
  const [scheduleMode, setScheduleMode] = React.useState<ScheduleMode>('one-time');
  const [selectedVenueId, setSelectedVenueId] = React.useState('');
  const { organizationId, brandId, loading: bootstrapLoading } = useBootstrap();
  const createDisabled = !event && (bootstrapLoading || !organizationId || !brandId);
  const { data: existingOccurrences } = useAdminQuery(
    ['listEventOccurrences', event?.id ?? 'none', 'form-schedule-mode'],
    () => adminApi.listEventOccurrences(event!.id),
    { enabled: Boolean(event?.id) },
  );
  const { data: savedVenues, refetch: refetchSavedVenues } = useAdminQuery(
    ['listSavedVenues', organizationId ?? 'none'],
    () => adminApi.listSavedVenues(organizationId!),
    { enabled: Boolean(organizationId) },
  );

  React.useEffect(() => {
    if (!event) {
      setScheduleMode('one-time');
      return;
    }
    if ((existingOccurrences?.length ?? 0) > 0) {
      setScheduleMode('multiple');
    }
  }, [event, existingOccurrences]);

  const initialValues = React.useMemo<EventFormValues>(
    () =>
      event
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
            minimumAge: event.minimumAge ?? undefined,
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
            minimumAge: undefined,
            coverImageUrl: '',
            externalUrl: '',
            seoTitle: '',
            seoDescription: '',
            seoImageUrl: '',
            currency: 'USD',
          },
    [event],
  );

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema) as Resolver<EventFormValues>,
    defaultValues: initialValues,
  });
  const { dirtyFields } = form.formState;
  const recoveryKey = event ? `tixkit:event-conflict:${event.id}:${section}` : undefined;

  React.useEffect(() => {
    if (!recoveryKey) return;
    const raw = window.sessionStorage.getItem(recoveryKey);
    if (!raw) return;
    window.sessionStorage.removeItem(recoveryKey);
    try {
      const recovery = JSON.parse(raw) as {
        values: EventFormValues;
        dirtyFields: Array<keyof EventFormValues>;
      };
      const merged = { ...initialValues };
      for (const field of recovery.dirtyFields) merged[field] = recovery.values[field] as never;
      form.reset(merged, { keepDefaultValues: true });
      setSaveState('idle');
      toast.info(
        'Your unsaved edits were restored over the latest event version. Review and save them.',
      );
    } catch {
      window.sessionStorage.removeItem(recoveryKey);
    }
  }, [form, initialValues, recoveryKey]);

  const reloadLatestPreservingEdits = () => {
    if (!recoveryKey) return;
    const changedFields = Object.entries(form.formState.dirtyFields)
      .filter(([, dirty]) => Boolean(dirty))
      .map(([field]) => field as keyof EventFormValues);
    window.sessionStorage.setItem(
      recoveryKey,
      JSON.stringify({ values: form.getValues(), dirtyFields: changedFields }),
    );
    window.location.reload();
  };

  const onSubmit = async (values: EventFormValues) => {
    if (!event && (!organizationId || !brandId)) {
      toast.error(
        'Workspace and brand context are required to create an event. Please ensure your account is properly configured.',
      );
      return;
    }
    setSubmitting(true);
    setSaveState('saving');
    try {
      const datePayload = buildEventDatePayload(values);
      if (!datePayload) {
        toast.error('Start date must be a valid date and time');
        return;
      }

      const venue = buildVenuePayload(values) ?? undefined;
      const seo = buildSeoPayload(values);

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
        minimumAge: values.minimumAge,
        externalUrl: emptyStringToUndefined(values.externalUrl),
        currency: values.currency,
      };

      const updateInput = event
        ? buildEventUpdatePayload(values, dirtyFields as EventFormDirtyFields, initialValues)
        : null;
      if (selectedVenueId) {
        createInput.venueId = selectedVenueId;
        if (updateInput) updateInput.venueId = selectedVenueId;
      }
      if (event && !updateInput) {
        toast.error('Start date must be a valid date and time');
        return;
      }
      if (event?.version && updateInput) updateInput.expectedVersion = event.version;

      const result = event
        ? await adminApi.updateEvent(event.id, updateInput as UpdateEventInput)
        : await adminApi.createEvent(createInput);

      if (result.ok) {
        setSaveState('saved');
        form.reset(values);
        toast.success(event ? 'Event updated' : 'Event created');
        onSuccess?.(result.data);
      } else {
        const stale = result.error.code === 'stale_event_version';
        setSaveState(stale ? 'conflict' : 'idle');
        if (stale) {
          void adminApi.reportOnboardingEvent({
            stage: 'stale_version_conflict',
            outcome: 'failed',
            reasonCode: 'stale_event_version',
          });
        }
        if (autosave) {
          void adminApi.reportOnboardingEvent({
            stage: 'autosave_failure',
            outcome: 'failed',
            reasonCode: stale ? 'stale_event_version' : 'request_failed',
          });
        }
        toast.error(result.error.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitRef = React.useRef(onSubmit);
  submitRef.current = onSubmit;
  React.useEffect(() => {
    if (!autosave || !event) return;
    let timeout: number | undefined;
    const subscription = form.watch(() => {
      window.clearTimeout(timeout);
      if (!navigator.onLine) {
        setSaveState('offline');
        return;
      }
      setSaveState('idle');
      timeout = window.setTimeout(() => {
        void form.handleSubmit((values) => submitRef.current(values))();
      }, 800);
    });
    const retry = () => {
      if (!form.formState.isDirty) return;
      setSaveState('idle');
      void form.handleSubmit((values) => submitRef.current(values))();
    };
    window.addEventListener('online', retry);
    return () => {
      window.clearTimeout(timeout);
      subscription.unsubscribe();
      window.removeEventListener('online', retry);
    };
  }, [autosave, event, form]);

  React.useEffect(() => {
    if (!autosave || !form.formState.isDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [autosave, form.formState.isDirty]);

  return (
    <Form {...form}>
      <form
        id={section === 'all' ? 'basics' : `${section}-form`}
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
      >
        {section === 'all' || section === 'basics' ? (
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl>
                  <Input placeholder="My Awesome Event" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {section === 'all' || section === 'basics' ? (
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Slug</FormLabel>
                  <FormControl>
                    <Input placeholder="my-awesome-event" {...field} />
                  </FormControl>
                  <FormDescription>URL-safe, auto-generated if empty</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
          {section === 'all' || section === 'sales' ? (
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select currency" />
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
          ) : null}
        </div>
        <div
          id={section === 'all' ? 'sales' : `${section}-sales-controls`}
          className="scroll-mt-6 grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {section === 'all' || section === 'basics' ? (
            <FormField
              control={form.control}
              name="visibility"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Visibility</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select visibility" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="public">Public</SelectItem>
                      <SelectItem value="unlisted">Unlisted</SelectItem>
                      <SelectItem value="private">Private</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
          {section === 'all' || section === 'sales' ? (
            <FormField
              control={form.control}
              name="capacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Capacity</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="Unlimited"
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
          ) : null}
          {section === 'all' || section === 'sales' ? (
            <FormField
              control={form.control}
              name="minimumAge"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Minimum age</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={120}
                      inputMode="numeric"
                      placeholder="No restriction"
                      title="Checked on the attendee’s event date."
                      value={field.value ?? ''}
                      onChange={(changeEvent) =>
                        field.onChange(
                          changeEvent.target.value ? Number(changeEvent.target.value) : undefined,
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
        </div>
        {section === 'all' || section === 'basics' ? (
          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Describe your event..."
                    className="resize-none"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}
        {section === 'all' || section === 'schedule' ? (
          <>
            <div
              id={section === 'all' ? 'schedule' : `${section}-schedule-controls`}
              className="scroll-mt-6 space-y-3 rounded-lg border p-3"
            >
              <div className="space-y-1">
                <p className="text-sm font-medium">Schedule</p>
                <p className="text-xs text-muted-foreground">
                  Choose a one-time event or manage multiple occurrences for tickets and check-in.
                </p>
              </div>
              <Tabs
                value={scheduleMode}
                onValueChange={(value) => setScheduleMode(value as ScheduleMode)}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="one-time" className="flex-1">
                    One-time event
                  </TabsTrigger>
                  <TabsTrigger value="multiple" className="flex-1">
                    Multiple occurrences
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              {scheduleMode === 'one-time' ? (
                <div className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="startsAt"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Start Date</FormLabel>
                          <FormControl>
                            <Input type="datetime-local" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="endsAt"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>End Date</FormLabel>
                          <FormControl>
                            <Input type="datetime-local" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="timezone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Timezone</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select timezone" />
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
                </div>
              ) : event ? (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Primary event start/end stay on the event for listings. Add each public
                    occurrence below; ticket types can be scoped to specific ones.
                  </p>
                  {/* Keep required date fields in the form when multi-occurrence is selected. */}
                  <div className="hidden">
                    <FormField
                      control={form.control}
                      name="startsAt"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input type="datetime-local" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="endsAt"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input type="datetime-local" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="timezone"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                  <EventScheduleView eventId={event.id} embedded />
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Set the primary event window now. After creating the event, open Edit to add
                    individual occurrences.
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="startsAt"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Primary Start</FormLabel>
                          <FormControl>
                            <Input type="datetime-local" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="endsAt"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Primary End</FormLabel>
                          <FormControl>
                            <Input type="datetime-local" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="timezone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Timezone</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select timezone" />
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
                </div>
              )}
            </div>
            <div id="schedule-venue" className="scroll-mt-6 grid gap-4 sm:grid-cols-2">
              {(savedVenues?.length ?? 0) > 0 ? (
                <div className="space-y-2 sm:col-span-2">
                  <label className="text-sm font-medium" htmlFor="event-saved-venue">
                    Saved venue
                  </label>
                  <select
                    id="event-saved-venue"
                    className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    value={selectedVenueId}
                    onChange={(change) => {
                      const venueId = change.target.value;
                      setSelectedVenueId(venueId);
                      const venue = savedVenues?.find((candidate) => candidate.id === venueId);
                      if (!venue) return;
                      form.setValue('venueName', venue.name, { shouldDirty: true });
                      form.setValue('address', venue.address.address ?? '', { shouldDirty: true });
                      form.setValue('city', venue.address.city ?? '', { shouldDirty: true });
                      form.setValue('region', venue.address.region ?? '', { shouldDirty: true });
                      form.setValue('postalCode', venue.address.postalCode ?? '', {
                        shouldDirty: true,
                      });
                      form.setValue('country', venue.address.country ?? '', { shouldDirty: true });
                      if (venue.timezone)
                        form.setValue('timezone', venue.timezone, { shouldDirty: true });
                    }}
                  >
                    <option value="">Use inline venue details</option>
                    {savedVenues?.map((venue) => (
                      <option key={venue.id} value={venue.id}>
                        {venue.name}
                      </option>
                    ))}
                  </select>
                  {selectedVenueId ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          const values = form.getValues();
                          const result = await adminApi.updateSavedVenue(selectedVenueId, {
                            name: values.venueName || 'Venue',
                            address: {
                              address: values.address,
                              city: values.city,
                              region: values.region,
                              postalCode: values.postalCode,
                              country: values.country,
                            },
                            timezone: values.timezone,
                          });
                          if (result.ok) {
                            toast.success('Saved venue updated');
                            await refetchSavedVenues();
                          } else toast.error(result.error.message);
                        }}
                      >
                        Save venue changes
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={async () => {
                          if (
                            !window.confirm(
                              'Delete this saved venue? Events already using it must be changed first.',
                            )
                          )
                            return;
                          const result = await adminApi.deleteSavedVenue(selectedVenueId);
                          if (result.ok) {
                            setSelectedVenueId('');
                            toast.success('Saved venue deleted');
                            await refetchSavedVenues();
                          } else toast.error(result.error.message);
                        }}
                      >
                        Delete saved venue
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <FormField
                control={form.control}
                name="venueName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Venue Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Venue Hall" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Address</FormLabel>
                    <FormControl>
                      <Input placeholder="123 Main St" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input placeholder="Austin" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Region</FormLabel>
                    <FormControl>
                      <Input placeholder="TX" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Postal Code</FormLabel>
                    <FormControl>
                      <Input placeholder="78701" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Country</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value || undefined}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select country" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {countries.map(([code, label]) => (
                        <SelectItem key={code} value={code}>
                          {label} ({code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!selectedVenueId && organizationId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  const values = form.getValues();
                  if (!values.venueName?.trim()) {
                    toast.error('Enter a venue name before saving it');
                    return;
                  }
                  const result = await adminApi.createSavedVenue({
                    organizationId,
                    name: values.venueName.trim(),
                    address: {
                      address: values.address,
                      city: values.city,
                      region: values.region,
                      postalCode: values.postalCode,
                      country: values.country,
                    },
                    timezone: values.timezone,
                  });
                  if (result.ok) {
                    setSelectedVenueId(result.data.id);
                    toast.success('Venue saved for reuse');
                    await refetchSavedVenues();
                  } else toast.error(result.error.message);
                }}
              >
                Save as reusable venue
              </Button>
            ) : null}
          </>
        ) : null}
        {section === 'all' || section === 'marketing' ? (
          <>
            <div id="media-fields" className="scroll-mt-6 grid gap-4 sm:grid-cols-2">
              <p className="text-sm text-muted-foreground">
                Cover and social images are managed in the Media section through the owned upload
                pipeline.
              </p>
              <FormField
                control={form.control}
                name="externalUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>External URL</FormLabel>
                    <FormControl>
                      <Input placeholder="https://example.com/event" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div
              id={section === 'all' ? 'marketing-fields' : `${section}-marketing-controls`}
              className="scroll-mt-6 space-y-3 rounded-lg border p-3"
            >
              <div className="space-y-1">
                <p className="text-sm font-medium">Marketing</p>
                <p className="text-xs text-muted-foreground">
                  SEO metadata and tracking pixels for hosted event pages and checkout.
                </p>
              </div>
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <p className="text-sm font-medium">SEO</p>
                  <p className="text-xs text-muted-foreground">
                    Optional page metadata used by hosted event pages and previews.
                  </p>
                </div>
                <FormField
                  control={form.control}
                  name="seoTitle"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SEO Title</FormLabel>
                      <FormControl>
                        <Input placeholder="Summer Music Festival tickets" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="seoDescription"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SEO Description</FormLabel>
                      <FormControl>
                        <Textarea
                          className="resize-none"
                          placeholder="Short search/social summary"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-sm text-muted-foreground">
                  Upload the social image in the Media section, or reuse the event cover.
                </p>
              </div>
              {event ? (
                <EventMarketingView eventId={event.id} embedded />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Tracking pixels can be connected after the event is created.
                </p>
              )}
            </div>
          </>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          {autosave && event ? (
            <div className="flex items-center gap-2">
              <output className="self-center text-sm text-muted-foreground">
                {saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'saved'
                    ? 'Saved'
                    : saveState === 'offline'
                      ? 'Offline — changes are unsaved'
                      : saveState === 'conflict'
                        ? 'Conflict — review the newer version'
                        : form.formState.isDirty
                          ? 'Unsaved changes'
                          : ''}
              </output>
              {saveState === 'conflict' ? (
                <Button type="button" variant="outline" onClick={reloadLatestPreservingEdits}>
                  Reload latest and keep my edits
                </Button>
              ) : null}
            </div>
          ) : null}
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={submitting || createDisabled || saveState === 'conflict'}>
            {submitting ? 'Saving...' : event ? 'Save Changes' : 'Create Event'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
