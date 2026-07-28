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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

export type EventFormValues = z.infer<typeof eventSchema>;
type EventFormDirtyFields = Partial<Record<keyof EventFormValues, unknown>>;

export type EventFormRecoverySnapshot = {
  schemaVersion: 1;
  values: EventFormValues;
  baseValues?: EventFormValues;
  dirtyFields: Array<keyof EventFormValues>;
  selectedVenueId: string;
  baseSelectedVenueId?: string;
  unresolvedConflicts?: EventFormConflictKey[];
};

export type EventFormConflictKey = keyof EventFormValues | 'schedule' | 'venue' | 'seo';

export type EventFormRecoveryPlan = {
  values: EventFormValues;
  selectedVenueId: string;
  conflicts: EventFormConflictKey[];
};

const eventFormConflictGroups = {
  schedule: ['startsAt', 'endsAt', 'timezone'],
  venue: ['venueName', 'address', 'city', 'region', 'postalCode', 'country'],
  seo: ['seoTitle', 'seoDescription', 'seoImageUrl'],
} as const satisfies Record<string, ReadonlyArray<keyof EventFormValues>>;

function eventFormConflictKey(field: keyof EventFormValues): EventFormConflictKey {
  for (const [group, fields] of Object.entries(eventFormConflictGroups)) {
    if ((fields as ReadonlyArray<keyof EventFormValues>).includes(field))
      return group as keyof typeof eventFormConflictGroups;
  }
  return field;
}

function formValuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

export function planEventFormRecovery(
  latestValues: EventFormValues,
  recovery: EventFormRecoverySnapshot,
  latestSelectedVenueId = '',
): EventFormRecoveryPlan {
  const values = { ...latestValues };
  const conflicts = new Set<EventFormConflictKey>();
  const touched = new Set<EventFormConflictKey>();
  for (const field of recovery.dirtyFields) {
    const localValue = recovery.values[field];
    const latestValue = latestValues[field];
    if (formValuesEqual(localValue, latestValue)) continue;
    values[field] = localValue as never;
    const conflictKey = eventFormConflictKey(field);
    touched.add(conflictKey);
    const baseValue = recovery.baseValues?.[field];
    if (
      !(conflictKey in eventFormConflictGroups) &&
      (!recovery.baseValues || !formValuesEqual(baseValue, latestValue))
    )
      conflicts.add(conflictKey);
  }
  for (const [group, fields] of Object.entries(eventFormConflictGroups)) {
    const conflictKey = group as keyof typeof eventFormConflictGroups;
    if (!touched.has(conflictKey)) continue;
    for (const field of fields) values[field] = recovery.values[field] as never;
  }
  const localVenueSelectionChanged =
    recovery.selectedVenueId !== (recovery.baseSelectedVenueId ?? '');
  const remoteVenueSelectionChanged =
    recovery.baseSelectedVenueId === undefined ||
    latestSelectedVenueId !== recovery.baseSelectedVenueId;
  const localVenueGroupTouched = touched.has('venue');
  const selectedVenueId =
    localVenueSelectionChanged || localVenueGroupTouched
      ? recovery.selectedVenueId
      : latestSelectedVenueId;
  if (localVenueSelectionChanged) touched.add('venue');
  for (const [group, fields] of Object.entries(eventFormConflictGroups)) {
    const conflictKey = group as keyof typeof eventFormConflictGroups;
    if (!touched.has(conflictKey)) continue;
    const remoteFieldsChanged =
      !recovery.baseValues ||
      fields.some((field) => !formValuesEqual(recovery.baseValues?.[field], latestValues[field]));
    const localDiffersFromLatest = fields.some(
      (field) => !formValuesEqual(values[field], latestValues[field]),
    );
    const venueSelectionConflicts =
      conflictKey === 'venue' &&
      (remoteFieldsChanged || remoteVenueSelectionChanged) &&
      (recovery.selectedVenueId !== latestSelectedVenueId || localDiffersFromLatest);
    if (remoteFieldsChanged && localDiffersFromLatest) conflicts.add(conflictKey);
    if (venueSelectionConflicts) conflicts.add('venue');
  }
  for (const conflict of recovery.unresolvedConflicts ?? []) conflicts.add(conflict);
  return { values, selectedVenueId, conflicts: [...conflicts] };
}

