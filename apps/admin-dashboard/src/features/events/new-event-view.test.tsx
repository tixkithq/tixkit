import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewEventView } from './new-event-view';

const push = vi.hoisted(() => vi.fn());
const createEvent = vi.hoisted(() => vi.fn());
const duplicateEvent = vi.hoisted(() => vi.fn());
const reportOnboardingEvent = vi.hoisted(() => vi.fn());
const listSavedVenues = vi.hoisted(() => vi.fn());
const refetchSourceEvents = vi.hoisted(() => vi.fn());
const allEventsState = vi.hoisted(() => ({
  value: {
    events: [{ id: 'evt_source', title: 'Source Gala' }],
    loading: false,
    error: undefined as { code: string; message: string } | undefined,
  },
}));
const bootstrapState = vi.hoisted(() => ({
  value: {
    organizationId: 'org_1',
    brandId: 'brd_1',
    brands: [],
    organizations: [],
  } as Record<string, unknown>,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState.value,
}));
vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({ can: () => true, loading: false }),
}));
vi.mock('@/hooks/use-all-events', () => ({
  useAllEvents: () => ({
    ...allEventsState.value,
    refetch: refetchSourceEvents,
  }),
}));
vi.mock('@/lib/api', () => ({
  adminApi: {
    createEvent,
    duplicateEvent,
    listPaymentAccounts: vi.fn(),
    listSavedVenues,
    reportOnboardingEvent,
  },
}));

