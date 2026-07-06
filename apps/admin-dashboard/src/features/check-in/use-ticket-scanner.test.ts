import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '@/lib/api';
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

    let resolved: Awaited<ReturnType<typeof result.current.scan>>;
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

  it('stores an invalid result when the API returns an error', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'Ticket not found' },
    });
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    let resolved: Awaited<ReturnType<typeof result.current.scan>>;
    await act(async () => {
      resolved = await result.current.scan('tkt_bad');
    });
    expect(resolved!.status).toBe('invalid');
    expect(resolved!.message).toBe('Ticket not found');
    expect(result.current.lastResult!.status).toBe('invalid');
    expect(result.current.acceptedScanCount).toBe(0);
  });

  it('stores an invalid result when the API call throws', async () => {
    vi.spyOn(adminApi, 'scanTicket').mockRejectedValue(new Error('Network failure'));
    const { result } = renderHook(() =>
      useTicketScanner({ eventId: 'evt_1', checkInListId: 'cil_1' }),
    );
    let resolved: Awaited<ReturnType<typeof result.current.scan>>;
    await act(async () => {
      resolved = await result.current.scan('tkt_throw');
    });
    expect(resolved!.status).toBe('invalid');
    expect(resolved!.message).toBe('Network failure');
    expect(result.current.scanning).toBe(false);
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
