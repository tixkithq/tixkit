import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventDetailView } from './event-detail-view';
import { toast } from 'sonner';

const useAdminDataMock = vi.hoisted(() => vi.fn());
const useBootstrapMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: useAdminDataMock,
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: useBootstrapMock,
}));

vi.mock('./create-event-drawer', () => ({
  CreateEventDrawer: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="event-edit-drawer" /> : null,
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
  useAdminDataMock
    .mockReturnValueOnce({ data: event, loading: false, error: null, refetch: vi.fn() })
    .mockReturnValueOnce({ data: [], loading: false, error: null, refetch: vi.fn() })
    .mockReturnValueOnce({
      data: { items: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    })
    .mockReturnValueOnce({ data: [], loading: false, error: null, refetch: vi.fn() });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  setClipboard(undefined);
});

describe('EventDetailView', () => {
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
});
