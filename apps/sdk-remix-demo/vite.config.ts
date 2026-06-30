import { fileURLToPath } from 'node:url';
import { vitePlugin as remix } from '@remix-run/dev';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    remix({
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
      },
    }),
  ],
  resolve: {
    alias: [
      {
        find: '@tixkit/remix/server',
        replacement: fileURLToPath(
          new URL('../../packages/sdk-remix/src/server.ts', import.meta.url),
        ),
      },
      {
        find: '@tixkit/remix/client',
        replacement: fileURLToPath(
          new URL('../../packages/sdk-remix/src/client.ts', import.meta.url),
        ),
      },
      {
        find: '@tixkit/remix',
        replacement: fileURLToPath(
          new URL('../../packages/sdk-remix/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@tixkit/js',
        replacement: fileURLToPath(new URL('../../packages/sdk-js/src/index.ts', import.meta.url)),
      },
    ],
  },
  server: {
    port: 3002,
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
