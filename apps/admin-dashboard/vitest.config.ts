import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    tsconfigRaw: {
      compilerOptions: {
        jsx: 'react-jsx',
        jsxImportSource: 'react',
      },
    },
  },
  oxc: false,
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: '../../coverage/apps/admin-dashboard',
      all: false,
      thresholds: {
        statements: 35,
        branches: 24,
        functions: 30,
        lines: 35,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(configDirectory, './src'),
    },
  },
});
