import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAllEvents } from './use-all-events';

function makeEvent(id: string, title: string) {
  return {
    id,
    title,
    status: 'published' as const,
    startsAt: '2026-07-05T00:00:00Z',
    timezone: 'UTC',
    visibility: 'public' as const,
    seo: { title: '', description: '' },
    currency: 'USD',
    grossSalesCents: 0,
    ticketsSold: 0,
    resalePolicy: { enabled: false, maxMultiplier: 1 },
    checkIns: 0,
    updatedAt: '2026-07-05T00:00:00Z',
  };
}

vi.mock('@/lib/api', () => ({
  adminApi: {
    listEvents: vi.fn(),
  },
}));

import { adminApi } from '@/lib/api';

const listEventsMock = vi.mocked(adminApi.listEvents);

afterEach(() => {
  listEventsMock.mockReset();
});

beforeEach(() => {
  listEventsMock.mockReset();
});

describe('useAllEvents', () => {
  it('fetches all pages by following nextCursor', async () => {
    listEventsMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: Array.from({ length: 50 }, (_, i) => makeEvent(`evt_${i}`, `Event ${i}`)),
          nextCursor: 'evt_49',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: Array.from({ length: 20 }, (_, i) =>
            makeEvent(`evt_${50 + i}`, `Event ${50 + i}`),
          ),
          nextCursor: undefined,
        },
      });

    const { result } = renderHook(() => useAllEvents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.events).toHaveLength(70);
    expect(result.current.error).toBeUndefined();
    expect(listEventsMock).toHaveBeenCalledTimes(2);
    expect(listEventsMock).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 50 });
    expect(listEventsMock).toHaveBeenNthCalledWith(2, { cursor: 'evt_49', limit: 50 });
  });

  it('stops after first page when no nextCursor', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [makeEvent('evt_1', 'Event 1')],
        nextCursor: undefined,
      },
    });

    const { result } = renderHook(() => useAllEvents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.events).toHaveLength(1);
    expect(listEventsMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces error when API fails', async () => {
    listEventsMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'events_unavailable', message: 'Events unavailable' },
    });

    const { result } = renderHook(() => useAllEvents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.events).toHaveLength(0);
    expect(result.current.error).toEqual({
      code: 'events_unavailable',
      message: 'Events unavailable',
    });
  });

  it('refetches all pages when refetch is called', async () => {
    listEventsMock.mockResolvedValue({
      ok: true,
      data: {
        items: [makeEvent('evt_1', 'Event 1')],
        nextCursor: undefined,
      },
    });

    const { result } = renderHook(() => useAllEvents());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(listEventsMock).toHaveBeenCalledTimes(1);

    result.current.refetch();

    await waitFor(() => {
      expect(listEventsMock).toHaveBeenCalledTimes(2);
    });
  });
});
