import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
  const organizationFixture = {
    id: 'org_1',
    tenantId: 'tnt_1',
    name: 'Tixkit',
    slug: 'tixkit',
    status: 'active' as const,
    eventDefaults: {} as {
      timezone?: string;
      currency?: string;
      country?: string;
      defaultVenueId?: string | null;
      eventDescription?: string;
    },
    boxOfficeSettings: {
      enabled: true,
      allowedTenderTypes: ['cash', 'manual_card', 'comp'] as Array<'cash' | 'manual_card' | 'comp'>,
      requireBuyerEmail: false,
      receiptMode: 'email' as const,
    },
  };
  return {
    organizationFixture,
    bootstrapState: {
      value: {
        organizations: [organizationFixture],
        organizationId: 'org_1',
        loading: false,
        error: null,
      },
    },
  };
});

const apiMock = vi.hoisted(() => ({
  updateOrganization: vi.fn(),
  listSavedVenues: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

const guardMock = vi.hoisted(() => ({
  allowed: true,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => testState.bootstrapState.value,
}));

vi.mock('@/lib/api', () => ({
  adminApi: apiMock,
}));

vi.mock('@/components/permission-guard', () => ({
  PermissionGuard: ({ children }: { children: React.ReactNode }) =>
    guardMock.allowed ? <>{children}</> : <div>Access denied</div>,
}));

vi.mock('sonner', () => ({
  toast: toastMock,
}));

import WorkspacePage from './page';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('WorkspacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardMock.allowed = true;
    testState.organizationFixture.name = 'Tixkit';
    testState.organizationFixture.slug = 'tixkit';
    testState.organizationFixture.eventDefaults = {};
    testState.bootstrapState.value = {
      organizations: [testState.organizationFixture],
      organizationId: 'org_1',
      loading: false,
      error: null,
    };
    apiMock.listSavedVenues.mockResolvedValue({ ok: true, data: [] });
  });

  it('does not mount workspace settings when settings permission is denied', () => {
    guardMock.allowed = false;

    render(<WorkspacePage />);

    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Workspace Name')).not.toBeInTheDocument();
    expect(apiMock.updateOrganization).not.toHaveBeenCalled();
  });

  it('saves workspace identity and box-office policy together', async () => {
    apiMock.updateOrganization.mockResolvedValue({
      ok: true,
      data: {
        ...testState.organizationFixture,
        name: 'Festival Ops',
        boxOfficeSettings: {
          enabled: true,
          allowedTenderTypes: ['cash', 'comp'],
          requireBuyerEmail: true,
          receiptMode: 'email',
        },
      },
    });

    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Workspace Name'), {
      target: { value: 'Festival Ops' },
    });
    fireEvent.click(screen.getByLabelText('Manual Card'));
    fireEvent.click(screen.getByText('Require buyer email for at-door orders'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(apiMock.updateOrganization).toHaveBeenCalledTimes(1));
    expect(apiMock.updateOrganization).toHaveBeenCalledWith('org_1', {
      name: 'Festival Ops',
      slug: 'tixkit',
      boxOfficeSettings: {
        enabled: true,
        allowedTenderTypes: ['cash', 'comp'],
        requireBuyerEmail: true,
        receiptMode: 'email',
      },
      eventDefaults: {},
    });
    expect(toastMock.success).toHaveBeenCalledWith('Workspace settings saved');
  });

  it('requires a non-empty workspace name before saving', async () => {
    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Workspace Name'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(apiMock.updateOrganization).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Workspace name is required');
    expect(screen.getByRole('alert')).toHaveTextContent('Workspace name is required');
  });

  it('retains a configured default venue and retries an explicit venue-load failure', async () => {
    testState.organizationFixture.eventDefaults = {
      timezone: 'America/Chicago',
      defaultVenueId: 'ven_configured',
    };
    apiMock.listSavedVenues
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'venues_unavailable', message: 'Saved venues are unavailable' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [{ id: 'ven_configured', name: 'Civic Hall' }],
      });

    render(<WorkspacePage />);

    const venue = await screen.findByLabelText('Default saved venue');
    expect(venue).toBeDisabled();
    expect(venue).toHaveValue('ven_configured');
    expect(
      screen.getByRole('option', { name: 'Configured venue (ven_configured) — unavailable' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Saved venues are unavailable');

    fireEvent.change(screen.getByLabelText('Timezone'), {
      target: { value: 'America/Denver' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved venues' }));

    await waitFor(() => expect(venue).toBeEnabled());
    expect(venue).toHaveValue('ven_configured');
    expect(screen.getByRole('option', { name: 'Civic Hall' })).toBeInTheDocument();
    expect(screen.getByLabelText('Timezone')).toHaveValue('America/Denver');
    expect(apiMock.listSavedVenues).toHaveBeenCalledTimes(2);
  });

  it('preserves edited defaults and re-enables saving after an API failure result', async () => {
    apiMock.updateOrganization.mockResolvedValue({
      ok: false,
      error: { code: 'workspace_conflict', message: 'Workspace changed elsewhere' },
    });

    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Timezone'), {
      target: { value: 'Europe/London' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Workspace changed elsewhere');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/London');
  });

  it('recovers from an unexpected save rejection without losing edits', async () => {
    apiMock.updateOrganization.mockRejectedValue(new Error('transport exploded'));

    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Default event description'), {
      target: { value: 'Doors open at six.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Workspace settings could not be saved. Try again.',
    );
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    expect(screen.getByLabelText('Default event description')).toHaveValue('Doors open at six.');
  });

  it('saves defaults atomically and reconciles server-normalized values', async () => {
    apiMock.listSavedVenues.mockResolvedValue({
      ok: true,
      data: [{ id: 'ven_a', name: 'Civic Hall' }],
    });
    apiMock.updateOrganization.mockResolvedValue({
      ok: true,
      data: {
        ...testState.organizationFixture,
        name: 'Festival Ops',
        slug: 'festival-ops',
        eventDefaults: {
          timezone: 'America/New_York',
          currency: 'USD',
          country: 'US',
          defaultVenueId: 'ven_a',
          eventDescription: 'Server-normalized description',
        },
      },
    });

    render(<WorkspacePage />);

    fireEvent.change(await screen.findByLabelText('Workspace Name'), {
      target: { value: 'Festival Ops' },
    });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'festival-ops' } });
    fireEvent.change(screen.getByLabelText('Timezone'), {
      target: { value: 'america/new_york' },
    });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'usd' } });
    fireEvent.change(screen.getByLabelText('Country'), { target: { value: 'us' } });
    fireEvent.change(screen.getByLabelText('Default saved venue'), {
      target: { value: 'ven_a' },
    });
    fireEvent.change(screen.getByLabelText('Default event description'), {
      target: { value: ' Local description ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(apiMock.updateOrganization).toHaveBeenCalledTimes(1));
    expect(apiMock.updateOrganization).toHaveBeenCalledWith('org_1', {
      name: 'Festival Ops',
      slug: 'festival-ops',
      boxOfficeSettings: testState.organizationFixture.boxOfficeSettings,
      eventDefaults: {
        timezone: 'america/new_york',
        currency: 'USD',
        country: 'US',
        defaultVenueId: 'ven_a',
        eventDescription: ' Local description ',
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace settings saved.');
    expect(screen.getByLabelText('Timezone')).toHaveValue('America/New_York');
    expect(screen.getByLabelText('Default event description')).toHaveValue(
      'Server-normalized description',
    );

    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/Chicago' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('makes every editable setting inert while a save is in flight', async () => {
    const pending = deferred<Awaited<ReturnType<typeof apiMock.updateOrganization>>>();
    apiMock.updateOrganization.mockReturnValue(pending.promise);

    render(<WorkspacePage />);

    const timezone = await screen.findByLabelText('Timezone');
    fireEvent.change(timezone, { target: { value: 'Europe/Paris' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saving workspace settings…');
    expect(timezone).toBeDisabled();
    expect(screen.getByLabelText('Workspace Name')).toBeDisabled();
    expect(screen.getByLabelText('Enable box-office sales')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(timezone).toHaveValue('Europe/Paris');

    pending.resolve({
      ok: false,
      error: { code: 'workspace_unavailable', message: 'Save failed safely' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Save failed safely');
    expect(timezone).toBeEnabled();
    expect(timezone).toHaveValue('Europe/Paris');
  });

  it('does not announce a late save completion after navigation', async () => {
    const pending = deferred<Awaited<ReturnType<typeof apiMock.updateOrganization>>>();
    apiMock.updateOrganization.mockReturnValue(pending.promise);

    const { unmount } = render(<WorkspacePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiMock.updateOrganization).toHaveBeenCalledTimes(1));
    unmount();

    pending.resolve({ ok: true, data: testState.organizationFixture });
    await Promise.resolve();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('ignores stale save completion after a workspace switch and during the newer save', async () => {
    const oldSave = deferred<Awaited<ReturnType<typeof apiMock.updateOrganization>>>();
    const newSave = deferred<Awaited<ReturnType<typeof apiMock.updateOrganization>>>();
    apiMock.updateOrganization
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newSave.promise);
    const secondOrganization = {
      ...testState.organizationFixture,
      id: 'org_2',
      name: 'Second workspace',
      slug: 'second-workspace',
      eventDefaults: { timezone: 'America/Denver' },
    };

    const { rerender } = render(<WorkspacePage />);
    fireEvent.change(await screen.findByLabelText('Workspace Name'), {
      target: { value: 'Old pending edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();

    testState.bootstrapState.value = {
      organizations: [testState.organizationFixture, secondOrganization],
      organizationId: 'org_2',
      loading: false,
      error: null,
    };
    rerender(<WorkspacePage />);
    expect(await screen.findByLabelText('Workspace Name')).toHaveValue('Second workspace');

    fireEvent.change(screen.getByLabelText('Workspace Name'), {
      target: { value: 'Second pending edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(apiMock.updateOrganization).toHaveBeenCalledTimes(2));

    oldSave.resolve({
      ok: true,
      data: {
        ...testState.organizationFixture,
        name: 'Stale server result',
      },
    });
    await Promise.resolve();
    expect(screen.getByLabelText('Workspace Name')).toHaveValue('Second pending edit');
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(toastMock.success).not.toHaveBeenCalled();

    newSave.resolve({
      ok: true,
      data: {
        ...secondOrganization,
        name: 'Second authoritative result',
      },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Workspace settings saved.');
    expect(screen.getByLabelText('Workspace Name')).toHaveValue('Second authoritative result');
    expect(toastMock.success).toHaveBeenCalledTimes(1);
  });
});
