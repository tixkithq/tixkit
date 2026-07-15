import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminEventDetail } from '@/lib/api';
import { EventForm } from './event-form';

const api = vi.hoisted(() => ({
  updateEvent: vi.fn(),
  createEvent: vi.fn(),
  getEvent: vi.fn(),
  reportOnboardingEvent: vi.fn(),
  listEventOccurrences: vi.fn(),
  listSavedVenues: vi.fn(),
  updateSavedVenue: vi.fn(),
  deleteSavedVenue: vi.fn(),
  createSavedVenue: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const queryState = vi.hoisted(() => ({ savedVenues: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/api', () => ({ adminApi: api }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizationId: 'org_1',
    brandId: 'brd_1',
    loading: false,
  }),
}));
vi.mock('@/hooks/use-admin-table-data', () => ({
  useAdminQuery: (key: string[]) => ({
    data: key[0] === 'listSavedVenues' ? queryState.savedVenues : [],
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  }),
}));
vi.mock('./event-marketing-view', () => ({ EventMarketingView: () => null }));
vi.mock('./event-schedule-view', () => ({ EventScheduleView: () => null }));

const baseEvent = {
  id: 'evt_merge',
  version: 2,
  title: 'Base title',
  slug: 'base-title',
  description: 'Base description',
  status: 'draft',
  startsAt: '2026-08-16T00:00:00.000Z',
  endsAt: '2026-08-16T02:00:00.000Z',
  timezone: 'America/Chicago',
  venue: null,
  venueId: null,
  visibility: 'public',
  seo: {},
  currency: 'USD',
  grossSalesCents: 0,
  ticketsSold: 0,
  coverImageUrl: null,
  coverImageAlt: undefined,
  externalUrl: null,
  resalePolicy: { enabled: false, maxMultiplier: 1 },
  checkIns: 0,
  updatedAt: '2026-07-15T00:00:00.000Z',
  brandId: 'brd_1',
} as AdminEventDetail;

function renderForm(event = baseEvent, onSuccess = vi.fn()) {
  return {
    onSuccess,
    ...render(<EventForm event={event} section="basics" onSuccess={onSuccess} />),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  queryState.savedVenues = [];
  api.reportOnboardingEvent.mockResolvedValue({ ok: true, data: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventForm optimistic merge recovery', () => {
  it('loads the latest event in place and requires an explicit same-field choice', async () => {
    api.updateEvent.mockResolvedValue({
      ok: false,
      error: { code: 'stale_event_version', message: 'Changed elsewhere' },
    });
    api.getEvent.mockResolvedValue({
      ok: true,
      data: { ...baseEvent, version: 3, title: 'Remote title' },
    });
    renderForm();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const heading = await screen.findByRole('heading', {
      name: 'Choose values for 1 conflicting field',
    });
    expect(heading).toHaveFocus();
    expect(screen.getByLabelText('Title')).toHaveValue('My title');
    expect(screen.getByRole('group', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Title: My title')).toBeInTheDocument();
    expect(screen.getByText('Title: Remote title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Use latest Title value' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Remote title');
    expect(screen.queryByRole('heading', { name: /Choose values/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
  });

  it('automatically merges unrelated local and remote fields', async () => {
    api.updateEvent.mockResolvedValue({
      ok: false,
      error: { code: 'stale_event_version', message: 'Changed elsewhere' },
    });
    api.getEvent.mockResolvedValue({
      ok: true,
      data: { ...baseEvent, version: 3, description: 'Remote description' },
    });
    renderForm();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.getEvent).toHaveBeenCalledWith('evt_merge'));
    expect(screen.getByLabelText('Title')).toHaveValue('My title');
    expect(screen.queryByRole('heading', { name: /Choose values/ })).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith('Your edits were safely merged with the latest event.');
  });

  it('preserves edits typed while the latest event request is pending', async () => {
    let releaseLatest: ((value: unknown) => void) | undefined;
    api.updateEvent.mockResolvedValue({
      ok: false,
      error: { code: 'stale_event_version', message: 'Changed elsewhere' },
    });
    api.getEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseLatest = resolve;
        }),
    );
    renderForm();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'First local title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Typed during GET' } });
    releaseLatest?.({
      ok: true,
      data: { ...baseEvent, version: 3, description: 'Remote description' },
    });

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Typed during GET'));
    expect(screen.queryByRole('heading', { name: /Choose values/ })).not.toBeInTheDocument();
  });

  it('keeps unresolved conflicts blocking across a remount and names every choice uniquely', async () => {
    api.updateEvent.mockResolvedValue({
      ok: false,
      error: { code: 'stale_event_version', message: 'Changed elsewhere' },
    });
    const latest = {
      ...baseEvent,
      version: 3,
      title: 'Remote title',
      description: 'Remote description',
    };
    api.getEvent.mockResolvedValue({ ok: true, data: latest });
    const first = renderForm();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'My description' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(
      await screen.findByRole('heading', { name: 'Choose values for 2 conflicting fields' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my Title change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep my Description change' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use latest Title value' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Use latest Description value' }),
    ).toBeInTheDocument();
    first.unmount();

    renderForm(latest);
    expect(
      await screen.findByRole('heading', { name: 'Choose values for 2 conflicting fields' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(screen.getByLabelText('Title')).toHaveValue('My title');
  });

  it('serializes saves and preserves typing that happens while a save is in flight', async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    api.updateEvent
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        data: { ...baseEvent, version: 4, title: 'Second title' },
      });
    renderForm();

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'First title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Second title' } });
    expect(api.updateEvent).toHaveBeenCalledTimes(1);

    releaseFirst?.({
      ok: true,
      data: { ...baseEvent, version: 3, title: 'First title' },
    });

    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(2));
    expect(api.updateEvent.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 2 });
    expect(api.updateEvent.mock.calls[1]?.[1]).toMatchObject({
      expectedVersion: 3,
      title: 'Second title',
    });
    expect(screen.getByLabelText('Title')).toHaveValue('Second title');
  });

  it('rebases an in-memory dirty form when a sibling section refreshes the event version', async () => {
    api.updateEvent.mockResolvedValue({
      ok: true,
      data: { ...baseEvent, version: 4, title: 'My title' },
    });
    const onSuccess = vi.fn();
    const view = render(<EventForm event={baseEvent} section="basics" onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } });

    view.rerender(
      <EventForm
        event={{ ...baseEvent, version: 3, title: 'Remote title' }}
        section="basics"
        onSuccess={onSuccess}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Choose values for 1 conflicting field' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Title: Remote title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep my Title change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(api.updateEvent).toHaveBeenCalledWith(
        'evt_merge',
        expect.objectContaining({ expectedVersion: 3, title: 'My title' }),
      ),
    );
  });

  it('does not autosave again after a successful reset removed every diff', async () => {
    api.updateEvent.mockResolvedValue({
      ok: true,
      data: { ...baseEvent, version: 3, title: 'Saved title' },
    });
    render(<EventForm event={baseEvent} section="basics" autosave onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Saved title' } });

    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(api.updateEvent).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('tixkit:event-draft:evt_merge:basics')).toBeNull();
  });

  it('persists offline edits and restores them after a remount', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const first = render(
      <EventForm event={baseEvent} section="basics" autosave onSuccess={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Offline title' } });

    const key = 'tixkit:event-draft:evt_merge:basics';
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toContain('Offline title'));
    first.unmount();
    render(<EventForm event={baseEvent} section="basics" autosave onSuccess={vi.fn()} />);

    expect(await screen.findByDisplayValue('Offline title')).toBeInTheDocument();
    expect(screen.getByText('Offline — changes are unsaved')).toBeInTheDocument();
  });

  it('preserves a saved venue binding in the durable recovery snapshot', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    queryState.savedVenues = [
      {
        id: 'ven_local',
        name: 'Local Hall',
        address: {
          address: '2 State St',
          city: 'Chicago',
          region: 'IL',
          postalCode: '60602',
          country: 'US',
        },
        timezone: 'America/Chicago',
      },
    ];
    const first = render(
      <EventForm event={baseEvent} section="schedule" autosave onSuccess={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Saved venue'), {
      target: { value: 'ven_local' },
    });

    const key = 'tixkit:event-draft:evt_merge:schedule';
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(key) ?? '{}')).toMatchObject({
        selectedVenueId: 'ven_local',
        baseSelectedVenueId: '',
      }),
    );
    first.unmount();
    render(<EventForm event={baseEvent} section="schedule" autosave onSuccess={vi.fn()} />);
    expect(await screen.findByLabelText('Saved venue')).toHaveValue('ven_local');
  });

  it('autosaves clearing a saved venue binding even when inline fields are unchanged', async () => {
    queryState.savedVenues = [
      {
        id: 'ven_base',
        name: 'Base Hall',
        address: {},
        timezone: 'America/Chicago',
      },
    ];
    api.updateEvent.mockResolvedValue({
      ok: true,
      data: { ...baseEvent, version: 3, venueId: null },
    });
    render(
      <EventForm
        event={{ ...baseEvent, venueId: 'ven_base' }}
        section="schedule"
        autosave
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Saved venue'), { target: { value: '' } });

    await waitFor(
      () =>
        expect(api.updateEvent).toHaveBeenCalledWith(
          'evt_merge',
          expect.objectContaining({ expectedVersion: 2, venueId: null }),
        ),
      { timeout: 2_000 },
    );
  });

  it('discards corrupted or version-mismatched recovery data safely', async () => {
    const key = 'tixkit:event-draft:evt_merge:basics';
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ schemaVersion: 99, values: { title: 'Injected title' } }),
    );
    render(<EventForm event={baseEvent} section="basics" autosave onSuccess={vi.fn()} />);

    expect(await screen.findByLabelText('Title')).toHaveValue('Base title');
    await waitFor(() => expect(window.sessionStorage.getItem(key)).toBeNull());
    expect(screen.queryByText(/Choose values/)).not.toBeInTheDocument();
  });
});
