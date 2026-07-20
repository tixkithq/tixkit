import {
  TixkitClient,
  type EventPageDocumentV2,
  type PuckComponentData,
  type PuckData,
  type PuckRootData,
  type PublicContentPage,
  type PublicEventDiscoveryCard,
  type PublicTicketListing,
  type PageResult,
  type ResaleSettlement,
  type ResaleSettlementMethod,
  type ResaleTermsAcceptance,
  type TicketListing,
} from '@tixkit/js';

export const TIXKIT_API_VERSION = '2026-08-23';

// NOTE: React Native does not provide Node.js `crypto` APIs by default.
// The following is a pure-JS HMAC-SHA256 implementation so the SDK works
// without a `node:crypto` polyfill. If you already have a `react-native-get-random-values`
// or `crypto` polyfill installed, you can replace these with the native imports.

// --- Pure JS SHA-256 ---
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // Pre-processing: padding
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  // Append length as 64-bit big-endian (we only use the low 32 bits)
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(7, w[i - 15]) ^ rotr(18, w[i - 15]) ^ (w[i - 15] >>> 3);
      const s1 = rotr(17, w[i - 2]) ^ rotr(19, w[i - 2]) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4],
      f = h[5],
      g = h[6],
      hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const result = new Uint8Array(32);
  const rdv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) {
    rdv.setUint32(i * 4, h[i], false);
  }
  return result;
}

function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const msgBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;

  // If key is longer than block size, hash it
  let k = keyBytes;
  if (k.length > 64) {
    k = sha256(k);
  }

  // Pad key to block size
  const blockKey = new Uint8Array(64);
  blockKey.set(k);

  // ipad and opad
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = blockKey[i] ^ 0x36;
    opad[i] = blockKey[i] ^ 0x5c;
  }

  // inner = sha256(ipad + message)
  const inner = new Uint8Array(64 + msgBytes.length);
  inner.set(ipad);
  inner.set(msgBytes, 64);
  const innerHash = sha256(inner);

  // outer = sha256(opad + innerHash)
  const outer = new Uint8Array(64 + 32);
  outer.set(opad);
  outer.set(innerHash, 64);
  return sha256(outer);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function qrHashForPayload(qrPayload: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(qrPayload)));
}

// Constant-time comparison in pure JS. A polyfill for timingSafeEqual is not
// guaranteed in React Native, so we implement a constant-time compare here.
function timingSafeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export type OfflineManifest = {
  eventId: string;
  checkInListId: string;
  generatedAt: string;
  expiresAt: string;
  keyId: string;
  signature: string;
  tickets: {
    ticketId: string;
    ticketTypeId: string;
    eventOccurrenceId?: string;
    attendeeName: string;
    qrHash: string;
    status: string;
  }[];
};

export type ScanResult = {
  outcome:
    | 'accepted'
    | 'duplicate'
    | 'invalid'
    | 'revoked'
    | 'not_found'
    | 'wrong_event'
    | 'wrong_list';
  ticketId?: string;
  message: string;
};

export type SyncResult = {
  accepted: number;
  duplicates: number;
  invalid: number;
  results: { qrHash: string; outcome: string }[];
};

export type TixkitScannerStorage = {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
};

type PersistedScannerState = {
  version: 1;
  deviceId: string;
  eventId: string;
  checkInListId: string;
  expiresAt: string;
  manifest: OfflineManifest;
  offlineScans: [string, string][];
};

export type TixkitSecureStorageAdapter = {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem?: (key: string) => Promise<void> | void;
  deleteItem?: (key: string) => Promise<void> | void;
};

export type TixkitScannerCredentials = {
  deviceId: string;
  deviceSecret: string;
  manifestSigningKey: string;
  apiBaseUrl?: string;
  checkoutBaseUrl?: string;
};

export type TixkitSecureStorageOptions = {
  keyPrefix?: string;
};

export type TixkitCheckoutHandoffItem = {
  ticketTypeId?: string;
  productId?: string;
  resaleListingId?: string;
  quantity: number;
};

export type TixkitCheckoutHandoffOptions = {
  checkoutBaseUrl?: string;
  eventId: string;
  brandId?: string;
  items?: TixkitCheckoutHandoffItem[];
  products?: string[];
  discountCode?: string;
  accessCode?: string;
  trackingId?: string;
  affiliateCode?: string;
  locale?: string;
  theme?: string;
  mode?: 'inline' | 'modal' | 'redirect';
  successUrl?: string;
  cancelUrl?: string;
};

