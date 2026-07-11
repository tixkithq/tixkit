# Headless checkout framework examples

Each directory is a minimal, buildable framework application using the public `@tixkit/checkout-headless@0.1.0` package contract. `scripts/test-checkout-headless-consumers.mjs` packs the local package, copies every example outside the monorepo, replaces only that dependency with the tarball, performs a clean install, and runs the framework's real production build.

The React, Next, and Remix examples use the React binding; Vue and Nuxt use the Vue binding; Svelte and SvelteKit use the Svelte store binding; Astro uses the framework-neutral controller directly. Checkout business state remains in the core controller.
