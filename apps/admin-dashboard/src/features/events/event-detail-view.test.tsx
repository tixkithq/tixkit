import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventDetailView } from './event-detail-view';
import { toast } from 'sonner';

const useAdminDataMock = vi.hoisted(() => vi.fn());
const useBootstrapMock = vi.hoisted(() => vi.fn());
const usePermissionsMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-admin-table-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-admin-table-data')>();
  return {
    ...actual,
    useAdminQuery: useAdminDataMock,
  };
});

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: useBootstrapMock,
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: usePermissionsMock,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const event = {
  id: 'evt_1',
  title: 'Launch Night',
  slug: 'launch-night',
  status: 'published' as const,
  startsAt: '2026-07-04T19:00:00.000Z',
  endsAt: '2026-07-04T23:00:00.000Z',
  timezone: 'America/New_York',
  venueName: 'Main Hall',
  venue: null,
  city: 'New York',
  description: 'Opening event',
  visibility: 'public' as const,
  seo: { title: 'Launch Night', description: 'Opening event' },
  currency: 'USD',
  grossSalesCents: 125_00,
  ticketsSold: 12,
  capacity: 100,
  coverImageUrl: null,
  externalUrl: null,
  resalePolicy: { enabled: false, maxMultiplier: 1 },
  checkIns: 0,
  updatedAt: '2026-07-01T00:00:00.000Z',
  brandId: 'brd_1',
};

const launchReadiness = {
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  brandId: 'brd_1',
  eventId: 'evt_1',
  eventVersion: 1,
  generatedAt: '2026-07-01T00:00:00.000Z',
  paymentMode: 'capture' as const,
  launchable: true,
  published: true,
  requiredBlockers: [],
  recommendedWarnings: [],
  steps: [],
};

function setClipboard(clipboard: Clipboard | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: clipboard,
  });
}