export type TixkitCheckoutOpenOptions = TixkitCheckoutHandoffOptions & {
  openURL: (url: string) => Promise<unknown> | unknown;
};

export type TixkitPublicEventPageClientConfig = {
  apiBaseUrl?: string;
};

export type TixkitResaleClientConfig = {
  apiBaseUrl?: string;
  apiKey?: string;
};

export type PublicEventPageParams = {
  locale?: string;
};

export type PublicEventPageBySlugParams = {
  host: string;
  locale?: string;
};

export type {
  EventPageDocumentV2,
  PuckComponentData,
  PuckData,
  PuckRootData,
  PublicContentPage,
  PublicEventDiscoveryCard,
};
export type { PublicTicketListing };

export type { ResaleSettlement, ResaleSettlementMethod, ResaleTermsAcceptance, TicketListing };

export type TixkitResaleListParams = {
  cursor?: string;
  limit?: number;
};

export type TixkitCreateResaleListingInput = {
  priceCents: number;
  expiresAt?: string;
  termsAcceptance: ResaleTermsAcceptance;
  idempotencyKey: string;
};

export type TixkitCreateCheckoutResaleListingInput = TixkitCreateResaleListingInput & {
  clientToken: string;
};

export type TixkitRecordResaleSettlementPayoutInput = {
  amountCents: number;
  currency: string;
  expectedVersion: number;
  method: ResaleSettlementMethod;
  externalReference: string;
  idempotencyKey: string;
};

export type TixkitRecordResaleSettlementReversalInput = {
  amountCents: number;
  currency: string;
  expectedVersion: number;
  method: ResaleSettlementMethod;
  reason: string;
  idempotencyKey: string;
};

export type TixkitCreateElement = (
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) => unknown;

export type TixkitReactNativeRuntime = {
  createElement: TixkitCreateElement;
  View: unknown;
  Text: unknown;
  Pressable?: unknown;
  CameraView?: unknown;
  ActivityIndicator?: unknown;
};

export type TixkitTicketDisplay = {
  ticketId: string;
  ticketTypeId?: string;
  attendeeName?: string;
  status: string;
};

export type TixkitTicketDisplayProps = {
  ticket: TixkitTicketDisplay;
  title?: string;
  onPress?: (ticket: TixkitTicketDisplay) => void;
  testID?: string;
};

export type TixkitScannerStatusProps = {
  result?: ScanResult;
  manifest?: Pick<OfflineManifest, 'eventId' | 'checkInListId' | 'expiresAt'>;
  offlineScanCount?: number;
  onSync?: () => void;
  testID?: string;
};

export type TixkitCameraPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';
export type TixkitScannerMode = 'online' | 'offline' | 'auto';

export type TixkitBarcodeScanEvent =
  | string
  | {
      data?: string;
      rawValue?: string;
      value?: string;
      nativeEvent?: {
        data?: string;
        rawValue?: string;
        value?: string;
        codeStringValue?: string;
      };
    };

export type TixkitScannerSyncRequest = {
  checkInListId: string;
  trigger: 'manual' | 'offline_accepted';
};

export type TixkitCameraScannerProps = {
  client: TixkitScannerClient;
  checkInListId: string;
  mode?: TixkitScannerMode;
  disabled?: boolean;
  cameraPermission?: TixkitCameraPermissionState;
  barcodeTypes?: string[];
  throttleMs?: number;
  testID?: string;
  cameraProps?: Record<string, unknown>;
  now?: () => number;
  qrHashFromPayload?: (qrPayload: string) => string;
  onRequestPermission?: () => Promise<boolean> | boolean;
  onResult?: (result: ScanResult) => void;
  onError?: (error: Error) => void;
  onSync?: (request: TixkitScannerSyncRequest) => Promise<SyncResult> | SyncResult;
  onSyncResult?: (result: SyncResult) => void;
  syncAfterOfflineAccepted?: boolean;
  renderOverlay?: (state: {
    disabled: boolean;
    mode: TixkitScannerMode;
    permission: TixkitCameraPermissionState;
  }) => unknown;
};

