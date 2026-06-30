import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  devToolbar: {
    enabled: false,
  },
  server: {
    port: 4321,
  },
  vite: {
    resolve: {
      alias: [
        {
          find: '@tixkit/astro/server',
          replacement: fileURLToPath(
            new URL('../../packages/sdk-astro/src/server.ts', import.meta.url),
          ),
        },
        {
          find: '@tixkit/astro/client',
          replacement: fileURLToPath(
            new URL('../../packages/sdk-astro/src/client.ts', import.meta.url),
          ),
        },
        {
          find: '@tixkit/astro',
          replacement: fileURLToPath(
            new URL('../../packages/sdk-astro/src/index.ts', import.meta.url),
          ),
        },
        {
          find: '@tixkit/js',
          replacement: fileURLToPath(
            new URL('../../packages/sdk-js/src/index.ts', import.meta.url),
          ),
        },
      ],
    },
    build: {
      target: 'esnext',
    },
    esbuild: {
      target: 'esnext',
    },
  },
});
