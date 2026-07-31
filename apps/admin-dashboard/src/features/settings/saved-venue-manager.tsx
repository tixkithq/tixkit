'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePermissions } from '@/context/permission-provider';
import { adminApi, type AdminEventVenue, type AdminSavedVenue } from '@/lib/api';

type VenueDraft = {
  name: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  timezone: string;
};

type SavedVenueManagerProps = {
  organizationId: string;
  venues: AdminSavedVenue[];
  loading: boolean;
  loadError: string | null;
  onVenuesChange: (venues: AdminSavedVenue[]) => void;
  onVenueDeleted?: (venueId: string) => void;
};

const emptyDraft: VenueDraft = {
  name: '',
  address: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
  timezone: '',
};

function venueDraft(venue: AdminSavedVenue): VenueDraft {
  return {
    name: venue.name,
    address: venue.address?.address ?? '',
    city: venue.address?.city ?? '',
    region: venue.address?.region ?? '',
    postalCode: venue.address?.postalCode ?? '',
    country: venue.address?.country ?? '',
    timezone: venue.timezone ?? '',
  };
}

function compactAddress(draft: VenueDraft): Omit<AdminEventVenue, 'name'> {
  return Object.fromEntries(
    Object.entries({
      address: draft.address.trim(),
      city: draft.city.trim(),
      region: draft.region.trim(),
      postalCode: draft.postalCode.trim(),
      country: draft.country.trim().toUpperCase(),
    }).filter(([, value]) => value.length > 0),
  );
}

function sortVenues(venues: AdminSavedVenue[]): AdminSavedVenue[] {
  return [...venues].sort((left, right) => left.name.localeCompare(right.name));
}