export type TixkitReactNativeComponents = {
  TixkitTicketCard(props: TixkitTicketDisplayProps): unknown;
  TixkitScannerStatus(props: TixkitScannerStatusProps): unknown;
  TixkitCameraScanner(props: TixkitCameraScannerProps): unknown;
};

export type TixkitBarcodeScanOptions = {
  client: TixkitScannerClient;
  checkInListId: string;
  qrPayload: string;
  idempotencyKey: string;
  scannedAt: string;
  mode?: TixkitScannerMode;
  qrHashFromPayload?: (qrPayload: string) => string;
};

export type TixkitScannerConflict = {
  qrHash: string;
  outcome: string;
};

export type TixkitScannerClientConfig = {
  deviceId: string;
  deviceSecret: string;
  apiBaseUrl?: string;
  checkoutBaseUrl?: string;
  manifestSigningKey: string;
  storage?: TixkitScannerStorage;
  storageKey?: string;
  onSyncConflict?: (conflict: TixkitScannerConflict) => void;
};

const DEFAULT_SECURE_STORAGE_PREFIX = 'tixkit';
const DEFAULT_SCANNER_CREDENTIALS_KEY = 'scanner:credentials';

function secureStorageKey(key: string, keyPrefix = DEFAULT_SECURE_STORAGE_PREFIX): string {
  return key.startsWith(`${keyPrefix}:`) ? key : `${keyPrefix}:${key}`;
}

export function createTixkitSecureStorage(
  adapter: TixkitSecureStorageAdapter,
  options: TixkitSecureStorageOptions = {},
): TixkitScannerStorage {
  const keyPrefix = options.keyPrefix ?? DEFAULT_SECURE_STORAGE_PREFIX;
  return {
    getItem: (key) => adapter.getItem(secureStorageKey(key, keyPrefix)),
    setItem: (key, value) => adapter.setItem(secureStorageKey(key, keyPrefix), value),
    removeItem: (key) => {
      const resolvedKey = secureStorageKey(key, keyPrefix);
      if (adapter.removeItem) return adapter.removeItem(resolvedKey);
      if (adapter.deleteItem) return adapter.deleteItem(resolvedKey);
      return adapter.setItem(resolvedKey, '');
    },
  };
}

function assertScannerCredentials(value: unknown): TixkitScannerCredentials | null {
  if (!value || typeof value !== 'object') return null;
  const credentials = value as Partial<Record<keyof TixkitScannerCredentials, unknown>>;
  if (
    typeof credentials.deviceId !== 'string' ||
    typeof credentials.deviceSecret !== 'string' ||
    typeof credentials.manifestSigningKey !== 'string'
  ) {
    return null;
  }
  return {
    deviceId: credentials.deviceId,
    deviceSecret: credentials.deviceSecret,
    manifestSigningKey: credentials.manifestSigningKey,
    apiBaseUrl: typeof credentials.apiBaseUrl === 'string' ? credentials.apiBaseUrl : undefined,
    checkoutBaseUrl:
      typeof credentials.checkoutBaseUrl === 'string' ? credentials.checkoutBaseUrl : undefined,
  };
}

export async function saveScannerCredentials(
  storage: TixkitScannerStorage,
  credentials: TixkitScannerCredentials,
  key = DEFAULT_SCANNER_CREDENTIALS_KEY,
): Promise<void> {
  await storage.setItem(key, JSON.stringify(credentials));
}

