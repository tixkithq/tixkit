import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type CheckInScanResult } from '@/lib/api';
import { useTicketScanner } from './use-ticket-scanner';

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useTicketScanner', () => {
  it('returns null and does not call the API when the payload is empty', async () => {
    const spy = vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: { status: 'accepted', message: 'ok', scannedAt: '2026-07-05T00:00:00.000Z' },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    const res = await act(() => result.current.scan('   '));
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.scanning).toBe(false);
  });

  it('returns null when disabled (no checkInListId)', async () => {
    const spy = vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: { status: 'accepted', message: 'ok', scannedAt: '2026-07-05T00:00:00.000Z' },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: '', enabled: false }),
    );
    const res = await act(() => result.current.scan('tkt_123'));
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('submits the trimmed payload and stores an accepted result', async () => {
    const spy = vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: {
        status: 'accepted',
        message: 'Check-in successful',
        scannedAt: '2026-07-05T12:00:00.000Z',
      },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );

    let resolved: Awaited<ReturnType<typeof result.current.scan>> = null;
    await act(async () => {
      resolved = await result.current.scan('  tkt_001  ');
    });

    expect(spy).toHaveBeenCalledWith({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      qrPayload: 'tkt_001',
      scannedAt: expect.any(String),
    });
    expect(resolved!.status).toBe('accepted');
    expect(result.current.lastResult).not.toBeNull();
    expect(result.current.lastResult!.status).toBe('accepted');
    expect(result.current.acceptedScanCount).toBe(1);
    expect(result.current.scanning).toBe(false);
  });

  it('does not increment acceptedScanCount for non-accepted results', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: {
        status: 'duplicate',
        message: 'Already checked in',
        scannedAt: '2026-07-05T12:00:00.000Z',
      },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    await act(() => result.current.scan('tkt_dup'));
    expect(result.current.acceptedScanCount).toBe(0);
    expect(result.current.lastResult!.status).toBe('duplicate');
  });

  it('preserves an invalid ticket outcome returned by the scan endpoint', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: {
        status: 'invalid',
        message: 'The ticket signature is invalid.',
        scannedAt: '2026-07-05T12:00:00.000Z',
      },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );

    let resolved: Awaited<ReturnType<typeof result.current.scan>> = null;
    await act(async () => {
      resolved = await result.current.scan('tkt_invalid_signature');
    });

    expect(resolved).toMatchObject({
      status: 'invalid',
      message: 'The ticket signature is invalid.',
    });
    expect(result.current.scanError).toBeNull();
    expect(result.current.lastResult).toEqual(resolved);
    expect(result.current.acceptedScanCount).toBe(0);
  });

  it('keeps API failures separate from legitimate invalid ticket outcomes', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'Ticket not found' },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.scan('tkt_bad');
      } catch (error) {
        rejection = error;
      }
    });
    expect(rejection).toEqual(new Error('Ticket not found'));
    expect(result.current.scanError).toBe('Ticket not found');
    expect(result.current.lastResult).toBeNull();
    expect(result.current.acceptedScanCount).toBe(0);
  });

  it('exposes a thrown transport failure without synthesizing a ticket result', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockRejectedValue(new Error('Network failure'));
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    let rejection: unknown;
    await act(async () => {
      try {
        await result.current.scan('tkt_throw');
      } catch (error) {
        rejection = error;
      }
    });
    expect(rejection).toEqual(new Error('Network failure'));
    expect(result.current.scanError).toBe('Network failure');
    expect(result.current.lastResult).toBeNull();
    expect(result.current.scanning).toBe(false);
  });

  it('retries the exact failed payload once and clears the error after recovery', async () => {
    const spy = vi
      .spyOn(adminApi, 'scanTicket')
      .mockRejectedValueOnce(new Error('Network failure'))
      .mockResolvedValueOnce({
        ok: true,
        data: {
          status: 'accepted',
          message: 'Check-in successful',
          scannedAt: '2026-07-05T12:00:00.000Z',
        },
      });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );

    await act(async () => {
      await result.current.scan('  tkt_retry_exact  ').catch(() => undefined);
    });
    expect(result.current.scanError).toBe('Network failure');

    let retried: Awaited<ReturnType<typeof result.current.retryLastScan>>;
    await act(async () => {
      retried = await result.current.retryLastScan();
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ qrPayload: 'tkt_retry_exact' }),
    );
    expect(retried!.status).toBe('accepted');
    expect(result.current.scanError).toBeNull();
    expect(result.current.acceptedScanCount).toBe(1);
  });

  it('keeps retry single-flight while another retry is pending', async () => {
    let resolveRetry!: (value: {
      ok: true;
      data: { status: 'accepted'; message: string; scannedAt: string };
    }) => void;
    const pendingRetry = new Promise<{
      ok: true;
      data: { status: 'accepted'; message: string; scannedAt: string };
    }>((resolve) => {
      resolveRetry = resolve;
    });
    const spy = vi
      .spyOn(adminApi, 'scanTicket')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementationOnce(() => pendingRetry);
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    await act(async () => {
      await result.current.scan('tkt_single_flight').catch(() => undefined);
    });

    let firstRetry: Promise<unknown>;
    let secondRetry: Awaited<ReturnType<typeof result.current.retryLastScan>>;
    act(() => {
      firstRetry = result.current.retryLastScan();
    });
    expect(result.current.scanning).toBe(true);
    expect(result.current.scanError).toBe('Offline');
    await act(async () => {
      secondRetry = await result.current.retryLastScan();
    });
    expect(secondRetry!).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRetry({
        ok: true,
        data: { status: 'accepted', message: 'ok', scannedAt: '2026-07-05T00:00:00.000Z' },
      });
      await firstRetry!;
    });
  });

  it('replaces the retained retry error when the retry also fails', async () => {
    vi.spyOn(adminApi, 'scanTicket')
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockRejectedValueOnce(new Error('Service still unavailable'));
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    await act(async () => {
      await result.current.scan('tkt_retry_failure').catch(() => undefined);
    });
    expect(result.current.scanError).toBe('Network unavailable');

    await act(async () => {
      await result.current.retryLastScan().catch(() => undefined);
    });

    expect(result.current.scanError).toBe('Service still unavailable');
    expect(result.current.lastResult).toBeNull();
  });

  it('ignores a stale accepted result after switching to another check-in list', async () => {
    let resolveOldScan!: (value: {
      ok: true;
      data: { status: 'accepted'; message: string; scannedAt: string };
    }) => void;
    vi.spyOn(adminApi, 'scanTicket').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldScan = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ checkInListId }) => useTicketScanner({ eventId: 'evt_1', checkInListId }),
      { initialProps: { checkInListId: 'cil_a' } },
    );

    let oldScan!: Promise<CheckInScanResult | null>;
    act(() => {
      oldScan = result.current.scan('tkt_old_list');
    });
    rerender({ checkInListId: 'cil_b' });
    expect(result.current.lastResult).toBeNull();
    expect(result.current.acceptedScanCount).toBe(0);

    await act(async () => {
      resolveOldScan({
        ok: true,
        data: {
          status: 'accepted',
          message: 'old result',
          scannedAt: '2026-07-05T00:00:00.000Z',
        },
      });
      await expect(oldScan).resolves.toBeNull();
    });

    expect(result.current.lastResult).toBeNull();
    expect(result.current.acceptedScanCount).toBe(0);
    expect(result.current.scanError).toBeNull();
  });

  it('ignores a stale transport rejection after switching events', async () => {
    let rejectOldScan!: (error: Error) => void;
    vi.spyOn(adminApi, 'scanTicket').mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOldScan = reject;
        }),
    );
    const { result, rerender } = renderHook(
      ({ eventId }) => useTicketScanner({ eventId, checkInListId: 'cil_1' }),
      { initialProps: { eventId: 'evt_a' } },
    );

    let oldScan!: Promise<CheckInScanResult | null>;
    act(() => {
      oldScan = result.current.scan('tkt_old_event');
    });
    rerender({ eventId: 'evt_b' });

    await act(async () => {
      rejectOldScan(new Error('Old event network failure'));
      await expect(oldScan).resolves.toBeNull();
    });

    expect(result.current.scanError).toBeNull();
    expect(result.current.lastResult).toBeNull();
    expect(result.current.scanning).toBe(false);
  });

  it('invalidates failed-payload retry authority when the list changes', async () => {
    const spy = vi.spyOn(adminApi, 'scanTicket').mockRejectedValueOnce(new Error('Offline'));
    const { result, rerender } = renderHook(
      ({ checkInListId }) => useTicketScanner({ eventId: 'evt_1', checkInListId }),
      { initialProps: { checkInListId: 'cil_a' } },
    );
    await act(async () => {
      await result.current.scan('tkt_list_a').catch(() => undefined);
    });
    expect(result.current.scanError).toBe('Offline');

    rerender({ checkInListId: 'cil_b' });
    let retryResult: CheckInScanResult | null | undefined;
    await act(async () => {
      retryResult = await result.current.retryLastScan();
    });

    expect(retryResult).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.scanError).toBeNull();
  });

  it('prevents concurrent scans (second call returns null while first is in flight)', async () => {
    let resolveFirst: (value: unknown) => void;
    const firstCall = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    vi.spyOn(adminApi, 'scanTicket').mockImplementationOnce(async () => {
      await firstCall;
      return {
        ok: true,
        data: { status: 'accepted', message: 'ok', scannedAt: '2026-07-05T00:00:00.000Z' },
      };
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );

    let firstResult: unknown;
    let secondResult: unknown;
    act(() => {
      void result.current.scan('tkt_first').then((r) => {
        firstResult = r;
      });
    });
    // While the first scan is in flight, attempt a second
    await act(async () => {
      secondResult = await result.current.scan('tkt_second');
    });
    expect(secondResult).toBeNull();
    // Resolve the first scan
    await act(async () => {
      resolveFirst!(undefined);
    });
    await waitFor(() => expect(firstResult).toBeDefined());
    expect((firstResult as { status: string }).status).toBe('accepted');
  });

  it('reset clears the last result and accepted count', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: { status: 'accepted', message: 'ok', scannedAt: '2026-07-05T00:00:00.000Z' },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    await act(() => result.current.scan('tkt_001'));
    expect(result.current.acceptedScanCount).toBe(1);
    expect(result.current.lastResult).not.toBeNull();
    act(() => result.current.reset());
    expect(result.current.acceptedScanCount).toBe(0);
    expect(result.current.lastResult).toBeNull();
  });
});
