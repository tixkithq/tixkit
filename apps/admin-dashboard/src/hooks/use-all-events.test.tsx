import { act, renderHook, waitFor } from '@testing-library/react';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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

  it('quarantines prior-workspace events synchronously while the next scope loads', async () => {
    const workspaceB = deferred<{
      ok: true;
      data: { items: ReturnType<typeof makeEvent>[]; nextCursor: undefined };
    }>();
    listEventsMock.mockImplementation((input) => {
      if (input?.organizationId === 'org_a') {
        return Promise.resolve({
          ok: true,
          data: { items: [makeEvent('evt_a', 'Workspace A Event')], nextCursor: undefined },
        });
      }
      return workspaceB.promise;
    });

    const { result, rerender } = renderHook(
      ({ organizationId, brandId }) => useAllEvents({ organizationId, brandId }),
      { initialProps: { organizationId: 'org_a', brandId: 'brd_a' } },
    );
    await waitFor(() => expect(result.current.events.map((event) => event.id)).toEqual(['evt_a']));

    rerender({ organizationId: 'org_b', brandId: 'brd_b' });
    expect(result.current.events).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      workspaceB.resolve({
        ok: true,
        data: { items: [makeEvent('evt_b', 'Workspace B Event')], nextCursor: undefined },
      });
      await workspaceB.promise;
    });
    await waitFor(() => expect(result.current.events.map((event) => event.id)).toEqual(['evt_b']));
  });
});