describe('NewEventView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEvent.mockResolvedValue({ ok: true, data: { id: 'evt_new' } });
    duplicateEvent.mockResolvedValue({ ok: true, data: { id: 'evt_duplicate' } });
    reportOnboardingEvent.mockResolvedValue({ ok: true, data: undefined });
    listSavedVenues.mockResolvedValue({ ok: true, data: [] });
    allEventsState.value = {
      events: [{ id: 'evt_source', title: 'Source Gala' }],
      loading: false,
      error: undefined,
    };
    bootstrapState.value = {
      organizationId: 'org_1',
      brandId: 'brd_1',
      brands: [],
      organizations: [],
    };
  });

  it('creates a durable blank draft and redirects to its media-aware launch follow-up', async () => {
    render(<NewEventView />);
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Community Night' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(createEvent.mock.calls[0][0]).toMatchObject({
      organizationId: 'org_1',
      brandId: 'brd_1',
      title: 'Community Night',
    });
    expect(push).toHaveBeenCalledWith('/events/evt_new?created=1');
  });

  it('preserves form data and does not redirect when atomic preset creation fails', async () => {
    createEvent.mockResolvedValue({
      ok: false,
      error: { message: 'Unable to apply the starting point. Retry to continue.' },
    });
    render(<NewEventView />);
    fireEvent.click(screen.getByRole('radio', { name: /Free RSVP/ }));
    expect(reportOnboardingEvent).toHaveBeenCalledWith({
      stage: 'starting_point_selected',
      outcome: 'free',
    });
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'RSVP Night' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to apply the starting point. Retry to continue.',
    );
    expect(screen.getByLabelText('Title')).toHaveValue('RSVP Night');
    expect(push).not.toHaveBeenCalled();
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent.mock.calls[0][0]).toMatchObject({ startingPoint: 'free' });
    await waitFor(() =>
      expect(reportOnboardingEvent).toHaveBeenCalledWith({
        stage: 'preset_creation',
        outcome: 'failed',
        reasonCode: 'request_failed',
      }),
    );

    createEvent.mockResolvedValueOnce({
      ok: false,
      error: { message: 'The retry also failed.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The retry also failed.');
    await waitFor(() =>
      expect(reportOnboardingEvent).toHaveBeenCalledWith({
        stage: 'recovery',
        outcome: 'failed',
        reasonCode: 'request_failed',
      }),
    );

    createEvent.mockResolvedValueOnce({ ok: true, data: { id: 'evt_recovered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(reportOnboardingEvent).toHaveBeenCalledWith({
        stage: 'recovery',
        outcome: 'completed',
      }),
    );
    expect(createEvent).toHaveBeenCalledTimes(3);
    const idempotencyKeys = createEvent.mock.calls.map(([input]) => input.idempotencyKey);
    expect(idempotencyKeys).toEqual([idempotencyKeys[0], idempotencyKeys[0], idempotencyKeys[0]]);
    expect(push).toHaveBeenCalledWith('/events/evt_recovered?created=1');
  });

  it('retries duplication with one idempotency key and opens the media follow-up', async () => {
    duplicateEvent
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Unable to duplicate the event. Retry to continue.' },
      })
      .mockResolvedValueOnce({ ok: true, data: { id: 'evt_duplicate' } });
    render(<NewEventView />);
    const duplicateStartingPoint = screen.getByRole('radio', {
      name: /Duplicate existing event/,
    });
    fireEvent.click(duplicateStartingPoint);
    expect(duplicateStartingPoint).toBeChecked();
    expect(reportOnboardingEvent).toHaveBeenCalledWith({
      stage: 'starting_point_selected',
      outcome: 'duplicate',
    });
    const sourceEvent = await screen.findByLabelText(/Source event/);
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Copied Gala' },
    });
    fireEvent.change(sourceEvent, {
      target: { value: 'evt_source' },
    });
    fireEvent.click(screen.getByLabelText('Poster, cover, and social media'));

    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to duplicate the event. Retry to continue.',
    );
    expect(push).not.toHaveBeenCalled();
    expect(duplicateEvent).toHaveBeenCalledTimes(1);
    const firstInput = duplicateEvent.mock.calls[0]![1];
    expect(duplicateEvent.mock.calls[0]).toEqual([
      'evt_source',
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        title: 'Copied Gala',
        copy: expect.objectContaining({ mediaAssets: false }),
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(duplicateEvent).toHaveBeenCalledTimes(2));
    expect(duplicateEvent.mock.calls[1]![1].idempotencyKey).toBe(firstInput.idempotencyKey);
    expect(reportOnboardingEvent).toHaveBeenCalledWith({
      stage: 'recovery',
      outcome: 'completed',
    });
    expect(push).toHaveBeenCalledWith('/events/evt_duplicate?created=1');
  });

  it('uses a new idempotency key when a failed request is edited', async () => {
    createEvent
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Unable to create the event. Retry to continue.' },
      })
      .mockResolvedValueOnce({ ok: true, data: { id: 'evt_edited' } });
    render(<NewEventView />);
    const title = screen.getByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Original title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to create the event. Retry to continue.',
    );
    const firstIdempotencyKey = createEvent.mock.calls[0]![0].idempotencyKey;

    fireEvent.change(title, { target: { value: 'Edited title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledTimes(2));

    expect(createEvent.mock.calls[1]![0]).toMatchObject({ title: 'Edited title' });
    expect(createEvent.mock.calls[1]![0].idempotencyKey).not.toBe(firstIdempotencyKey);
    expect(push).toHaveBeenCalledWith('/events/evt_edited?created=1');
  });

  it('validates title before calling the API', async () => {
    render(<NewEventView />);
    const submit = screen.getByRole('button', { name: 'Create draft' });
    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an event title');
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('selects a reusable venue and applies its timezone', async () => {
    listSavedVenues.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'ven_1',
          organizationId: 'org_1',
          name: 'Saved Hall',
          address: { city: 'Austin', country: 'US' },
          timezone: 'America/Chicago',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    render(<NewEventView />);
    const savedVenue = await screen.findByLabelText('Saved venue');
    fireEvent.change(savedVenue, { target: { value: 'ven_1' } });
    expect(screen.getByLabelText(/Venue name/)).toHaveValue('Saved Hall');
    expect(screen.getByRole('combobox', { name: /Timezone/ })).toHaveValue('America/Chicago');
  });

  it('applies the configured default venue timezone after venues load', async () => {
    bootstrapState.value = {
      organizationId: 'org_1',
      brandId: 'brd_1',
      brands: [],
      organizations: [{ id: 'org_1', eventDefaults: { defaultVenueId: 'ven_1' } }],
    };
    listSavedVenues.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'ven_1',
          organizationId: 'org_1',
          name: 'Saved Hall',
          address: { city: 'Austin', country: 'US' },
          timezone: 'America/Chicago',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    render(<NewEventView />);

    expect(await screen.findByLabelText('Saved venue')).toHaveValue('ven_1');
    expect(screen.getByLabelText(/Venue name/)).toHaveValue('Saved Hall');
    expect(screen.getByRole('combobox', { name: /Timezone/ })).toHaveValue('America/Chicago');
  });

  it('clears workspace defaults when switching to a workspace without defaults', async () => {
    bootstrapState.value = {
      organizationId: 'org_a',
      brandId: 'brd_a',
      brands: [],
      organizations: [
        {
          id: 'org_a',
          eventDefaults: {
            timezone: 'Europe/London',
            currency: 'GBP',
            country: 'GB',
            defaultVenueId: 'ven_a',
          },
        },
      ],
    };
    const { rerender } = render(<NewEventView />);
    expect(screen.getByLabelText('Currency')).toHaveValue('GBP');
    expect(screen.getByLabelText('Venue country')).toHaveValue('GB');

    bootstrapState.value = {
      organizationId: 'org_b',
      brandId: 'brd_b',
      brands: [],
      organizations: [{ id: 'org_b', eventDefaults: {} }],
    };
    rerender(<NewEventView />);
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(screen.getByLabelText('Venue country')).toHaveValue('');
  });

  it('ignores an out-of-order saved-venue response from the previous workspace', async () => {
    const workspaceA = deferred<{
      ok: true;
      data: Array<{
        id: string;
        organizationId: string;
        name: string;
        address: { country: string };
        timezone: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>();
    const workspaceB = deferred<{
      ok: true;
      data: Array<{
        id: string;
        organizationId: string;
        name: string;
        address: { country: string };
        timezone: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>();
    listSavedVenues.mockImplementation((organizationId: string) =>
      organizationId === 'org_a' ? workspaceA.promise : workspaceB.promise,
    );
    bootstrapState.value = {
      organizationId: 'org_a',
      brandId: 'brd_a',
      brands: [],
      organizations: [
        { id: 'org_a', eventDefaults: { defaultVenueId: 'ven_a' } },
        { id: 'org_b', eventDefaults: { defaultVenueId: 'ven_b' } },
      ],
    };
    const view = render(<NewEventView />);
    await waitFor(() => expect(listSavedVenues).toHaveBeenCalledWith('org_a'));

    bootstrapState.value = {
      ...bootstrapState.value,
      organizationId: 'org_b',
      brandId: 'brd_b',
    };
    view.rerender(<NewEventView />);
    await waitFor(() => expect(listSavedVenues).toHaveBeenCalledWith('org_b'));

    workspaceB.resolve({
      ok: true,
      data: [
        {
          id: 'ven_b',
          organizationId: 'org_b',
          name: 'Workspace B Hall',
          address: { country: 'US' },
          timezone: 'America/Chicago',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(await screen.findByRole('option', { name: 'Workspace B Hall' })).toBeInTheDocument();
    workspaceA.resolve({
      ok: true,
      data: [
        {
          id: 'ven_a',
          organizationId: 'org_a',
          name: 'Workspace A Hall',
          address: { country: 'US' },
          timezone: 'America/New_York',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Workspace A Hall' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('option', { name: 'Workspace B Hall' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Venue name/)).toHaveValue('Workspace B Hall');

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Workspace B Event' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalled());
    expect(createEvent.mock.calls[0]![0]).toMatchObject({
      organizationId: 'org_b',
      brandId: 'brd_b',
      venueId: 'ven_b',
    });
  });

  it('preserves and quarantines the current workspace default until venue loading recovers', async () => {
    listSavedVenues
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            id: 'ven_a',
            organizationId: 'org_a',
            name: 'Workspace A Hall',
            address: { country: 'US' },
            timezone: 'America/New_York',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'network_error', message: 'Unable to load venues' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            id: 'ven_b',
            organizationId: 'org_b',
            name: 'Workspace B Hall',
            address: { country: 'US' },
            timezone: 'America/Chicago',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    bootstrapState.value = {
      organizationId: 'org_a',
      brandId: 'brd_a',
      brands: [],
      organizations: [
        { id: 'org_a', eventDefaults: { defaultVenueId: 'ven_a' } },
        { id: 'org_b', eventDefaults: { defaultVenueId: 'ven_b' } },
      ],
    };
    const view = render(<NewEventView />);
    expect(await screen.findByRole('option', { name: 'Workspace A Hall' })).toBeInTheDocument();

    bootstrapState.value = {
      ...bootstrapState.value,
      organizationId: 'org_b',
      brandId: 'brd_b',
    };
    view.rerender(<NewEventView />);

    await waitFor(() => expect(listSavedVenues).toHaveBeenCalledWith('org_b'));
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: 'Workspace A Hall' })).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Saved venue')).toHaveValue('ven_b');
    expect(
      screen.getByRole('option', { name: 'Configured default venue (unavailable)' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Saved venues could not be loaded. The configured default was preserved.',
    );

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Workspace B Event' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText(/Retry saved venues or choose a one-time venue/)).toBeVisible();
    expect(createEvent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry saved venues' }));
    expect(await screen.findByRole('option', { name: 'Workspace B Hall' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledOnce());
    expect(createEvent.mock.calls[0]![0]).toMatchObject({
      organizationId: 'org_b',
      brandId: 'brd_b',
      venueId: 'ven_b',
    });
  });

  it('allows an explicit one-time venue after a rejected saved-venue request', async () => {
    listSavedVenues.mockRejectedValueOnce(new Error('network unavailable'));
    bootstrapState.value = {
      organizationId: 'org_1',
      brandId: 'brd_1',
      brands: [],
      organizations: [{ id: 'org_1', eventDefaults: { defaultVenueId: 'ven_default' } }],
    };
    render(<NewEventView />);

    expect(
      await screen.findByText(
        'Saved venues could not be loaded. The configured default was preserved.',
      ),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText('Saved venue'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'One-time Venue Event' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(createEvent).toHaveBeenCalledOnce());
    expect(createEvent.mock.calls[0]![0]).toMatchObject({ venueId: null });
  });

  it('blocks a configured default omitted by a successful venue response until an explicit choice', async () => {
    bootstrapState.value = {
      organizationId: 'org_1',
      brandId: 'brd_1',
      brands: [],
      organizations: [{ id: 'org_1', eventDefaults: { defaultVenueId: 'ven_removed' } }],
    };
    render(<NewEventView />);

    expect(await screen.findByText(/The configured default venue is unavailable/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Missing Venue Event' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText(/Retry saved venues or choose a one-time venue/)).toBeVisible();
    expect(createEvent).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Saved venue'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(createEvent).toHaveBeenCalledOnce());
    expect(createEvent.mock.calls[0]![0]).toMatchObject({ venueId: null });
  });

  it.each([
    ['loading', { events: [], loading: true, error: undefined }],
    [
      'failed',
      {
        events: [],
        loading: false,
        error: { code: 'network_error', message: 'Unable to load events' },
      },
    ],
    ['empty', { events: [], loading: false, error: undefined }],
    [
      'unselected',
      {
        events: [{ id: 'evt_source', title: 'Source Gala' }],
        loading: false,
        error: undefined,
      },
    ],
  ] as const)(
    'validates a %s duplicate source before creation or recovery telemetry',
    async (_state, sourceState) => {
      allEventsState.value = {
        events: [...sourceState.events],
        loading: sourceState.loading,
        error: sourceState.error,
      };
      render(<NewEventView />);
      fireEvent.click(screen.getByRole('radio', { name: /Duplicate existing event/ }));
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Duplicate Draft' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

      await waitFor(() =>
        expect(document.getElementById('new-event-error')).toHaveTextContent(
          /source events|current workspace/i,
        ),
      );
      expect(duplicateEvent).not.toHaveBeenCalled();
      expect(reportOnboardingEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'preset_creation' }),
      );
      expect(reportOnboardingEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'recovery' }),
      );
    },
  );

  it('shows duplicate-source loading, failure, empty, and recovered states', async () => {
    allEventsState.value = { events: [], loading: true, error: undefined };
    const view = render(<NewEventView />);
    await waitFor(() => expect(listSavedVenues).toHaveBeenCalledWith('org_1'));
    fireEvent.click(screen.getByRole('radio', { name: /Duplicate existing event/ }));

    expect(screen.getByText('Loading events available to duplicate…')).toBeInTheDocument();
    expect(view.container.querySelector('#new-event-source')).toBeDisabled();

    allEventsState.value = {
      events: [],
      loading: false,
      error: { code: 'network_error', message: 'Unable to load events' },
    };
    view.rerender(<NewEventView />);
    expect(screen.getByRole('alert')).toHaveTextContent('Source events could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry source events' }));
    expect(refetchSourceEvents).toHaveBeenCalledOnce();

    allEventsState.value = { events: [], loading: false, error: undefined };
    view.rerender(<NewEventView />);
    expect(
      screen.getByText('No events are available to duplicate in this workspace.'),
    ).toBeInTheDocument();

    allEventsState.value = {
      events: [{ id: 'evt_recovered', title: 'Recovered Gala' }],
      loading: false,
      error: undefined,
    };
    view.rerender(<NewEventView />);
    expect(screen.getByRole('option', { name: 'Recovered Gala' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Source event/)).toBeEnabled();

    fireEvent.change(screen.getByLabelText(/Source event/), {
      target: { value: 'evt_recovered' },
    });
    bootstrapState.value = {
      organizationId: 'org_2',
      brandId: 'brd_2',
      brands: [],
      organizations: [],
    };
    view.rerender(<NewEventView />);
    await waitFor(() => expect(screen.getByLabelText(/Source event/)).toHaveValue(''));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Wrong Workspace Copy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText(/Choose an event from the current workspace/)).toBeVisible();
    expect(duplicateEvent).not.toHaveBeenCalled();
  });
});
