import { createHash } from 'node:crypto';
import {
  ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION,
  parseExactOrigin,
  validateClerkPublishableKey,
  type AdminAuthProvider,
  type AdminDeploymentProfile,
  type PublicAdminRuntimeConfig,
} from './runtime-config-contract';

export type AdminRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const PROFILES = new Set<AdminDeploymentProfile>([
  'development',
  'test',
  'compact',
  'evaluation',
  'production',
  'cloud',
]);
const PRODUCTION_LIKE = new Set<AdminDeploymentProfile>(['evaluation', 'production', 'cloud']);
const BUILD_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLACEHOLDER_BUILD_REVISION =
  /^(?:latest|local|unknown|unset|development|dev|main|master|head|snapshot|unstable|placeholder|example|changeme)$/iu;
const CLERK_SECRET_KEY = /^sk_(?:test|live)_[A-Za-z0-9_-]{3,}$/u;

function profileFromEnvironment(environment: AdminRuntimeEnvironment): AdminDeploymentProfile {
  const configured = environment.TIXKIT_DEPLOYMENT_PROFILE?.toLowerCase();
  if (!configured && environment.NODE_ENV === 'production') {
    throw new Error('TIXKIT_DEPLOYMENT_PROFILE is required in production');
  }
  const fallback =
    environment.NODE_ENV === 'test'
      ? 'test'
      : environment.NODE_ENV === 'production'
        ? 'production'
        : 'development';
  const profile = (configured ?? fallback) as AdminDeploymentProfile;
  if (!PROFILES.has(profile)) throw new Error('TIXKIT_DEPLOYMENT_PROFILE is invalid');
  return profile;
}

function requiredOrLocalDefault(
  environment: AdminRuntimeEnvironment,
  key: string,
  profile: AdminDeploymentProfile,
  localDefault: string,
): string {
  const value = environment[key];
  if (value) return value;
  if (profile === 'development' || profile === 'test') return localDefault;
  throw new Error(`${key} is required`);
}

export function parseAdminRuntimeConfig(
  environment: AdminRuntimeEnvironment = process.env,
): PublicAdminRuntimeConfig {
  const deploymentProfile = profileFromEnvironment(environment);
  const allowInsecureLocalOrigins = environment.ALLOW_INSECURE_LOCAL_ORIGINS === '1';
  const allowLoopbackHttp =
    deploymentProfile === 'development' ||
    deploymentProfile === 'test' ||
    (deploymentProfile === 'compact' && allowInsecureLocalOrigins);
  const apiBaseUrl = parseExactOrigin(
    requiredOrLocalDefault(environment, 'API_BASE_URL', deploymentProfile, 'http://localhost:4000'),
    'API_BASE_URL',
    { allowLoopbackHttp },
  );
  const checkoutUrl = parseExactOrigin(
    requiredOrLocalDefault(
      environment,
      'TIXKIT_CHECKOUT_URL',
      deploymentProfile,
      'http://localhost:3000',
    ),
    'TIXKIT_CHECKOUT_URL',
    { allowLoopbackHttp },
  );
  const uploadOrigin = parseExactOrigin(
    requiredOrLocalDefault(
      environment,
      'S3_PUBLIC_ENDPOINT',
      deploymentProfile,
      'http://localhost:9000',
    ),
    'S3_PUBLIC_ENDPOINT',
    { allowLoopbackHttp },
  );
  const docsUrl = environment.TIXKIT_DOCS_URL
    ? parseExactOrigin(environment.TIXKIT_DOCS_URL, 'TIXKIT_DOCS_URL', { allowLoopbackHttp })
    : deploymentProfile === 'development' || deploymentProfile === 'test'
      ? 'http://localhost:3002'
      : undefined;

  const configuredProvider = environment.AUTH_PROVIDER?.toLowerCase();
  if (configuredProvider && configuredProvider !== 'clerk' && configuredProvider !== 'dev') {
    throw new Error('AUTH_PROVIDER must be clerk or dev');
  }
  const authProvider = (configuredProvider ??
    (deploymentProfile === 'development' || deploymentProfile === 'test'
      ? 'dev'
      : 'clerk')) as AdminAuthProvider;
  if (PRODUCTION_LIKE.has(deploymentProfile) && authProvider !== 'clerk') {
    throw new Error(`${deploymentProfile} requires Clerk authentication`);
  }
  if (deploymentProfile === 'compact' && authProvider === 'dev' && !allowInsecureLocalOrigins) {
    throw new Error('Compact dev authentication requires ALLOW_INSECURE_LOCAL_ORIGINS=1');
  }
  const clerkPublishableKey = environment.CLERK_PUBLISHABLE_KEY
    ? validateClerkPublishableKey(environment.CLERK_PUBLISHABLE_KEY)
    : undefined;
  if (authProvider === 'clerk' && !clerkPublishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY is required for Clerk authentication');
  }
  const clerkSecretKey = environment.CLERK_SECRET_KEY;
  if (
    authProvider === 'clerk' &&
    (!clerkSecretKey || clerkSecretKey.length > 256 || !CLERK_SECRET_KEY.test(clerkSecretKey))
  ) {
    throw new Error('CLERK_SECRET_KEY is required and must be a valid server secret');
  }
  if (authProvider === 'dev' && clerkPublishableKey) {
    throw new Error('CLERK_PUBLISHABLE_KEY must be omitted for dev authentication');
  }
  const buildRevision = environment.TIXKIT_BUILD_REVISION ?? 'development';
  if (PRODUCTION_LIKE.has(deploymentProfile) && !environment.TIXKIT_BUILD_REVISION) {
    throw new Error('TIXKIT_BUILD_REVISION is required for production-like profiles');
  }
  if (PRODUCTION_LIKE.has(deploymentProfile) && PLACEHOLDER_BUILD_REVISION.test(buildRevision)) {
    throw new Error('TIXKIT_BUILD_REVISION must identify an immutable production artifact');
  }
  if (!BUILD_REVISION.test(buildRevision)) throw new Error('TIXKIT_BUILD_REVISION is invalid');

  const canonical = JSON.stringify({
    schemaVersion: ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION,
    deploymentProfile,
    apiBaseUrl,
    platformApiBaseUrl: `${apiBaseUrl}/v1`,
    checkoutUrl,
    docsUrl: docsUrl ?? null,
    uploadOrigin,
    authProvider,
    clerkPublishableKey: clerkPublishableKey ?? null,
    buildRevision,
  });
  const configFingerprint = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  return Object.freeze({
    schemaVersion: ADMIN_RUNTIME_CONFIG_SCHEMA_VERSION,
    deploymentProfile,
    apiBaseUrl,
    platformApiBaseUrl: `${apiBaseUrl}/v1`,
    checkoutUrl,
    ...(docsUrl ? { docsUrl } : {}),
    uploadOrigin,
    authProvider,
    ...(clerkPublishableKey ? { clerkPublishableKey } : {}),
    buildRevision,
    configFingerprint,
  });
}

export function adminRuntimeReadiness(config: PublicAdminRuntimeConfig) {
  return {
    schemaVersion: config.schemaVersion,
    buildRevision: config.buildRevision,
    configFingerprint: config.configFingerprint,
  };
}
