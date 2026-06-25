/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@gatekit/js', '@gatekit/next'],
  env: {
    NEXT_PUBLIC_API_BASE_URL:
      process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/v1',
    NEXT_PUBLIC_ADMIN_API_BASE_URL:
      process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? 'http://localhost:4000',
  },
};

export default nextConfig;
