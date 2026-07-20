import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminSavedVenue } from '@/lib/api';

const apiMock = vi.hoisted(() => ({
  createSavedVenue: vi.fn(),
  updateSavedVenue: vi.fn(),
  deleteSavedVenue: vi.fn(),
}));

const permissionState = vi.hoisted(() => ({
  permissions: new Set(['events.read', 'events.write']),
  loading: false,
  error: null as Error | null,
  retry: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  adminApi: apiMock,
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({
    can: (permission: string) => permissionState.permissions.has(permission),
    loading: permissionState.loading,
    error: permissionState.error,
    retry: permissionState.retry,
  }),
}));

import { SavedVenueManager } from './saved-venue-manager';

const civicHall: AdminSavedVenue = {
  id: 'ven_civic',
  organizationId: 'org_1',
  name: 'Civic Hall',
  address: {
    address: '100 Main St',
    city: 'Austin',
    region: 'TX',
    postalCode: '78701',
    country: 'US',
  },
  timezone: 'America/Chicago',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};
const defaultVenues = [civicHall];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function VenueHarness({
  organizationId = 'org_1',
  initialVenues = defaultVenues,
}: {
  organizationId?: string;
  initialVenues?: AdminSavedVenue[];
}) {
  const [venues, setVenues] = React.useState(initialVenues);
  return (
    <SavedVenueManager
      organizationId={organizationId}
      venues={venues}
      loading={false}
      loadError={null}
      onVenuesChange={setVenues}
    />
  );
}

