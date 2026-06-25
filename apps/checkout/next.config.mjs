/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [],
  env: {
    NEXT_PUBLIC_GATEKIT_API_BASE_URL:
      process.env.NEXT_PUBLIC_GATEKIT_API_BASE_URL ??
      process.env.NEXT_PUBLIC_API_BASE_URL ??
      'http://localhost:4000/v1',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
  },
}

export default nextConfig
