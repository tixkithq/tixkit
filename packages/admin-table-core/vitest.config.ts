import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: '../../coverage/packages/admin-table-core',
      all: true,
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 78,
        branches: 68,
        functions: 74,
        lines: 78,
      },
    },
  },
});
