/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // TypeScript 7 is enforced by the workspace typecheck; Next 16's embedded
  // checker still imports TypeScript internals removed in TS 7.
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
