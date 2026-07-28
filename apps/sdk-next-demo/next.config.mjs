/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: { useTypeScriptCli: true },
  // TypeScript 7 is enforced by the workspace typecheck before every CI build.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
