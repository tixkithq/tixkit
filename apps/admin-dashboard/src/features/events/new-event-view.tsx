'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, Gift, HeartHandshake, Layers3, Ticket, Copy } from 'lucide-react';
import { adminApi, type AdminSavedVenue } from '@/lib/api';
import { routes } from '@/lib/routes';
import { timezoneDatetimeInputToIso } from '@/lib/datetime';
import { useBootstrap } from '@/context/bootstrap-provider';
import { usePermissions } from '@/context/permission-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAllEvents } from '@/hooks/use-all-events';

type StartingPoint = 'blank' | 'free' | 'paid' | 'donation' | 'multiple' | 'duplicate';
type DuplicateCopyOptions = {
  basicsVenue: boolean;
  ticketTypes: boolean;
  products: boolean;
  checkoutQuestions: boolean;
  feeResalePolicies: boolean;
  eventPageContent: boolean;
  lifecycleContent: boolean;
  marketingIntegrations: boolean;
  mediaAssets: boolean;
};
const duplicateCopyLabels: Array<[keyof DuplicateCopyOptions, string]> = [
  ['basicsVenue', 'Basics, venue, and schedule'],
  ['ticketTypes', 'Ticket types and inventory'],
  ['products', 'Products'],
  ['checkoutQuestions', 'Checkout questions'],
  ['feeResalePolicies', 'Fee and resale policies'],
  ['eventPageContent', 'Event-page content'],
  ['lifecycleContent', 'Lifecycle messages'],
  ['marketingIntegrations', 'Marketing integrations'],
  ['mediaAssets', 'Poster, cover, and social media'],
];

const startingPoints: Array<{
  id: StartingPoint;
  title: string;
  description: string;
  icon: typeof Ticket;
}> = [
  {
    id: 'blank',
    title: 'Blank',
    description: 'Start with event details only.',
    icon: CalendarDays,
  },
  {
    id: 'free',
    title: 'Free RSVP',
    description: 'Add a free RSVP ticket.',
    icon: Gift,
  },
  {
    id: 'paid',
    title: 'Paid admission',
    description: 'Add a paid general-admission ticket.',
    icon: Ticket,
  },
  {
    id: 'donation',
    title: 'Donation',
    description: 'Let guests choose an amount.',
    icon: HeartHandshake,
  },
  {
    id: 'multiple',
    title: 'Multiple occurrences',
    description: 'Start a repeatable schedule.',
    icon: Layers3,
  },
  {
    id: 'duplicate',
    title: 'Duplicate existing event',
    description: 'Copy safe setup from another event.',
    icon: Copy,
  },
];

