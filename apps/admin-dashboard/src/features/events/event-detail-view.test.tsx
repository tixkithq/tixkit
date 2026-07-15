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
      return { data: { items: [] }, loading: false, error: null, refetch: vi.fn() };
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
    fireEvent.click(await view.findByRole('button', { name: 'Copy link' }));

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
    fireEvent.click(await view.findByRole('button', { name: 'Copy link' }));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Copy unavailable. Select and copy the public event URL manually.',
    );
  });

  it('does not show copy success when clipboard write is rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    setClipboard({ writeText } as unknown as Clipboard);
    mockLoadedEventDetail();

    const view = render(<EventDetailView eventId="evt_1" />);
    fireEvent.click(await view.findByRole('button', { name: 'Copy link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/e/evt_1');
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Unable to copy public event link. Select and copy it manually.',
    );
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
        return { data: { items: [] }, loading: false, error: null, refetch: vi.fn() };
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
