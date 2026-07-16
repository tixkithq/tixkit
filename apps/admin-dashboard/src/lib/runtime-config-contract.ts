export const ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION = '1' as const;

export const ADMIN_RUNTIME_CONFIG_ATTRIBUTES = {
  schemaVersion: 'data-tixkit-runtime-schema',
  deploymentProfile: 'data-tixkit-deployment-profile',
  apiBaseUrl: 'data-tixkit-api-base-url',
  platformApiBaseUrl: 'data-tixkit-platform-api-base-url',
  checkoutUrl: 'data-tixkit-checkout-url',
  docsUrl: 'data-tixkit-docs-url',
  uploadOrigin: 'data-tixkit-upload-origin',
  authProvider: 'data-tixkit-auth-provider',
  clerkPublishableKey: 'data-tixkit-clerk-publishable-key',
  buildRevision: 'data-tixkit-build-revision',
  configFingerprint: 'data-tixkit-config-fingerprint',
} as const;

export type AdminDeploymentProfile =
  | 'development'
  | 'test'
  | 'compact'
  | 'evaluation'
  | 'production'
  | 'cloud';

export type AdminAuthProvider = 'clerk' | 'dev';

export type PublicAdminRuntimeConfig = Readonly<{
  schemaVersion: typeof ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION;
  deploymentProfile: AdminDeploymentProfile;
  apiBaseUrl: string;
  platformApiBaseUrl: string;
  checkoutUrl: string;
  docsUrl?: string;
  uploadOrigin: string;
  authProvider: AdminAuthProvider;
  clerkPublishableKey?: string;
  buildRevision: string;
  configFingerprint: string;
}>;

export type RuntimeConfigAttributeReader = {
  getAttribute(name: string): string | null;
};

const BUILD_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const CLERK_KEY = /^pk_(?:test|live)_[A-Za-z0-9_-]{3,}$/u;
const MAX_PUBLIC_ATTRIBUTE_LENGTH = 512;

function hasControlOrCspDelimiter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 32 || codePoint === 127 || ';,"\'\\{}<>'.includes(character)) return true;
  }
  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$|\.$/gu, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:7f')
  );
}

