import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CheckInConsole } from './check-in-console';

const navigationState = vi.hoisted(() => ({
  pathname: '/kiosk/evt_1',
  searchParams: new URLSearchParams('tab=scan&listId=cil_1'),
  router: { replace: vi.fn() },
}));
const permissionState = vi.hoisted(() => ({
  values: new Set<string>(['checkins.write', 'checkins.read', 'box_office.write']),
}));
const listCheckInLists = vi.fn();
const listCheckInActivity = vi.fn();
const listTicketTypes = vi.fn();
const listEventOccurrences = vi.fn();
const listAttendees = vi.fn();
const subscribeToCheckInActivity = vi.fn((..._args: unknown[]) => vi.fn());
const useTicketScanner = vi.fn((_options: unknown) => ({
  scanning: false,
  lastResult: null,
  scanError: null,
  acceptedScanCount: 0,
  scan: vi.fn(),
  retryLastScan: vi.fn(),
  reset: vi.fn(),
}));

function setNavigatorOnline(isOnline: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: isOnline,
  });
}

vi.mock('next/navigation', () => ({
  useRouter: () => navigationState.router,
  usePathname: () => navigationState.pathname,
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({
    can: (permission?: string) => Boolean(permission && permissionState.values.has(permission)),
  }),
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizationId: 'org_1',
    brandId: 'brd_1',
  }),
}));

