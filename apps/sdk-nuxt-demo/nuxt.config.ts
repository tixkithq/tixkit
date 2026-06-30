import { fileURLToPath } from 'node:url';

const sdkVueServer = fileURLToPath(
  new URL('../../packages/sdk-vue/src/server.ts', import.meta.url),
);
const sdkVueClient = fileURLToPath(
  new URL('../../packages/sdk-vue/src/client.ts', import.meta.url),
);
const sdkVueIndex = fileURLToPath(
  new URL('../../packages/sdk-vue/src/index.ts', import.meta.url),
);
const sdkJsIndex = fileURLToPath(new URL('../../packages/sdk-js/src/index.ts', import.meta.url));

export default defineNuxtConfig({
  devtools: { enabled: false },
  typescript: { strict: true },
  alias: {
    '@tixkit/vue/server': sdkVueServer,
    '@tixkit/vue/client': sdkVueClient,
    '@tixkit/vue': sdkVueIndex,
    '@tixkit/js': sdkJsIndex,
  },
  runtimeConfig: {
    tixkitApiKey: process.env.TIXKIT_API_KEY ?? '',
    tixkitWebhookSecret: process.env.TIXKIT_WEBHOOK_SECRET ?? '',
    public: {
      tixkitCheckoutUrl: process.env.NUXT_PUBLIC_TIXKIT_CHECKOUT_URL ?? 'http://localhost:3201',
    },
  },
  vite: {
    resolve: {
      alias: [
        {
          find: '@tixkit/vue/server',
          replacement: sdkVueServer,
        },
        {
          find: '@tixkit/vue/client',
          replacement: sdkVueClient,
        },
        {
          find: '@tixkit/vue',
          replacement: sdkVueIndex,
        },
        {
          find: '@tixkit/js',
          replacement: sdkJsIndex,
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
