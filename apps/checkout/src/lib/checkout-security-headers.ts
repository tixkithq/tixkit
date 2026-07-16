import type { PublicCheckoutRuntimeConfig } from './runtime-config-contract';

export function checkoutContentSecurityPolicy(
  config: PublicCheckoutRuntimeConfig,
  nonce: string,
): string {
  const development = config.deploymentProfile === 'development';
  const localProfile = ['development', 'test', 'compact'].includes(config.deploymentProfile);
  const developmentSources = development
    ? ['http://localhost:*', 'http://127.0.0.1:*', 'ws://localhost:*', 'ws://127.0.0.1:*']
    : [];
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    // Public checkout is intentionally embeddable by HTTPS storefronts. This
    // permits framing; it does not authenticate or authorize the parent.
    `frame-ancestors 'self' https:${localProfile ? ' http://localhost:* http://127.0.0.1:*' : ''}`,
    `img-src 'self' data: blob: ${config.apiBaseUrl} ${config.mediaOrigin} https://*.stripe.com`,
    "font-src 'self' data:",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com https://*.js.stripe.com ${developmentSources.join(' ')}`.trim(),
    `connect-src 'self' ${config.apiBaseUrl} ${config.mediaOrigin} https://api.stripe.com https://r.stripe.com ${developmentSources.join(' ')}`.trim(),
    "frame-src 'self' https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
    "worker-src 'self' blob:",
    ...(config.apiBaseUrl.startsWith('http://') ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function checkoutSecurityHeaders(
  config: PublicCheckoutRuntimeConfig,
  nonce: string,
  options: { noReferrer?: boolean } = {},
): Readonly<Record<string, string>> {
  return Object.freeze({
    'Content-Security-Policy': checkoutContentSecurityPolicy(config, nonce),
    'Referrer-Policy': options.noReferrer ? 'no-referrer' : 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
}

export const INVALID_RUNTIME_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
});
