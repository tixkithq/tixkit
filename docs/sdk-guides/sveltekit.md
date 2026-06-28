# SvelteKit SDK

API version: `2026-01-01`

Use `@tixkit/sveltekit/server` in server routes and `@tixkit/sveltekit/client` for browser-safe checkout URLs.

```ts
import {
  TIXKIT_API_VERSION,
  createCheckoutFormAction,
  createTixkitClient,
} from '@tixkit/sveltekit/server';

const client = createTixkitClient({
  apiKey: process.env.TIXKIT_API_KEY!,
  apiVersion: TIXKIT_API_VERSION,
});

export const actions = {
  checkout: createCheckoutFormAction(client),
};
```

## Validation

Run `bun run --filter @tixkit/sveltekit test:unit`, `bun run --filter @tixkit/sveltekit build`, and `npm pack --dry-run` from `packages/sdk-sveltekit`.
