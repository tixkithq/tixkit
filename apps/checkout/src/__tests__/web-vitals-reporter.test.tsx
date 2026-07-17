import './test-dom';
import { cleanup, render, waitFor } from '@testing-library/react';
import { RUM_MAXIMUM_VALUES, RUM_SCHEMA_VERSION, RUM_WEB_VITALS } from '@tixkit/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyBuyerSurface,
  issueBuyerRumUrl,
  WebVitalsReporter,
} from '@/components/web-vitals-reporter';
import {
  initializeBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from '@/lib/runtime-config-browser';

let report: ((metric: { name: string; value: number }) => void) | undefined;

vi.mock('next/web-vitals', () => ({
  useReportWebVitals: (callback: typeof report) => {
    report = callback;
  },
}));

describe('privacy-safe web-vitals reporter', () => {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 202 }),
  );

  beforeEach(() => {
    report = undefined;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    initializeBrowserRuntimeConfig({
      schemaVersion: '1',
      deploymentProfile: 'test',
      apiBaseUrl: 'https://api.example.test',
      platformApiBaseUrl: 'https://api.example.test/v1',
      checkoutUrl: 'https://checkout.tixkit.com',
      mediaOrigin: 'https://media.example.test',
      buildRevision: 'test',
      configFingerprint: `sha256:${'1'.repeat(64)}`,
    });
    window.history.replaceState({}, '', '/checkout');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetBrowserRuntimeConfigForTests();
  });

  it('reports only LCP, INP, and CLS with fixed-cardinality identifier-free payloads', async () => {
    render(<WebVitalsReporter />);
    expect(report).toBeTypeOf('function');

    report?.({ name: 'LCP', value: 2_500 });
    report?.({ name: 'INP', value: 200 });
    report?.({ name: 'CLS', value: 0.1 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'LCP', value: 2.5 },
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'INP', value: 0.2 },
      { schemaVersion: RUM_SCHEMA_VERSION, surface: 'checkout', metric: 'CLS', value: 0.1 },
    ]);
    expect(bodies.map(({ metric }) => metric)).toEqual(RUM_WEB_VITALS);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.example.test/v1/public/rum');
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        keepalive: true,
      });
      expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual([
        'metric',
        'schemaVersion',
        'surface',
        'value',
      ]);
    }
  });

  it('uses only a bounded event-page surface rather than route or event identity', async () => {
    window.history.replaceState({}, '', '/e/evt_private?token=secret');
    render(<WebVitalsReporter />);
    report?.({ name: 'LCP', value: 1_000 });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      schemaVersion: RUM_SCHEMA_VERSION,
      surface: 'event-page',
      metric: 'LCP',
      value: 1,
    });
    expect(JSON.stringify(body)).not.toMatch(/evt_private|token|url|path|session|user|tenant/iu);
  });

  it('classifies supported event ID, event slug, and checkout route inventory', () => {
    expect(classifyBuyerSurface('/e/evt_123', 'checkout.tixkit.com')).toBe('event-page');
    expect(classifyBuyerSurface('/e/evt_123/', 'checkout.tixkit.com')).toBe('event-page');
    expect(classifyBuyerSurface('/summer-festival', 'events.example.com')).toBe('event-page');
    expect(classifyBuyerSurface('/custom-domain-event/', 'tickets.example.org')).toBe('event-page');
    expect(classifyBuyerSurface('/summer-festival', 'checkout.tixkit.com')).toBeNull();
    expect(classifyBuyerSurface('/checkout', 'checkout.tixkit.com')).toBe('checkout');
    expect(classifyBuyerSurface('/checkout/confirmation', 'checkout.tixkit.com')).toBe('checkout');
    expect(classifyBuyerSurface('/checkout/confirmation/', 'checkout.tixkit.com')).toBe('checkout');
  });

  it.each([
    '/',
    '/embed-preview',
    '/health',
    '/api/rum',
    '/_next/static/chunk.js',
    '/favicon.ico',
    '/robots.txt',
    '/sign-in',
    '/sign-up/callback',
    '/auth/callback',
    '/login',
    '/logout',
    '/e',
    '/e/',
    '/e/event/extra',
    '/checkout/unsupported',
    '/Invalid-Slug',
  ])('drops unsupported shell, auth, static, and malformed path %s', (pathname) => {
    expect(classifyBuyerSurface(pathname, 'checkout.tixkit.com')).toBeNull();
  });

  it.each([
    '/embed-preview',
    '/health',
    '/favicon.ico',
    '/robots.txt',
    '/sign-in',
    '/sign-up',
    '/login',
    '/logout',
  ])('drops reserved shell and auth path %s on custom domains', (pathname) => {
    expect(classifyBuyerSurface(pathname, 'tickets.example.org')).toBeNull();
  });

  it('does not report a supported metric from an unsupported route', () => {
    window.history.replaceState({}, '', '/embed-preview');
    render(<WebVitalsReporter />);
    report?.({ name: 'LCP', value: 1_000 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops unsupported, non-finite, negative, and oversized samples', () => {
    render(<WebVitalsReporter />);
    for (const sample of [
      { name: 'FCP', value: 100 },
      { name: 'TTFB', value: 100 },
      { name: 'LCP', value: Infinity },
      { name: 'INP', value: -1 },
      { name: 'CLS', value: 10.01 },
    ]) {
      report?.(sample);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(RUM_MAXIMUM_VALUES).toEqual({ LCP: 60, INP: 10, CLS: 10 });
  });

  it('does not block or retry when metric delivery fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<WebVitalsReporter />);
    expect(() => report?.({ name: 'CLS', value: 0.05 })).not.toThrow();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'javascript:alert(1)',
    'https://user:secret@api.example.test/v1',
    'https://api.example.test/v1/escape',
    'https://api.example.test/v1?target=rum',
    'http://api.example.test/v1',
    'https://api.example.test/v1\nX-Test: yes',
  ])('rejects a hostile RUM base without issuing a request: %s', (baseUrl) => {
    expect(() => issueBuyerRumUrl(baseUrl)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