vi.mock('@/hooks/use-all-events', () => ({
  useAllEvents: () => ({
    events: [
      {
        id: 'evt_1',
        title: 'Launch Night',
        currency: 'USD',
        capacity: 100,
        ticketsSold: 25,
        checkIns: 10,
      },
    ],
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api', () => ({
  adminApi: {
    listCheckInLists: (...args: unknown[]) => listCheckInLists(...args),
    listCheckInActivity: (...args: unknown[]) => listCheckInActivity(...args),
    listTicketTypes: (...args: unknown[]) => listTicketTypes(...args),
    listEventOccurrences: (...args: unknown[]) => listEventOccurrences(...args),
    listAttendees: (...args: unknown[]) => listAttendees(...args),
  },
}));

vi.mock('@/lib/scan-activity', () => ({
  subscribeToCheckInActivity: (...args: unknown[]) => subscribeToCheckInActivity(...args),
}));

vi.mock('@/features/check-in/scanner-panel', () => ({
  ScannerPanel: () => <div>Scanner panel</div>,
}));

vi.mock('@/features/events/box-office-order-panel', () => ({
  BoxOfficeOrderPanel: () => <div>Box office panel</div>,
}));

vi.mock('@/features/check-in/use-ticket-scanner', () => ({
  useTicketScanner: (options: unknown) => useTicketScanner(options),
}));

describe('CheckInConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNavigatorOnline(true);
    navigationState.pathname = '/kiosk/evt_1';
    navigationState.searchParams = new URLSearchParams('tab=scan&listId=cil_1');
    permissionState.values = new Set(['checkins.write', 'checkins.read', 'box_office.write']);
    listCheckInLists.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'cil_1',
          eventId: 'evt_1',
          name: 'Main door',
          ticketTypeIds: [],
          status: 'active',
        },
      ],
    });
    listCheckInActivity.mockResolvedValue({
      ok: true,
      data: {
        items: [],
        summary: { checkedIn: 0, remaining: 10, total: 10, acceptedScans: 0 },
      },
    });
    listTicketTypes.mockResolvedValue({ ok: true, data: [] });
    listEventOccurrences.mockResolvedValue({ ok: true, data: [] });
    listAttendees.mockResolvedValue({
      ok: true,
      data: { items: [], total: 0, nextCursor: undefined, filterTotal: 0 },
    });
    useTicketScanner.mockImplementation((_options: unknown) => ({
      scanning: false,
      lastResult: null,
      scanError: null,
      acceptedScanCount: 0,
      scan: vi.fn(),
      retryLastScan: vi.fn(),
      reset: vi.fn(),
    }));
  });

  afterAll(() => {
    delete (window.navigator as { onLine?: boolean }).onLine;
  });

  it('shows an accessible offline network status on initial render', async () => {
    setNavigatorOnline(false);

    render(<CheckInConsole mode="kiosk" initialEventId="evt_1" initialListId="cil_1" />);

    expect(await screen.findByTestId('scan-network-status')).toHaveTextContent('Network offline');
    expect(screen.getByTestId('scan-connectivity-status')).toHaveTextContent(
      'Online check-in only',
    );
  });

  it('updates the network status for offline and online browser events and removes listeners', async () => {
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <CheckInConsole mode="kiosk" initialEventId="evt_1" initialListId="cil_1" />,
    );

    expect(await screen.findByTestId('scan-network-status')).toHaveTextContent('Network online');

    setNavigatorOnline(false);
    act(() => window.dispatchEvent(new Event('offline')));
    expect(screen.getByTestId('scan-network-status')).toHaveTextContent('Network offline');

    setNavigatorOnline(true);
    act(() => window.dispatchEvent(new Event('online')));
    expect(screen.getByTestId('scan-network-status')).toHaveTextContent('Network online');

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('offline', expect.any(Function));
  });

  it('renders kiosk tabs for scan, live activity, and sales', async () => {
    render(<CheckInConsole mode="kiosk" initialEventId="evt_1" initialListId="cil_1" />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /launch night/i })).toBeInTheDocument();
    });

    expect(screen.getByText(/check-in kiosk/i)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /scan/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /live/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /sales/i })).toBeInTheDocument();
    expect(screen.getByText('Scanner panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new check-in list/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open kiosk mode/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open dashboard/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Event setup'));
    expect(screen.getByRole('combobox', { name: 'Event' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Check-in list' })).toBeInTheDocument();
    await waitFor(() => expect(listCheckInLists).toHaveBeenCalledWith('evt_1'));
    expect(listTicketTypes).not.toHaveBeenCalled();
    expect(listEventOccurrences).not.toHaveBeenCalled();
    expect(listCheckInActivity).not.toHaveBeenCalled();
    expect(subscribeToCheckInActivity).not.toHaveBeenCalled();
    expect(useTicketScanner).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('embeds in the dashboard with an open-kiosk control', async () => {
    navigationState.pathname = '/check-in';
    navigationState.searchParams = new URLSearchParams('eventId=evt_1&tab=scan&listId=cil_1');
    render(
      <CheckInConsole
        mode="embedded"
        initialEventId="evt_1"
        initialListId="cil_1"
        initialTab="scan"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /launch night/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/^check-in$/i)).toBeInTheDocument();
    const kioskLink = screen.getByRole('link', { name: /open kiosk mode/i });
    expect(kioskLink).toHaveAttribute('href', '/kiosk/evt_1?tab=scan&listId=cil_1');
    expect(screen.queryByRole('link', { name: /open dashboard/i })).not.toBeInTheDocument();
  });

  it('searches attendees from the shared manual lookup panel', async () => {
    listAttendees.mockImplementation(async (input: { search?: string }) => ({
      ok: true,
      data: {
        items: input.search?.trim()
          ? [
              {
                id: 'att_1',
                eventId: 'evt_1',
                orderId: 'ord_1',
                ticketId: 'tkt_1',
                ticketTypeName: 'VIP',
                name: 'Avery Stone',
                email: 'avery@example.test',
                status: 'active',
                checkInStatus: 'checked_in',
              },
            ]
          : [],
        total: input.search?.trim() ? 1 : 0,
        nextCursor: undefined,
        filterTotal: 0,
      },
    }));

    render(
      <CheckInConsole
        mode="kiosk"
        initialEventId="evt_1"
        initialListId="cil_1"
        initialTab="scan"
      />,
    );

    const manualSearch = await screen.findByPlaceholderText('Search by name, email, or ticket ID');
    manualSearch.focus();
    fireEvent.change(manualSearch, { target: { value: 'avery' } });

    // Input stays mounted while the debounced search request is in flight.
    expect(screen.getByPlaceholderText('Search by name, email, or ticket ID')).toHaveFocus();
    expect(await screen.findByText('Avery Stone')).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getAllByText('Checked in').length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(listAttendees).toHaveBeenCalledWith({
        eventId: 'evt_1',
        checkInListId: 'cil_1',
        limit: 25,
        search: 'avery',
      });
    });
    expect(screen.getByPlaceholderText('Search by name, email, or ticket ID')).toBeInTheDocument();
  });

  it('clears an invalid listId once check-in lists load', async () => {
    listCheckInLists.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'cil_1',
          eventId: 'evt_1',
          name: 'Main door',
          ticketTypeIds: [],
          status: 'active',
        },
        {
          id: 'cil_2',
          eventId: 'evt_1',
          name: 'VIP door',
          ticketTypeIds: [],
          status: 'active',
        },
      ],
    });

    render(
      <CheckInConsole
        mode="kiosk"
        initialEventId="evt_1"
        initialListId="cil_missing"
        initialTab="scan"
      />,
    );

    await waitFor(() => {
      expect(listCheckInLists).toHaveBeenCalledWith('evt_1');
    });
    await waitFor(() => {
      expect(screen.getByText('Choose a check-in list')).toBeInTheDocument();
    });
    expect(screen.queryByText('Scanner panel')).not.toBeInTheDocument();
  });

  it('shows a choose-list empty state on Live before a list is selected', async () => {
    navigationState.searchParams = new URLSearchParams('tab=activity');
    listCheckInLists.mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'cil_1',
          eventId: 'evt_1',
          name: 'Main door',
          ticketTypeIds: [],
          status: 'active',
        },
        {
          id: 'cil_2',
          eventId: 'evt_1',
          name: 'VIP door',
          ticketTypeIds: [],
          status: 'active',
        },
      ],
    });

    render(<CheckInConsole mode="kiosk" initialEventId="evt_1" initialTab="activity" />);

    expect(await screen.findByText('Choose a check-in list')).toBeInTheDocument();
    expect(
      screen.getByText(/select the list whose live admits you want to monitor/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Connecting/)).not.toBeInTheDocument();
    expect(listCheckInActivity).not.toHaveBeenCalled();
    expect(subscribeToCheckInActivity).not.toHaveBeenCalled();
  });

  it('shows checked-in summary including accepted scans on this device', async () => {
    useTicketScanner.mockImplementation((_options: unknown) => ({
      scanning: false,
      lastResult: null,
      scanError: null,
      acceptedScanCount: 1,
      scan: vi.fn(),
      retryLastScan: vi.fn(),
      reset: vi.fn(),
    }));

    render(
      <CheckInConsole
        mode="kiosk"
        initialEventId="evt_1"
        initialListId="cil_1"
        initialTab="scan"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Capacity').previousElementSibling).toHaveTextContent('100');
    });
    expect(screen.getByText('Tickets sold').previousElementSibling).toHaveTextContent('25');
    expect(screen.getByText('Checked in').previousElementSibling).toHaveTextContent('11');
  });

  it('loads only sales data and does not replace an already canonical sales URL', async () => {
    navigationState.searchParams = new URLSearchParams('tab=sales');

    render(<CheckInConsole initialEventId="evt_1" initialTab="sales" />);

    await waitFor(() => {
      expect(listTicketTypes).toHaveBeenCalledWith('evt_1');
      expect(listEventOccurrences).toHaveBeenCalledWith('evt_1');
    });
    expect(screen.getByText('Box office panel')).toBeInTheDocument();
    expect(listCheckInLists).not.toHaveBeenCalled();
    expect(listCheckInActivity).not.toHaveBeenCalled();
    expect(subscribeToCheckInActivity).not.toHaveBeenCalled();
    expect(useTicketScanner).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(navigationState.router.replace).not.toHaveBeenCalled();
  });

  it('loads and subscribes to check-in activity only on the Live tab', async () => {
    navigationState.searchParams = new URLSearchParams('tab=activity&listId=cil_1');

    render(<CheckInConsole initialEventId="evt_1" initialListId="cil_1" initialTab="activity" />);

    await waitFor(() => {
      expect(listCheckInLists).toHaveBeenCalledWith('evt_1');
      expect(listCheckInActivity).toHaveBeenCalledWith('evt_1', 'cil_1', {
        limit: 50,
      });
      expect(subscribeToCheckInActivity).toHaveBeenCalledTimes(1);
    });
    expect(listTicketTypes).not.toHaveBeenCalled();
    expect(listEventOccurrences).not.toHaveBeenCalled();
    expect(useTicketScanner).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(navigationState.router.replace).not.toHaveBeenCalled();

    const handlers = subscribeToCheckInActivity.mock.calls[0]?.[2] as
      | {
          onReconnecting?: (details: { attempt: number; retryInMs: number; error?: Error }) => void;
        }
      | undefined;
    act(() => {
      handlers?.onReconnecting?.({
        attempt: 1,
        retryInMs: 1_000,
        error: new Error('Network unavailable'),
      });
    });
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByText(/network unavailable/i)).toBeInTheDocument();

    const unsubscribe = subscribeToCheckInActivity.mock.results[0]?.value;
    fireEvent.mouseDown(screen.getByRole('tab', { name: /sales/i }), {
      button: 0,
      ctrlKey: false,
    });

    await waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(listTicketTypes).toHaveBeenCalledWith('evt_1');
      expect(listEventOccurrences).toHaveBeenCalledWith('evt_1');
    });
  });

  it('opens Live before the initial REST history resolves so new scans cannot fall into a gap', async () => {
    navigationState.searchParams = new URLSearchParams('tab=activity&listId=cil_1');
    let resolveActivity!: (value: unknown) => void;
    listCheckInActivity.mockReturnValue(
      new Promise((resolve) => {
        resolveActivity = resolve;
      }),
    );

    render(<CheckInConsole initialEventId="evt_1" initialListId="cil_1" initialTab="activity" />);

    await waitFor(() => expect(subscribeToCheckInActivity).toHaveBeenCalledTimes(1));
    expect(listCheckInActivity).toHaveBeenCalledTimes(1);
    resolveActivity({
      ok: true,
      data: {
        items: [],
        summary: { checkedIn: 0, remaining: 10, total: 10, acceptedScans: 0 },
      },
    });
  });

  it('does not drop a live scan when an older manual refresh resolves afterward', async () => {
    navigationState.searchParams = new URLSearchParams('tab=activity&listId=cil_1');
    render(<CheckInConsole initialEventId="evt_1" initialListId="cil_1" initialTab="activity" />);
    await waitFor(() => expect(subscribeToCheckInActivity).toHaveBeenCalledTimes(1));

    let resolveRefresh!: (value: unknown) => void;
    listCheckInActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh activity' }));
    const handlers = subscribeToCheckInActivity.mock.calls[0]?.[2] as {
      onScan: (item: Record<string, unknown>) => void;
      onSummary: (summary: Record<string, number>) => void;
    };
    act(() => {
      handlers.onScan({
        id: 'scan_live',
        checkInListId: 'cil_1',
        ticketId: 'tkt_1',
        deviceId: 'door_phone',
        outcome: 'accepted',
        scannedAt: new Date().toISOString(),
        offline: false,
        attendeeName: 'Just Scanned',
        attendeeEmail: 'scan@example.com',
        ticketTypeId: 'tt_1',
      });
      handlers.onSummary({ checkedIn: 1, remaining: 9, total: 10, acceptedScans: 1 });
    });
    resolveRefresh({
      ok: true,
      data: {
        items: [],
        summary: { checkedIn: 0, remaining: 10, total: 10, acceptedScans: 0 },
      },
    });

    expect(await screen.findByText('Just Scanned')).toBeInTheDocument();
  });

  it('keeps the event-scoped invite action available at mobile sizes', async () => {
    permissionState.values.add('settings.write');
    render(<CheckInConsole initialEventId="evt_1" initialListId="cil_1" />);

    const inviteLink = await screen.findByRole('link', { name: 'Invite staff' });
    expect(inviteLink).not.toHaveClass('hidden');
    expect(inviteLink).toHaveAttribute(
      'href',
      expect.stringContaining('/settings/members?invite=1&eventId=evt_1'),
    );
  });

  it('removes the redundant eventId query parameter with one URL replacement', async () => {
    navigationState.searchParams = new URLSearchParams('tab=sales&eventId=evt_1');

    render(<CheckInConsole initialEventId="evt_1" initialTab="sales" />);

    await waitFor(() => {
      expect(navigationState.router.replace).toHaveBeenCalledWith('/kiosk/evt_1?tab=sales', {
        scroll: false,
      });
    });
    expect(navigationState.router.replace).toHaveBeenCalledTimes(1);
  });

  it('keeps scan-only and sales-only capabilities in separate tabs', async () => {
    permissionState.values = new Set(['box_office.write']);
    const { unmount } = render(<CheckInConsole initialEventId="evt_1" initialListId="cil_1" />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /sales/i })).toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: /scan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /live/i })).not.toBeInTheDocument();
    unmount();

    permissionState.values = new Set(['checkins.write', 'checkins.read']);
    render(<CheckInConsole initialEventId="evt_1" initialListId="cil_1" />);

    await waitFor(() => expect(screen.getByRole('tab', { name: /scan/i })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /live/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /sales/i })).not.toBeInTheDocument();
  });
});
