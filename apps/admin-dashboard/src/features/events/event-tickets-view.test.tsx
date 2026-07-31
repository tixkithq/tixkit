import { fireEvent, render, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventTicketsView } from './event-tickets-view';

type EventTicketsAdminApiMock = {
  getEvent: ReturnType<typeof vi.fn>;
  listTicketTypes: ReturnType<typeof vi.fn>;
  listWaitlist: ReturnType<typeof vi.fn>;
  listEventOccurrences: ReturnType<typeof vi.fn>;
  getResalePolicy: ReturnType<typeof vi.fn>;
  updateResalePolicy: ReturnType<typeof vi.fn>;
  getEventFeePolicy: ReturnType<typeof vi.fn>;
  updateEventFeePolicy: ReturnType<typeof vi.fn>;
  listResaleListings: ReturnType<typeof vi.fn>;
  delistResaleListing: ReturnType<typeof vi.fn>;
  createEventOccurrence: ReturnType<typeof vi.fn>;
  offerWaitlistEntry: ReturnType<typeof vi.fn>;
  updateWaitlistSettings: ReturnType<typeof vi.fn>;
};

const adminApiMock = vi.hoisted(
  (): EventTicketsAdminApiMock => ({
    getEvent: vi.fn(),
    listTicketTypes: vi.fn(),
    listWaitlist: vi.fn(),
    listEventOccurrences: vi.fn(),
    getResalePolicy: vi.fn(),
    updateResalePolicy: vi.fn(),
    getEventFeePolicy: vi.fn(),
    updateEventFeePolicy: vi.fn(),
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

const waitlistEntry = {
  id: 'wle_1',
  eventId: 'evt_1',
  ticketTypeId: 'tt_friday',
  email: 'waitlist-buyer@example.com',
  firstName: 'Waitlist',
  lastName: 'Buyer',
  quantity: 2,
  status: 'joined' as const,
  createdAt: '2026-08-15T12:00:00.000Z',
  updatedAt: '2026-08-15T12:00:00.000Z',
};

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function mockEventTicketsData() {
  adminApiMock.getEvent.mockResolvedValue({
    ok: true,
    data: {
      id: 'evt_1',
      title: 'All Access',
      startsAt: fridayOccurrence.startsAt,
      timezone: fridayOccurrence.timezone,
      minimumAge: null,
    },
  });
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
  adminApiMock.getEventFeePolicy.mockResolvedValue({
    ok: true,
    data: {
      eventId: 'evt_1',
      passFeesToBuyer: true,
      rules: [
        {
          id: 'fee_1',
          eventId: 'evt_1',
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          appliedTo: 'per_ticket',
          absorbIntoPrice: false,
        },
      ],
    },
  });
  adminApiMock.updateEventFeePolicy.mockResolvedValue({
    ok: true,
    data: {
      eventId: 'evt_1',
      passFeesToBuyer: false,
      rules: [
        {
          id: 'fee_1',
          eventId: 'evt_1',
          name: 'Service fee',
          type: 'percentage',
          value: 500,
          appliedTo: 'per_ticket',
          absorbIntoPrice: true,
        },
      ],
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

function mockWaitlistData() {
  adminApiMock.listWaitlist.mockResolvedValue({
    ok: true,
    data: {
      items: [waitlistEntry],
      settings: {
        autoOfferEnabled: true,
        offerTtlMinutes: 1440,
      },
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  vi.clearAllMocks();
});

describe('EventTicketsView occurrences', () => {
  it('renders event occurrences and resolves occurrence-scoped ticket labels', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    const tablist = await view.findByRole('tablist');
    for (const tab of within(tablist).getAllByRole('tab')) {
      expect(tab.parentElement).toHaveAttribute('role', 'presentation');
    }

    // Ticket table is on the default "Tickets" tab; occurrence labels resolve there.
    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });

    const fridayTicketRow = view
      .getAllByText('Friday GA')
      .map((node) => node.closest('tr'))
      .find((row): row is HTMLTableRowElement =>
        Boolean(row && within(row).queryByText('Friday evening')),
      );
    if (!fridayTicketRow) throw new Error('Friday ticket row not found');
    expect(within(fridayTicketRow).getByText('Friday evening')).toBeInTheDocument();
    const weekendTicketRow = view
      .getAllByText('Weekend pass')
      .map((node) => node.closest('tr'))
      .find((row): row is HTMLTableRowElement =>
        Boolean(row && within(row).queryByText('All occurrences')),
      );
    if (!weekendTicketRow) throw new Error('Weekend ticket row not found');
    expect(within(weekendTicketRow).getByText('All occurrences')).toBeInTheDocument();
  });
});

describe('EventTicketsView waitlist claim links', () => {
  it('reports claim-link copy only after the clipboard write succeeds', async () => {
    const claimUrl = 'https://checkout.tixkit.test/claim/wle_1';
    const deferredWrite = createDeferred<void>();
    const writeText = vi.fn(() => deferredWrite.promise);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockEventTicketsData();
    mockWaitlistData();
    adminApiMock.offerWaitlistEntry.mockResolvedValue({
      ok: true,
      data: {
        entry: {
          ...waitlistEntry,
          status: 'offered',
          offeredAt: '2026-08-15T12:05:00.000Z',
          offerExpiresAt: '2026-08-16T12:05:00.000Z',
        },
        claimToken: 'claim_token_wle_1',
        claimUrl,
      },
    });

    const view = render(<EventTicketsView eventId="evt_1" />);

    // Wait for ticket data, then switch to Waitlist tab.
    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Waitlist/i }));

    const row = (await view.findByText(waitlistEntry.email)).closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLTableRowElement).getByRole('button', { name: 'Offer' }));

    await waitFor(() => {
      expect(adminApiMock.offerWaitlistEntry).toHaveBeenCalledWith('evt_1', waitlistEntry.id);
    });
    await waitFor(() => {
      expect(view.getByLabelText(`Claim link for ${waitlistEntry.email}`)).toHaveValue(claimUrl);
    });

    expect(writeText).toHaveBeenCalledWith(claimUrl);
    expect(toast.success).toHaveBeenCalledWith('Waitlist offer created');
    expect(toast.success).not.toHaveBeenCalledWith('Claim link copied');

    deferredWrite.resolve();

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Claim link copied');
    });
  });

  it('keeps the claim link available when offer-time clipboard access is unavailable', async () => {
    const claimUrl = 'https://checkout.tixkit.test/claim/manual-copy';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    mockEventTicketsData();
    mockWaitlistData();
    adminApiMock.offerWaitlistEntry.mockResolvedValue({
      ok: true,
      data: {
        entry: {
          ...waitlistEntry,
          status: 'offered',
          offeredAt: '2026-08-15T12:05:00.000Z',
          offerExpiresAt: '2026-08-16T12:05:00.000Z',
        },
        claimToken: 'claim_token_manual_copy',
        claimUrl,
      },
    });

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Waitlist/i }));

    const row = (await view.findByText(waitlistEntry.email)).closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLTableRowElement).getByRole('button', { name: 'Offer' }));

    await waitFor(() => {
      expect(view.getByLabelText(`Claim link for ${waitlistEntry.email}`)).toHaveValue(claimUrl);
    });
    expect(toast.success).toHaveBeenCalledWith('Waitlist offer created');
    expect(toast.success).not.toHaveBeenCalledWith('Claim link copied');
    expect(toast.error).toHaveBeenCalledWith('Claim link ready. Copy it manually from the row.');
  });

  it('does not show copy success when the row Copy button clipboard write is rejected', async () => {
    const claimUrl = 'https://checkout.tixkit.test/claim/rejected-copy';
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockEventTicketsData();
    mockWaitlistData();
    adminApiMock.offerWaitlistEntry.mockResolvedValue({
      ok: true,
      data: {
        entry: {
          ...waitlistEntry,
          status: 'offered',
          offeredAt: '2026-08-15T12:05:00.000Z',
          offerExpiresAt: '2026-08-16T12:05:00.000Z',
        },
        claimToken: 'claim_token_rejected_copy',
        claimUrl,
      },
    });

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Waitlist/i }));

    const row = (await view.findByText(waitlistEntry.email)).closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLTableRowElement).getByRole('button', { name: 'Offer' }));

    const claimInput = await view.findByLabelText(`Claim link for ${waitlistEntry.email}`);
    expect(claimInput).toHaveValue(claimUrl);
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Claim link copied');
    });

    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2);
    });
    expect(toast.success).not.toHaveBeenCalledWith('Claim link copied');
    expect(toast.error).toHaveBeenCalledWith('Claim link ready. Copy it manually from the row.');
  });
});