const eventFormFieldLabels: Record<EventFormConflictKey, string> = {
  title: 'Title',
  slug: 'URL slug',
  description: 'Description',
  startsAt: 'Start date and time',
  endsAt: 'End date and time',
  timezone: 'Timezone',
  status: 'Status',
  visibility: 'Visibility',
  venueName: 'Venue name',
  address: 'Venue address',
  city: 'Venue city',
  region: 'Venue region',
  postalCode: 'Venue postal code',
  country: 'Venue country',
  capacity: 'Capacity',
  minimumAge: 'Minimum age',
  coverImageUrl: 'Legacy cover image',
  externalUrl: 'External URL',
  seoTitle: 'SEO title',
  seoDescription: 'SEO description',
  seoImageUrl: 'Legacy SEO image',
  currency: 'Currency',
  schedule: 'Schedule and timezone',
  venue: 'Venue',
  seo: 'SEO metadata',
};

function conflictFields(conflict: EventFormConflictKey): ReadonlyArray<keyof EventFormValues> {
  return conflict in eventFormConflictGroups
    ? eventFormConflictGroups[conflict as keyof typeof eventFormConflictGroups]
    : [conflict as keyof EventFormValues];
}

function displayConflictValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Empty';
  return String(value).slice(0, 120);
}

function eventFormConflictSummary(
  conflict: EventFormConflictKey,
  values: EventFormValues,
  selectedVenueId: string,
): string {
  const parts = conflictFields(conflict).map(
    (field) => `${eventFormFieldLabels[field]}: ${displayConflictValue(values[field])}`,
  );
  if (conflict === 'venue') parts.unshift(`Saved venue: ${displayConflictValue(selectedVenueId)}`);
  return parts.join('; ').slice(0, 600);
}

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

function eventToFormValues(event: AdminEventDetail): EventFormValues {
  return {
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
  };
}

