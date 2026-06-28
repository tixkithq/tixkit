import { defineConfig } from 'vitest/config';

/**
 * API package vitest configuration.
 *
 * The globalSetup ensures the database schema is migrated before DB-backed
 * integration tests (inventory concurrency, load harnesses) run. When
 * DATABASE_URL is unset, the setup is a no-op and those suites skip via
 * `describe.skipIf(!process.env.DATABASE_URL)`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    globalSetup: ['./src/__tests__/integration/migration-setup.ts'],
    setupFiles: ['./src/__tests__/integration/otel-interop-fix.ts'],
  },
});
