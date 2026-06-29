import type { BaseEntity, ISO8601Date, Ulid } from '../shared/index.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export * from './code-formats.js';

export type TicketStatus = 'valid' | 'void' | 'refunded' | 'transferred' | 'checked_in';

export type Ticket = BaseEntity & {
  orderId: Ulid;
  attendeeId: Ulid;
  eventId: Ulid;
  ticketTypeId: Ulid;
  status: TicketStatus;
  code: string;
  qrPayload: string;
  qrHash: string;
  transferredToEmail?: string;
  transferredAt?: ISO8601Date;
  checkedInAt?: ISO8601Date;
  checkedInByDeviceId?: Ulid;
  walletPassId?: Ulid;
};

export type TicketSecret = BaseEntity & {
  ticketId: Ulid;
  keyId: string;
  encryptedSecret: string;
  revokedAt?: ISO8601Date;
};

export type CheckInList = BaseEntity & {
  eventId: Ulid;
  name: string;
  ticketTypeIds: Ulid[];
  status: 'active' | 'closed';
};

export type CheckInDevice = BaseEntity & {
  checkInListId: Ulid;
  scannerDeviceId: Ulid;
  name: string;
  lastSyncedAt?: ISO8601Date;
  status: 'active' | 'revoked';
};

export type ScanOutcome =
  | 'accepted'
  | 'duplicate'
  | 'invalid'
  | 'revoked'
  | 'offline_pending'
  | 'not_found'
  | 'wrong_event'
  | 'wrong_list';

export type ScanLog = BaseEntity & {
  checkInListId: Ulid;
  deviceId: Ulid;
  ticketId?: Ulid;
  qrHash: string;
  outcome: ScanOutcome;
  scannedAt: ISO8601Date;
  syncedAt?: ISO8601Date;
  offline: boolean;
  metadata?: Record<string, unknown>;
};

export type WalletPassProvider = 'apple' | 'google';

export type WalletPassStatus = 'active' | 'revoked';

export type WalletPass = BaseEntity & {
  tenantId: Ulid;
  ticketId: Ulid;
  provider: WalletPassProvider;
  passUrl: string;
  serialNumber: string;
  status: WalletPassStatus;
  revokedAt?: ISO8601Date;
};

export type OfflineCheckInManifest = {
  eventId: Ulid;
  checkInListId: Ulid;
  generatedAt: ISO8601Date;
  expiresAt: ISO8601Date;
  keyId: string;
  tickets: {
    ticketId: Ulid;
    ticketTypeId: Ulid;
    attendeeName: string;
    qrHash: string;
    status: TicketStatus;
  }[];
};

export type ScanRequest = {
  checkInListId: Ulid;
  qrPayload: string;
  qrHash?: string;
  deviceId?: Ulid;
  offline?: boolean;
  scannedAt: ISO8601Date;
};

export type ScanResult = {
  outcome: ScanOutcome;
  ticket?: Ticket;
  attendeeName?: string;
  ticketTypeName?: string;
  message: string;
};

export type SyncScanInput = {
  deviceId?: Ulid;
  checkInListId: Ulid;
  scans: {
    qrHash: string;
    scannedAt: ISO8601Date;
    offline: boolean;
  }[];
};

export type SyncScanResult = {
  accepted: number;
  duplicates: number;
  invalid: number;
  results: { qrHash: string; outcome: ScanOutcome }[];
};

export type TransferTicketInput = {
  ticketId: Ulid;
  toEmail: string;
  idempotencyKey: string;
};

export type QrPayload = {
  ticketId: string;
  code: string;
  payload: string;
  hash: string;
};

export type QrVerification = {
  ticketId: string;
  code: string;
  valid: boolean;
};

export class QrService {
  private readonly key: string;

  constructor(secret?: string) {
    const configuredSecret = secret ?? process.env.QR_SIGNING_SECRET;
    if (!configuredSecret && process.env.NODE_ENV === 'production') {
      throw new Error('QR_SIGNING_SECRET is required in production');
    }
    this.key = configuredSecret ?? 'tixkit-qr-secret-dev-only';
  }

  generate(ticketId: string): QrPayload {
    const code = `TK-${randomBytes(6).toString('hex').toUpperCase()}`;
    const signedPayload = JSON.stringify({ ticketId, code, ts: Date.now() });
    const signature = createHmac('sha256', this.key).update(signedPayload).digest('hex');
    const payload = Buffer.from(JSON.stringify({ p: signedPayload, s: signature })).toString(
      'base64url',
    );
    const hash = this.hashPayload(payload);

    return { ticketId, code, payload, hash };
  }

  getQrPayload(qrPayload: string): QrVerification {
    try {
      const decoded = JSON.parse(Buffer.from(qrPayload, 'base64url').toString()) as {
        p?: unknown;
        s?: unknown;
      };
      if (typeof decoded.p !== 'string' || typeof decoded.s !== 'string') {
        return { ticketId: '', code: '', valid: false };
      }

      const expectedSignature = createHmac('sha256', this.key).update(decoded.p).digest('hex');
      const signatureBuffer = Buffer.from(decoded.s, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');
      const valid =
        signatureBuffer.length === expectedBuffer.length &&
        timingSafeEqual(signatureBuffer, expectedBuffer);

      const parsed = JSON.parse(decoded.p) as { ticketId?: unknown; code?: unknown };
      if (typeof parsed.ticketId !== 'string' || typeof parsed.code !== 'string') {
        return { ticketId: '', code: '', valid: false };
      }

      return { ticketId: parsed.ticketId, code: parsed.code, valid };
    } catch {
      return { ticketId: '', code: '', valid: false };
    }
  }

  hashPayload(qrPayload: string): string {
    return createHash('sha256').update(qrPayload).digest('hex');
  }
}