describe('EventTicketsView resale', () => {
  it('renders resale policy controls and active listings', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Fees & Resale/i }));

    const panel = await view.findByTestId('resale-policy-panel');

    expect(within(panel).getByText('Resale')).toBeInTheDocument();
    expect(within(panel).getByText('Enabled')).toBeInTheDocument();
    expect(within(panel).getByRole('switch', { name: /Resale policy/i })).toHaveAttribute(
      'data-state',
      'checked',
    );
    expect(within(panel).getByLabelText('Max markup')).toHaveValue(1.2);
    expect(within(panel).getByLabelText('Absolute cap ($)')).toHaveValue(60);
    expect(within(panel).getByText('tkt_1')).toBeInTheDocument();
    expect(within(panel).getByText('$55.00')).toBeInTheDocument();
    expect(within(panel).getByText('$35.00')).toBeInTheDocument();
  });

  it('saves resale policy edits and refreshes policy data', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Fees & Resale/i }));

    const panel = await view.findByTestId('resale-policy-panel');
    fireEvent.click(within(panel).getByRole('switch', { name: /Resale policy/i }));
    fireEvent.change(within(panel).getByLabelText('Max markup'), {
      target: { value: '1.1' },
    });
    fireEvent.change(within(panel).getByLabelText('Absolute cap ($)'), {
      target: { value: '55' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: /Save resale policy/i }));

    await waitFor(() => {
      expect(adminApiMock.updateResalePolicy).toHaveBeenCalledWith('evt_1', {
        enabled: false,
        maxMultiplier: 1.1,
        maxAbsoluteCents: 5500,
      });
    });
    await waitFor(() => expect(adminApiMock.getResalePolicy).toHaveBeenCalledTimes(2));
  });

  it('delists resale listings with a scoped idempotency key and refreshes listings', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Fees & Resale/i }));

    const panel = await view.findByTestId('resale-policy-panel');
    fireEvent.click(within(panel).getByRole('button', { name: /Delist/i }));

    await waitFor(() => {
      expect(adminApiMock.delistResaleListing).toHaveBeenCalledWith('lst_1', {
        idempotencyKey: expect.stringMatching(/^resale_evt_1_[a-zA-Z0-9-]+$/),
      });
    });
    await waitFor(() => expect(adminApiMock.listResaleListings).toHaveBeenCalledTimes(2));
  });
});