export function parseExactOrigin(
  value: string,
  name: string,
  options: { allowLoopbackHttp: boolean },
): string {
  if (
    !value ||
    value.length > MAX_PUBLIC_ATTRIBUTE_LENGTH ||
    value !== value.trim() ||
    hasControlOrCspDelimiter(value) ||
    value.includes('*')
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  if (parsed.protocol !== 'https:') {
    if (!options.allowLoopbackHttp || !isLoopbackHostname(parsed.hostname)) {
      throw new Error(`${name} must use HTTPS`);
    }
  }
  if (isLoopbackHostname(parsed.hostname) && !options.allowLoopbackHttp) {
    throw new Error(`${name} must not use a loopback origin`);
  }
  return parsed.origin;
}

export function validateClerkPublishableKey(value: string): string {
  if (value.length > 256 || !CLERK_KEY.test(value)) {
    throw new Error('CLERK_PUBLISHABLE_KEY is invalid');
  }
  return value;
}

function requiredAttribute(reader: RuntimeConfigAttributeReader, name: string): string {
  const value = reader.getAttribute(name);
  if (value === null || value === '') throw new Error(`Missing runtime attribute ${name}`);
  if (value.length > MAX_PUBLIC_ATTRIBUTE_LENGTH) {
    throw new Error(`Runtime attribute ${name} is too long`);
  }
  return value;
}

export function readAdminRuntimeConfig(
  reader?: RuntimeConfigAttributeReader,
): PublicAdminRuntimeConfig {
  const source = reader ?? (typeof document === 'undefined' ? undefined : document.documentElement);
  if (!source) throw new Error('Admin runtime configuration is unavailable');

  const schemaVersion = requiredAttribute(source, ADMIN_RUNTIME_CONFIG_ATTRIBUTES.schemaVersion);
  if (schemaVersion !== ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION) {
    throw new Error('Unsupported admin runtime configuration schema');
  }
  const deploymentProfile = requiredAttribute(
    source,
    ADMIN_RUNTIME_CONFIG_ATTRIBUTES.deploymentProfile,
  ) as AdminDeploymentProfile;
  if (
    !['development', 'test', 'compact', 'evaluation', 'production', 'cloud'].includes(
      deploymentProfile,
    )
  ) {
    throw new Error('Invalid admin deployment profile');
  }
  const allowLoopbackHttp =
    deploymentProfile === 'development' ||
    deploymentProfile === 'test' ||
    deploymentProfile === 'compact';
  const apiBaseUrl = parseExactOrigin(
    requiredAttribute(source, ADMIN_RUNTIME_CONFIG_ATTRIBUTES.apiBaseUrl),
    'API_BASE_URL',
    { allowLoopbackHttp },
  );
  const expectedPlatformApiBaseUrl = `${apiBaseUrl}/v1`;
  const platformApiBaseUrl = requiredAttribute(
    source,
    ADMIN_RUNTIME_CONFIG_ATTRIBUTES.platformApiBaseUrl,
  );
  if (platformApiBaseUrl !== expectedPlatformApiBaseUrl) {
    throw new Error('Platform API URL does not match the admin API origin');
  }
  const checkoutUrl = parseExactOrigin(
    requiredAttribute(source, ADMIN_RUNTIME_CONFIG_ATTRIBUTES.checkoutUrl),
    'TIXKIT_CHECKOUT_URL',
    { allowLoopbackHttp },
  );
  const uploadOrigin = parseExactOrigin(
    requiredAttribute(source, ADMIN_RUNTIME_CONFIG_ATTRIBUTES.uploadOrigin),
    'S3_PUBLIC_ENDPOINT',
    { allowLoopbackHttp },
  );
  const docsValue = source.getAttribute(ADMIN_RUNTIME_CONFIG_ATTRIBUTES.docsUrl);
  const docsUrl = docsValue
    ? parseExactOrigin(docsValue, 'TIXKIT_DOCS_URL', { allowLoopbackHttp })
    : undefined;
  const authProvider = requiredAttribute(source, ADMIN_RUNTIME_CONFIG_ATTRIBUTES.authProvider);
  if (authProvider !== 'clerk' && authProvider !== 'dev') throw new Error('Invalid auth provider');
  if (
    ['evaluation', 'production', 'cloud'].includes(deploymentProfile) &&
    authProvider !== 'clerk'
  ) {
    throw new Error(`${deploymentProfile} requires Clerk authentication`);
  }
  const keyValue = source.getAttribute(ADMIN_RUNTIME_CONFIG_ATTRIBUTES.clerkPublishableKey);
  const clerkPublishableKey = keyValue ? validateClerkPublishableKey(keyValue) : undefined;
  if (authProvider === 'clerk' && !clerkPublishableKey)
    throw new Error('Clerk configuration is incomplete');
  if (authProvider === 'dev' && clerkPublishableKey)
    throw new Error('Dev auth must not include a Clerk key');
  const buildRevision = requiredAttribute(source, ADMIN_RUNTIME_CONFIG_ATTRIBUTES.buildRevision);
  if (!BUILD_REVISION.test(buildRevision)) throw new Error('Invalid build revision');
  const configFingerprint = requiredAttribute(
    source,
    ADMIN_RUNTIME_CONFIG_ATTRIBUTES.configFingerprint,
  );
  if (!FINGERPRINT.test(configFingerprint)) throw new Error('Invalid config fingerprint');

  return Object.freeze({
    schemaVersion,
    deploymentProfile,
    apiBaseUrl,
    platformApiBaseUrl,
    checkoutUrl,
    ...(docsUrl ? { docsUrl } : {}),
    uploadOrigin,
    authProvider,
    ...(clerkPublishableKey ? { clerkPublishableKey } : {}),
    buildRevision,
    configFingerprint,
  });
}

export function runtimeConfigDataAttributes(
  config: PublicAdminRuntimeConfig,
): Record<string, string> {
  return {
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.schemaVersion]: config.schemaVersion,
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.deploymentProfile]: config.deploymentProfile,
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.apiBaseUrl]: config.apiBaseUrl,
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.platformApiBaseUrl]: config.platformApiBaseUrl,
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.checkoutUrl]: config.checkoutUrl,
    ...(config.docsUrl ? { [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.docsUrl]: config.docsUrl } : {}),
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.uploadOrigin]: config.uploadOrigin,
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.authProvider]: config.authProvider,
    ...(config.clerkPublishableKey
      ? { [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.clerkPublishableKey]: config.clerkPublishableKey }
      : {}),
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.buildRevision]: config.buildRevision,
    [ADMIN_RUNTIME_CONFIG_ATTRIBUTES.configFingerprint]: config.configFingerprint,
  };
}
