import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewEventView } from './new-event-view';

const push = vi.hoisted(() => vi.fn());
const createEvent = vi.hoisted(() => vi.fn());
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
  useAllEvents: () => ({ events: [], loading: false }),
}));
vi.mock('@/lib/api', () => ({
  adminApi: {
    createEvent,
    duplicateEvent: vi.fn(),
    listPaymentAccounts: vi.fn(),
    listSavedVenues,
    reportOnboardingEvent,
  },
}));

describe('NewEventView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createEvent.mockResolvedValue({ ok: true, data: { id: 'evt_new' } });
    reportOnboardingEvent.mockResolvedValue({ ok: true, data: undefined });
    listSavedVenues.mockResolvedValue({ ok: true, data: [] });
    bootstrapState.value = {
      organizationId: 'org_1',
      brandId: 'brd_1',
      brands: [],
      organizations: [],
    };
  });

  it('creates a durable blank draft and redirects to its launch center', async () => {
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
    expect(push).toHaveBeenCalledWith('/events/evt_new');
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
