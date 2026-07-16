export const CHECKOUT_RUNTIME_CONFIG_SCHEMA_VERSION = '1' as const;

export const CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES = {
  schemaVersion: 'data-tixkit-runtime-schema',
  deploymentProfile: 'data-tixkit-deployment-profile',
  apiBaseUrl: 'data-tixkit-api-base-url',
  platformApiBaseUrl: 'data-tixkit-platform-api-base-url',
  checkoutUrl: 'data-tixkit-checkout-url',
  mediaOrigin: 'data-tixkit-media-origin',
  stripePublishableKey: 'data-tixkit-stripe-publishable-key',
  domainBrandMap: 'data-tixkit-domain-brand-map',
  buildRevision: 'data-tixkit-build-revision',
  configFingerprint: 'data-tixkit-config-fingerprint',
} as const;

export type CheckoutDeploymentProfile =
  | 'development'
  | 'test'
  | 'compact'
  | 'evaluation'
  | 'production'
  | 'cloud';

export type PublicCheckoutRuntimeConfig = Readonly<{
  schemaVersion: typeof CHECKOUT_RUNTIME_CONFIG_SCHEMA_VERSION;
  deploymentProfile: CheckoutDeploymentProfile;
  apiBaseUrl: string;
  platformApiBaseUrl: string;
  checkoutUrl: string;
  mediaOrigin: string;
  stripePublishableKey?: string;
  domainBrandMap?: string;
  buildRevision: string;
  configFingerprint: string;
}>;

export type RuntimeConfigAttributeReader = { getAttribute(name: string): string | null };

const BUILD_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLACEHOLDER_BUILD_REVISION =
  /^(?:latest|local|unknown|unset|development|dev|main|master|head|snapshot|unstable|placeholder|example|changeme)$/iu;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const STRIPE_KEY = /^pk_(?:test|live)_[A-Za-z0-9_-]{3,}$/u;
const BRAND_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_ATTRIBUTE_LENGTH = 4096;

function hasUnsafeOriginCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 32 || codePoint === 127 || ';,"\'\\{}<>*'.includes(character)) return true;
  }
  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$|\.$/gu, '');
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '0.0.0.0' ||
    value === '::' ||
    value.endsWith('.localhost') ||
    value.startsWith('127.') ||
    value.startsWith('::ffff:7f')
  );
}

export function parseExactOrigin(
  value: string,
  name: string,
  options: { allowLoopbackHttp: boolean },
): string {
  if (!value || value.length > 512 || value !== value.trim() || hasUnsafeOriginCharacter(value)) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  if (
    parsed.protocol !== 'https:' &&
    (!options.allowLoopbackHttp || !isLoopbackHostname(parsed.hostname))
  ) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (isLoopbackHostname(parsed.hostname) && !options.allowLoopbackHttp) {
    throw new Error(`${name} must not use a loopback origin`);
  }
  return parsed.origin;
}

export function validateStripePublishableKey(value: string): string {
  if (value.length > 256 || !STRIPE_KEY.test(value))
    throw new Error('STRIPE_PUBLISHABLE_KEY is invalid');
  return value;
}

