/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  experimental: { useTypeScriptCli: true },
  // The mandatory TS 7 `typecheck` gate runs separately before every CI build.
  typescript: { ignoreBuildErrors: true },
  transpilePackages: [
    '@tixkit/content-email',
    '@tixkit/content-editor-shell',
    '@tixkit/content-event-page-react',
    '@tixkit/content-event-page',
    '@tixkit/js',
    '@tixkit/next',
  ],
};

export default nextConfig;