function mockLoadedEventDetail() {
  useBootstrapMock.mockReturnValue({ brands: [] });
  usePermissionsMock.mockReturnValue({
    can: vi.fn(() => true),
    loading: false,
    error: null,
  });
  useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
    const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
    if (key === 'getEvent') {
      return { data: event, loading: false, error: null, refetch: vi.fn() };
    }
    if (key === 'listTicketTypes') {
      return { data: [], loading: false, error: null, refetch: vi.fn() };
    }
    if (key === 'listOrders') {
      return {
        data: { items: [] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (key === 'eventLaunchReadiness') {
      return {
        data: launchReadiness,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    return { data: undefined, loading: false, error: null, refetch: vi.fn() };
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  setClipboard(undefined);
  window.history.replaceState({}, '', '/');
});

describe('EventDetailView', () => {
  it('offers an optimized event-media follow-up after draft creation and consumes the URL flag', async () => {
    window.history.replaceState({}, '', '/events/evt_1?created=1');
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByRole('status')).toHaveTextContent('Your event draft is ready.');
    expect(view.getByRole('link', { name: 'Add event media' })).toHaveAttribute(
      'href',
      '/events/evt_1/settings#media',
    );
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('consumes the creation flag without offering a write action to read-only organizers', async () => {
    window.history.replaceState({}, '', '/events/evt_1?created=1');
    mockLoadedEventDetail();
    usePermissionsMock.mockReturnValue({
      can: vi.fn((permission: string) => permission !== 'events.write'),
      loading: false,
      error: null,
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(view.queryByRole('link', { name: 'Add event media' })).not.toBeInTheDocument();
  });

  it('consumes both creation notices while preserving unrelated query parameters and the hash', async () => {
    window.history.replaceState(
      {},
      '',
      '/events/evt_1?tab=launch&created=1&setupWarning=Add+ticket+inventory#readiness',
    );
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByRole('status')).toHaveTextContent('Your event draft is ready.');
    expect(view.getByRole('alert')).toHaveTextContent('Add ticket inventory');
    await waitFor(() => {
      expect(window.location.search).toBe('?tab=launch');
      expect(window.location.hash).toBe('#readiness');
    });
  });

  it('shows copy success only after writing the public event URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText } as unknown as Clipboard);
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);
    fireEvent.click(await view.findByRole('button', { name: 'Copy public link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/e/evt_1');
    });
    expect(toast.success).toHaveBeenCalledWith('Public event link copied');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not show copy success when clipboard access is unavailable', async () => {
    setClipboard(undefined);
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);
    fireEvent.click(await view.findByRole('button', { name: 'Copy public link' }));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Copy unavailable. Select and copy the public event URL manually.',
    );
    expect(view.getByRole('textbox', { name: 'Public event URL' })).toHaveValue(
      'http://localhost:3000/e/evt_1',
    );
  });

  it('does not show copy success when clipboard write is rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    setClipboard({ writeText } as unknown as Clipboard);
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);
    fireEvent.click(await view.findByRole('button', { name: 'Copy public link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/e/evt_1');
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Unable to copy public event link. Select and copy it manually.',
    );
    expect(view.getByRole('textbox', { name: 'Public event URL' })).toHaveValue(
      'http://localhost:3000/e/evt_1',
    );
  });

  it('ranks only active ticket inventory as a live risk', async () => {
    mockLoadedEventDetail();
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return { data: event, loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listTicketTypes') {
        return {
          data: [
            {
              id: 'ticket_draft',
              eventId: 'evt_1',
              name: 'Draft ticket',
              status: 'draft',
              priceCents: 1000,
              currency: 'USD',
              quantityTotal: 5,
              quantitySold: 5,
              maxPerOrder: 2,
              requiresAccessCode: false,
            },
            {
              id: 'ticket_active',
              eventId: 'evt_1',
              name: 'Active ticket',
              status: 'active',
              priceCents: 1000,
              currency: 'USD',
              quantityTotal: 10,
              quantitySold: 8,
              maxPerOrder: 2,
              requiresAccessCode: false,
            },
          ],
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'eventLaunchReadiness') {
        return {
          data: launchReadiness,
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText('Review inventory risk')).toBeInTheDocument();
    expect(view.getByText(/1 ticket type may need more inventory/)).toBeInTheDocument();
  });

  it.each([
    ['listTicketTypes', 'checking', 'Checking inventory, messaging, and launch health'],
    ['listMessages', 'failed', 'Health checks are incomplete'],
    ['eventLaunchReadiness', 'failed', 'Health checks are incomplete'],
  ])('does not recommend from incomplete %s signals (%s)', async (failedKey, _state, notice) => {
    mockLoadedEventDetail();
    const refetchTickets = vi.fn();
    const refetchMessages = vi.fn();
    const refetchReadiness = vi.fn();
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return { data: event, loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listTicketTypes') {
        return {
          data: [],
          loading: failedKey === key,
          error: null,
          refetch: refetchTickets,
        };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'eventLaunchReadiness') {
        return {
          data: failedKey === key ? undefined : launchReadiness,
          loading: false,
          error: failedKey === key ? new Error('readiness unavailable') : null,
          refetch: refetchReadiness,
        };
      }
      if (key === 'listMessages') {
        return {
          data: [],
          loading: false,
          error: failedKey === key ? new Error('messages unavailable') : null,
          refetch: refetchMessages,
        };
      }
      return {
        data: undefined,
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText(new RegExp(notice))).toBeInTheDocument();
    expect(view.queryByText('Recommended next')).not.toBeInTheDocument();
    if (failedKey === 'listMessages') {
      fireEvent.click(view.getAllByRole('button', { name: 'Retry health checks' })[0]);
      expect(refetchTickets).toHaveBeenCalledOnce();
      expect(refetchMessages).toHaveBeenCalledOnce();
      expect(refetchReadiness).toHaveBeenCalledOnce();
    }
  });

  it('reports consent suppressions as safe policy outcomes instead of messaging incidents', async () => {
    mockLoadedEventDetail();
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return { data: event, loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listTicketTypes') {
        return { data: [], loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'listMessages') {
        return {
          data: [
            {
              id: 'campaign_1',
              eventId: 'evt_1',
              name: 'Door reminder',
              channel: 'email',
              status: 'sent',
              audience: 'all_attendees',
              audienceLabel: 'All attendees',
              queuedCount: 1,
              sentCount: 0,
              deliveredCount: 0,
              failedCount: 0,
              suppressedCount: 1,
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'eventLaunchReadiness') {
        return {
          data: launchReadiness,
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(
      await view.findByText(/No failed deliveries\. 1 recipient was safely suppressed/),
    ).toBeInTheDocument();
    expect(view.queryByText('Review message outcomes')).not.toBeInTheDocument();
  });

  it('prioritizes only failed deliveries when outcomes also include policy suppressions', async () => {
    mockLoadedEventDetail();
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return { data: event, loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listTicketTypes') {
        return { data: [], loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'listMessages') {
        return {
          data: [
            {
              id: 'campaign_1',
              eventId: 'evt_1',
              name: 'Door reminder',
              channel: 'email',
              status: 'sent',
              audience: 'all_attendees',
              audienceLabel: 'All attendees',
              queuedCount: 5,
              sentCount: 0,
              deliveredCount: 0,
              failedCount: 2,
              suppressedCount: 3,
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'eventLaunchReadiness') {
        return {
          data: launchReadiness,
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText('Review message outcomes')).toBeInTheDocument();
    expect(view.getByText('2 failed delivery outcomes need review.')).toBeInTheDocument();
    expect(
      view.getByText(/2 failed delivery outcomes\. 3 recipients were safely suppressed/),
    ).toBeInTheDocument();
  });

  it('hides the Messages quick link without messages.write', async () => {
    mockLoadedEventDetail();
    usePermissionsMock.mockReturnValue({
      can: vi.fn((permission: string) => permission !== 'messages.write'),
      loading: false,
      error: null,
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByRole('link', { name: 'Tickets' })).toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Messages' })).not.toBeInTheDocument();
  });

  it('disables protected order and messaging queries and labels unavailable data', async () => {
    mockLoadedEventDetail();
    usePermissionsMock.mockReturnValue({
      can: vi.fn(
        (permission: string) => permission !== 'orders.read' && permission !== 'messages.write',
      ),
      loading: false,
      error: null,
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(
      await view.findByText('Orders access is required to view recent purchases.'),
    ).toBeInTheDocument();
    expect(
      view.getByText('Messaging access is required to view delivery health.'),
    ).toBeInTheDocument();
    expect(view.queryByText('No orders yet.')).not.toBeInTheDocument();
    expect(view.queryByText(/Health checks are incomplete/)).not.toBeInTheDocument();
    expect(view.queryByText('Review message outcomes')).not.toBeInTheDocument();

    const ordersQuery = useAdminDataMock.mock.calls.find(
      ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'listOrders',
    );
    const messagesQuery = useAdminDataMock.mock.calls.find(
      ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'listMessages',
    );
    expect(ordersQuery?.[2]).toEqual({ enabled: false });
    expect(messagesQuery?.[2]).toEqual({ enabled: false });
  });

  it('keeps protected data pending until permissions resolve without showing a false denial', async () => {
    mockLoadedEventDetail();
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => false),
      loading: true,
      error: null,
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByLabelText('Checking orders access')).toBeInTheDocument();
    expect(view.getByText('Checking messaging access…')).toBeInTheDocument();
    expect(view.queryByText(/access is required/)).not.toBeInTheDocument();
    expect(
      useAdminDataMock.mock.calls.find(
        ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'listOrders',
      )?.[2],
    ).toEqual({ enabled: false });

    useAdminDataMock.mockClear();
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => true),
      loading: false,
      error: null,
    });
    view.rerender(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText('No orders yet.')).toBeInTheDocument();
    expect(
      useAdminDataMock.mock.calls.find(
        ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'listOrders',
      )?.[2],
    ).toEqual({ enabled: true });
    expect(
      useAdminDataMock.mock.calls.find(
        ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'listMessages',
      )?.[2],
    ).toEqual({ enabled: true });
  });

  it('distinguishes permission lookup failure from an access denial', async () => {
    mockLoadedEventDetail();
    usePermissionsMock.mockReturnValue({
      can: vi.fn(() => false),
      loading: false,
      error: new Error('permission service unavailable'),
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText('Orders access could not be verified.')).toHaveAttribute(
      'role',
      'alert',
    );
    expect(view.getByText('Messaging access could not be verified.')).toBeInTheDocument();
    expect(view.queryByText(/access is required/)).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Retry health checks' })).not.toBeInTheDocument();
    expect(view.queryByText('Recommended next')).not.toBeInTheDocument();
    expect(view.getByText(/Action priority is unavailable/)).toBeInTheDocument();
  });

  it('uses inventory-only progress copy when messaging access is unavailable', async () => {
    mockLoadedEventDetail();
    usePermissionsMock.mockReturnValue({
      can: vi.fn((permission: string) => permission !== 'messages.write'),
      loading: false,
      error: null,
    });
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return { data: event, loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listTicketTypes') {
        return { data: [], loading: true, error: null, refetch: vi.fn() };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'eventLaunchReadiness') {
        return {
          data: launchReadiness,
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText('Checking inventory health…')).toBeInTheDocument();
    expect(view.queryByText('Checking inventory and messaging health…')).not.toBeInTheDocument();
  });

  it('does not retry a disabled messaging query when another health signal fails', async () => {
    mockLoadedEventDetail();
    const refetchTickets = vi.fn();
    const refetchMessages = vi.fn();
    const refetchReadiness = vi.fn();
    usePermissionsMock.mockReturnValue({
      can: vi.fn((permission: string) => permission !== 'messages.write'),
      loading: false,
      error: null,
    });
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return { data: event, loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listTicketTypes') {
        return {
          data: [],
          loading: false,
          error: new Error('inventory unavailable'),
          refetch: refetchTickets,
        };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'listMessages') {
        return {
          data: undefined,
          loading: false,
          error: null,
          refetch: refetchMessages,
        };
      }
      if (key === 'eventLaunchReadiness') {
        return {
          data: launchReadiness,
          loading: false,
          error: null,
          refetch: refetchReadiness,
        };
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    const [retryHealthChecks] = await view.findAllByRole('button', {
      name: 'Retry health checks',
    });
    fireEvent.click(retryHealthChecks!);
    expect(refetchTickets).toHaveBeenCalledOnce();
    expect(refetchReadiness).toHaveBeenCalledOnce();
    expect(refetchMessages).not.toHaveBeenCalled();
  });

  it('shows the Messages quick link with messages.write', async () => {
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByRole('link', { name: 'Messages' })).toHaveAttribute(
      'href',
      '/events/evt_1/messages',
    );
  });

  it('shows event description copy without duplicate edit actions', async () => {
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByText('Event Description')).toBeInTheDocument();
    expect(view.getByText('Opening event')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Design page' })).not.toBeInTheDocument();
    expect(view.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/events/evt_1/settings',
    );
    expect(view.getByRole('link', { name: 'Event Page' })).toHaveAttribute(
      'href',
      '/events/evt_1/content/event-page',
    );
  });

  it('shows an empty event description state and keeps existing edit entry points', async () => {
    mockLoadedEventDetail();
    useAdminDataMock.mockImplementation((queryKey: unknown[]) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === 'getEvent') {
        return {
          data: { ...event, description: '   ' },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      if (key === 'listTicketTypes') {
        return { data: [], loading: false, error: null, refetch: vi.fn() };
      }
      if (key === 'listOrders') {
        return {
          data: { items: [] },
          loading: false,
          error: null,
          refetch: vi.fn(),
        };
      }
      return { data: undefined, loading: false, error: null, refetch: vi.fn() };
    });

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(
      await view.findByText(/No description yet. Add the canonical event copy in Settings/),
    ).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Design page' })).not.toBeInTheDocument();
    expect(view.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/events/evt_1/settings',
    );
    expect(view.getByRole('link', { name: 'Event Page' })).toHaveAttribute(
      'href',
      '/events/evt_1/content/event-page',
    );
  });

  it('keeps Schedule and Marketing out of quick links and opens settings as a route', async () => {
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);

    expect(await view.findByRole('link', { name: 'Tickets' })).toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Marketing' })).not.toBeInTheDocument();
    expect(view.queryByTestId('inline-event-schedule')).not.toBeInTheDocument();
    expect(view.queryByTestId('inline-event-marketing')).not.toBeInTheDocument();

    expect(view.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/events/evt_1/settings',
    );
  });
});
