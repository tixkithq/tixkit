import type { PublicAdminRuntimeConfig } from './runtime-config-contract';

let browserRuntimeConfig: PublicAdminRuntimeConfig | undefined;

function sameConfig(left: PublicAdminRuntimeConfig, right: PublicAdminRuntimeConfig): boolean {
  return (
    left.configFingerprint === right.configFingerprint &&
    left.schemaVersion === right.schemaVersion &&
    left.deploymentProfile === right.deploymentProfile &&
    left.apiBaseUrl === right.apiBaseUrl &&
    left.platformApiBaseUrl === right.platformApiBaseUrl &&
    left.checkoutUrl === right.checkoutUrl &&
    left.docsUrl === right.docsUrl &&
    left.uploadOrigin === right.uploadOrigin &&
    left.authProvider === right.authProvider &&
    left.clerkPublishableKey === right.clerkPublishableKey &&
    left.buildRevision === right.buildRevision
  );
}

/**
 * Bind imperative browser transports to the request-scoped React snapshot.
 * This is deliberately inert during SSR, so server requests never share state.
 * A production browser realm may bind exactly once for its document lifetime.
 */
export function initializeBrowserRuntimeConfig(config: PublicAdminRuntimeConfig): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (browserRuntimeConfig) {
    if (!sameConfig(browserRuntimeConfig, config)) {
      throw new Error('Admin runtime configuration cannot change within a browser document');
    }
    return;
  }
  browserRuntimeConfig = Object.freeze({ ...config });
}

export function getBrowserRuntimeConfig(): PublicAdminRuntimeConfig {
  if (!browserRuntimeConfig) {
    throw new Error('Admin browser runtime configuration is not initialized');
  }
  return browserRuntimeConfig;
}

export function resetBrowserRuntimeConfigForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Browser runtime configuration reset is test-only');
  }
  browserRuntimeConfig = undefined;
}