describe('SavedVenueManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.permissions = new Set(['events.read', 'events.write']);
    permissionState.loading = false;
    permissionState.error = null;
  });

  it('keeps venues read-only when the viewer lacks event editing permission', () => {
    permissionState.permissions = new Set(['events.read']);

    render(<VenueHarness />);

    expect(screen.getByText('Civic Hall')).toBeVisible();
    expect(screen.getByText(/event editing permission is required/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add saved venue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Civic Hall' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Civic Hall' })).toBeNull();
  });

  it('preserves a failed create draft and reconciles the authoritative venue on retry', async () => {
    const created: AdminSavedVenue = {
      ...civicHall,
      id: 'ven_river',
      name: 'River Room',
      address: { city: 'Chicago', region: 'IL', country: 'US' },
    };
    apiMock.createSavedVenue
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'network_error', message: 'Venue service is offline' },
      })
      .mockResolvedValueOnce({ ok: true, data: created });

    render(<VenueHarness initialVenues={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add saved venue' }));
    const name = screen.getByLabelText('Venue name');
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: 'River Room' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Chicago' } });
    fireEvent.change(screen.getByLabelText('State or region'), { target: { value: 'IL' } });
    fireEvent.change(screen.getByLabelText('Country code'), { target: { value: 'us' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Venue service is offline');
    expect(name).toHaveValue('River Room');
    expect(screen.getByLabelText('City')).toHaveValue('Chicago');

    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));

    expect(await screen.findByText('River Room')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Saved venue created.');
    expect(apiMock.createSavedVenue).toHaveBeenCalledTimes(2);
    const firstInput = apiMock.createSavedVenue.mock.calls[0]?.[0];
    const secondInput = apiMock.createSavedVenue.mock.calls[1]?.[0];
    expect(firstInput).toMatchObject({
      organizationId: 'org_1',
      name: 'River Room',
      address: { city: 'Chicago', region: 'IL', country: 'US' },
    });
    expect(firstInput.idempotencyKey).toMatch(/^venue_/u);
    expect(secondInput).toEqual(firstInput);
  });

  it('focuses and associates an invalid country code with its error', async () => {
    render(<VenueHarness initialVenues={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add saved venue' }));
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'River Room' } });
    const country = screen.getByLabelText('Country code');
    fireEvent.change(country, { target: { value: 'U' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Country must be a two-letter ISO code.',
    );
    expect(country).toHaveFocus();
    expect(country).toHaveAttribute('aria-invalid', 'true');
    expect(country).toHaveAccessibleDescription('Country must be a two-letter ISO code.');
    expect(apiMock.createSavedVenue).not.toHaveBeenCalled();
  });

  it('starts a new idempotent attempt after a failed draft is materially changed', async () => {
    apiMock.createSavedVenue
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'validation_error', message: 'Review the venue name' },
      })
      .mockResolvedValueOnce({ ok: true, data: civicHall });
    render(<VenueHarness initialVenues={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add saved venue' }));
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Civic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Review the venue name');
    const firstKey = apiMock.createSavedVenue.mock.calls[0]?.[0].idempotencyKey;

    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Civic Hall' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));

    expect(await screen.findByText('Civic Hall')).toBeVisible();
    const secondKey = apiMock.createSavedVenue.mock.calls[1]?.[0].idempotencyKey;
    expect(secondKey).toMatch(/^venue_/u);
    expect(secondKey).not.toBe(firstKey);
  });

  it('moves focus to Add saved venue after a successful deletion', async () => {
    apiMock.deleteSavedVenue.mockResolvedValue({ ok: true, data: undefined });
    render(<VenueHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Civic Hall' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete venue' }));

    expect(await screen.findByText('Civic Hall deleted.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add saved venue' })).toHaveFocus(),
    );
  });

  it('prevents another mutation from invalidating a pending deletion', async () => {
    const pending = deferred<{ ok: true; data: undefined }>();
    apiMock.deleteSavedVenue.mockReturnValue(pending.promise);
    render(<VenueHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Civic Hall' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete venue' }));

    expect(screen.getByRole('button', { name: 'Add saved venue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Civic Hall' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete Civic Hall' })).toBeDisabled();
    pending.resolve({ ok: true, data: undefined });

    expect(await screen.findByText('Civic Hall deleted.')).toBeVisible();
    expect(screen.queryByText('Civic Hall')).toBeNull();
  });

  it('edits a venue without replacing the list until the server succeeds', async () => {
    const pending = deferred<{ ok: true; data: AdminSavedVenue }>();
    apiMock.updateSavedVenue.mockReturnValue(pending.promise);

    render(<VenueHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit Civic Hall' }));
    fireEvent.change(screen.getByLabelText('Venue name'), {
      target: { value: 'Civic Auditorium' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));

    expect(screen.getByText('Civic Hall')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Saving venue…' })).toBeDisabled();
    const name = screen.getByLabelText('Venue name');
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('Timezone')).toBeDisabled();
    expect(name).toHaveValue('Civic Auditorium');

    pending.resolve({
      ok: true,
      data: { ...civicHall, name: 'Civic Auditorium', updatedAt: '2026-07-20T01:00:00.000Z' },
    });

    expect(await screen.findByText('Civic Auditorium')).toBeVisible();
    expect(screen.queryByText('Civic Hall')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Saved venue updated.');
  });

  it('keeps an in-use venue and returns focus to its delete trigger', async () => {
    apiMock.deleteSavedVenue.mockResolvedValue({
      ok: false,
      error: {
        code: 'venue_in_use',
        message: 'Remove this venue from event drafts and workspace defaults before deleting it',
      },
    });

    render(<VenueHarness />);

    const trigger = screen.getByRole('button', { name: 'Delete Civic Hall' });
    fireEvent.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Delete venue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Remove this venue from event drafts and workspace defaults before deleting it',
    );
    expect(screen.getByText('Civic Hall')).toBeVisible();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('ignores a create completion from the previous workspace', async () => {
    const pending = deferred<{ ok: true; data: AdminSavedVenue }>();
    apiMock.createSavedVenue.mockReturnValue(pending.promise);
    const onVenuesChange = vi.fn();
    const { rerender } = render(
      <SavedVenueManager
        organizationId="org_1"
        venues={[]}
        loading={false}
        loadError={null}
        onVenuesChange={onVenuesChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add saved venue' }));
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'Old venue' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save venue' }));

    rerender(
      <SavedVenueManager
        organizationId="org_2"
        venues={[]}
        loading={false}
        loadError={null}
        onVenuesChange={onVenuesChange}
      />,
    );
    pending.resolve({ ok: true, data: { ...civicHall, name: 'Old venue' } });
    await Promise.resolve();

    expect(onVenuesChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Venue name')).toBeNull();
  });
});
