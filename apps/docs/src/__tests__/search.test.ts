import type { DocsSearchRecord } from '@tixkit/docs-core';
import { describe, expect, it } from 'vitest';
import { searchDocs, tokenize } from '../lib/search';

const records: DocsSearchRecord[] = [
  {
    url: '/developers/webhooks/verify-signatures',
    title: 'Verify webhook signatures',
    description: 'Authenticate callback delivery payloads.',
    headings: [{ id: 'replay-protection', text: 'Replay protection', level: 2 }],
    body: 'Reject stale timestamps and compare the signature.',
    audience: ['developer'],
    productArea: 'webhooks',
    contentType: 'how-to',
    status: 'stable',
    keywords: ['callback', 'security'],
  },
  {
    url: '/operators/check-in',
    title: 'Run check-in',
    description: 'Scan attendee tickets at the door.',
    headings: [],
    body: 'Prepare scanner devices and offline fallback.',
    audience: ['operator'],
    productArea: 'check-in',
    contentType: 'how-to',
    status: 'stable',
    keywords: ['scanner'],
  },
];

describe('documentation search', () => {
  it('normalizes and deduplicates tokens', () => {
    expect(tokenize(' Webhooks, WEBHOOKS + replay ')).toEqual(['webhooks', 'replay']);
  });

  it('ranks title matches and returns heading deep links', () => {
    expect(searchDocs(records, 'webhook replay')).toEqual([
      expect.objectContaining({
        url: '/developers/webhooks/verify-signatures#replay-protection',
        title: 'Verify webhook signatures',
      }),
    ]);
  });

  it('supports aliases, prefixes, and filters', () => {
    expect(searchDocs(records, 'scan', { audience: 'operator' })[0]?.url).toBe(
      '/operators/check-in',
    );
    expect(searchDocs(records, 'callback', { productArea: 'webhooks' })[0]?.url).toContain(
      '/developers/webhooks',
    );
    expect(searchDocs(records, 'callback', { audience: 'operator' })).toEqual([]);
  });

  it('returns no results for an empty query', () => {
    expect(searchDocs(records, '   ')).toEqual([]);
  });

  it('normalizes non-integer and non-positive result limits', () => {
    expect(searchDocs(records, 'scan', {}, 0)).toEqual([]);
    expect(searchDocs(records, 'scan', {}, -1)).toEqual([]);
    expect(searchDocs(records, 'webhook', {}, 1.9)).toHaveLength(1);
  });
});

describe('search performance budget', () => {
  it('returns representative results within the 50 ms p75 query budget', () => {
    const benchmarkRecords: DocsSearchRecord[] = Array.from({ length: 2_000 }, (_, index) => ({
      ...records[0]!,
      url: `/developers/webhooks/testing#record-${index}`,
      title: `Webhook delivery ${index}`,
    }));
    const durations = Array.from({ length: 40 }, () => {
      const started = performance.now();
      searchDocs(benchmarkRecords, 'signature retry', { audience: 'developer' });
      return performance.now() - started;
    });
    // eslint-disable-next-line unicorn/no-array-sort -- Vitest still compiles this package against ES2022.
    durations.sort((left, right) => left - right);
    expect(durations[Math.floor(durations.length * 0.75)]).toBeLessThanOrEqual(50);
  });
});
