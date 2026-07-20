import { describe, expect, it } from 'vitest';
import {
  BrowserOfflineCheckInSession,
  validatedOfflineSyncOutcomes,
} from './browser-offline-checkin';

const snapshot = [
  { qrHash: 'hash_a', scannedAt: '2026-07-20T12:00:00.000Z' },
  { qrHash: 'hash_b', scannedAt: '2026-07-20T12:00:01.000Z' },
];

describe('offline reconciliation response validation', () => {
  it('reads pending state through the private IndexedDB receiver boundary', async () => {
    const requestListeners = new Map<string, EventListenerOrEventListenerObject>();
    const transactionListeners = new Map<string, EventListenerOrEventListenerObject>();
    const dispatch = (listeners: Map<string, EventListenerOrEventListenerObject>, type: string) => {
      const listener = listeners.get(type);
      if (!listener) return;
      const event = new Event(type);
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    };
    const request = {
      result: { pending: [{ qrHash: 'hash_a' }, { qrHash: 'hash_b' }] },
      error: null,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        requestListeners.set(type, listener);
      },
    };
    const requestedKeys: IDBValidKey[] = [];
    const transaction = {
      error: null,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        transactionListeners.set(type, listener);
      },
      objectStore() {
        return {
          get(key: IDBValidKey) {
            requestedKeys.push(key);
            queueMicrotask(() => {
              dispatch(requestListeners, 'success');
              dispatch(transactionListeners, 'complete');
            });
            return request;
          },
        };
      },
    };
    const database = {
      transaction: () => transaction,
    } as unknown as IDBDatabase;

    const session = new BrowserOfflineCheckInSession(database, 'offline-context');

    await expect(session.pendingCount()).resolves.toBe(2);
    expect(requestedKeys).toEqual(['offline-context']);
  });

  it('accepts a unique terminal subset of the submitted snapshot', () => {
    expect([
      ...validatedOfflineSyncOutcomes(snapshot, [{ qrHash: 'hash_a', outcome: 'accepted' }]),
    ]).toEqual([['hash_a', 'accepted']]);
  });

  it.each([
    ['missing results', undefined],
    ['non-object item', ['invalid']],
    ['extraneous hash', [{ qrHash: 'hash_c', outcome: 'accepted' }]],
    [
      'duplicate hash',
      [
        { qrHash: 'hash_a', outcome: 'accepted' },
        { qrHash: 'hash_a', outcome: 'duplicate' },
      ],
    ],
    ['unknown outcome', [{ qrHash: 'hash_a', outcome: 'provider_drift' }]],
    ['missing hash', [{ outcome: 'accepted' }]],
  ])('fails closed for %s', (_label, results) => {
    expect(() => validatedOfflineSyncOutcomes(snapshot, results)).toThrow(/Offline sync/u);
  });
});
