import { createHash } from 'node:crypto';
import {
  CHECKOUT_RUNTIME_CONFIG_SCHEMA_VERSION,
  parseExactOrigin,
  validateDomainBrandMap,
  validateStripePublishableKey,
  type CheckoutDeploymentProfile,
  type PublicCheckoutRuntimeConfig,
} from './runtime-config-contract';

export type CheckoutRuntimeEnvironment = Readonly<Record<string, string | undefined>>;
export type CheckoutServerRuntime = Readonly<{
  publicConfig: PublicCheckoutRuntimeConfig;
  internalApiBaseUrl: string;
}>;
const PROFILES = new Set<CheckoutDeploymentProfile>([
  'development',
  'test',
  'compact',
  'evaluation',
  'production',
  'cloud',
]);
const PRODUCTION_LIKE = new Set<CheckoutDeploymentProfile>(['evaluation', 'production', 'cloud']);
const BUILD_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLACEHOLDER =
  /^(?:latest|local|unknown|unset|development|dev|main|master|head|snapshot|unstable|placeholder|example|changeme)$/iu;

function profile(environment: CheckoutRuntimeEnvironment): CheckoutDeploymentProfile {
  const configured = environment.TIXKIT_DEPLOYMENT_PROFILE?.toLowerCase();
  if (!configured && environment.NODE_ENV === 'production')
    throw new Error('TIXKIT_DEPLOYMENT_PROFILE is required in production');
  const value = (configured ??
    (environment.NODE_ENV === 'test' ? 'test' : 'development')) as CheckoutDeploymentProfile;
  if (!PROFILES.has(value)) throw new Error('TIXKIT_DEPLOYMENT_PROFILE is invalid');
  return value;
}

function requiredOrLocal(
  environment: CheckoutRuntimeEnvironment,
  key: string,
  deploymentProfile: CheckoutDeploymentProfile,
  fallback: string,
): string {
  const value = environment[key];
  if (value) return value;
  if (deploymentProfile === 'development' || deploymentProfile === 'test') return fallback;
  throw new Error(`${key} is required`);
}

export function parseCheckoutRuntimeConfig(
  environment: CheckoutRuntimeEnvironment = process.env,
): PublicCheckoutRuntimeConfig {
  const deploymentProfile = profile(environment);
  const allowLoopbackHttp =
    ['development', 'test'].includes(deploymentProfile) ||
    (deploymentProfile === 'compact' && environment.ALLOW_INSECURE_LOCAL_ORIGINS === '1');
  const apiBaseUrl = parseExactOrigin(
    requiredOrLocal(environment, 'API_BASE_URL', deploymentProfile, 'http://localhost:4000'),
    'API_BASE_URL',
    { allowLoopbackHttp },
  );
  const checkoutUrl = parseExactOrigin(
    requiredOrLocal(environment, 'TIXKIT_CHECKOUT_URL', deploymentProfile, 'http://localhost:3000'),
    'TIXKIT_CHECKOUT_URL',
    { allowLoopbackHttp },
  );
  const mediaOrigin = parseExactOrigin(
    requiredOrLocal(environment, 'S3_PUBLIC_ENDPOINT', deploymentProfile, 'http://localhost:9000'),
    'S3_PUBLIC_ENDPOINT',
    { allowLoopbackHttp },
  );
  const stripePublishableKey = environment.STRIPE_PUBLISHABLE_KEY
    ? validateStripePublishableKey(environment.STRIPE_PUBLISHABLE_KEY)
    : undefined;
  if (PRODUCTION_LIKE.has(deploymentProfile) && !stripePublishableKey)
    throw new Error('STRIPE_PUBLISHABLE_KEY is required for production-like profiles');
  const domainBrandMap = environment.TIXKIT_DOMAIN_BRANDS
    ? validateDomainBrandMap(environment.TIXKIT_DOMAIN_BRANDS)
    : undefined;
  const buildRevision = environment.TIXKIT_BUILD_REVISION ?? 'development';
  if (
    PRODUCTION_LIKE.has(deploymentProfile) &&
    (!environment.TIXKIT_BUILD_REVISION || PLACEHOLDER.test(buildRevision))
  ) {
    throw new Error('TIXKIT_BUILD_REVISION must identify an immutable production artifact');
  }
  if (!BUILD_REVISION.test(buildRevision)) throw new Error('TIXKIT_BUILD_REVISION is invalid');
  const canonical = JSON.stringify({
    schemaVersion: CHECKOUT_RUNTIME_CONFIG_SCHEMA_VERSION,
    deploymentProfile,
    apiBaseUrl,
    platformApiBaseUrl: `${apiBaseUrl}/v1`,
    checkoutUrl,
    mediaOrigin,
    stripePublishableKey: stripePublishableKey ?? null,
    domainBrandMap: domainBrandMap ?? null,
    buildRevision,
  });
  const configFingerprint = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  return Object.freeze({
    schemaVersion: CHECKOUT_RUNTIME_CONFIG_SCHEMA_VERSION,
    deploymentProfile,
    apiBaseUrl,
    platformApiBaseUrl: `${apiBaseUrl}/v1`,
    checkoutUrl,
    mediaOrigin,
    ...(stripePublishableKey ? { stripePublishableKey } : {}),
    ...(domainBrandMap ? { domainBrandMap } : {}),
    buildRevision,
    configFingerprint,
  });
}

function parseInternalOrigin(value: string): string {
  const hasUnsafeCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 32 || codePoint === 127 || ';,"\'\\{}<>*'.includes(character);
  });
  if (!value || value.length > 512 || value !== value.trim() || hasUnsafeCharacter) {
    throw new Error('INTERNAL_API_BASE_URL must be an exact HTTP(S) origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('INTERNAL_API_BASE_URL must be an exact HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('INTERNAL_API_BASE_URL must be an exact HTTP(S) origin');
  }
  return parsed.origin;
}

export function parseCheckoutServerRuntime(
  environment: CheckoutRuntimeEnvironment = process.env,
): CheckoutServerRuntime {
  const publicConfig = parseCheckoutRuntimeConfig(environment);
  const internalApiBaseUrl = environment.INTERNAL_API_BASE_URL
    ? parseInternalOrigin(environment.INTERNAL_API_BASE_URL)
    : publicConfig.apiBaseUrl;
  return Object.freeze({ publicConfig, internalApiBaseUrl });
}

export function checkoutRuntimeReadiness(config: PublicCheckoutRuntimeConfig) {
  return {
    schemaVersion: config.schemaVersion,
    buildRevision: config.buildRevision,
    configFingerprint: config.configFingerprint,
  };
}
