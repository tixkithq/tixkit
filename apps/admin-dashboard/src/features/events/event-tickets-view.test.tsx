import { fireEvent, render, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventTicketsView } from './event-tickets-view';

type EventTicketsAdminApiMock = {
  listTicketTypes: ReturnType<typeof vi.fn>;
  listWaitlist: ReturnType<typeof vi.fn>;
  listEventOccurrences: ReturnType<typeof vi.fn>;
  getResalePolicy: ReturnType<typeof vi.fn>;
  updateResalePolicy: ReturnType<typeof vi.fn>;
  listResaleListings: ReturnType<typeof vi.fn>;
  delistResaleListing: ReturnType<typeof vi.fn>;
  createEventOccurrence: ReturnType<typeof vi.fn>;
  offerWaitlistEntry: ReturnType<typeof vi.fn>;
  updateWaitlistSettings: ReturnType<typeof vi.fn>;
};

const adminApiMock = vi.hoisted(
  (): EventTicketsAdminApiMock => ({
    listTicketTypes: vi.fn(),
    listWaitlist: vi.fn(),
    listEventOccurrences: vi.fn(),
    getResalePolicy: vi.fn(),
    updateResalePolicy: vi.fn(),
    listResaleListings: vi.fn(),
    delistResaleListing: vi.fn(),
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

const resaleListing = {
  id: 'lst_1',
  tenantId: 'tnt_1',
  eventId: 'evt_1',
  ticketId: 'tkt_1',
  sellerId: 'usr_seller',
  status: 'listed' as const,
  priceCents: 5500,
  currency: 'USD',
  faceValueCents: 3500,
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
};

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
  adminApiMock.getResalePolicy.mockResolvedValue({
    ok: true,
    data: {
      enabled: true,
      maxMultiplier: 1.2,
      maxAbsoluteCents: 6000,
    },
  });
  adminApiMock.updateResalePolicy.mockResolvedValue({
    ok: true,
    data: {
      enabled: false,
      maxMultiplier: 1.1,
      maxAbsoluteCents: 5500,
    },
  });
  adminApiMock.listResaleListings.mockResolvedValue({
    ok: true,
    data: {
      items: [resaleListing],
      nextCursor: undefined,
      hasMore: false,
    },
  });
  adminApiMock.delistResaleListing.mockResolvedValue({
    ok: true,
    data: {
      ...resaleListing,
      status: 'delisted',
    },
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
    expect(
      within(fridayTicketRow as HTMLTableRowElement).getByText('Friday evening'),
    ).toBeInTheDocument();
    const weekendTicketRow = view.getByText('Weekend pass').closest('tr');
    expect(weekendTicketRow).not.toBeNull();
    expect(
      within(weekendTicketRow as HTMLTableRowElement).getByText('All occurrences'),
    ).toBeInTheDocument();
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

describe('EventTicketsView resale', () => {
  it('renders resale policy controls and active listings', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    const panel = await view.findByTestId('resale-policy-panel');

    expect(within(panel).getByText('Resale')).toBeInTheDocument();
    expect(within(panel).getByText('Enabled')).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /Resale policy/i })).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(within(panel).getByLabelText('Max markup')).toHaveValue(1.2);
    expect(within(panel).getByLabelText('Absolute cap')).toHaveValue(6000);
    expect(within(panel).getByText('tkt_1')).toBeInTheDocument();
    expect(within(panel).getByText('$55.00')).toBeInTheDocument();
    expect(within(panel).getByText('$35.00')).toBeInTheDocument();
  });

  it('saves resale policy edits and refreshes policy data', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    const panel = await view.findByTestId('resale-policy-panel');
    fireEvent.click(within(panel).getByRole('switch', { name: /Resale policy/i }));
    fireEvent.change(within(panel).getByLabelText('Max markup'), {
      target: { value: '1.1' },
    });
    fireEvent.change(within(panel).getByLabelText('Absolute cap'), {
      target: { value: '5500' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: /Save resale policy/i }));

    await waitFor(() => {
      expect(adminApiMock.updateResalePolicy).toHaveBeenCalledWith('evt_1', {
        enabled: false,
        maxMultiplier: 1.1,
        maxAbsoluteCents: 5500,
      });
    });
    expect(adminApiMock.getResalePolicy).toHaveBeenCalledTimes(2);
  });

  it('delists resale listings with a scoped idempotency key and refreshes listings', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    const panel = await view.findByTestId('resale-policy-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /Delist/i }));

    await waitFor(() => {
      expect(adminApiMock.delistResaleListing).toHaveBeenCalledWith('lst_1', {
        idempotencyKey: expect.stringMatching(/^resale_evt_1_[a-zA-Z0-9-]+$/),
      });
    });
    expect(adminApiMock.listResaleListings).toHaveBeenCalledTimes(2);
  });
});
