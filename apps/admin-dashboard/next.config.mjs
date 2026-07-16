const invalidCspInputPattern = /[\u0000-\u0020\u007f;,"'\\]/u;

export function isLoopbackHostname(hostname) {
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

function configuredHttpOrigin(value, { name, production, allowInsecureLocalOrigins }) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || invalidCspInputPattern.test(value)) {
    throw new Error(`${name} must be a valid HTTP(S) URL without CSP delimiters`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (parsed.hostname.includes('*')) {
    throw new Error(`${name} must use an exact hostname`);
  }
  if (production) {
    const loopback = isLoopbackHostname(parsed.hostname);
    const compactLoopbackEscape =
      allowInsecureLocalOrigins === true && loopback && parsed.protocol === 'http:';
    if (loopback && !compactLoopbackEscape) {
      throw new Error(`${name} must not use a loopback origin in production`);
    }
    if (parsed.protocol !== 'https:' && !compactLoopbackEscape) {
      throw new Error(`${name} must use HTTPS in production`);
    }
  }
  return parsed.origin;
}

/**
 * Build the admin CSP without reading ambient environment state. Configured
 * application URLs are reduced to origins so paths and query strings can never
 * expand the policy. Production intentionally has no localhost fallback.
 *
 * @param {{ nodeEnv?: string, apiUrl?: string, checkoutUrl?: string, disableReactDevtools?: boolean, allowInsecureLocalOrigins?: boolean }} options
 */
export function adminContentSecurityPolicy({
  nodeEnv,
  apiUrl,
  checkoutUrl,
  disableReactDevtools = false,
  allowInsecureLocalOrigins = false,
}) {
  const production = nodeEnv === 'production';
  const refineDevelopmentSources =
    production || disableReactDevtools ? [] : ['http://localhost:7331', 'https://esm.sh'];
  const apiOrigin = configuredHttpOrigin(apiUrl, {
    name: 'admin API URL',
    production,
    allowInsecureLocalOrigins,
  });
  const checkoutOrigin = configuredHttpOrigin(checkoutUrl, {
    name: 'checkout URL',
    production,
    allowInsecureLocalOrigins,
  });
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    ...(production ? [] : ["'unsafe-eval'", ...refineDevelopmentSources]),
    'https://*.clerk.accounts.dev',
    'https://*.clerk.com',
  ];
  const connectSources = [
    "'self'",
    ...(apiOrigin ? [apiOrigin] : []),
    ...(checkoutOrigin ? [checkoutOrigin] : []),
    'https://*.clerk.accounts.dev',
    'https://*.clerk.com',
    ...(production
      ? []
      : [
          'http://localhost:*',
          'http://127.0.0.1:*',
          'ws://localhost:*',
          'ws://127.0.0.1:*',
          ...refineDevelopmentSources.filter((source) => source === 'https://esm.sh'),
        ]),
  ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://*.clerk.accounts.dev https://*.clerk.com",
    ['img-src', "'self'", 'data:', 'blob:', 'https:', ...(apiOrigin ? [apiOrigin] : [])].join(' '),
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSources.join(' ')}`,
    `connect-src ${connectSources.join(' ')}`,
    [
      'frame-src',
      "'self'",
      ...(checkoutOrigin ? [checkoutOrigin] : []),
      'https://*.clerk.accounts.dev',
      'https://*.clerk.com',
    ].join(' '),
    "worker-src 'self' blob:",
  ].join('; ');
}

const adminCsp = adminContentSecurityPolicy({
  nodeEnv: process.env.NODE_ENV,
  apiUrl:
    process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ??
    process.env.NEXT_PUBLIC_API_BASE_URL ??
    (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:4000'),
  checkoutUrl:
    process.env.NEXT_PUBLIC_CHECKOUT_URL ??
    process.env.PUBLIC_CHECKOUT_URL ??
    (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000'),
  disableReactDevtools: process.env.NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS === '1',
  allowInsecureLocalOrigins: process.env.ALLOW_INSECURE_LOCAL_ORIGINS === '1',
});

const adminSecurityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: adminCsp,
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Next 16's embedded checker uses removed TypeScript internals. The repo's
  // mandatory TS 7 `typecheck` gate runs separately before every CI build.
  typescript: { ignoreBuildErrors: true },
  transpilePackages: [
    '@tixkit/content-email',
    '@tixkit/content-editor-shell',
    '@tixkit/content-event-page-react',
    '@tixkit/content-event-page',
    '@tixkit/js',
    '@tixkit/next',
  ],
  env: {
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/v1',
    NEXT_PUBLIC_ADMIN_API_BASE_URL:
      process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? 'http://localhost:4000',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: adminSecurityHeaders,
      },
    ];
  },
};

export default nextConfig;
