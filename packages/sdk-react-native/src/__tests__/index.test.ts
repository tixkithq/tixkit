import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  TixkitScannerClient,
  TixkitPublicEventPageClient,
  checkoutHandoffUrl,
  clearScannerCredentials,
  createTixkitReactNativeComponents,
  createTixkitSecureStorage,
  extractBarcodePayload,
  hmacSha256,
  loadScannerCredentials,
  qrHashForPayload,
  saveScannerCredentials,
  scanBarcodePayload,
  sha256,
} from '../index.js';

type RenderNode = {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
};

const SIGNING_KEY = 'test-manifest-signing-key';

function makeClient(overrides: Partial<{ apiBaseUrl: string; manifestSigningKey: string }> = {}) {
  return new TixkitScannerClient({
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

function createReactNativeRuntime() {
  return {
    createElement: vi.fn(
      (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
        type,
        props,
        children,
      }),
    ),
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    CameraView: 'CameraView',
    ActivityIndicator: 'ActivityIndicator',
  };
}

function textValues(node: RenderNode): string[] {
  return node.children.flatMap((child) => {
    if (typeof child === 'string') return [child];
    if (child && typeof child === 'object' && 'children' in child) {
      return textValues(child as RenderNode);
    }
    return [];
  });
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

describe('TixkitScannerClient', () => {
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
    const first = new TixkitScannerClient({
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
      'tixkit:scanner:sd_public_1:offline-scans',
      JSON.stringify([['hash_1', '2026-06-01T12:00:00.000Z']]),
    );

    const second = new TixkitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
      manifestSigningKey: SIGNING_KEY,
      storage,
    });
    await second.restoreOfflineScans();
    expect(store.get('tixkit:scanner:sd_public_1:offline-scans')).toContain('hash_1');
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
        new Response(
          JSON.stringify({
            accepted: 0,
            duplicates: 1,
            invalid: 0,
            results: [{ qrHash: 'hash_1', outcome: 'duplicate' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accepted: 0,
            duplicates: 1,
            invalid: 0,
            results: [{ qrHash: 'hash_1', outcome: 'duplicate' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    const client = new TixkitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
      manifestSigningKey: SIGNING_KEY,
      onSyncConflict: conflict,
    });

    await client.downloadManifest('evt_1', 'cil_1');
    client.scanOffline('hash_1');
    await client.syncScans();
    await client.syncScans();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(conflict).toHaveBeenCalledTimes(2);
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

  it('builds hosted checkout handoff URLs for React Native linking', () => {
    const url = checkoutHandoffUrl({
      checkoutBaseUrl: 'https://checkout.example.test',
      eventId: 'evt_1',
      brandId: 'brd_1',
      items: [
        { ticketTypeId: 'tt_1', quantity: 2 },
        { productId: 'prod_1', quantity: 1 },
        { ticketTypeId: 'tt_invalid', quantity: 0 },
      ],
      products: ['prod_2'],
      discountCode: 'SAVE20',
      accessCode: 'VIP',
      trackingId: 'campaign_1',
      affiliateCode: 'AFF1',
      locale: 'en',
      theme: 'dark',
      mode: 'redirect',
      successUrl: 'myapp://checkout/success',
      cancelUrl: 'myapp://checkout/cancel',
    });

    expect(url).toBe(
      'https://checkout.example.test/checkout?eventId=evt_1&brand=brd_1&items=tt_1%3D2%2Cprod_1%3D1&products=prod_2&discount=SAVE20&accessCode=VIP&tracking=campaign_1&affiliate=AFF1&locale=en&theme=dark&mode=redirect&successUrl=myapp%3A%2F%2Fcheckout%2Fsuccess&cancelUrl=myapp%3A%2F%2Fcheckout%2Fcancel',
    );
  });

  it('opens hosted checkout through a React Native Linking-compatible adapter', async () => {
    const openURL = vi.fn(async () => undefined);
    const client = new TixkitScannerClient({
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      apiBaseUrl: 'https://api.test',
      checkoutBaseUrl: 'https://checkout.example.test',
      manifestSigningKey: SIGNING_KEY,
    });

    await expect(
      client.openCheckout({
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        openURL,
      }),
    ).resolves.toBe('https://checkout.example.test/checkout?eventId=evt_1&items=tt_1%3D1');
    expect(openURL).toHaveBeenCalledWith(
      'https://checkout.example.test/checkout?eventId=evt_1&items=tt_1%3D1',
    );
  });

  it('fetches public event-page content without scanner or API-key headers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/discovery-card')) {
        return new Response(
          JSON.stringify({
            title: 'All Access',
            summary: 'Chicago',
            tags: ['music'],
            venueName: 'The Salt Shed',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          document: {
            eventId: 'evt_1',
            channel: 'event_page',
            key: 'main',
            name: 'Main event page',
            locale: 'en',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
          version: {
            versionNumber: 3,
            renderedHtml: '<main class="tixkit-event-page">All Access</main>',
            renderedText: 'All Access',
            publishedAt: '2026-06-02T00:00:00.000Z',
          },
          page: {
            html: '<main>All Access</main>',
            text: 'All Access',
            headless: [{ type: 'hero', id: 'hero', title: 'All Access' }],
            discovery: {
              title: 'All Access',
              summary: 'Chicago',
              tags: ['music'],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new TixkitPublicEventPageClient({ apiBaseUrl: 'https://api.test' });

    await expect(client.getContentPage('evt_1', { locale: 'en' })).resolves.toMatchObject({
      document: { eventId: 'evt_1' },
    });
    await client.getEventPage('evt_1', { locale: 'en' });
    await client.getEventPageBySlug('all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    await expect(client.getEventDiscoveryCard('evt_1')).resolves.toMatchObject({
      title: 'All Access',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.test/v1/public/events/evt_1/content-page?locale=en',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://api.test/v1/public/events/evt_1/page?locale=en',
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      'https://api.test/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en',
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      'https://api.test/v1/public/events/evt_1/discovery-card',
    );
    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers['X-Device-Id']).toBeUndefined();
      expect(headers['X-Device-Secret']).toBeUndefined();
    }
  });

  it('hashes scanned QR payloads with the same SHA-256 contract as offline manifests', () => {
    const payload = 'signed-ticket-payload';
    const expected = createHash('sha256').update(payload).digest('hex');

    expect(qrHashForPayload(payload)).toBe(expected);
  });

  it('extracts barcode payloads from common React Native camera event shapes', () => {
    expect(extractBarcodePayload(' signed ')).toBe('signed');
    expect(extractBarcodePayload({ data: 'camera-data' })).toBe('camera-data');
    expect(extractBarcodePayload({ rawValue: 'raw-value' })).toBe('raw-value');
    expect(extractBarcodePayload({ nativeEvent: { codeStringValue: 'ios-code' } })).toBe(
      'ios-code',
    );
    expect(extractBarcodePayload({ nativeEvent: { data: 'native-data' } })).toBe('native-data');
    expect(extractBarcodePayload({ data: '   ' })).toBeNull();
  });

  it('routes scan payloads online by default', async () => {
    const client = makeClient();
    const scanOnline = vi
      .spyOn(client, 'scanOnline')
      .mockResolvedValue({ outcome: 'accepted', message: 'ok' });
    const scanOffline = vi.spyOn(client, 'scanOffline');

    await expect(
      scanBarcodePayload({
        client,
        checkInListId: 'cil_1',
        qrPayload: 'signed-ticket-payload',
      }),
    ).resolves.toEqual({ outcome: 'accepted', message: 'ok' });

    expect(scanOnline).toHaveBeenCalledWith('cil_1', 'signed-ticket-payload');
    expect(scanOffline).not.toHaveBeenCalled();
  });

  it('routes scan payloads offline using QR hashes', async () => {
    const client = makeClient();
    const scanOffline = vi
      .spyOn(client, 'scanOffline')
      .mockReturnValue({ outcome: 'accepted', message: 'offline' });

    await expect(
      scanBarcodePayload({
        client,
        checkInListId: 'cil_1',
        qrPayload: 'signed-ticket-payload',
        mode: 'offline',
        qrHashFromPayload: () => 'hash_1',
      }),
    ).resolves.toEqual({ outcome: 'accepted', message: 'offline' });

    expect(scanOffline).toHaveBeenCalledWith('hash_1');
  });

  it('falls back to offline scans in auto mode when online scan fails', async () => {
    const client = makeClient();
    vi.spyOn(client, 'scanOnline').mockRejectedValue(new Error('network unavailable'));
    const scanOffline = vi
      .spyOn(client, 'scanOffline')
      .mockReturnValue({ outcome: 'accepted', message: 'offline' });

    await expect(
      scanBarcodePayload({
        client,
        checkInListId: 'cil_1',
        qrPayload: 'signed-ticket-payload',
        mode: 'auto',
        qrHashFromPayload: () => 'hash_1',
      }),
    ).resolves.toEqual({ outcome: 'accepted', message: 'offline' });

    expect(scanOffline).toHaveBeenCalledWith('hash_1');
  });
});

describe('Tixkit secure storage helpers', () => {
  it('wraps Keychain or Keystore-style adapters for scanner storage', async () => {
    const secureStore = new Map<string, string>();
    const adapter = {
      getItem: vi.fn((key: string) => secureStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        secureStore.set(key, value);
      }),
      deleteItem: vi.fn((key: string) => {
        secureStore.delete(key);
      }),
    };
    const storage = createTixkitSecureStorage(adapter, { keyPrefix: 'tixkit-secure' });

    await storage.setItem('scanner:manifest', 'encrypted-manifest-json');
    expect(await storage.getItem('scanner:manifest')).toBe('encrypted-manifest-json');
    await storage.removeItem('scanner:manifest');

    expect(adapter.setItem).toHaveBeenCalledWith(
      'tixkit-secure:scanner:manifest',
      'encrypted-manifest-json',
    );
    expect(adapter.getItem).toHaveBeenCalledWith('tixkit-secure:scanner:manifest');
    expect(adapter.deleteItem).toHaveBeenCalledWith('tixkit-secure:scanner:manifest');
    expect(secureStore.has('tixkit-secure:scanner:manifest')).toBe(false);
  });

  it('saves, loads, and clears scanner credentials through secure storage', async () => {
    const { storage, store } = createMemoryStorage();
    const secureStorage = createTixkitSecureStorage(storage);
    const credentials = {
      deviceId: 'sd_public_1',
      deviceSecret: 'scanner-secret',
      manifestSigningKey: SIGNING_KEY,
      apiBaseUrl: 'https://api.test',
      checkoutBaseUrl: 'https://checkout.test',
    };

    await saveScannerCredentials(secureStorage, credentials);
    await expect(loadScannerCredentials(secureStorage)).resolves.toEqual(credentials);

    expect(store.get('tixkit:scanner:credentials')).toBe(JSON.stringify(credentials));

    await clearScannerCredentials(secureStorage);
    await expect(loadScannerCredentials(secureStorage)).resolves.toBeNull();
  });

  it('ignores malformed scanner credentials in secure storage', async () => {
    const { storage } = createMemoryStorage({
      'tixkit:scanner:credentials': JSON.stringify({ deviceId: 'sd_public_1' }),
    });

    await expect(loadScannerCredentials(createTixkitSecureStorage(storage))).resolves.toBeNull();
  });
});

describe('Tixkit React Native component adapters', () => {
  it('renders ticket cards with stable display fields and press handling', () => {
    const runtime = createReactNativeRuntime();
    const components = createTixkitReactNativeComponents(runtime);
    const onPress = vi.fn();

    const card = components.TixkitTicketCard({
      title: 'Admission',
      testID: 'ticket-card',
      onPress,
      ticket: {
        ticketId: 'tkt_1',
        ticketTypeId: 'vip',
        attendeeName: 'Ada Lovelace',
        status: 'checked_in',
      },
    }) as RenderNode;

    expect(card.type).toBe('Pressable');
    expect(card.props).toMatchObject({ testID: 'ticket-card' });
    expect(textValues(card)).toEqual([
      'Admission',
      'Ada Lovelace',
      'Ticket tkt_1',
      'Type vip',
      'Checked In',
    ]);

    const cardProps = card.props;
    expect(cardProps?.onPress).toEqual(expect.any(Function));
    (cardProps!.onPress as () => void)();
    expect(onPress).toHaveBeenCalledWith({
      ticketId: 'tkt_1',
      ticketTypeId: 'vip',
      attendeeName: 'Ada Lovelace',
      status: 'checked_in',
    });
  });

  it('renders scanner status with manifest, result, offline count, and sync action', () => {
    const runtime = createReactNativeRuntime();
    const components = createTixkitReactNativeComponents(runtime);
    const onSync = vi.fn();

    const status = components.TixkitScannerStatus({
      testID: 'scanner-status',
      result: {
        outcome: 'wrong_event',
        ticketId: 'tkt_2',
        message: 'Ticket belongs to another event',
      },
      manifest: {
        eventId: 'evt_1',
        checkInListId: 'cil_1',
        expiresAt: '2027-06-02T00:00:00.000Z',
      },
      offlineScanCount: 3,
      onSync,
    }) as RenderNode;

    expect(status.type).toBe('View');
    expect(status.props).toMatchObject({ testID: 'scanner-status' });
    expect(textValues(status)).toEqual([
      'Wrong Event',
      'Ticket belongs to another event',
      'Event evt_1',
      'List cil_1',
      'Expires 2027-06-02T00:00:00.000Z',
      'Offline scans 3',
      'Sync',
    ]);

    const syncAction = status.children.find((child) => {
      return Boolean(
        child && typeof child === 'object' && (child as RenderNode).props?.key === 'sync',
      );
    }) as RenderNode | undefined;
    expect(syncAction).toBeDefined();
    expect(syncAction?.type).toBe('Pressable');
    expect(syncAction?.props?.onPress).toEqual(expect.any(Function));
    (syncAction!.props!.onPress as () => void)();
    expect(onSync).toHaveBeenCalledOnce();
  });

  it('renders a camera scanner component that calls online scan handlers from camera events', async () => {
    const runtime = createReactNativeRuntime();
    const components = createTixkitReactNativeComponents(runtime);
    const client = makeClient();
    const onResult = vi.fn();
    const scanOnline = vi
      .spyOn(client, 'scanOnline')
      .mockResolvedValue({ outcome: 'accepted', message: 'ok' });

    const scanner = components.TixkitCameraScanner({
      client,
      checkInListId: 'cil_1',
      cameraPermission: 'granted',
      testID: 'camera-scanner',
      onResult,
    }) as RenderNode;
    const camera = scanner.children.find((child) => {
      return Boolean(
        child && typeof child === 'object' && (child as RenderNode).type === 'CameraView',
      );
    }) as RenderNode | undefined;

    expect(scanner.type).toBe('View');
    expect(scanner.props).toMatchObject({ testID: 'camera-scanner' });
    expect(camera?.props).toMatchObject({
      testID: 'camera-scanner-camera',
      barcodeScannerSettings: { barcodeTypes: ['qr'] },
    });

    await (camera!.props!.onBarcodeScanned as (event: unknown) => Promise<void>)({
      data: 'signed-ticket-payload',
    });

    expect(scanOnline).toHaveBeenCalledWith('cil_1', 'signed-ticket-payload');
    expect(onResult).toHaveBeenCalledWith({ outcome: 'accepted', message: 'ok' });
  });

  it('throttles duplicate camera reads inside the configured scan window', async () => {
    const runtime = createReactNativeRuntime();
    const components = createTixkitReactNativeComponents(runtime);
    const client = makeClient();
    const scanOnline = vi
      .spyOn(client, 'scanOnline')
      .mockResolvedValue({ outcome: 'accepted', message: 'ok' });
    let now = 1_000;

    const scanner = components.TixkitCameraScanner({
      client,
      checkInListId: 'cil_1',
      cameraPermission: 'granted',
      throttleMs: 2_000,
      now: () => now,
    }) as RenderNode;
    const camera = scanner.children.find((child) => {
      return Boolean(
        child && typeof child === 'object' && (child as RenderNode).type === 'CameraView',
      );
    }) as RenderNode;
    const onBarcodeScanned = camera.props!.onBarcodeScanned as (event: unknown) => Promise<void>;

    await onBarcodeScanned({ data: 'same-payload' });
    now = 2_000;
    await onBarcodeScanned({ data: 'same-payload' });
    now = 3_500;
    await onBarcodeScanned({ data: 'same-payload' });

    expect(scanOnline).toHaveBeenCalledTimes(2);
  });

  it('renders permission recovery UI before camera access is granted', () => {
    const runtime = createReactNativeRuntime();
    const components = createTixkitReactNativeComponents(runtime);
    const requestPermission = vi.fn();

    const scanner = components.TixkitCameraScanner({
      client: makeClient(),
      checkInListId: 'cil_1',
      cameraPermission: 'denied',
      testID: 'camera-scanner',
      onRequestPermission: requestPermission,
    }) as RenderNode;

    expect(scanner.type).toBe('View');
    expect(textValues(scanner)).toEqual(['Camera permission denied', 'Allow camera']);
    const action = scanner.children.find((child) => {
      return Boolean(
        child &&
        typeof child === 'object' &&
        (child as RenderNode).props?.key === 'permissionAction',
      );
    }) as RenderNode | undefined;
    expect(action?.type).toBe('Pressable');
    (action!.props!.onPress as () => void)();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('surfaces manual scanner sync results from the camera component', async () => {
    const runtime = createReactNativeRuntime();
    const components = createTixkitReactNativeComponents(runtime);
    const onSync = vi.fn(async () => ({ accepted: 1, duplicates: 0, invalid: 0, results: [] }));
    const onSyncResult = vi.fn();

    const scanner = components.TixkitCameraScanner({
      client: makeClient(),
      checkInListId: 'cil_1',
      cameraPermission: 'granted',
      onSync,
      onSyncResult,
    }) as RenderNode;
    const syncAction = scanner.children.find((child) => {
      return Boolean(
        child && typeof child === 'object' && (child as RenderNode).props?.key === 'sync',
      );
    }) as RenderNode | undefined;

    await (syncAction!.props!.onPress as () => Promise<void>)();

    expect(onSync).toHaveBeenCalledWith({ checkInListId: 'cil_1', trigger: 'manual' });
    expect(onSyncResult).toHaveBeenCalledWith({
      accepted: 1,
      duplicates: 0,
      invalid: 0,
      results: [],
    });
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
        {
          ticketId: 'tkt_1',
          ticketTypeId: 'tt_1',
          attendeeName: 'Ada Lovelace',
          qrHash: 'hash_1',
          status: 'valid',
        },
      ],
    });
    const expected = createHmac('sha256', key).update(payload).digest();
    const actual = hmacSha256(key, payload);
    expect(Array.from(actual)).toEqual(Array.from(expected));
  });
});