function emptyEventFormValues(): EventFormValues {
  return {
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
  };
}

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
  const [mergeConflicts, setMergeConflicts] = React.useState<EventFormConflictKey[]>([]);
  const [scheduleMode, setScheduleMode] = React.useState<ScheduleMode>('one-time');
  const scheduleModeEventIdRef = React.useRef<string | undefined>(undefined);
  const scheduleModeChosenLocallyRef = React.useRef(false);
  const [selectedVenueId, setSelectedVenueId] = React.useState(event?.venueId ?? '');
  const selectedVenueIdRef = React.useRef(event?.venueId ?? '');
  const updateSelectedVenueId = (venueId: string) => {
    selectedVenueIdRef.current = venueId;
    setSelectedVenueId(venueId);
  };
  const { organizationId, brandId, loading: bootstrapLoading } = useBootstrap();
  const editingEventId = event?.id;
  const createDisabled = !event && (bootstrapLoading || !organizationId || !brandId);
  const {
    data: existingOccurrences,
    loading: existingOccurrencesLoading,
    error: existingOccurrencesError,
    refetch: refetchExistingOccurrences,
  } = useAdminQuery(
    ['listEventOccurrences', event?.id ?? 'none', 'form-schedule-mode'],
    () => adminApi.listEventOccurrences(event!.id),
    { enabled: Boolean(event?.id) },
  );
  const {
    data: savedVenues,
    loading: savedVenuesLoading,
    error: savedVenuesError,
    refetch: refetchSavedVenues,
  } = useAdminQuery(
    ['listSavedVenues', organizationId ?? 'none'],
    () => adminApi.listSavedVenues(organizationId!),
    { enabled: Boolean(organizationId) },
  );

  React.useEffect(() => {
    if (!editingEventId) {
      scheduleModeEventIdRef.current = undefined;
      scheduleModeChosenLocallyRef.current = false;
      setScheduleMode('one-time');
      return;
    }
    if (existingOccurrencesLoading || existingOccurrencesError || !existingOccurrences) return;
    if (scheduleModeEventIdRef.current !== editingEventId) {
      scheduleModeEventIdRef.current = editingEventId;
      scheduleModeChosenLocallyRef.current = false;
      setScheduleMode(existingOccurrences.length > 0 ? 'multiple' : 'one-time');
      return;
    }
    if (existingOccurrences.length > 0) setScheduleMode('multiple');
    else if (!scheduleModeChosenLocallyRef.current) setScheduleMode('one-time');
  }, [editingEventId, existingOccurrences, existingOccurrencesError, existingOccurrencesLoading]);

  const selectedSavedVenue = savedVenues?.find((venue) => venue.id === selectedVenueId);
  const savedVenueBindingUnavailable = Boolean(
    selectedVenueId && !savedVenuesLoading && !savedVenuesError && !selectedSavedVenue,
  );

  const initialValues = React.useMemo<EventFormValues>(
    () => (event ? eventToFormValues(event) : emptyEventFormValues()),
    [event],
  );

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema) as Resolver<EventFormValues>,
    defaultValues: initialValues,
  });
  const { dirtyFields } = form.formState;
  const recoveryKey = event ? `tixkit:event-draft:${event.id}:${section}` : undefined;
  const baselineRef = React.useRef(initialValues);
  const baselineVenueIdRef = React.useRef(event?.venueId ?? '');
  const versionRef = React.useRef(event?.version ?? 1);
  const saveInFlightRef = React.useRef(false);
  const saveQueuedRef = React.useRef(false);
  const mergeConflictsRef = React.useRef<EventFormConflictKey[]>([]);
  const conflictHeadingRef = React.useRef<HTMLHeadingElement>(null);
  const currentRecoverySnapshot = React.useCallback((): EventFormRecoverySnapshot => {
    const changedFields = Object.entries(form.formState.dirtyFields)
      .filter(([, dirty]) => Boolean(dirty))
      .map(([field]) => field as keyof EventFormValues);
    return {
      schemaVersion: 1,
      values: form.getValues(),
      baseValues: baselineRef.current,
      dirtyFields: changedFields,
      selectedVenueId: selectedVenueIdRef.current,
      baseSelectedVenueId: baselineVenueIdRef.current,
      unresolvedConflicts: mergeConflictsRef.current,
    };
  }, [form]);
  const hasCurrentChanges = React.useCallback((): boolean => {
    const values = form.getValues();
    return (
      (Object.keys(values) as Array<keyof EventFormValues>).some(
        (field) => !formValuesEqual(values[field], baselineRef.current[field]),
      ) || selectedVenueIdRef.current !== baselineVenueIdRef.current
    );
  }, [form]);

  React.useEffect(() => {
    if (mergeConflicts.length > 0) conflictHeadingRef.current?.focus();
  }, [mergeConflicts.length]);

  React.useEffect(() => {
    if (!event || (event.version ?? 1) === versionRef.current) return;
    const latestVenueId = event.venueId ?? '';
    const recovery = currentRecoverySnapshot();
    const plan = planEventFormRecovery(initialValues, recovery, latestVenueId);
    baselineRef.current = initialValues;
    baselineVenueIdRef.current = latestVenueId;
    versionRef.current = event.version ?? 1;
    form.reset(initialValues);
    for (const field of Object.keys(plan.values) as Array<keyof EventFormValues>) {
      if (formValuesEqual(plan.values[field], initialValues[field])) continue;
      form.setValue(field, plan.values[field] as never, { shouldDirty: true });
    }
    updateSelectedVenueId(plan.selectedVenueId);
    mergeConflictsRef.current = plan.conflicts;
    setMergeConflicts(plan.conflicts);
    setSaveState(plan.conflicts.length > 0 ? 'conflict' : 'idle');
    if (recoveryKey) {
      const dirtyFields = (Object.keys(plan.values) as Array<keyof EventFormValues>).filter(
        (field) => !formValuesEqual(plan.values[field], initialValues[field]),
      );
      window.sessionStorage.setItem(
        recoveryKey,
        JSON.stringify({
          schemaVersion: 1,
          values: plan.values,
          baseValues: initialValues,
          dirtyFields,
          selectedVenueId: plan.selectedVenueId,
          baseSelectedVenueId: latestVenueId,
          unresolvedConflicts: plan.conflicts,
        } satisfies EventFormRecoverySnapshot),
      );
    }
  }, [currentRecoverySnapshot, event, form, initialValues, recoveryKey]);

  React.useEffect(() => {
    if (!recoveryKey) return;
    const raw = window.sessionStorage.getItem(recoveryKey);
    if (!raw) return;
    try {
      const candidate = JSON.parse(raw) as Record<string, unknown>;
      if (candidate.schemaVersion !== 1) throw new Error('unsupported recovery version');
      const values = eventSchema.safeParse(candidate.values);
      const parsedBaseValues =
        candidate.baseValues === undefined
          ? undefined
          : eventSchema.safeParse(candidate.baseValues);
      if (!values.success || (parsedBaseValues && !parsedBaseValues.success))
        throw new Error('invalid recovery');
      const dirtyFields = Array.isArray(candidate.dirtyFields)
        ? candidate.dirtyFields.filter(
            (field): field is keyof EventFormValues =>
              typeof field === 'string' && Object.hasOwn(initialValues, field),
          )
        : [];
      const recovery: EventFormRecoverySnapshot = {
        schemaVersion: 1,
        values: values.data,
        baseValues: parsedBaseValues?.success ? parsedBaseValues.data : undefined,
        dirtyFields,
        selectedVenueId:
          typeof candidate.selectedVenueId === 'string' ? candidate.selectedVenueId : '',
        baseSelectedVenueId:
          typeof candidate.baseSelectedVenueId === 'string'
            ? candidate.baseSelectedVenueId
            : undefined,
        unresolvedConflicts: Array.isArray(candidate.unresolvedConflicts)
          ? candidate.unresolvedConflicts.filter(
              (conflict): conflict is EventFormConflictKey =>
                typeof conflict === 'string' && Object.hasOwn(eventFormFieldLabels, conflict),
            )
          : undefined,
      };
      const plan = planEventFormRecovery(initialValues, recovery, event?.venueId ?? '');
      form.reset(plan.values, { keepDefaultValues: true });
      updateSelectedVenueId(plan.selectedVenueId);
      mergeConflictsRef.current = plan.conflicts;
      setMergeConflicts(plan.conflicts);
      setSaveState(plan.conflicts.length > 0 ? 'conflict' : navigator.onLine ? 'idle' : 'offline');
      toast.info(
        plan.conflicts.length > 0
          ? 'Your edits were restored. Choose which value to keep for fields that also changed remotely.'
          : 'Your unsaved edits were safely merged with the latest event version. Review and save them.',
      );
    } catch {
      window.sessionStorage.removeItem(recoveryKey);
    }
  }, [event?.venueId, form, initialValues, recoveryKey]);

  const recoverLatestPreservingEdits = async () => {
    if (!event || !recoveryKey) return;
    const recovery = currentRecoverySnapshot();
    window.sessionStorage.setItem(recoveryKey, JSON.stringify(recovery));
    setSaveState('saving');
    let latest: Awaited<ReturnType<typeof adminApi.getEvent>>;
    try {
      latest = await adminApi.getEvent(event.id);
    } catch (cause) {
      setSaveState('conflict');
      toast.error(
        cause instanceof Error ? cause.message : 'Unable to load the latest event version.',
      );
      return;
    }
    if (!latest.ok) {
      setSaveState('conflict');
      toast.error(`Unable to load the latest event: ${latest.error.message}`);
      return;
    }
    const currentRecovery = currentRecoverySnapshot();
    const latestValues = eventToFormValues(latest.data);
    const latestVenueId = latest.data.venueId ?? '';
    const plan = planEventFormRecovery(latestValues, currentRecovery, latestVenueId);
    baselineRef.current = latestValues;
    baselineVenueIdRef.current = latestVenueId;
    versionRef.current = latest.data.version ?? versionRef.current;
    form.reset(latestValues);
    for (const field of Object.keys(plan.values) as Array<keyof EventFormValues>) {
      if (formValuesEqual(plan.values[field], latestValues[field])) continue;
      form.setValue(field, plan.values[field] as never, { shouldDirty: true });
    }
    updateSelectedVenueId(plan.selectedVenueId);
    mergeConflictsRef.current = plan.conflicts;
    setMergeConflicts(plan.conflicts);
    setSaveState(plan.conflicts.length > 0 ? 'conflict' : 'idle');
    const rebasedDirtyFields = (Object.keys(plan.values) as Array<keyof EventFormValues>).filter(
      (field) => !formValuesEqual(plan.values[field], latestValues[field]),
    );
    window.sessionStorage.setItem(
      recoveryKey,
      JSON.stringify({
        schemaVersion: 1,
        values: plan.values,
        baseValues: latestValues,
        dirtyFields: rebasedDirtyFields,
        selectedVenueId: plan.selectedVenueId,
        baseSelectedVenueId: latestVenueId,
        unresolvedConflicts: plan.conflicts,
      } satisfies EventFormRecoverySnapshot),
    );
    if (plan.conflicts.length === 0) {
      toast.info('Your edits were safely merged with the latest event.');
    }
  };

  const resolveMergeConflict = (field: EventFormConflictKey, resolution: 'local' | 'latest') => {
    if (resolution === 'latest') {
      for (const conflictField of conflictFields(field)) {
        form.resetField(conflictField, {
          defaultValue: baselineRef.current[conflictField] as never,
        });
      }
      if (field === 'venue') updateSelectedVenueId(baselineVenueIdRef.current);
    }
    setMergeConflicts((current) => {
      const remaining = current.filter((candidate) => candidate !== field);
      mergeConflictsRef.current = remaining;
      if (remaining.length === 0) setSaveState('idle');
      if (recoveryKey) {
        const snapshot = currentRecoverySnapshot();
        window.sessionStorage.setItem(
          recoveryKey,
          JSON.stringify({ ...snapshot, unresolvedConflicts: remaining }),
        );
      }
      return remaining;
    });
  };

  const onSubmit = async (values: EventFormValues) => {
    if (mergeConflictsRef.current.length > 0) {
      toast.error('Resolve every field conflict before saving.');
      return;
    }
    if (!event && (!organizationId || !brandId)) {
      toast.error(
        'Workspace and brand context are required to create an event. Please ensure your account is properly configured.',
      );
      return;
    }
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return;
    }
    saveInFlightRef.current = true;
    const submittedValues = { ...values };
    const submittedVenueId = selectedVenueIdRef.current;
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
        ? buildEventUpdatePayload(values, dirtyFields as EventFormDirtyFields, baselineRef.current)
        : null;
      if (submittedVenueId) createInput.venueId = submittedVenueId;
      if (updateInput && submittedVenueId !== baselineVenueIdRef.current)
        updateInput.venueId = submittedVenueId || null;
      if (event && !updateInput) {
        toast.error('Start date must be a valid date and time');
        return;
      }
      if (event && updateInput) updateInput.expectedVersion = versionRef.current;

      const result = event
        ? await adminApi.updateEvent(event.id, updateInput as UpdateEventInput)
        : await adminApi.createEvent(createInput);

      if (result.ok) {
        const savedBaseline = eventToFormValues(result.data);
        const savedVenueId = result.data.venueId ?? '';
        const currentValues = form.getValues();
        const laterChangedFields = (
          Object.keys(currentValues) as Array<keyof EventFormValues>
        ).filter((field) => !formValuesEqual(currentValues[field], submittedValues[field]));
        const currentSelectedVenueId = selectedVenueIdRef.current;
        const venueSelectionChanged = currentSelectedVenueId !== submittedVenueId;
        baselineRef.current = savedBaseline;
        baselineVenueIdRef.current = savedVenueId;
        versionRef.current = result.data.version ?? versionRef.current + 1;
        form.reset(savedBaseline);
        for (const field of laterChangedFields) {
          form.setValue(field, currentValues[field] as never, { shouldDirty: true });
        }
        updateSelectedVenueId(venueSelectionChanged ? currentSelectedVenueId : savedVenueId);
        const hasLaterEdits = laterChangedFields.length > 0 || venueSelectionChanged;
        setSaveState(hasLaterEdits ? 'idle' : 'saved');
        if (recoveryKey) {
          if (hasLaterEdits) {
            window.sessionStorage.setItem(
              recoveryKey,
              JSON.stringify({
                schemaVersion: 1,
                values: { ...savedBaseline, ...currentValues },
                baseValues: savedBaseline,
                dirtyFields: laterChangedFields,
                selectedVenueId: venueSelectionChanged ? currentSelectedVenueId : savedVenueId,
                baseSelectedVenueId: savedVenueId,
              } satisfies EventFormRecoverySnapshot),
            );
            saveQueuedRef.current = true;
          } else {
            window.sessionStorage.removeItem(recoveryKey);
          }
        }
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
          await recoverLatestPreservingEdits();
        }
        if (autosave) {
          void adminApi.reportOnboardingEvent({
            stage: 'autosave_failure',
            outcome: 'failed',
            reasonCode: stale ? 'stale_event_version' : 'request_failed',
          });
        }
        if (!stale) toast.error(result.error.message);
      }
    } catch (cause) {
      setSaveState(navigator.onLine ? 'idle' : 'offline');
      if (autosave) {
        void adminApi.reportOnboardingEvent({
          stage: 'autosave_failure',
          outcome: 'failed',
          reasonCode: 'request_failed',
        });
      }
      toast.error(cause instanceof Error ? cause.message : 'Unable to save the event.');
    } finally {
      saveInFlightRef.current = false;
      setSubmitting(false);
      if (saveQueuedRef.current && hasCurrentChanges() && mergeConflictsRef.current.length === 0) {
        saveQueuedRef.current = false;
        queueMicrotask(() => {
          void form.handleSubmit((nextValues) => submitRef.current(nextValues))();
        });
      }
    }
  };

  const submitRef = React.useRef(onSubmit);
  submitRef.current = onSubmit;
  React.useEffect(() => {
    if (!autosave || !event) return;
    let timeout: number | undefined;
    const persistDraft = (): boolean => {
      if (!recoveryKey) return false;
      const values = form.getValues();
      const changedFields = (Object.keys(values) as Array<keyof EventFormValues>).filter(
        (field) => !formValuesEqual(values[field], baselineRef.current[field]),
      );
      if (
        changedFields.length === 0 &&
        selectedVenueIdRef.current === baselineVenueIdRef.current &&
        mergeConflictsRef.current.length === 0
      ) {
        window.sessionStorage.removeItem(recoveryKey);
        return false;
      }
      window.sessionStorage.setItem(
        recoveryKey,
        JSON.stringify({
          schemaVersion: 1,
          values,
          baseValues: baselineRef.current,
          dirtyFields: changedFields,
          selectedVenueId: selectedVenueIdRef.current,
          baseSelectedVenueId: baselineVenueIdRef.current,
          unresolvedConflicts: mergeConflictsRef.current,
        } satisfies EventFormRecoverySnapshot),
      );
      return true;
    };
    const subscription = form.watch(() => {
      window.clearTimeout(timeout);
      const hasPendingChanges = persistDraft();
      if (!hasPendingChanges) return;
      if (!navigator.onLine) {
        setSaveState('offline');
        return;
      }
      if (mergeConflictsRef.current.length > 0) {
        setSaveState('conflict');
        return;
      }
      setSaveState('idle');
      timeout = window.setTimeout(() => {
        void form.handleSubmit((values) => submitRef.current(values))();
      }, 800);
    });
    const retry = () => {
      if (!persistDraft()) return;
      if (mergeConflictsRef.current.length > 0) return;
      setSaveState('idle');
      void form.handleSubmit((values) => submitRef.current(values))();
    };
    window.addEventListener('online', retry);
    return () => {
      window.clearTimeout(timeout);
      subscription.unsubscribe();
      window.removeEventListener('online', retry);
    };
  }, [autosave, event, form, recoveryKey]);

  React.useEffect(() => {
    if (!autosave || !hasCurrentChanges()) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [autosave, form.formState.isDirty, hasCurrentChanges, selectedVenueId]);

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
              {event && existingOccurrencesLoading ? (
                <output className="block text-sm text-muted-foreground">
                  Checking the current event schedule…
                </output>
              ) : event && existingOccurrencesError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    The current schedule could not be loaded. Schedule choices are unavailable until
                    it is retried.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refetchExistingOccurrences()}
                  >
                    Retry current schedule
                  </Button>
                </div>
              ) : (
                <Tabs
                  value={scheduleMode}
                  onValueChange={(value) => {
                    scheduleModeChosenLocallyRef.current = true;
                    setScheduleMode(value as ScheduleMode);
                  }}
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="one-time" className="flex-1">
                      One-time event
                    </TabsTrigger>
                    <TabsTrigger value="multiple" className="flex-1">
                      Multiple occurrences
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="one-time" forceMount className="sr-only" />
                  <TabsContent value="multiple" forceMount className="sr-only" />
                </Tabs>
              )}

              {(!event || (!existingOccurrencesLoading && !existingOccurrencesError)) &&
              scheduleMode === 'one-time' ? (
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
              ) : (!event || (!existingOccurrencesLoading && !existingOccurrencesError)) &&
                scheduleMode === 'multiple' &&
                event ? (
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
              ) : (!event || (!existingOccurrencesLoading && !existingOccurrencesError)) &&
                scheduleMode === 'multiple' ? (
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
              ) : null}
            </div>
            <div id="schedule-venue" className="scroll-mt-6 grid gap-4 sm:grid-cols-2">
              {savedVenuesLoading ? (
                <output className="block text-sm text-muted-foreground sm:col-span-2">
                  Checking saved venues…
                </output>
              ) : null}
              {savedVenuesError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 text-sm sm:col-span-2"
                >
                  <span>
                    Saved venues could not be loaded. Any existing venue binding is preserved but
                    unavailable for changes.
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refetchSavedVenues()}
                  >
                    Retry saved venues
                  </Button>
                </div>
              ) : null}
              {(savedVenues?.length ?? 0) > 0 || selectedVenueId ? (
                <div className="space-y-2 sm:col-span-2">
                  <label className="text-sm font-medium" htmlFor="event-saved-venue">
                    Saved venue
                  </label>
                  <select
                    id="event-saved-venue"
                    className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    disabled={savedVenuesLoading || Boolean(savedVenuesError)}
                    value={selectedVenueId}
                    onChange={(change) => {
                      const venueId = change.target.value;
                      updateSelectedVenueId(venueId);
                      form.setValue('venueName', form.getValues('venueName'), {
                        shouldDirty: true,
                      });
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
                    {selectedVenueId && !selectedSavedVenue ? (
                      <option value={selectedVenueId}>
                        {savedVenuesLoading
                          ? 'Current saved venue (checking…)'
                          : 'Current saved venue (unavailable)'}
                      </option>
                    ) : null}
                    {savedVenues?.map((venue) => (
                      <option key={venue.id} value={venue.id}>
                        {venue.name}
                      </option>
                    ))}
                  </select>
                  {savedVenueBindingUnavailable ? (
                    <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">
                      The saved venue currently attached to this event is unavailable. Choose an
                      available venue or use inline venue details before changing the binding.
                    </p>
                  ) : null}
                  {selectedSavedVenue ? (
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
                            updateSelectedVenueId('');
                            form.setValue('venueName', form.getValues('venueName'), {
                              shouldDirty: true,
                            });
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
                    updateSelectedVenueId(result.data.id);
                    form.setValue('venueName', form.getValues('venueName'), {
                      shouldDirty: true,
                    });
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
        {mergeConflicts.length > 0 ? (
          <section
            className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
            aria-labelledby="event-merge-conflicts-heading"
          >
            <div>
              <h2
                ref={conflictHeadingRef}
                id="event-merge-conflicts-heading"
                className="font-medium"
                tabIndex={-1}
              >
                Choose values for {mergeConflicts.length} conflicting{' '}
                {mergeConflicts.length === 1 ? 'field' : 'fields'}
              </h2>
              <p className="text-sm text-foreground" role="alert">
                These fields changed both here and in the newer event version. Nothing will save
                until you choose which value to keep.
              </p>
            </div>
            <ul className="space-y-2">
              {mergeConflicts.map((field) => (
                <li key={field}>
                  <fieldset className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3">
                    <legend className="px-1 text-sm font-medium">
                      {eventFormFieldLabels[field]}
                    </legend>
                    <dl className="grid w-full gap-2 text-xs sm:grid-cols-2">
                      <div className="rounded bg-muted/50 p-2">
                        <dt className="font-medium">My version</dt>
                        <dd className="mt-1 break-words">
                          {eventFormConflictSummary(
                            field,
                            form.getValues(),
                            selectedVenueIdRef.current,
                          )}
                        </dd>
                      </div>
                      <div className="rounded bg-muted/50 p-2">
                        <dt className="font-medium">Latest version</dt>
                        <dd className="mt-1 break-words">
                          {eventFormConflictSummary(
                            field,
                            baselineRef.current,
                            baselineVenueIdRef.current,
                          )}
                        </dd>
                      </div>
                    </dl>
                    <div className="flex w-full flex-wrap justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`Keep my ${eventFormFieldLabels[field]} change`}
                        onClick={() => resolveMergeConflict(field, 'local')}
                      >
                        Keep my change
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`Use latest ${eventFormFieldLabels[field]} value`}
                        onClick={() => resolveMergeConflict(field, 'latest')}
                      >
                        Use latest value
                      </Button>
                    </div>
                  </fieldset>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          {autosave && event ? (
            <div className="flex items-center gap-2">
              <output className="self-center text-sm text-muted-foreground" aria-live="polite">
                {saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'saved'
                    ? 'Saved'
                    : saveState === 'offline'
                      ? 'Offline — changes are unsaved'
                      : saveState === 'conflict'
                        ? mergeConflicts.length > 0
                          ? `Conflict — resolve ${mergeConflicts.length} ${mergeConflicts.length === 1 ? 'field' : 'fields'}`
                          : 'Conflict — load the newer version'
                        : form.formState.isDirty
                          ? 'Unsaved changes'
                          : ''}
              </output>
              {saveState === 'conflict' && mergeConflicts.length === 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void recoverLatestPreservingEdits()}
                >
                  Load latest and merge my edits
                </Button>
              ) : null}
            </div>
          ) : null}
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            disabled={
              submitting || createDisabled || saveState === 'conflict' || mergeConflicts.length > 0
            }
          >
            {submitting ? 'Saving...' : event ? 'Save Changes' : 'Create Event'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
