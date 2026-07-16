import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';

describe('admin dashboard build configuration', () => {
  it('does not freeze deployment configuration or security headers into the build', () => {
    expect(nextConfig.env).toBeUndefined();
    expect(nextConfig.headers).toBeUndefined();
  });
});