export async function loadScannerCredentials(
  storage: TixkitScannerStorage,
  key = DEFAULT_SCANNER_CREDENTIALS_KEY,
): Promise<TixkitScannerCredentials | null> {
  const raw = await storage.getItem(key);
  if (!raw) return null;
  try {
    return assertScannerCredentials(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearScannerCredentials(
  storage: TixkitScannerStorage,
  key = DEFAULT_SCANNER_CREDENTIALS_KEY,
): Promise<void> {
  await storage.removeItem(key);
}

function statusLabel(status: string): string {
  return (
    status
      .split('_')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Unknown'
  );
}

export function extractBarcodePayload(event: TixkitBarcodeScanEvent): string | null {
  if (typeof event === 'string') return event.trim() || null;

  const payload =
    event.data ??
    event.rawValue ??
    event.value ??
    event.nativeEvent?.data ??
    event.nativeEvent?.rawValue ??
    event.nativeEvent?.value ??
    event.nativeEvent?.codeStringValue;

  return typeof payload === 'string' && payload.trim().length > 0 ? payload.trim() : null;
}

export async function scanBarcodePayload(options: TixkitBarcodeScanOptions): Promise<ScanResult> {
  const mode = options.mode ?? 'online';
  if (mode === 'offline') {
    return options.client.scanOffline(
      (options.qrHashFromPayload ?? qrHashForPayload)(options.qrPayload),
    );
  }

  try {
    return await options.client.scanOnline(
      options.checkInListId,
      options.qrPayload,
      options.idempotencyKey,
      options.scannedAt,
    );
  } catch (error) {
    if (mode !== 'auto') throw error;
    return options.client.scanOffline(
      (options.qrHashFromPayload ?? qrHashForPayload)(options.qrPayload),
    );
  }
}

export function createTixkitReactNativeComponents(
  runtime: TixkitReactNativeRuntime,
): TixkitReactNativeComponents {
  const { createElement, View, Text, Pressable, CameraView, ActivityIndicator } = runtime;

  function text(value: string, key: string): unknown {
    return createElement(Text, { key }, value);
  }

  function TixkitTicketCard(props: TixkitTicketDisplayProps): unknown {
    const body = [
      text(props.title ?? 'Ticket', 'title'),
      text(props.ticket.attendeeName ?? 'Guest', 'attendeeName'),
      text(`Ticket ${props.ticket.ticketId}`, 'ticketId'),
      text(statusLabel(props.ticket.status), 'status'),
    ];
    if (props.ticket.ticketTypeId) {
      body.splice(3, 0, text(`Type ${props.ticket.ticketTypeId}`, 'ticketTypeId'));
    }

    if (props.onPress && Pressable) {
      return createElement(
        Pressable,
        { testID: props.testID, onPress: () => props.onPress?.(props.ticket) },
        ...body,
      );
    }

    return createElement(View, { testID: props.testID }, ...body);
  }

  function TixkitScannerStatus(props: TixkitScannerStatusProps): unknown {
    const body = [
      text(props.result ? statusLabel(props.result.outcome) : 'Ready to scan', 'status'),
      text(props.result?.message ?? 'Download a manifest for offline scanning.', 'message'),
    ];
    if (props.manifest) {
      body.push(text(`Event ${props.manifest.eventId}`, 'eventId'));
      body.push(text(`List ${props.manifest.checkInListId}`, 'checkInListId'));
      body.push(text(`Expires ${props.manifest.expiresAt}`, 'expiresAt'));
    }
    if (props.offlineScanCount !== undefined) {
      body.push(text(`Offline scans ${props.offlineScanCount}`, 'offlineScanCount'));
    }
    if (props.onSync && Pressable) {
      body.push(
        createElement(Pressable, { key: 'sync', onPress: props.onSync }, text('Sync', 'syncText')),
      );
    }
    return createElement(View, { testID: props.testID }, ...body);
  }

  function TixkitCameraScanner(props: TixkitCameraScannerProps): unknown {
    const mode = props.mode ?? 'online';
    const permission = props.cameraPermission ?? 'unknown';
    const disabled = Boolean(props.disabled);
    const throttleMs = props.throttleMs ?? 1_500;
    const barcodeTypes = props.barcodeTypes ?? ['qr'];
    let inFlight = false;
    let lastPayload = '';
    let lastScanAt = 0;

    async function sync(trigger: TixkitScannerSyncRequest['trigger']): Promise<void> {
      if (!props.onSync) return;
      try {
        const result = await props.onSync({
          checkInListId: props.checkInListId,
          trigger,
        });
        props.onSyncResult?.(result);
      } catch (error) {
        props.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }

    async function onBarcodeScanned(event: TixkitBarcodeScanEvent): Promise<void> {
      if (disabled || inFlight) return;
      const qrPayload = extractBarcodePayload(event);
      if (!qrPayload) return;

      const now = props.now?.() ?? Date.now();
      if (qrPayload === lastPayload && now - lastScanAt < throttleMs) return;
      lastPayload = qrPayload;
      lastScanAt = now;
      inFlight = true;
      const scannedAt = new Date(now).toISOString();
      const idempotencyKey = `scan:${props.checkInListId}:${now}:${(props.qrHashFromPayload ?? qrHashForPayload)(qrPayload).slice(0, 32)}`;

      try {
        const result = await scanBarcodePayload({
          client: props.client,
          checkInListId: props.checkInListId,
          qrPayload,
          idempotencyKey,
          scannedAt,
          mode,
          qrHashFromPayload: props.qrHashFromPayload,
        });
        props.onResult?.(result);
        if (props.syncAfterOfflineAccepted && mode !== 'online' && result.outcome === 'accepted') {
          await sync('offline_accepted');
        }
      } catch (error) {
        props.onError?.(error instanceof Error ? error : new Error(String(error)));
      } finally {
        inFlight = false;
      }
    }

    if (permission !== 'granted') {
      const body = [
        text(
          permission === 'denied' ? 'Camera permission denied' : 'Camera permission required',
          'permission',
        ),
      ];
      if (props.onRequestPermission && Pressable) {
        body.push(
          createElement(
            Pressable,
            { key: 'permissionAction', onPress: props.onRequestPermission },
            text('Allow camera', 'permissionActionText'),
          ),
        );
      }
      return createElement(View, { testID: props.testID }, ...body);
    }

    if (!CameraView) {
      return createElement(
        View,
        { testID: props.testID },
        text('Camera view adapter is required', 'missingCamera'),
      );
    }

    const camera = createElement(CameraView, {
      ...props.cameraProps,
      key: 'camera',
      testID: props.testID ? `${props.testID}-camera` : undefined,
      barcodeScannerSettings: { barcodeTypes },
      onBarcodeScanned: disabled ? undefined : onBarcodeScanned,
    });
    const body = [camera, text(disabled ? 'Scanner paused' : `Scanner ready (${mode})`, 'status')];
    if (disabled && ActivityIndicator) {
      body.push(createElement(ActivityIndicator, { key: 'activity', animating: false }));
    }
    const overlay = props.renderOverlay?.({ disabled, mode, permission });
    if (overlay !== undefined && overlay !== null) body.push(overlay);
    if (props.onSync && Pressable) {
      body.push(
        createElement(
          Pressable,
          { key: 'sync', onPress: () => sync('manual') },
          text('Sync', 'syncText'),
        ),
      );
    }
    return createElement(View, { testID: props.testID }, ...body);
  }

  return { TixkitTicketCard, TixkitScannerStatus, TixkitCameraScanner };
}

function encodeCheckoutItems(items: TixkitCheckoutHandoffItem[] | undefined): string | undefined {
  if (!items?.length) return undefined;
  const encoded = items
    .map((item) => {
      if (item.resaleListingId) return null;
      const id = item.ticketTypeId ?? item.productId;
      if (!id || !Number.isInteger(item.quantity) || item.quantity <= 0) return null;
      return `${id}=${item.quantity}`;
    })
    .filter((item): item is string => Boolean(item));
  return encoded.length > 0 ? encoded.join(',') : undefined;
}

export function checkoutHandoffUrl(options: TixkitCheckoutHandoffOptions): string {
  const base = options.checkoutBaseUrl ?? 'https://checkout.tixkit.com';
  const url = new URL('/checkout', base);
  url.searchParams.set('eventId', options.eventId);
  if (options.brandId) url.searchParams.set('brand', options.brandId);
  const resaleListingId = options.items?.find((item) => item.resaleListingId)?.resaleListingId;
  if (resaleListingId) url.searchParams.set('resaleListing', resaleListingId);
  const items = encodeCheckoutItems(options.items);
  if (items) url.searchParams.set('items', items);
  if (options.products?.length) url.searchParams.set('products', options.products.join(','));
  if (options.discountCode) url.searchParams.set('discount', options.discountCode);
  if (options.accessCode) url.searchParams.set('accessCode', options.accessCode);
  if (options.trackingId) url.searchParams.set('tracking', options.trackingId);
  if (options.affiliateCode) url.searchParams.set('affiliate', options.affiliateCode);
  if (options.locale) url.searchParams.set('locale', options.locale);
  if (options.theme) url.searchParams.set('theme', options.theme);
  if (options.mode) url.searchParams.set('mode', options.mode);
  if (options.successUrl) url.searchParams.set('successUrl', options.successUrl);
  if (options.cancelUrl) url.searchParams.set('cancelUrl', options.cancelUrl);
  return url.toString();
}

export class TixkitPublicEventPageClient {
  private readonly client: TixkitClient;

  constructor(config: TixkitPublicEventPageClientConfig = {}) {
    this.client = new TixkitClient({ apiBaseUrl: config.apiBaseUrl });
  }

  async getEventPage(eventId: string, params?: PublicEventPageParams): Promise<PublicContentPage> {
    return this.client.public.getEventPage(eventId, params);
  }

  async getContentPage(
    eventId: string,
    params?: PublicEventPageParams,
  ): Promise<PublicContentPage> {
    return this.client.public.getContentPage(eventId, params);
  }

  async getEventPageBySlug(
    slug: string,
    params: PublicEventPageBySlugParams,
  ): Promise<PublicContentPage> {
    return this.client.public.getEventPageBySlug(slug, params);
  }

  async getEventDiscoveryCard(
    eventId: string,
    params?: PublicEventPageParams,
  ): Promise<PublicEventDiscoveryCard> {
    return this.client.public.getEventDiscoveryCard(eventId, params);
  }

  async listResaleListings(
    eventId: string,
    params?: TixkitResaleListParams,
  ): Promise<PageResult<PublicTicketListing>> {
    return this.client.public.listResaleListings(eventId, params);
  }
}

export class TixkitResaleClient {
  private readonly client: TixkitClient;

  constructor(config: TixkitResaleClientConfig = {}) {
    this.client = new TixkitClient({
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      apiVersion: TIXKIT_API_VERSION,
    });
  }

  async listResaleListings(
    eventId: string,
    params?: TixkitResaleListParams,
  ): Promise<PageResult<TicketListing>> {
    return this.client.events.listResaleListings(eventId, params);
  }

  async createTicketResaleListing(
    ticketId: string,
    input: TixkitCreateResaleListingInput,
  ): Promise<TicketListing> {
    return this.client.tickets.createResaleListing(ticketId, input);
  }

  async createCheckoutTicketResaleListing(
    sessionId: string,
    ticketId: string,
    input: TixkitCreateCheckoutResaleListingInput,
  ): Promise<TicketListing> {
    return this.client.checkout.createTicketResaleListing(sessionId, ticketId, input);
  }

  async delistResaleListing(
    listingId: string,
    input: { idempotencyKey: string },
  ): Promise<TicketListing> {
    return this.client.tickets.delistResaleListing(listingId, input);
  }

  async getResaleSettlement(listingId: string): Promise<ResaleSettlement> {
    return this.client.tickets.getResaleSettlement(listingId);
  }

  async recordResaleSettlementPayout(
    listingId: string,
    input: TixkitRecordResaleSettlementPayoutInput,
  ): Promise<ResaleSettlement> {
    return this.client.tickets.recordResaleSettlementPayout(listingId, input);
  }

  async recordResaleSettlementReversal(
    listingId: string,
    input: TixkitRecordResaleSettlementReversalInput,
  ): Promise<ResaleSettlement> {
    return this.client.tickets.recordResaleSettlementReversal(listingId, input);
  }
}

export class TixkitScannerClient {
  private client: TixkitClient;
  private readonly deviceId: string;
  private readonly deviceSecret: string;
  private readonly checkoutBaseUrl?: string;
  private readonly manifestSigningKey: string;
  private readonly storage?: TixkitScannerStorage;
  private readonly storageKey: string;
  private readonly onSyncConflict?: (conflict: TixkitScannerConflict) => void;
  private manifest: OfflineManifest | null = null;
  private offlineScans = new Map<string, string>();

  constructor(config: TixkitScannerClientConfig) {
    this.deviceId = config.deviceId;
    this.deviceSecret = config.deviceSecret;
    this.checkoutBaseUrl = config.checkoutBaseUrl;
    this.manifestSigningKey = config.manifestSigningKey;
    this.storage = config.storage;
    this.storageKey = config.storageKey ?? `tixkit:scanner:${config.deviceId}:offline-state`;
    this.onSyncConflict = config.onSyncConflict;
    this.client = new TixkitClient({ apiBaseUrl: config.apiBaseUrl });
  }

  /**
   * Downloads the offline check-in manifest for an event.
   * The manifest is signed by the server; the SDK verifies the signature
   * before storing it to prevent tampering.
   */
  async downloadManifest(eventId: string, checkInListId: string): Promise<OfflineManifest> {
    const manifest = await this.client.request<OfflineManifest>(
      'GET',
      `/events/${eventId}/check-in-lists/${checkInListId}/manifest`,
      {
        headers: this.authHeaders(),
      },
    );

    // Verify the manifest signature before use.
    if (!this.verifyManifestSignature(manifest)) {
      throw new Error('Offline manifest signature verification failed');
    }

    this.manifest = manifest;
    this.offlineScans.clear();
    await this.persistOfflineState();
    return manifest;
  }

  /**
   * Verifies the HMAC signature on a signed offline manifest.
   * Uses timingSafeEqual to prevent timing attacks.
   */
  private verifyManifestSignature(manifest: OfflineManifest): boolean {
    try {
      const signingKey = this.manifestSigningKey;
      const { signature, ...payload } = manifest;
      const expectedSig = hmacSha256(signingKey, JSON.stringify(payload));
      const receivedSig = hexToBytes(signature);
      return timingSafeCompare(expectedSig, receivedSig);
    } catch {
      return false;
    }
  }

  /**
   * Scans a ticket offline using the downloaded manifest.
   * Works without network after manifest download.
   */
  scanOffline(qrHash: string): ScanResult {
    if (!this.manifest) {
      return { outcome: 'invalid', message: 'No manifest downloaded' };
    }

    if (this.isManifestExpired(this.manifest)) {
      return { outcome: 'invalid', message: 'Manifest expired' };
    }

    const ticket = this.manifest.tickets.find((t) => t.qrHash === qrHash);
    if (!ticket) {
      return { outcome: 'not_found', message: 'Ticket not in manifest' };
    }

    if (
      ticket.status === 'void' ||
      ticket.status === 'refunded' ||
      ticket.status === 'transferred'
    ) {
      return {
        outcome: 'revoked',
        message: 'Ticket is voided, refunded, or transferred',
      };
    }

    if (this.offlineScans.has(qrHash)) {
      return {
        outcome: 'duplicate',
        message: 'Ticket already checked in',
        ticketId: ticket.ticketId,
      };
    }

    this.offlineScans.set(qrHash, new Date().toISOString());
    void this.persistOfflineState();
    return {
      outcome: 'accepted',
      message: 'Check-in successful (offline)',
      ticketId: ticket.ticketId,
    };
  }

  /**
   * Syncs offline scans with the server when network is available.
   */
  async syncScans(checkInListId: string = this.manifest?.checkInListId ?? ''): Promise<SyncResult> {
    if (!checkInListId) {
      throw new Error('checkInListId is required to sync offline scans');
    }

    const scans = Array.from(this.offlineScans.entries()).map(([qrHash, scannedAt]) => ({
      qrHash,
      scannedAt,
      offline: true,
    }));

    if (scans.length === 0) {
      return { accepted: 0, duplicates: 0, invalid: 0, results: [] };
    }

    const result = await this.client.request<SyncResult>('POST', '/check-ins/sync', {
      body: { checkInListId, scans },
      idempotencyKey: this.syncIdempotencyKey(checkInListId, scans),
      headers: this.authHeaders(),
    });
    for (const item of result.results) {
      if (item.outcome !== 'accepted') {
        this.onSyncConflict?.({ qrHash: item.qrHash, outcome: item.outcome });
      }
    }
    for (const item of result.results) {
      if (item.outcome === 'accepted') this.offlineScans.delete(item.qrHash);
    }
    await this.persistOfflineState();
    return result;
  }

  async restoreOfflineScans(): Promise<void> {
    if (!this.storage) return;
    const raw = await this.storage.getItem(this.storageKey);
    if (!raw) return;
    const state = this.parsePersistedScannerState(raw);
    if (
      !state ||
      state.deviceId !== this.deviceId ||
      state.eventId !== state.manifest.eventId ||
      state.checkInListId !== state.manifest.checkInListId ||
      state.expiresAt !== state.manifest.expiresAt ||
      !this.verifyManifestSignature(state.manifest) ||
      this.isManifestExpired(state.manifest)
    ) {
      this.manifest = null;
      this.offlineScans.clear();
      if (state?.deviceId === this.deviceId) await this.storage.removeItem(this.storageKey);
      return;
    }
    this.manifest = state.manifest;
    this.offlineScans = new Map(state.offlineScans);
  }

  async clearOfflineScans(): Promise<void> {
    this.offlineScans.clear();
    await this.persistOfflineState();
  }

  checkoutUrl(options: Omit<TixkitCheckoutHandoffOptions, 'checkoutBaseUrl'>): string {
    return checkoutHandoffUrl({
      checkoutBaseUrl: this.checkoutBaseUrl,
      ...options,
    });
  }

  async openCheckout(options: Omit<TixkitCheckoutOpenOptions, 'checkoutBaseUrl'>): Promise<string> {
    const url = this.checkoutUrl(options);
    await options.openURL(url);
    return url;
  }

  /**
   * Scans a ticket online (requires network).
   */
  async scanOnline(
    checkInListId: string,
    qrPayload: string,
    idempotencyKey: string,
    scannedAt: string,
  ): Promise<ScanResult> {
    return this.client.request('POST', '/check-ins/scan', {
      body: {
        checkInListId,
        qrPayload,
        scannedAt,
        offline: false,
      },
      idempotencyKey,
      headers: this.authHeaders(),
    });
  }

  private authHeaders(): Record<string, string> {
    return {
      'X-Device-Id': this.deviceId,
      'X-Device-Secret': this.deviceSecret,
    };
  }

  private syncIdempotencyKey(checkInListId: string, scans: { scannedAt: string }[]): string {
    let firstTimestamp = 'none';
    let lastTimestamp = 'none';
    for (const scan of scans) {
      if (firstTimestamp === 'none' || scan.scannedAt < firstTimestamp)
        firstTimestamp = scan.scannedAt;
      if (lastTimestamp === 'none' || scan.scannedAt > lastTimestamp)
        lastTimestamp = scan.scannedAt;
    }
    return [
      'scanner-sync',
      this.deviceId,
      checkInListId,
      String(scans.length),
      firstTimestamp,
      lastTimestamp,
    ].join(':');
  }

  private async persistOfflineState(): Promise<void> {
    if (!this.storage) return;
    if (!this.manifest && this.offlineScans.size === 0) {
      await this.storage.removeItem(this.storageKey);
      return;
    }
    if (!this.manifest) return;
    const state: PersistedScannerState = {
      version: 1,
      deviceId: this.deviceId,
      eventId: this.manifest.eventId,
      checkInListId: this.manifest.checkInListId,
      expiresAt: this.manifest.expiresAt,
      manifest: this.manifest,
      offlineScans: [...this.offlineScans.entries()],
    };
    await this.storage.setItem(this.storageKey, JSON.stringify(state));
  }

  private parsePersistedScannerState(raw: string): PersistedScannerState | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const state = parsed as Partial<PersistedScannerState>;
      if (
        state.version !== 1 ||
        typeof state.deviceId !== 'string' ||
        typeof state.eventId !== 'string' ||
        typeof state.checkInListId !== 'string' ||
        typeof state.expiresAt !== 'string' ||
        !this.isOfflineManifest(state.manifest) ||
        !Array.isArray(state.offlineScans)
      ) {
        return null;
      }
      const offlineScans = state.offlineScans.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
      );
      return {
        version: 1,
        deviceId: state.deviceId,
        eventId: state.eventId,
        checkInListId: state.checkInListId,
        expiresAt: state.expiresAt,
        manifest: state.manifest,
        offlineScans,
      };
    } catch {
      return null;
    }
  }

  private isOfflineManifest(value: unknown): value is OfflineManifest {
    if (!value || typeof value !== 'object') return false;
    const manifest = value as Partial<OfflineManifest>;
    return (
      typeof manifest.eventId === 'string' &&
      typeof manifest.checkInListId === 'string' &&
      typeof manifest.generatedAt === 'string' &&
      typeof manifest.expiresAt === 'string' &&
      typeof manifest.keyId === 'string' &&
      typeof manifest.signature === 'string' &&
      Array.isArray(manifest.tickets) &&
      manifest.tickets.every(
        (ticket) =>
          ticket &&
          typeof ticket === 'object' &&
          typeof ticket.ticketId === 'string' &&
          typeof ticket.ticketTypeId === 'string' &&
          (ticket.eventOccurrenceId === undefined ||
            typeof ticket.eventOccurrenceId === 'string') &&
          typeof ticket.attendeeName === 'string' &&
          typeof ticket.qrHash === 'string' &&
          typeof ticket.status === 'string',
      )
    );
  }

  private isManifestExpired(manifest: OfflineManifest): boolean {
    const expiresAt = Date.parse(manifest.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt < Date.now();
  }
}

// Exported for testing against node:crypto known-answer vectors.
export { sha256, hmacSha256 };
