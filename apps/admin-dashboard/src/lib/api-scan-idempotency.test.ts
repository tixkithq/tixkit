import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from './api';

const apiHttpMock = vi.hoisted(() => ({
  getAdminApiAuthHeaders: vi.fn(async (headers: Record<string, string>) => headers),
  getAdminApiBaseUrl: vi.fn(() => 'https://api.test'),
  request: vi.fn(),
  withFixture: vi.fn(async <T>(call: () => Promise<T>) => call()),
}));

vi.mock('./api-http', () => apiHttpMock);

afterEach(() => {
  apiHttpMock.request.mockReset();
  apiHttpMock.withFixture.mockClear();
});

describe('adminApi.scanTicket idempotency', () => {
  it('reuses the same idempotency key when retrying the same scan after a transport failure', async () => {
    apiHttpMock.request
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'network_error', message: 'Connection lost' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { outcome: 'accepted', message: 'Check-in successful' },
      });

    const firstResult = await adminApi.scanTicket({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      qrPayload: ' signed-ticket-payload ',
      scannedAt: '2026-07-01T14:58:18.000Z',
    });
    const secondResult = await adminApi.scanTicket({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      qrPayload: ' signed-ticket-payload ',
      scannedAt: '2026-07-01T14:58:20.000Z',
    });

    expect(firstResult.ok).toBe(false);
    expect(secondResult.ok).toBe(true);
    expect(apiHttpMock.request).toHaveBeenCalledTimes(2);

    const firstOptions = apiHttpMock.request.mock.calls[0][1] as RequestInit;
    const secondOptions = apiHttpMock.request.mock.calls[1][1] as RequestInit;
    const firstKey = (firstOptions.headers as Record<string, string>)['Idempotency-Key'];
    const secondKey = (secondOptions.headers as Record<string, string>)['Idempotency-Key'];

    expect(firstKey).toMatch(/^scan_evt_1_/);
    expect(secondKey).toBe(firstKey);
    expect(JSON.parse(String(firstOptions.body))).toMatchObject({
      checkInListId: 'cil_1',
      qrPayload: 'signed-ticket-payload',
      scannedAt: '2026-07-01T14:58:18.000Z',
    });
    expect(JSON.parse(String(secondOptions.body))).toMatchObject({
      checkInListId: 'cil_1',
      qrPayload: 'signed-ticket-payload',
      scannedAt: '2026-07-01T14:58:20.000Z',
    });
  });

  it('uses a fresh idempotency key for a later scan after a completed response', async () => {
    apiHttpMock.request
      .mockResolvedValueOnce({
        ok: true,
        data: { outcome: 'accepted', message: 'Check-in successful' },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { outcome: 'duplicate', message: 'Already checked in' },
      });

    await adminApi.scanTicket({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      qrPayload: 'signed-ticket-payload',
      scannedAt: '2026-07-01T14:58:18.000Z',
    });
    await adminApi.scanTicket({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      qrPayload: 'signed-ticket-payload',
      scannedAt: '2026-07-01T14:59:18.000Z',
    });

    const firstOptions = apiHttpMock.request.mock.calls[0][1] as RequestInit;
    const secondOptions = apiHttpMock.request.mock.calls[1][1] as RequestInit;
    const firstKey = (firstOptions.headers as Record<string, string>)['Idempotency-Key'];
    const secondKey = (secondOptions.headers as Record<string, string>)['Idempotency-Key'];

    expect(firstKey).toMatch(/^scan_evt_1_/);
    expect(secondKey).toMatch(/^scan_evt_1_/);
    expect(secondKey).not.toBe(firstKey);
  });
});
