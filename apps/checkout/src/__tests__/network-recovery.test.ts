import { describe, expect, it } from 'vitest';
import {
  isTransportFailure,
  readConnectivityStatus,
  RequestGeneration,
  runSingleFlight,
  transportFailureMessage,
} from '@/lib/network-recovery';
import { CheckoutApiError } from '@/lib/api';

describe('readConnectivityStatus', () => {
  it('maps navigator.onLine values', () => {
    expect(readConnectivityStatus(true)).toBe('online');
    expect(readConnectivityStatus(false)).toBe('offline');
    expect(readConnectivityStatus(null)).toBe('unknown');
  });
});

describe('isTransportFailure', () => {
  it('detects network and 5xx failures without treating 4xx as transport', () => {
    expect(isTransportFailure(new CheckoutApiError('NETWORK_ERROR', 'x', 0))).toBe(true);
    expect(isTransportFailure(new CheckoutApiError('SERVICE_UNAVAILABLE', 'x', 503))).toBe(true);
    expect(isTransportFailure(new CheckoutApiError('INVENTORY_EXHAUSTED', 'x', 409))).toBe(false);
    expect(isTransportFailure(new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('RequestGeneration', () => {
  it('ignores superseded generations after invalidate or next', () => {
    const gen = new RequestGeneration();
    const first = gen.next();
    expect(gen.isCurrent(first)).toBe(true);
    const second = gen.next();
    expect(gen.isCurrent(first)).toBe(false);
    expect(gen.isCurrent(second)).toBe(true);
    gen.invalidate();
    expect(gen.isCurrent(second)).toBe(false);
  });
});

describe('runSingleFlight', () => {
  it('coalesces concurrent callers onto one promise', async () => {
    const state = { inFlight: null as Promise<number> | null };
    let runs = 0;
    const task = () =>
      runSingleFlight(state, async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      });

    const [a, b] = await Promise.all([task(), task()]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(runs).toBe(1);
  });
});

describe('transportFailureMessage', () => {
  it('explains offline vs generic transport failure', () => {
    expect(transportFailureMessage('offline')).toMatch(/offline/i);
    expect(transportFailureMessage('unknown')).toMatch(/could not reach/i);
  });
});
