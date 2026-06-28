export default defineNuxtConfig({
  devtools: { enabled: false },
  typescript: { strict: true },
  runtimeConfig: {
    tixkitApiKey: process.env.TIXKIT_API_KEY ?? '',
    tixkitWebhookSecret: process.env.TIXKIT_WEBHOOK_SECRET ?? '',
  },
  vite: {
    build: {
      target: 'esnext',
    },
    esbuild: {
      target: 'esnext',
    },
  },
});
