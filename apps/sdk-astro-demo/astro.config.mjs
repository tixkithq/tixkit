import { defineConfig } from 'astro/config';

export default defineConfig({
  devToolbar: {
    enabled: false,
  },
  server: {
    port: 4321,
  },
});
