import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { GateKitScannerClient, sha256, hmacSha256 } from '../index.js';

const SIGNING_KEY = 'test-manifest-signing-key';

function makeClient(overrides: Partial<{ apiBaseUrl: string; manifestSigningKey: string }> = {}) {
  return new GateKitScannerClient({
    deviceId: 'sd_public_1',
    deviceSecret: 'scanner-secret',
    apiBaseUrl: overrides.apiBaseUrl ?? 'https://api.test',
    manifestSigningKey: overrides.manifestSigningKey ?? SIGNING_KEY,
  });
}

function createMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    storage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
    },
  };
}

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
    const client = makeClient();

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
    const client = makeClient();

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
    const client = makeClient();

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
    const client = makeClient();

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

  it('persists and restores offline scans through the configured storage adapter', async () => {
    vi.useFakeTimers();
    const manifest = makeSignedManifest();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { storage, store } = createMemoryStorage();
    const first = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
      manifestSigningKey: SIGNING_KEY,
      storage,
    });

    await first.downloadManifest('evt_1', 'cil_1');
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    expect(first.scanOffline('hash_1').outcome).toBe('accepted');
    expect(storage.setItem).toHaveBeenCalledWith(
      'gatekit:scanner:sd_public_1:offline-scans',
      JSON.stringify([['hash_1', '2026-06-01T12:00:00.000Z']]),
    );

    const second = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
      manifestSigningKey: SIGNING_KEY,
      storage,
    });
    await second.restoreOfflineScans();
    expect(store.get('gatekit:scanner:sd_public_1:offline-scans')).toContain('hash_1');
  });

  it('invokes conflict callbacks for non-accepted sync results', async () => {
    const manifest = makeSignedManifest();
    const conflict = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          accepted: 0,
          duplicates: 1,
          invalid: 0,
          results: [{ qrHash: 'hash_1', outcome: 'duplicate' }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new GateKitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
      manifestSigningKey: SIGNING_KEY,
      onSyncConflict: conflict,
    });

    await client.downloadManifest('evt_1', 'cil_1');
    client.scanOffline('hash_1');
    await client.syncScans();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(conflict).toHaveBeenCalledWith({ qrHash: 'hash_1', outcome: 'duplicate' });
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
    const client = makeClient();

    await expect(client.downloadManifest('evt_tampered', 'cil_1')).rejects.toThrow(
      'Offline manifest signature verification failed',
    );
  });
});

describe('Pure-JS SHA-256 known-answer tests', () => {
  it('matches node:crypto SHA-256 for empty input', () => {
    const expected = createHash('sha256').update('').digest();
    const actual = sha256(new TextEncoder().encode(''));
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it('matches node:crypto SHA-256 for ASCII input', () => {
    const input = 'The quick brown fox jumps over the lazy dog';
    const expected = createHash('sha256').update(input).digest();
    const actual = sha256(new TextEncoder().encode(input));
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it('matches node:crypto SHA-256 for input longer than block size', () => {
    const input = 'a'.repeat(200);
    const expected = createHash('sha256').update(input).digest();
    const actual = sha256(new TextEncoder().encode(input));
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });
});

describe('Pure-JS HMAC-SHA256 known-answer tests', () => {
  it('matches node:crypto HMAC for short key and message', () => {
    const key = 'whsec_test';
    const message = '1234567890.{"id":"wevt_1"}';
    const expected = createHmac('sha256', key).update(message).digest();
    const actual = hmacSha256(key, message);
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it('matches node:crypto HMAC for key longer than block size', () => {
    const key = 'k'.repeat(200);
    const message = 'manifest payload data';
    const expected = createHmac('sha256', key).update(message).digest();
    const actual = hmacSha256(key, message);
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it('matches node:crypto HMAC for manifest-sized JSON payload', () => {
    const key = 'manifest-signing-key';
    const payload = JSON.stringify({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      generatedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2027-06-02T00:00:00.000Z',
      keyId: 'manifest:v1',
      tickets: [
        { ticketId: 'tkt_1', ticketTypeId: 'tt_1', attendeeName: 'Ada Lovelace', qrHash: 'hash_1', status: 'valid' },
      ],
    });
    const expected = createHmac('sha256', key).update(payload).digest();
    const actual = hmacSha256(key, payload);
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });
});
