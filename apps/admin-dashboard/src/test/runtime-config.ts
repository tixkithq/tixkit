import {
  ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION,
  runtimeConfigDataAttributes,
  type PublicAdminRuntimeConfig,
} from '@/lib/runtime-config-contract';

export const defaultTestRuntimeConfig: PublicAdminRuntimeConfig = Object.freeze({
  schemaVersion: ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION,
  deploymentProfile: 'test',
  apiBaseUrl: 'http://localhost:4000',
  platformApiBaseUrl: 'http://localhost:4000/v1',
  checkoutUrl: 'http://localhost:3000',
  docsUrl: 'http://localhost:3002',
  uploadOrigin: 'http://localhost:9000',
  authProvider: 'dev',
  buildRevision: 'test',
  configFingerprint: `sha256:${'0'.repeat(64)}`,
});

export function installTestRuntimeConfig(
  overrides: Partial<PublicAdminRuntimeConfig> = {},
): PublicAdminRuntimeConfig {
  const config = { ...defaultTestRuntimeConfig, ...overrides } as PublicAdminRuntimeConfig;
  for (const attribute of document.documentElement.getAttributeNames()) {
    if (attribute.startsWith('data-tixkit-')) document.documentElement.removeAttribute(attribute);
  }
  for (const [name, value] of Object.entries(runtimeConfigDataAttributes(config))) {
    document.documentElement.setAttribute(name, value);
  }
  return config;
}
