import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewEventView } from './new-event-view';

const push = vi.hoisted(() => vi.fn());
const createEvent = vi.hoisted(() => vi.fn());
const duplicateEvent = vi.hoisted(() => vi.fn());
const reportOnboardingEvent = vi.hoisted(() => vi.fn());
const listSavedVenues = vi.hoisted(() => vi.fn());
const bootstrapState = vi.hoisted(() => ({
  value: {
    organizationId: 'org_1',
    brandId: 'brd_1',
    brands: [],
    organizations: [],
  } as Record<string, unknown>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => bootstrapState.value,
}));
vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({ can: () => true, loading: false }),
}));
vi.mock('@/hooks/use-all-events', () => ({
  useAllEvents: () => ({
    events: [{ id: 'evt_source', title: 'Source Gala' }],
    loading: false,
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

    createEvent.mockResolvedValue({ ok: true, data: { id: 'evt_recovered' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(reportOnboardingEvent).toHaveBeenCalledWith({
        stage: 'recovery',
        outcome: 'completed',
      }),
    );
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
});
