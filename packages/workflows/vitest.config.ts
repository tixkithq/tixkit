import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workspacePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@tixkit\/db\/migrate$/, replacement: workspacePath('../db/src/migrate.ts') },
      { find: /^@tixkit\/db$/, replacement: workspacePath('../db/src/index.ts') },
      {
        find: /^@tixkit\/domain\/developer$/,
        replacement: workspacePath('../domain/src/developer/index.ts'),
      },
      {
        find: /^@tixkit\/domain\/messaging$/,
        replacement: workspacePath('../domain/src/messaging/index.ts'),
      },
      {
        find: /^@tixkit\/domain\/tickets$/,
        replacement: workspacePath('../domain/src/tickets/index.ts'),
      },
      { find: /^@tixkit\/domain$/, replacement: workspacePath('../domain/src/index.ts') },
      { find: /^@tixkit\/shared$/, replacement: workspacePath('../shared/src/index.ts') },
      {
        find: /^@tixkit\/content-core$/,
        replacement: workspacePath('../content-core/src/index.ts'),
      },
      {
        find: /^@tixkit\/content-message$/,
        replacement: workspacePath('../content-message/src/index.ts'),
      },
      {
        find: /^@tixkit\/email-transport$/,
        replacement: workspacePath('../email-transport/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: '../../coverage/packages/workflows',
      all: false,
      thresholds: {
        statements: 35,
        branches: 24,
        functions: 30,
        lines: 35,
      },
    },
  },
});
