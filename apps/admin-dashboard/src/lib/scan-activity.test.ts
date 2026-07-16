import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeToCheckInActivity } from './scan-activity';

vi.mock('@/lib/api', () => ({
  getAdminApiAuthHeaders: vi.fn(async (headers: Record<string, string>) => headers),
  resolveAdminApiUrl: (path: string) => `http://localhost:4000${path}`,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('subscribeToCheckInActivity', () => {
  it('reports ready after parsing the initial SSE frame', async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('event: ready\ndata: {"eventId":"evt_1","checkInListId":"cil_1"}\n\n'),
            );
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const onReady = vi.fn();
    const unsubscribe = subscribeToCheckInActivity('evt_1', 'cil_1', {
      onScan: vi.fn(),
      onReady,
    });

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
    });
    unsubscribe();
  });

  it('starts the stream from the REST activity cursor', async () => {
    const encoder = new TextEncoder();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const unsubscribe = subscribeToCheckInActivity(
      'evt_1',
      'cil_1',
      { onScan: vi.fn() },
      'scan_50',
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'Last-Event-ID': 'scan_50',
    });
    unsubscribe();
  });

  it('surfaces network retries instead of remaining silently connecting', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const onReconnecting = vi.fn();
    const unsubscribe = subscribeToCheckInActivity('evt_1', 'cil_1', {
      onScan: vi.fn(),
      onReconnecting,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onReconnecting).toHaveBeenCalledWith({
      attempt: 1,
      retryInMs: 1_000,
      error: expect.objectContaining({ message: 'Failed to fetch' }),
    });
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it('reports non-retryable HTTP failures as offline errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Session expired' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const onError = vi.fn();
    subscribeToCheckInActivity('evt_1', 'cil_1', {
      onScan: vi.fn(),
      onError,
    });

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Session expired' })),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
