'use client';

import type { PublicCheckoutRuntimeConfig } from './runtime-config-contract';

let browserRuntimeConfig: PublicCheckoutRuntimeConfig | null = null;
const PUBLIC_CONFIG_FIELDS: ReadonlyArray<keyof PublicCheckoutRuntimeConfig> = [
  'schemaVersion',
  'deploymentProfile',
  'apiBaseUrl',
  'platformApiBaseUrl',
  'checkoutUrl',
  'mediaOrigin',
  'stripePublishableKey',
  'domainBrandMap',
  'buildRevision',
  'configFingerprint',
];

export function initializeBrowserRuntimeConfig(config: PublicCheckoutRuntimeConfig): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const snapshot = Object.freeze({ ...config });
  if (
    browserRuntimeConfig &&
    PUBLIC_CONFIG_FIELDS.some((key) => browserRuntimeConfig?.[key] !== snapshot[key])
  ) {
    throw new Error('Checkout runtime configuration changed after initialization');
  }
  if (!browserRuntimeConfig) browserRuntimeConfig = snapshot;
}

export function getBrowserRuntimeConfig(): PublicCheckoutRuntimeConfig {
  if (browserRuntimeConfig) return browserRuntimeConfig;
  if (process.env.NODE_ENV === 'test') {
    return Object.freeze({
      schemaVersion: '1',
      deploymentProfile: 'test',
      apiBaseUrl: 'http://localhost:4000',
      platformApiBaseUrl: 'http://localhost:4000/v1',
      checkoutUrl: 'https://checkout.tixkit.com',
      mediaOrigin: 'http://localhost:9000',
      buildRevision: 'test',
      configFingerprint: `sha256:${'0'.repeat(64)}`,
    });
  }
  throw new Error('Checkout runtime configuration has not been initialized');
}

export function resetBrowserRuntimeConfigForTests(): void {
  if (process.env.NODE_ENV !== 'test')
    throw new Error('Runtime configuration can only be reset in tests');
  browserRuntimeConfig = null;
}
