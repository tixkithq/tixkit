'use client';

import { useReportWebVitals } from 'next/web-vitals';
import { RUM_MAXIMUM_VALUES, RUM_SCHEMA_VERSION, type RumWebVital } from '@tixkit/domain';
import { apiBaseUrl } from '@/lib/api';
import { isSharedCheckoutHost } from '@/lib/hosts';

type WebVitalSample = {
  name: string;
  value: number;
};

const RESERVED_TOP_LEVEL_PATHS = new Set([
  'api',
  'auth',
  'checkout',
  'embed-preview',
  'favicon.ico',
  'health',
  'login',
  'logout',
  'robots.txt',
  'sign-in',
  'sign-up',
  'sitemap.xml',
  '_next',
]);

export function classifyBuyerSurface(
  pathname: string,
  host: string,
): 'checkout' | 'event-page' | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
  if (normalized === '/checkout' || normalized === '/checkout/confirmation') return 'checkout';
  if (/^\/e\/[A-Za-z0-9_-]+$/u.test(normalized)) return 'event-page';

  const topLevel = normalized.match(/^\/([^/]+)$/u)?.[1];
  if (
    topLevel &&
    !isSharedCheckoutHost(host) &&
    !RESERVED_TOP_LEVEL_PATHS.has(topLevel.toLowerCase()) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(topLevel)
  ) {
    return 'event-page';
  }
  return null;
}

function normalizedValue(metric: RumWebVital, value: number): number {
  return metric === 'CLS' ? value : value / 1_000;
}

export function reportBuyerWebVital(sample: WebVitalSample): void {
  if (!Object.hasOwn(RUM_MAXIMUM_VALUES, sample.name)) return;
  const metric = sample.name as RumWebVital;
  const value = normalizedValue(metric, sample.value);
  if (!Number.isFinite(value) || value < 0 || value > RUM_MAXIMUM_VALUES[metric]) return;
  const surface = classifyBuyerSurface(window.location.pathname, window.location.host);
  if (!surface) return;

  const body = {
    schemaVersion: RUM_SCHEMA_VERSION,
    surface,
    metric,
    value,
  };
  try {
    void fetch(`${apiBaseUrl()}/public/rum`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Real-user monitoring is diagnostic and never blocks buyer interaction.
  }
}

export function WebVitalsReporter() {
  useReportWebVitals(reportBuyerWebVital);
  return null;
}