export function SavedVenueManager({
  organizationId,
  venues,
  loading,
  loadError,
  onVenuesChange,
  onVenueDeleted,
}: SavedVenueManagerProps) {
  const { can, loading: permissionsLoading, error: permissionsError } = usePermissions();
  const [editingId, setEditingId] = React.useState<string | 'new' | null>(null);
  const [draft, setDraft] = React.useState<VenueDraft>(emptyDraft);
  const [saving, setSaving] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const operationGeneration = React.useRef(0);
  const createAttemptKey = React.useRef<string | null>(null);
  const createAttemptSubmitted = React.useRef(false);
  const mounted = React.useRef(true);
  const nameInput = React.useRef<HTMLInputElement>(null);
  const countryInput = React.useRef<HTMLInputElement>(null);
  const addButton = React.useRef<HTMLButtonElement>(null);
  const returnFocus = React.useRef<HTMLButtonElement | null>(null);
  const focusAddAfterDelete = React.useRef(false);
  const venuesRef = React.useRef(venues);
  venuesRef.current = venues;

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
    };
  }, []);

  React.useEffect(() => {
    operationGeneration.current += 1;
    setEditingId(null);
    setDraft(emptyDraft);
    setSaving(false);
    setDeletingId(null);
    setError(null);
    setNotice(null);
    createAttemptKey.current = null;
    createAttemptSubmitted.current = false;
    focusAddAfterDelete.current = false;
  }, [organizationId]);

  React.useEffect(() => {
    if (editingId !== null) nameInput.current?.focus();
  }, [editingId]);

  React.useEffect(() => {
    if (deletingId !== null || !focusAddAfterDelete.current) return;
    focusAddAfterDelete.current = false;
    const frame = requestAnimationFrame(() => addButton.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [deletingId, venues]);

  const canRead = !permissionsLoading && !permissionsError && can('events.read');
  const canWrite = !permissionsLoading && !permissionsError && can('events.write');

  const restoreFocus = () => {
    const target = returnFocus.current;
    if (target) requestAnimationFrame(() => target.focus());
  };

  const beginCreate = (trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    createAttemptKey.current = `venue_${globalThis.crypto.randomUUID()}`;
    createAttemptSubmitted.current = false;
    setEditingId('new');
    setDraft(emptyDraft);
    setError(null);
    setNotice(null);
  };

  const beginEdit = (venue: AdminSavedVenue, trigger: HTMLButtonElement) => {
    returnFocus.current = trigger;
    createAttemptKey.current = null;
    createAttemptSubmitted.current = false;
    setEditingId(venue.id);
    setDraft(venueDraft(venue));
    setError(null);
    setNotice(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(emptyDraft);
    setError(null);
    createAttemptKey.current = null;
    createAttemptSubmitted.current = false;
    restoreFocus();
  };

  const updateDraft = (field: keyof VenueDraft, value: string) => {
    if (editingId === 'new' && createAttemptSubmitted.current) {
      createAttemptKey.current = `venue_${globalThis.crypto.randomUUID()}`;
      createAttemptSubmitted.current = false;
    }
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
    setNotice(null);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite || saving || editingId === null) return;
    if (draft.name.trim().length === 0) {
      setError('Venue name is required.');
      nameInput.current?.focus();
      return;
    }
    const country = draft.country.trim();
    if (country.length > 0 && country.length !== 2) {
      setError('Country must be a two-letter ISO code.');
      countryInput.current?.focus();
      return;
    }

    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    const savedOrganizationId = organizationId;
    const isCurrent = () =>
      mounted.current &&
      generation === operationGeneration.current &&
      savedOrganizationId === organizationId;
    setSaving(true);
    setError(null);
    setNotice(null);

    try {
      const input = {
        name: draft.name.trim(),
        address: compactAddress(draft),
        ...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : {}),
      };
      const result =
        editingId === 'new'
          ? await (async () => {
              createAttemptSubmitted.current = true;
              return adminApi.createSavedVenue({
                organizationId: savedOrganizationId,
                ...input,
                idempotencyKey:
                  createAttemptKey.current ??
                  (createAttemptKey.current = `venue_${globalThis.crypto.randomUUID()}`),
              });
            })()
          : await adminApi.updateSavedVenue(editingId, input);
      if (!isCurrent()) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onVenuesChange(
        sortVenues(
          editingId === 'new'
            ? [...venuesRef.current, result.data]
            : venuesRef.current.map((venue) => (venue.id === result.data.id ? result.data : venue)),
        ),
      );
      setEditingId(null);
      setDraft(emptyDraft);
      createAttemptKey.current = null;
      createAttemptSubmitted.current = false;
      setNotice(editingId === 'new' ? 'Saved venue created.' : 'Saved venue updated.');
      restoreFocus();
    } catch {
      if (isCurrent()) setError('The saved venue could not be saved. Try again.');
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  const remove = async (venue: AdminSavedVenue) => {
    if (!canWrite || deletingId !== null) return;
    const generation = operationGeneration.current + 1;
    operationGeneration.current = generation;
    const savedOrganizationId = organizationId;
    const isCurrent = () =>
      mounted.current &&
      generation === operationGeneration.current &&
      savedOrganizationId === organizationId;
    setDeletingId(venue.id);
    setError(null);
    setNotice(null);
    try {
      const result = await adminApi.deleteSavedVenue(venue.id);
      if (!isCurrent()) return;
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onVenuesChange(venuesRef.current.filter((candidate) => candidate.id !== venue.id));
      onVenueDeleted?.(venue.id);
      setNotice(`${venue.name} deleted.`);
      focusAddAfterDelete.current = true;
    } catch {
      if (isCurrent()) setError('The saved venue could not be deleted. Try again.');
    } finally {
      if (isCurrent()) setDeletingId(null);
    }
  };

  return (
    <section className="space-y-4 rounded-md border p-4" aria-labelledby="saved-venues-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="saved-venues-title" className="font-medium">
            Saved venues
          </h3>
          <p className="text-sm text-muted-foreground">
            Reuse venue addresses and timezones across event drafts.
          </p>
        </div>
        {canRead && canWrite && !loadError ? (
          <Button
            ref={addButton}
            type="button"
            variant="outline"
            onClick={(event) => beginCreate(event.currentTarget)}
            disabled={loading || saving || deletingId !== null || editingId !== null}
          >
            Add saved venue
          </Button>
        ) : null}
      </div>

      {permissionsLoading ? (
        <output className="text-sm text-muted-foreground">Checking saved venue access…</output>
      ) : permissionsError ? (
        <p className="text-sm text-muted-foreground">
          Venue management is unavailable while access is being recovered.
        </p>
      ) : !canRead ? (
        <p className="text-sm text-muted-foreground">
          Event viewing permission is required to inspect saved venues.
        </p>
      ) : loadError ? (
        <p className="text-sm text-muted-foreground">
          Venue management is unavailable until the saved venue list is reloaded.
        </p>
      ) : loading ? (
        <output className="text-sm text-muted-foreground">Loading saved venues…</output>
      ) : (
        <>
          {venues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reusable venues have been saved.</p>
          ) : (
            <ul className="divide-y" aria-label="Reusable saved venues">
              {venues.map((venue) => (
                <li key={venue.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{venue.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {[venue.address?.city, venue.address?.region, venue.address?.country]
                        .filter(Boolean)
                        .join(', ') || 'No locality configured'}
                      {venue.timezone ? ` · ${venue.timezone}` : ''}
                    </p>
                  </div>
                  {canWrite ? (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={(event) => beginEdit(venue, event.currentTarget)}
                        disabled={saving || deletingId !== null || editingId !== null}
                      >
                        Edit {venue.name}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={saving || deletingId !== null || editingId !== null}
                          >
                            Delete {venue.name}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete {venue.name}?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Venues used by events, occurrences, or workspace defaults cannot be
                              deleted until those references are removed.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void remove(venue)}>
                              Delete venue
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {!canWrite ? (
            <p className="text-sm text-muted-foreground">
              Event editing permission is required to manage saved venues.
            </p>
          ) : null}
        </>
      )}

      {editingId !== null && canWrite ? (
        <form className="space-y-4 rounded-md bg-muted/40 p-4" onSubmit={submit} noValidate>
          <h4 className="font-medium">{editingId === 'new' ? 'Add saved venue' : 'Edit venue'}</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="saved-venue-name">Venue name</Label>
              <Input
                ref={nameInput}
                id="saved-venue-name"
                value={draft.name}
                onChange={(event) => updateDraft('name', event.target.value)}
                aria-invalid={error === 'Venue name is required.'}
                disabled={saving}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="saved-venue-address">Street address</Label>
              <Input
                id="saved-venue-address"
                value={draft.address}
                onChange={(event) => updateDraft('address', event.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saved-venue-city">City</Label>
              <Input
                id="saved-venue-city"
                value={draft.city}
                onChange={(event) => updateDraft('city', event.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saved-venue-region">State or region</Label>
              <Input
                id="saved-venue-region"
                value={draft.region}
                onChange={(event) => updateDraft('region', event.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saved-venue-postal-code">Postal code</Label>
              <Input
                id="saved-venue-postal-code"
                value={draft.postalCode}
                onChange={(event) => updateDraft('postalCode', event.target.value)}
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="saved-venue-country">Country code</Label>
              <Input
                ref={countryInput}
                id="saved-venue-country"
                maxLength={2}
                value={draft.country}
                onChange={(event) => updateDraft('country', event.target.value.toUpperCase())}
                disabled={saving}
                aria-invalid={error === 'Country must be a two-letter ISO code.'}
                aria-describedby={
                  error === 'Country must be a two-letter ISO code.'
                    ? 'saved-venue-form-error'
                    : undefined
                }
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="saved-venue-timezone">Timezone</Label>
              <Input
                id="saved-venue-timezone"
                value={draft.timezone}
                onChange={(event) => updateDraft('timezone', event.target.value)}
                disabled={saving}
              />
            </div>
          </div>
          {error ? (
            <p id="saved-venue-form-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving venue…' : 'Save venue'}
            </Button>
            <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {editingId === null && error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : notice ? (
        <output className="text-sm text-success">{notice}</output>
      ) : null}
    </section>
  );
}
