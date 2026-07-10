const checkoutSecurityHeaders = [
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Next 16's embedded checker uses removed TypeScript internals. The repo's
  // mandatory TS 7 `typecheck` gate runs separately before every CI build.
  typescript: { ignoreBuildErrors: true },
  transpilePackages: ['@tixkit/content-event-page-react', '@tixkit/content-event-page'],
  env: {
    NEXT_PUBLIC_TIXKIT_API_BASE_URL:
      process.env.NEXT_PUBLIC_TIXKIT_API_BASE_URL ??
      process.env.NEXT_PUBLIC_API_BASE_URL ??
      'http://localhost:4000/v1',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: checkoutSecurityHeaders,
      },
    ];
  },
};

export default nextConfig;
