import type { PublicAdminRuntimeConfig } from './runtime-config-contract';

export const ADMIN_SECURITY_HEADER_NAMES = [
  'Content-Security-Policy',
  'Referrer-Policy',
  'Permissions-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
] as const;

// Sonner and react-remove-scroll create bundled, static <style> elements at
// runtime. Keep these hashes pinned to those exact styles instead of allowing
// arbitrary inline styles in production.
const RUNTIME_STYLE_HASHES = [
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
  "'sha256-CIxDM5jnsGiKqXs2v7NKCY5MzdR9gu6TtiMJrDw29AY='",
  "'sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo='",
] as const;

export function adminContentSecurityPolicy(
  config: PublicAdminRuntimeConfig,
  nonce: string,
  options: { development?: boolean } = {},
): string {
  if (!/^[A-Za-z0-9+/_=-]{1,128}$/u.test(nonce)) {
    throw new TypeError('CSP nonce must be a bounded base64 value');
  }
  const development = options.development === true;
  const clerkSources = ['https://*.clerk.accounts.dev', 'https://*.clerk.com'];
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(development
      ? ["'unsafe-inline'", "'unsafe-eval'", 'http://localhost:7331', 'https://esm.sh']
      : []),
    ...clerkSources,
  ];
  const connectSources = [
    "'self'",
    config.apiBaseUrl,
    config.checkoutUrl,
    config.uploadOrigin,
    ...clerkSources,
    ...(development
      ? [
          'http://localhost:*',
          'http://127.0.0.1:*',
          'ws://localhost:*',
          'ws://127.0.0.1:*',
          'https://esm.sh',
        ]
      : []),
  ];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `form-action 'self' ${clerkSources.join(' ')}`,
    `img-src 'self' data: blob: https: ${config.apiBaseUrl} ${config.uploadOrigin}`,
    "font-src 'self' data:",
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}' ${RUNTIME_STYLE_HASHES.join(' ')}`,
    "style-src-attr 'unsafe-inline'",
    `script-src ${scriptSources.join(' ')}`,
    "script-src-attr 'none'",
    `connect-src ${connectSources.join(' ')}`,
    `frame-src 'self' ${config.checkoutUrl} ${clerkSources.join(' ')}`,
    "worker-src 'self' blob:",
  ].join('; ');
}

export function adminSecurityHeaders(
  config: PublicAdminRuntimeConfig,
  nonce: string,
): Readonly<Record<string, string>> {
  const development = config.deploymentProfile === 'development';
  return Object.freeze({
    'Content-Security-Policy': adminContentSecurityPolicy(config, nonce, { development }),
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  });
}

export const INVALID_RUNTIME_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
});
