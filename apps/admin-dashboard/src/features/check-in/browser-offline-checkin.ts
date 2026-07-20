'use client';

import {
  classifyOfflineManifestTicketStatus,
  type OfflineManifestV2,
  type OfflineManifestVerificationKeySet,
} from '@tixkit/domain/offline-checkin';
import {
  adminApi,
  getAdminApiBaseUrl,
  type CheckInScanResult,
  type OfflineSyncResult,
} from '@/lib/api';
import { verifyOfflineManifestForBrowser } from './offline-manifest-crypto';

type PendingOfflineScan = {
  qrHash: string;
  scannedAt: string;
};

type ReconciledOfflineScan = PendingOfflineScan & {
  outcome: OfflineSyncResult['results'][number]['outcome'];
  reconciledAt: string;
};

type SyncLease = {
  owner: string;
  expiresAt: string;
};

type OfflineCheckInState = {
  version: 1;
  key: string;
  apiOrigin: string;
  tenantId: string;
  eventId: string;
  checkInListId: string;
  manifest: OfflineManifestV2;
  keySet: OfflineManifestVerificationKeySet;
  pending: PendingOfflineScan[];
  reconciled: ReconciledOfflineScan[];
  syncLease?: SyncLease;
};

const DATABASE_NAME = 'tixkit-offline-checkin-v1';
const STORE_NAME = 'contexts';
const SYNC_LEASE_MS = 30_000;
// A manifest is capped at 50,000 unique tickets by the API. Retaining one
// hash-only reconciliation per ticket prevents re-admission for the complete
// lifetime of every manifest without allowing unbounded browser state.
const MAX_RECONCILIATIONS = 50_000;
const RECONCILIATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const TERMINAL_SYNC_OUTCOMES = new Set<ReconciledOfflineScan['outcome']>([
  'accepted',
  'duplicate',
  'invalid',
  'not_found',
  'revoked',
  'wrong_event',
  'wrong_list',
]);

export function validatedOfflineSyncOutcomes(
  snapshot: readonly PendingOfflineScan[],
  results: unknown,
): ReadonlyMap<string, ReconciledOfflineScan['outcome']> {
  if (!Array.isArray(results)) throw new Error('Offline sync returned malformed results.');
  const submitted = new Set(snapshot.map((scan) => scan.qrHash));
  const outcomes = new Map<string, ReconciledOfflineScan['outcome']>();
  for (const item of results) {
    if (!item || typeof item !== 'object') {
      throw new Error('Offline sync returned malformed results.');
    }
    const qrHash = Reflect.get(item, 'qrHash');
    const outcome = Reflect.get(item, 'outcome');
    if (
      typeof qrHash !== 'string' ||
      !submitted.has(qrHash) ||
      outcomes.has(qrHash) ||
      !TERMINAL_SYNC_OUTCOMES.has(outcome as ReconciledOfflineScan['outcome'])
    ) {
      throw new Error('Offline sync returned results outside the submitted snapshot.');
    }
    outcomes.set(qrHash, outcome as ReconciledOfflineScan['outcome']);
  }
  return outcomes;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB failed')),
      {
        once: true,
      },
    );
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('Offline storage is unavailable in this browser.');
  const request = globalThis.indexedDB.open(DATABASE_NAME, 1);
  request.addEventListener('upgradeneeded', () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    }
  });
  return requestResult(request);
}

async function readState(database: IDBDatabase, key: string): Promise<OfflineCheckInState | null> {
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const completion = transactionComplete(transaction);
  const state = await requestResult(
    transaction.objectStore(STORE_NAME).get(key) as IDBRequest<OfflineCheckInState | undefined>,
  );
  await completion;
  return state ?? null;
}

async function mutateState<T>(
  database: IDBDatabase,
  key: string,
  mutation: (state: OfflineCheckInState | null) => { state: OfflineCheckInState; result: T },
): Promise<T> {
  const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' });
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const current = await requestResult(
    store.get(key) as IDBRequest<OfflineCheckInState | undefined>,
  );
  const next = mutation(current ?? null);
  store.put(next.state);
  await completion;
  return next.result;
}

