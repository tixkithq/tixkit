import { GateKitClient } from '@gatekit/js';

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
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
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

    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
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
    attendeeName: string;
    qrHash: string;
    status: string;
  }[];
};

export type ScanResult = {
  outcome: 'accepted' | 'duplicate' | 'invalid' | 'revoked' | 'not_found' | 'wrong_event' | 'wrong_list';
  ticketId?: string;
  message: string;
};

export type SyncResult = {
  accepted: number;
  duplicates: number;
  invalid: number;
  results: { qrHash: string; outcome: string }[];
};

export type GateKitScannerStorage = {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
};

export type GateKitScannerConflict = {
  qrHash: string;
  outcome: string;
};

export type GateKitScannerClientConfig = {
  deviceId: string;
  deviceSecret: string;
  apiBaseUrl?: string;
  manifestSigningKey: string;
  storage?: GateKitScannerStorage;
  storageKey?: string;
  onSyncConflict?: (conflict: GateKitScannerConflict) => void;
};

export class GateKitScannerClient {
  private client: GateKitClient;
  private readonly deviceId: string;
  private readonly deviceSecret: string;
  private readonly manifestSigningKey: string;
  private readonly storage?: GateKitScannerStorage;
  private readonly storageKey: string;
  private readonly onSyncConflict?: (conflict: GateKitScannerConflict) => void;
  private manifest: OfflineManifest | null = null;
  private offlineScans = new Map<string, string>();

  constructor(config: GateKitScannerClientConfig) {
    this.deviceId = config.deviceId;
    this.deviceSecret = config.deviceSecret;
    this.manifestSigningKey = config.manifestSigningKey;
    this.storage = config.storage;
    this.storageKey = config.storageKey ?? `gatekit:scanner:${config.deviceId}:offline-scans`;
    this.onSyncConflict = config.onSyncConflict;
    this.client = new GateKitClient({ apiBaseUrl: config.apiBaseUrl });
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

    if (new Date(this.manifest.expiresAt) < new Date()) {
      return { outcome: 'invalid', message: 'Manifest expired' };
    }

    const ticket = this.manifest.tickets.find((t) => t.qrHash === qrHash);
    if (!ticket) {
      return { outcome: 'not_found', message: 'Ticket not in manifest' };
    }

    if (ticket.status === 'void' || ticket.status === 'refunded' || ticket.status === 'transferred') {
      return { outcome: 'revoked', message: 'Ticket is voided, refunded, or transferred' };
    }

    if (this.offlineScans.has(qrHash)) {
      return { outcome: 'duplicate', message: 'Ticket already checked in', ticketId: ticket.ticketId };
    }

    this.offlineScans.set(qrHash, new Date().toISOString());
    void this.persistOfflineScans();
    return { outcome: 'accepted', message: 'Check-in successful (offline)', ticketId: ticket.ticketId };
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
    await this.persistOfflineScans();
    return result;
  }

  async restoreOfflineScans(): Promise<void> {
    if (!this.storage) return;
    const raw = await this.storage.getItem(this.storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<[string, string]>;
    this.offlineScans = new Map(
      parsed.filter((entry): entry is [string, string] =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
      ),
    );
  }

  async clearOfflineScans(): Promise<void> {
    this.offlineScans.clear();
    await this.storage?.removeItem(this.storageKey);
  }

  /**
   * Scans a ticket online (requires network).
   */
  async scanOnline(checkInListId: string, qrPayload: string): Promise<ScanResult> {
    return this.client.request('POST', '/check-ins/scan', {
      body: {
        checkInListId,
        qrPayload,
        scannedAt: new Date().toISOString(),
        offline: false,
      },
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
      if (firstTimestamp === 'none' || scan.scannedAt < firstTimestamp) firstTimestamp = scan.scannedAt;
      if (lastTimestamp === 'none' || scan.scannedAt > lastTimestamp) lastTimestamp = scan.scannedAt;
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

  private async persistOfflineScans(): Promise<void> {
    if (!this.storage) return;
    if (this.offlineScans.size === 0) {
      await this.storage.removeItem(this.storageKey);
      return;
    }
    await this.storage.setItem(this.storageKey, JSON.stringify([...this.offlineScans.entries()]));
  }
}

// Exported for testing against node:crypto known-answer vectors.
export { sha256, hmacSha256 };
