import { describe, expect, it } from 'vitest';
import { validatedOfflineSyncOutcomes } from './browser-offline-checkin';

const snapshot = [
  { qrHash: 'hash_a', scannedAt: '2026-07-20T12:00:00.000Z' },
  { qrHash: 'hash_b', scannedAt: '2026-07-20T12:00:01.000Z' },
];

describe('offline reconciliation response validation', () => {
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
