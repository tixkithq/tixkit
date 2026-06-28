import { fireEvent, render, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventTicketsView } from './event-tickets-view';

type EventTicketsAdminApiMock = {
  listTicketTypes: ReturnType<typeof vi.fn>;
  listWaitlist: ReturnType<typeof vi.fn>;
  listEventOccurrences: ReturnType<typeof vi.fn>;
  createEventOccurrence: ReturnType<typeof vi.fn>;
  offerWaitlistEntry: ReturnType<typeof vi.fn>;
  updateWaitlistSettings: ReturnType<typeof vi.fn>;
};

const adminApiMock = vi.hoisted(
  (): EventTicketsAdminApiMock => ({
    listTicketTypes: vi.fn(),
    listWaitlist: vi.fn(),
    listEventOccurrences: vi.fn(),
    createEventOccurrence: vi.fn(),
    offerWaitlistEntry: vi.fn(),
    updateWaitlistSettings: vi.fn(),
  }),
);

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    adminApi: adminApiMock,
  };
});

vi.mock('./ticket-type-form', () => ({
  TicketTypeFormDrawer: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="ticket-type-drawer" /> : null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const fridayOccurrence = {
  id: 'occ_friday',
  eventId: 'evt_1',
  title: 'Friday evening',
  startsAt: '2026-08-15T23:00:00.000Z',
  endsAt: '2026-08-16T03:00:00.000Z',
  timezone: 'America/New_York',
  venue: null,
  capacity: 500,
  sortOrder: 0,
  status: 'scheduled' as const,
};

const saturdayOccurrence = {
  ...fridayOccurrence,
  id: 'occ_saturday',
  title: 'Saturday matinee',
  startsAt: '2026-08-16T17:00:00.000Z',
  endsAt: '2026-08-16T20:00:00.000Z',
  sortOrder: 1,
};

const ticketTypes = [
  {
    id: 'tt_friday',
    eventId: 'evt_1',
    eventOccurrenceId: 'occ_friday',
    name: 'Friday GA',
    description: null,
    kind: 'paid' as const,
    status: 'active' as const,
    visibility: 'public' as const,
    currency: 'USD',
    priceCents: 3500,
    quantityTotal: 100,
    quantitySold: 12,
    minimumPriceCents: null,
    salesStartAt: null,
    salesEndAt: null,
    minPerOrder: 1,
    maxPerOrder: 8,
    inventoryPoolId: 'pool_1',
    requiresAccessCode: false,
    accessCodeHint: null,
    sortOrder: 0,
  },
  {
    id: 'tt_weekend',
    eventId: 'evt_1',
    eventOccurrenceId: undefined,
    name: 'Weekend pass',
    description: null,
    kind: 'paid' as const,
    status: 'active' as const,
    visibility: 'public' as const,
    currency: 'USD',
    priceCents: 8000,
    quantityTotal: 200,
    quantitySold: 45,
    minimumPriceCents: null,
    salesStartAt: null,
    salesEndAt: null,
    minPerOrder: 1,
    maxPerOrder: 8,
    inventoryPoolId: 'pool_2',
    requiresAccessCode: false,
    accessCodeHint: null,
    sortOrder: 1,
  },
];

function mockEventTicketsData() {
  adminApiMock.listTicketTypes.mockResolvedValue({
    ok: true,
    data: ticketTypes,
  });
  adminApiMock.listWaitlist.mockResolvedValue({
    ok: true,
    data: {
      items: [],
      settings: {
        autoOfferEnabled: true,
        offerTtlMinutes: 1440,
      },
    },
  });
  adminApiMock.listEventOccurrences.mockResolvedValue({
    ok: true,
    data: [fridayOccurrence, saturdayOccurrence],
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('EventTicketsView occurrences', () => {
  it('renders event occurrences and resolves occurrence-scoped ticket labels', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getAllByText('Friday evening').length).toBeGreaterThanOrEqual(2);
    });

    expect(view.getByText('Saturday matinee')).toBeInTheDocument();
    const fridayTicketRow = view.getByText('Friday GA').closest('tr');
    expect(fridayTicketRow).not.toBeNull();
    expect(within(fridayTicketRow as HTMLTableRowElement).getByText('Friday evening')).toBeInTheDocument();
    const weekendTicketRow = view.getByText('Weekend pass').closest('tr');
    expect(weekendTicketRow).not.toBeNull();
    expect(within(weekendTicketRow as HTMLTableRowElement).getByText('All occurrences')).toBeInTheDocument();
  });

  it('creates an occurrence through the admin API and refetches occurrences', async () => {
    mockEventTicketsData();
    adminApiMock.createEventOccurrence.mockResolvedValue({
      ok: true,
      data: {
        ...fridayOccurrence,
        id: 'occ_sunday',
        title: 'Sunday closing',
      },
    });

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getAllByText('Friday evening').length).toBeGreaterThanOrEqual(2);
    });
    fireEvent.change(view.getByLabelText('Title'), {
      target: { value: 'Sunday closing' },
    });
    fireEvent.change(view.getByLabelText('Starts'), {
      target: { value: '2026-08-17T18:00' },
    });
    fireEvent.change(view.getByLabelText('Ends'), {
      target: { value: '2026-08-17T21:00' },
    });
    fireEvent.change(view.getByLabelText('Timezone'), {
      target: { value: 'America/Chicago' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Add' }));

    await waitFor(() => {
      expect(adminApiMock.createEventOccurrence).toHaveBeenCalledWith('evt_1', {
        title: 'Sunday closing',
        startsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/),
        endsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/),
        timezone: 'America/Chicago',
      });
    });
    const [, input] = adminApiMock.createEventOccurrence.mock.calls[0];
    expect(new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime()).toBe(
      3 * 60 * 60 * 1000,
    );
    expect(adminApiMock.listEventOccurrences).toHaveBeenCalledTimes(2);
  });
});