async function purgeExpiredStates(database: IDBDatabase, now: Date = new Date()): Promise<void> {
  const transaction = database.transaction(STORE_NAME, 'readwrite', { durability: 'strict' });
  const completion = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const states = await requestResult(store.getAll() as IDBRequest<OfflineCheckInState[]>);
  const nowMs = now.getTime();
  for (const state of states) {
    const manifestExpired = Date.parse(state.manifest.expiresAt) <= nowMs;
    const reconciled = state.reconciled.filter(
      (scan) => Date.parse(scan.reconciledAt) > nowMs - RECONCILIATION_RETENTION_MS,
    );
    if (manifestExpired && state.pending.length === 0) {
      store.delete(state.key);
      continue;
    }
    const manifest = manifestExpired ? { ...state.manifest, tickets: [] } : state.manifest;
    if (manifest !== state.manifest || reconciled.length !== state.reconciled.length) {
      store.put({ ...state, manifest, reconciled });
    }
  }
  await completion;
}

function contextKey(input: {
  apiOrigin: string;
  tenantId: string;
  eventId: string;
  checkInListId: string;
}): string {
  return JSON.stringify([input.apiOrigin, input.tenantId, input.eventId, input.checkInListId]);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function result(
  status: CheckInScanResult['status'],
  message: string,
  scannedAt: string,
): CheckInScanResult {
  return { status, message, scannedAt };
}

export class BrowserOfflineCheckInSession {
  constructor(
    private readonly database: IDBDatabase,
    private readonly key: string,
  ) {}

  async pendingCount(): Promise<number> {
    return (await readState(this.database, this.key))?.pending.length ?? 0;
  }

  async scan(qrPayload: string, now: Date = new Date()): Promise<CheckInScanResult> {
    const state = await readState(this.database, this.key);
    const scannedAt = now.toISOString();
    if (!state) return result('invalid', 'No verified offline manifest is available.', scannedAt);
    const verified = await verifyOfflineManifestForBrowser(state.manifest, state.keySet, {
      apiOrigin: state.apiOrigin,
      tenantId: state.tenantId,
      eventId: state.eventId,
      checkInListId: state.checkInListId,
      now,
    });
    if (!verified) {
      return result(
        'invalid',
        'The offline manifest is expired or could not be verified.',
        scannedAt,
      );
    }
    const qrHash = await sha256Hex(qrPayload.trim());
    const ticket = state.manifest.tickets.find((candidate) => candidate.qrHash === qrHash);
    if (!ticket)
      return result('invalid', 'Ticket is not present in the offline manifest.', scannedAt);
    const disposition = classifyOfflineManifestTicketStatus(ticket.status);
    if (disposition === 'duplicate') {
      return result('duplicate', 'Ticket was already checked in before this manifest.', scannedAt);
    }
    if (disposition === 'revoked') {
      return result('revoked', 'Ticket is void, refunded, or transferred.', scannedAt);
    }
    if (disposition !== 'candidate') {
      return result('invalid', 'Ticket status is not safe for offline admission.', scannedAt);
    }
    const localDisposition = await mutateState(this.database, this.key, (current) => {
      if (!current) throw new Error('Offline manifest context was removed.');
      if (
        current.manifest.signature !== state.manifest.signature ||
        current.manifest.keyId !== state.manifest.keyId
      ) {
        throw new Error('Offline manifest changed while the scan was being verified. Scan again.');
      }
      if (current.pending.some((scan) => scan.qrHash === qrHash)) {
        return { state: current, result: 'pending' as const };
      }
      if (current.reconciled.some((scan) => scan.qrHash === qrHash)) {
        return { state: current, result: 'reconciled' as const };
      }
      return {
        state: { ...current, pending: [...current.pending, { qrHash, scannedAt }] },
        result: 'queued' as const,
      };
    });
    if (localDisposition === 'queued') {
      return result(
        'accepted',
        'Check-in accepted offline and queued for synchronization.',
        scannedAt,
      );
    }
    return localDisposition === 'pending'
      ? result('duplicate', 'Ticket is already queued on this browser.', scannedAt)
      : result('duplicate', 'Ticket was already admitted on this browser.', scannedAt);
  }

  async sync(): Promise<OfflineSyncResult | null> {
    const owner = globalThis.crypto.randomUUID();
    const now = new Date();
    const snapshot = await mutateState(this.database, this.key, (current) => {
      if (!current) throw new Error('Offline manifest context was removed.');
      if (current.syncLease && Date.parse(current.syncLease.expiresAt) > now.getTime()) {
        return { state: current, result: null };
      }
      const state = {
        ...current,
        syncLease: {
          owner,
          expiresAt: new Date(now.getTime() + SYNC_LEASE_MS).toISOString(),
        },
      };
      return { state, result: state.pending };
    });
    if (!snapshot || snapshot.length === 0) {
      if (snapshot) await this.releaseLease(owner);
      return null;
    }
    const state = await readState(this.database, this.key);
    if (!state) throw new Error('Offline manifest context was removed.');
    const scans = snapshot.map((scan) => ({ ...scan, offline: true as const }));
    const idempotencyKey = `offline-browser-${await sha256Hex(
      JSON.stringify([state.tenantId, state.eventId, state.checkInListId, scans]),
    )}`;
    let response: Awaited<ReturnType<typeof adminApi.syncOfflineScans>>;
    try {
      response = await adminApi.syncOfflineScans(state.checkInListId, scans, idempotencyKey);
    } catch (error) {
      await this.releaseLease(owner);
      throw error;
    }
    if (!response.ok) {
      await this.releaseLease(owner);
      throw new Error(response.error.message || 'Offline scans could not be synchronized.');
    }
    let outcomes: ReadonlyMap<string, ReconciledOfflineScan['outcome']>;
    try {
      outcomes = validatedOfflineSyncOutcomes(snapshot, response.data.results);
    } catch (error) {
      await this.releaseLease(owner);
      throw error;
    }
    await mutateState(this.database, this.key, (current) => {
      if (!current) throw new Error('Offline manifest context was removed.');
      if (current.syncLease?.owner !== owner) return { state: current, result: undefined };
      const reconciledAt = new Date().toISOString();
      const terminal = snapshot.flatMap((scan) => {
        const outcome = outcomes.get(scan.qrHash);
        return outcome ? [{ ...scan, outcome, reconciledAt }] : [];
      });
      return {
        state: {
          ...current,
          pending: current.pending.filter(
            (scan) =>
              !snapshot.some((submitted) => submitted.qrHash === scan.qrHash) ||
              !outcomes.has(scan.qrHash),
          ),
          reconciled: [...current.reconciled, ...terminal].slice(-MAX_RECONCILIATIONS),
          syncLease: undefined,
        },
        result: undefined,
      };
    });
    await purgeExpiredStates(this.database);
    return response.data;
  }

  private async releaseLease(owner: string): Promise<void> {
    await mutateState(this.database, this.key, (current) => {
      if (!current || current.syncLease?.owner !== owner) {
        if (!current) throw new Error('Offline manifest context was removed.');
        return { state: current, result: undefined };
      }
      return { state: { ...current, syncLease: undefined }, result: undefined };
    });
  }
}

export async function prepareBrowserOfflineCheckIn(input: {
  eventId: string;
  checkInListId: string;
}): Promise<BrowserOfflineCheckInSession> {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
    throw new Error('Offline check-in is unavailable in this browser.');
  }
  const apiOrigin = getAdminApiBaseUrl();
  const principal = await adminApi.getPrincipal();
  if (!principal.ok || !principal.data.tenantId) {
    throw new Error(principal.ok ? 'Tenant identity is unavailable.' : principal.error.message);
  }
  let keys = await adminApi.getOfflineManifestVerificationKeys(input.eventId);
  if (!keys.ok) throw new Error(keys.error.message);
  const manifest = await adminApi.getOfflineManifestV2(input.eventId, input.checkInListId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  if (!keys.data.keys.some((key) => key.keyId === manifest.data.keyId)) {
    keys = await adminApi.getOfflineManifestVerificationKeys(input.eventId, { bypassCache: true });
    if (!keys.ok) throw new Error(keys.error.message);
  }
  const verified = await verifyOfflineManifestForBrowser(manifest.data, keys.data, {
    apiOrigin,
    tenantId: principal.data.tenantId,
    eventId: input.eventId,
    checkInListId: input.checkInListId,
  });
  if (!verified) throw new Error('Offline manifest verification failed.');

  const database = await openDatabase();
  await purgeExpiredStates(database);
  const key = contextKey({
    apiOrigin,
    tenantId: principal.data.tenantId,
    eventId: input.eventId,
    checkInListId: input.checkInListId,
  });
  await mutateState(database, key, (current) => ({
    state: {
      version: 1,
      key,
      apiOrigin,
      tenantId: principal.data.tenantId,
      eventId: input.eventId,
      checkInListId: input.checkInListId,
      manifest: manifest.data,
      keySet: keys.data,
      pending: current?.pending ?? [],
      reconciled: current?.reconciled ?? [],
      syncLease: current?.syncLease,
    },
    result: undefined,
  }));
  return new BrowserOfflineCheckInSession(database, key);
}