describe('EventTicketsView fee policy', () => {
  it('renders fee impact by ticket type using current ticket prices', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Fees & Resale/i }));

    const panel = await view.findByTestId('fee-policy-card');
    expect(panel).toHaveTextContent('Ticket Fees');
    expect(within(panel).getByText('Buyer pays')).toBeInTheDocument();

    const fridayRow = within(panel).getByText('Friday GA').closest('tr');
    expect(fridayRow).not.toBeNull();
    expect(within(fridayRow as HTMLTableRowElement).getAllByText('$35.00')).toHaveLength(2);
    expect(within(fridayRow as HTMLTableRowElement).getByText('$1.32')).toBeInTheDocument();
    expect(within(fridayRow as HTMLTableRowElement).getByText('$1.75')).toBeInTheDocument();
    expect(within(fridayRow as HTMLTableRowElement).getByText('$38.07')).toBeInTheDocument();

    const weekendRow = within(panel).getByText('Weekend pass').closest('tr');
    expect(weekendRow).not.toBeNull();
    expect(within(weekendRow as HTMLTableRowElement).getAllByText('$80.00')).toHaveLength(2);
    expect(within(weekendRow as HTMLTableRowElement).getByText('$2.62')).toBeInTheDocument();
    expect(within(weekendRow as HTMLTableRowElement).getByText('$4.00')).toBeInTheDocument();
    expect(within(weekendRow as HTMLTableRowElement).getByText('$86.62')).toBeInTheDocument();
  });

  it('autosaves pass-through changes without a fee save button', async () => {
    mockEventTicketsData();

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Fees & Resale/i }));

    const panel = await view.findByTestId('fee-policy-card');
    expect(within(panel).queryByRole('button', { name: /Save Fees/i })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('switch', { name: /Pass fees to buyers/i }));

    await waitFor(() => {
      expect(within(panel).getByText('Organizer absorbs')).toBeInTheDocument();
    });
    const fridayRow = within(panel).getByText('Friday GA').closest('tr');
    expect(fridayRow).not.toBeNull();
    expect(within(fridayRow as HTMLTableRowElement).getAllByText('$35.00')).toHaveLength(2);
    expect(within(fridayRow as HTMLTableRowElement).getByText('$1.75')).toBeInTheDocument();
    expect(within(fridayRow as HTMLTableRowElement).getByText('$31.93')).toBeInTheDocument();

    await waitFor(() => {
      expect(adminApiMock.updateEventFeePolicy).toHaveBeenCalledWith('evt_1', {
        expectedVersion: 1,
        passFeesToBuyer: false,
        rules: [
          {
            id: 'fee_1',
            name: 'Service fee',
            type: 'percentage',
            value: 500,
            appliedTo: 'per_ticket',
          },
        ],
      });
    });
    await waitFor(() => {
      expect(adminApiMock.getEventFeePolicy).toHaveBeenCalledTimes(2);
    });
  });

  it('does not repeat failed fee autosave toasts for the same form state', async () => {
    mockEventTicketsData();
    adminApiMock.updateEventFeePolicy.mockResolvedValue({
      ok: false,
      error: {
        message: 'Internal error occurred',
      },
    });

    const view = render(<EventTicketsView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('Friday GA')).toBeInTheDocument();
    });
    fireEvent.click(view.getByRole('tab', { name: /Fees & Resale/i }));

    const panel = await view.findByTestId('fee-policy-card');
    fireEvent.click(within(panel).getByRole('button', { name: /Add Fee/i }));

    await waitFor(() => {
      expect(adminApiMock.updateEventFeePolicy).toHaveBeenCalledTimes(1);
    });
    expect(toast.error).toHaveBeenCalledWith('Internal error occurred');
    expect(toast.error).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => window.setTimeout(resolve, 700));

    expect(adminApiMock.updateEventFeePolicy).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
