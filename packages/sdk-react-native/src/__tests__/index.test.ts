import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { GateKitScannerClient } from '../index.js';

const SIGNING_KEY = 'gatekit-manifest-secret-dev-only';

function signManifest(payload: Omit<import('../index.js').OfflineManifest, 'signature'>) {
  const signature = createHmac('sha256', SIGNING_KEY).update(JSON.stringify(payload)).digest('hex');
  return { ...payload, signature };
}

function makeSignedManifest(overrides: Partial<import('../index.js').OfflineManifest> = {}) {
  return signManifest({
    eventId: 'evt_1',
    checkInListId: 'cil_1',
    generatedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: '2027-06-02T00:00:00.000Z',
    keyId: 'manifest:v1',
    tickets: [
      {
        ticketId: 'tkt_1',
        ticketTypeId: 'tt_1',
        attendeeName: 'Ada Lovelace',
        qrHash: 'hash_1',
        status: 'valid',
      },
    ],
    ...overrides,
  });
}

describe('GateKitScannerClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads the server offline manifest with scanner credentials', async () => {
    const manifest = makeSignedManifest();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
    });

    await expect(client.downloadManifest('evt_1', 'cil_1')).resolves.toEqual(manifest);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;

    expect(String(url)).toBe('https://api.test/v1/events/evt_1/check-in-lists/cil_1/manifest');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Device-Id']).toBe('sd_public_1');
    expect(headers['X-Device-Secret']).toBe('scanner-secret');
  });

  it('authenticates with scanner headers and sends signed QR payloads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'accepted', message: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
    });

    await client.scanOnline('cil_1', 'signed-qr-payload');

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;

    expect(String(url)).toBe('https://api.test/v1/check-ins/scan');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Device-Id']).toBe('sd_public_1');
    expect(headers['X-Device-Secret']).toBe('scanner-secret');
    expect(body).toMatchObject({
      checkInListId: 'cil_1',
      qrPayload: 'signed-qr-payload',
      offline: false,
    });
    expect(body).not.toHaveProperty('deviceId');
    expect(body).not.toHaveProperty('qrHash');
  });

  it('rejects transferred tickets during offline scans', async () => {
    const manifest = makeSignedManifest({
      tickets: [
        {
          ticketId: 'tkt_1',
          ticketTypeId: 'tt_1',
          attendeeName: 'Ada Lovelace',
          qrHash: 'hash_1',
          status: 'transferred',
        },
      ],
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
    });

    await client.downloadManifest('evt_1', 'cil_1');

    expect(client.scanOffline('hash_1')).toEqual({
      outcome: 'revoked',
      message: 'Ticket is voided, refunded, or transferred',
    });
  });

  it('syncs offline scans with the original scan timestamp', async () => {
    vi.useFakeTimers();
    const manifest = makeSignedManifest();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: 1, duplicates: 0, invalid: 0, results: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
    });

    await client.downloadManifest('evt_1', 'cil_1');
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    expect(client.scanOffline('hash_1').outcome).toBe('accepted');
    vi.setSystemTime(new Date('2026-06-01T12:05:00.000Z'));

    await client.syncScans();

    const [, init] = fetchMock.mock.calls[1]!;
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(init?.body as string) as {
      scans: { qrHash: string; scannedAt: string; offline: boolean }[];
    };
    expect(headers['Idempotency-Key']).toBe(
      'scanner-sync:sd_public_1:cil_1:1:2026-06-01T12:00:00.000Z:2026-06-01T12:00:00.000Z',
    );
    expect(body.scans).toEqual([
      {
        qrHash: 'hash_1',
        scannedAt: '2026-06-01T12:00:00.000Z',
        offline: true,
      },
    ]);
  });

  it('rejects manifests with invalid signatures', async () => {
    const tamperedManifest = makeSignedManifest();
    // Tamper with the eventId after signing
    const tampered = { ...tamperedManifest, eventId: 'evt_tampered' };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(tampered), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
    });

    await expect(client.downloadManifest('evt_tampered', 'cil_1')).rejects.toThrow(
      'Offline manifest signature verification failed',
    );
  });
});
