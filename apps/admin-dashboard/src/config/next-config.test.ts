import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';

describe('admin dashboard security headers', () => {
  it('allows same-origin camera access while keeping microphone and geolocation disabled', async () => {
    if (!nextConfig.headers) throw new Error('Next config must define security headers');
    const routes = await nextConfig.headers();
    const catchAll = routes.find((route: { source: string }) => route.source === '/:path*');
    const permissionsPolicy = catchAll?.headers.find(
      (header: { key: string }) => header.key === 'Permissions-Policy',
    );

    expect(permissionsPolicy?.value).toBe('camera=(self), microphone=(), geolocation=()');
  });
});