export function validateDomainBrandMap(value: string): string {
  if (!value || value.length > MAX_ATTRIBUTE_LENGTH)
    throw new Error('TIXKIT_DOMAIN_BRANDS is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('TIXKIT_DOMAIN_BRANDS must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TIXKIT_DOMAIN_BRANDS must be a JSON object');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 100) throw new Error('TIXKIT_DOMAIN_BRANDS has too many entries');
  const canonical: Record<string, string> = {};
  for (const [hostname, brandId] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (hostname.length > 253 || typeof brandId !== 'string' || !BRAND_ID.test(brandId)) {
      throw new Error('TIXKIT_DOMAIN_BRANDS contains an invalid mapping');
    }
    const wildcard = hostname.startsWith('*.');
    const candidate = wildcard ? hostname.slice(2) : hostname;
    let normalized: string;
    try {
      const parsedHost = new URL(`https://${candidate}`);
      if (
        parsedHost.hostname !== candidate.toLowerCase() ||
        parsedHost.port ||
        parsedHost.pathname !== '/'
      ) {
        throw new Error('invalid');
      }
      normalized = `${wildcard ? '*.' : ''}${parsedHost.hostname}`;
    } catch {
      throw new Error('TIXKIT_DOMAIN_BRANDS contains an invalid hostname');
    }
    canonical[normalized] = brandId;
  }
  return JSON.stringify(canonical);
}

function required(reader: RuntimeConfigAttributeReader, name: string): string {
  const value = reader.getAttribute(name);
  if (!value) throw new Error(`Missing runtime attribute ${name}`);
  if (value.length > MAX_ATTRIBUTE_LENGTH) throw new Error(`Runtime attribute ${name} is too long`);
  return value;
}

export function readCheckoutRuntimeConfig(
  reader: RuntimeConfigAttributeReader,
): PublicCheckoutRuntimeConfig {
  const schemaVersion = required(reader, CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.schemaVersion);
  if (schemaVersion !== CHECKOUT_RUNTIME_CONFIG_SCHEMA_VERSION)
    throw new Error('Unsupported checkout runtime configuration schema');
  const deploymentProfile = required(
    reader,
    CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.deploymentProfile,
  ) as CheckoutDeploymentProfile;
  if (
    !['development', 'test', 'compact', 'evaluation', 'production', 'cloud'].includes(
      deploymentProfile,
    )
  ) {
    throw new Error('Invalid checkout deployment profile');
  }
  const allowLoopbackHttp = ['development', 'test', 'compact'].includes(deploymentProfile);
  const apiBaseUrl = parseExactOrigin(
    required(reader, CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.apiBaseUrl),
    'API_BASE_URL',
    { allowLoopbackHttp },
  );
  const platformApiBaseUrl = required(
    reader,
    CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.platformApiBaseUrl,
  );
  if (platformApiBaseUrl !== `${apiBaseUrl}/v1`)
    throw new Error('Platform API URL does not match the checkout API origin');
  const checkoutUrl = parseExactOrigin(
    required(reader, CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.checkoutUrl),
    'TIXKIT_CHECKOUT_URL',
    { allowLoopbackHttp },
  );
  const mediaOrigin = parseExactOrigin(
    required(reader, CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.mediaOrigin),
    'S3_PUBLIC_ENDPOINT',
    { allowLoopbackHttp },
  );
  const stripeValue = reader.getAttribute(CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.stripePublishableKey);
  const stripePublishableKey = stripeValue ? validateStripePublishableKey(stripeValue) : undefined;
  if (['evaluation', 'production', 'cloud'].includes(deploymentProfile) && !stripePublishableKey) {
    throw new Error(`${deploymentProfile} requires Stripe configuration`);
  }
  const mapValue = reader.getAttribute(CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.domainBrandMap);
  const domainBrandMap = mapValue ? validateDomainBrandMap(mapValue) : undefined;
  const buildRevision = required(reader, CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.buildRevision);
  if (!BUILD_REVISION.test(buildRevision)) throw new Error('Invalid build revision');
  if (
    ['evaluation', 'production', 'cloud'].includes(deploymentProfile) &&
    PLACEHOLDER_BUILD_REVISION.test(buildRevision)
  ) {
    throw new Error('Build revision must identify an immutable production artifact');
  }
  const configFingerprint = required(reader, CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.configFingerprint);
  if (!FINGERPRINT.test(configFingerprint)) throw new Error('Invalid config fingerprint');
  return Object.freeze({
    schemaVersion,
    deploymentProfile,
    apiBaseUrl,
    platformApiBaseUrl,
    checkoutUrl,
    mediaOrigin,
    ...(stripePublishableKey ? { stripePublishableKey } : {}),
    ...(domainBrandMap ? { domainBrandMap } : {}),
    buildRevision,
    configFingerprint,
  });
}

export function runtimeConfigDataAttributes(
  config: PublicCheckoutRuntimeConfig,
): Record<string, string> {
  return {
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.schemaVersion]: config.schemaVersion,
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.deploymentProfile]: config.deploymentProfile,
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.apiBaseUrl]: config.apiBaseUrl,
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.platformApiBaseUrl]: config.platformApiBaseUrl,
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.checkoutUrl]: config.checkoutUrl,
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.mediaOrigin]: config.mediaOrigin,
    ...(config.stripePublishableKey
      ? { [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.stripePublishableKey]: config.stripePublishableKey }
      : {}),
    ...(config.domainBrandMap
      ? { [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.domainBrandMap]: config.domainBrandMap }
      : {}),
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.buildRevision]: config.buildRevision,
    [CHECKOUT_RUNTIME_CONFIG_ATTRIBUTES.configFingerprint]: config.configFingerprint,
  };
}
