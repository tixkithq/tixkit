const checkoutFrameSrc = process.env.PUBLIC_CHECKOUT_URL?.trim()
  ? new URL(process.env.PUBLIC_CHECKOUT_URL).origin
  : 'http://localhost:3000';

function originFromUrl(value, fallback) {
  try {
    return new URL(value?.trim() || fallback).origin;
  } catch {
    return new URL(fallback).origin;
  }
}

const adminApiImageSrc = originFromUrl(
  process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL,
  'http://localhost:4000',
);

const adminSecurityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self' https://*.clerk.accounts.dev https://*.clerk.com",
      `img-src 'self' data: blob: https: ${adminApiImageSrc}`,
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com",
      "connect-src 'self' http://localhost:* http://127.0.0.1:* https:",
      `frame-src 'self' ${checkoutFrameSrc} https://*.clerk.accounts.dev https://*.clerk.com`,
      "worker-src 'self' blob:",
    ].join('; '),
  },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
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