function defaultStart(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function NewEventView() {
  const router = useRouter();
  const {
    organizations = [],
    organizationId,
    brandId,
    brands,
    loading: bootstrapLoading,
  } = useBootstrap();
  const { can, loading: permissionsLoading } = usePermissions();
  const [startingPoint, setStartingPoint] = React.useState<StartingPoint>('blank');
  const [sourceEventId, setSourceEventId] = React.useState('');
  const [duplicateCopy, setDuplicateCopy] = React.useState<DuplicateCopyOptions>({
    basicsVenue: true,
    ticketTypes: true,
    products: true,
    checkoutQuestions: true,
    feeResalePolicies: true,
    eventPageContent: true,
    lifecycleContent: true,
    marketingIntegrations: true,
    mediaAssets: true,
  });
  const [title, setTitle] = React.useState('');
  const [startsAt, setStartsAt] = React.useState(defaultStart);
  const [endsAt, setEndsAt] = React.useState('');
  const [timezone, setTimezone] = React.useState('UTC');
  const [currency, setCurrency] = React.useState('USD');
  const [venueName, setVenueName] = React.useState('');
  const [country, setCountry] = React.useState('');
  const [venueId, setVenueId] = React.useState('');
  const [savedVenues, setSavedVenues] = React.useState<AdminSavedVenue[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [errorField, setErrorField] = React.useState<string>();
  const creationIdempotencyKey = React.useRef<string | undefined>(undefined);
  const recoveryPending = React.useRef(false);
  const fieldRefs = React.useRef<Record<string, HTMLInputElement | null>>({});
  const { events: sourceEvents } = useAllEvents({
    organizationId,
    brandId,
    enabled: Boolean(organizationId && brandId),
  });

  React.useEffect(() => {
    const defaults = organizations.find(
      (organization) => organization.id === organizationId,
    )?.eventDefaults;
    setTimezone(defaults?.timezone || browserTimezone());
    setCurrency(defaults?.currency || 'USD');
    setVenueId(defaults?.defaultVenueId || '');
    setCountry(defaults?.country || '');
    setVenueName('');
    void adminApi.reportOnboardingEvent({ stage: 'onboarding_started', outcome: 'started' });
  }, [organizationId, organizations]);
  React.useEffect(() => {
    if (!organizationId) return;
    void adminApi.listSavedVenues(organizationId).then((result) => {
      if (!result.ok) return;
      setSavedVenues(result.data);
      const selected = result.data.find((venue) => venue.id === venueId);
      if (selected) setVenueName(selected.name);
    });
  }, [organizationId, venueId]);
  React.useEffect(() => {
    const selectedBrand = brands.find((brand) => brand.id === brandId);
    const organizationDefaults = organizations.find(
      (organization) => organization.id === organizationId,
    )?.eventDefaults;
    if (organizationDefaults?.currency) return;
    if (!organizationId || !selectedBrand?.paymentAccountId) return;
    let cancelled = false;
    void adminApi.listPaymentAccounts(organizationId).then((result) => {
      if (cancelled || !result.ok) return;
      const selected = result.data.find((account) => account.id === selectedBrand.paymentAccountId);
      if (selected?.defaultCurrency) setCurrency(selected.defaultCurrency.toUpperCase());
    });
    return () => {
      cancelled = true;
    };
  }, [brandId, brands, organizationId, organizations]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setErrorField(undefined);
    if (!organizationId || !brandId) {
      setError('Select an organization and brand before creating an event.');
      return;
    }
    if (!can('events.write')) {
      setError('You do not have permission to create events.');
      return;
    }
    if (!title.trim()) {
      setError('Enter an event title.');
      setErrorField('new-event-title');
      fieldRefs.current['new-event-title']?.focus();
      return;
    }
    if (!/^[A-Z]{3}$/.test(currency.toUpperCase())) {
      setError('Currency must be a three-letter ISO code.');
      setErrorField('new-event-currency');
      fieldRefs.current['new-event-currency']?.focus();
      return;
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      setError('Enter a valid IANA timezone.');
      setErrorField('new-event-timezone');
      fieldRefs.current['new-event-timezone']?.focus();
      return;
    }
    const startIso = timezoneDatetimeInputToIso(startsAt, timezone);
    const endIso = timezoneDatetimeInputToIso(endsAt, timezone);
    if (!startIso) {
      setError('Enter a valid start date, time, and timezone.');
      setErrorField('new-event-start');
      fieldRefs.current['new-event-start']?.focus();
      return;
    }
    if (endsAt && (!endIso || new Date(endIso) <= new Date(startIso))) {
      setError('End must be after start.');
      setErrorField('new-event-end');
      fieldRefs.current['new-event-end']?.focus();
      return;
    }
    setSubmitting(true);
    creationIdempotencyKey.current ??= window.crypto.randomUUID();
    const recovering = recoveryPending.current;
    if (recovering) {
      void adminApi.reportOnboardingEvent({ stage: 'recovery', outcome: 'attempted' });
    }
    try {
      if (startingPoint === 'duplicate') {
        if (!sourceEventId) throw new Error('Choose an existing event to duplicate.');
        const duplicated = await adminApi.duplicateEvent(sourceEventId, {
          idempotencyKey: creationIdempotencyKey.current,
          startsAt: startIso,
          title: title.trim(),
          copy: duplicateCopy,
        });
        if (!duplicated.ok) throw new Error(duplicated.error.message);
        if (recovering) {
          void adminApi.reportOnboardingEvent({ stage: 'recovery', outcome: 'completed' });
        }
        router.push(routes.eventDetail(duplicated.data.id));
        return;
      }
      const created = await adminApi.createEvent({
        organizationId,
        brandId,
        title: title.trim(),
        description: organizations.find((organization) => organization.id === organizationId)
          ?.eventDefaults?.eventDescription,
        startsAt: startIso,
        endsAt: endIso ?? null,
        timezone,
        currency: currency.toUpperCase(),
        venue: venueName.trim() || country ? { name: venueName.trim(), country } : null,
        venueId: venueId || null,
        startingPoint,
        idempotencyKey: creationIdempotencyKey.current,
      });
      if (!created.ok) throw new Error(created.error.message);
      if (recovering) {
        void adminApi.reportOnboardingEvent({ stage: 'recovery', outcome: 'completed' });
      }
      router.push(routes.eventDetail(created.data.id));
    } catch (cause) {
      recoveryPending.current = true;
      const message = cause instanceof Error ? cause.message : 'Unable to create the event draft.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!permissionsLoading && !can('events.write')) {
    return (
      <div role="alert" className="mx-auto max-w-2xl rounded-lg border p-6">
        <h1 className="text-xl font-semibold">Event creation unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask a workspace administrator for event editing permission.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 pb-12">
      <header className="space-y-2">
        <p className="text-sm font-medium text-primary">New durable draft</p>
        <h1 className="text-3xl font-bold tracking-tight">Create an event</h1>
        <p className="text-muted-foreground">
          Add the essentials now. Tickets, content, checkout, and launch checks stay in their
          focused editors.
        </p>
      </header>
      <form onSubmit={submit} className="space-y-6" noValidate>
        <fieldset>
          <legend className="mb-3 text-sm font-semibold">Starting point</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {startingPoints.map((point) => (
              <label
                key={point.id}
                className={`cursor-pointer rounded-lg border p-4 outline-none transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${startingPoint === point.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/40'}`}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="startingPoint"
                  value={point.id}
                  checked={startingPoint === point.id}
                  onChange={() => {
                    setStartingPoint(point.id);
                    void adminApi.reportOnboardingEvent({
                      stage: 'starting_point_selected',
                      outcome: point.id,
                    });
                  }}
                />
                <point.icon className="mb-3 size-5" aria-hidden="true" />
                <span className="block font-medium">{point.title}</span>
                <span className="mt-1 block text-sm text-foreground/80">{point.description}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Card>
          <CardHeader>
            <CardTitle>Event essentials</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <label className="space-y-2 sm:col-span-2" htmlFor="new-event-title">
              <span className="text-sm font-medium">Title</span>
              <Input
                id="new-event-title"
                ref={(node) => {
                  fieldRefs.current['new-event-title'] = node;
                }}
                aria-invalid={errorField === 'new-event-title'}
                aria-describedby={errorField === 'new-event-title' ? 'new-event-error' : undefined}
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
              />
            </label>
            <label className="space-y-2" htmlFor="new-event-start">
              <span className="text-sm font-medium">Start</span>
              <Input
                required
                id="new-event-start"
                ref={(node) => {
                  fieldRefs.current['new-event-start'] = node;
                }}
                aria-invalid={errorField === 'new-event-start'}
                aria-describedby={errorField === 'new-event-start' ? 'new-event-error' : undefined}
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </label>
            <label className="space-y-2" htmlFor="new-event-end">
              <span className="text-sm font-medium">
                End <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Input
                type="datetime-local"
                id="new-event-end"
                ref={(node) => {
                  fieldRefs.current['new-event-end'] = node;
                }}
                aria-invalid={errorField === 'new-event-end'}
                aria-describedby={errorField === 'new-event-end' ? 'new-event-error' : undefined}
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </label>
            <label className="space-y-2" htmlFor="new-event-timezone">
              <span className="text-sm font-medium">Timezone</span>
              <Input
                required
                id="new-event-timezone"
                ref={(node) => {
                  fieldRefs.current['new-event-timezone'] = node;
                }}
                aria-invalid={errorField === 'new-event-timezone'}
                aria-describedby={
                  errorField === 'new-event-timezone' ? 'new-event-error' : undefined
                }
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                list="event-timezones"
              />
              <datalist id="event-timezones" aria-label="Suggested event timezones">
                <option value="UTC">UTC</option>
                <option value="America/Chicago">America/Chicago</option>
                <option value="America/Los_Angeles">America/Los_Angeles</option>
                <option value="America/New_York">America/New_York</option>
                <option value="Europe/London">Europe/London</option>
              </datalist>
            </label>
            <label className="space-y-2" htmlFor="new-event-currency">
              <span className="text-sm font-medium">Currency</span>
              <Input
                required
                id="new-event-currency"
                ref={(node) => {
                  fieldRefs.current['new-event-currency'] = node;
                }}
                aria-invalid={errorField === 'new-event-currency'}
                aria-describedby={
                  errorField === 'new-event-currency' ? 'new-event-error' : undefined
                }
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                pattern="[A-Za-z]{3}"
                maxLength={3}
              />
            </label>
            <label className="space-y-2 sm:col-span-2" htmlFor="new-event-venue">
              <span className="text-sm font-medium">
                Venue name <span className="font-normal text-muted-foreground">(optional)</span>
              </span>
              <Input
                id="new-event-venue"
                value={venueName}
                onChange={(e) => setVenueName(e.target.value)}
              />
            </label>
            <label className="space-y-2" htmlFor="new-event-country">
              <span className="text-sm font-medium">Venue country</span>
              <Input
                id="new-event-country"
                maxLength={2}
                value={country}
                onChange={(change) => setCountry(change.target.value.toUpperCase())}
              />
            </label>
            {savedVenues.length ? (
              <label className="space-y-2 sm:col-span-2" htmlFor="new-event-saved-venue">
                <span className="text-sm font-medium">Saved venue</span>
                <select
                  className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  id="new-event-saved-venue"
                  value={venueId}
                  onChange={(change) => {
                    const nextId = change.target.value;
                    setVenueId(nextId);
                    const selected = savedVenues.find((venue) => venue.id === nextId);
                    if (selected) {
                      setVenueName(selected.name);
                      if (selected.timezone) setTimezone(selected.timezone);
                    }
                  }}
                >
                  <option value="">Use a one-time venue</option>
                  {savedVenues.map((venue) => (
                    <option key={venue.id} value={venue.id}>
                      {venue.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {startingPoint === 'duplicate' ? (
              <div className="space-y-4 sm:col-span-2">
                <label className="space-y-2" htmlFor="new-event-source">
                  <span className="text-sm font-medium">Source event</span>
                  <select
                    className="flex h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                    id="new-event-source"
                    required
                    value={sourceEventId}
                    onChange={(event) => setSourceEventId(event.target.value)}
                  >
                    <option value="">Choose an event</option>
                    {sourceEvents.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.title}
                      </option>
                    ))}
                  </select>
                  <span className="block text-xs text-muted-foreground">
                    Choose only the setup the new draft should inherit.
                  </span>
                </label>
                <fieldset className="rounded-lg border p-4">
                  <legend className="px-1 text-sm font-medium">Configuration to copy</legend>
                  <p className="mb-3 text-xs text-muted-foreground">
                    Orders, attendees, issued tickets, scans, analytics, holds, credentials, and
                    provider events are never copied.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {duplicateCopyLabels.map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={duplicateCopy[key]}
                          onChange={(change) =>
                            setDuplicateCopy((current) => {
                              const next = {
                                ...current,
                                [key]: change.target.checked,
                              };
                              if (key === 'basicsVenue' && !change.target.checked) {
                                next.ticketTypes = false;
                                next.checkoutQuestions = false;
                              }
                              if (key === 'ticketTypes') {
                                if (change.target.checked) next.basicsVenue = true;
                                else next.checkoutQuestions = false;
                              }
                              if (key === 'checkoutQuestions' && change.target.checked) {
                                next.ticketTypes = true;
                                next.basicsVenue = true;
                              }
                              return next;
                            })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            ) : null}
          </CardContent>
        </Card>
        {error ? (
          <div
            role="alert"
            id="new-event-error"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push(routes.events)}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={submitting || bootstrapLoading || !organizationId || !brandId}
          >
            {submitting ? 'Creating draft…' : 'Create draft'}
          </Button>
        </div>
      </form>
    </div>
  );
}
