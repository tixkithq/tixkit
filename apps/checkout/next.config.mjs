const checkoutSecurityHeaders = [
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  experimental: { useTypeScriptCli: true },
  // The mandatory TS 7 `typecheck` gate runs separately before every CI build.
  typescript: { ignoreBuildErrors: true },
  transpilePackages: ['@tixkit/content-event-page-react', '@tixkit/content-event-page'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: checkoutSecurityHeaders,
      },
      {
        source: '/checkout',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },
};

export default nextConfig;
