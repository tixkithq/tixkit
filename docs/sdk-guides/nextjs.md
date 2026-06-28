# Next.js SDK

API version: `2026-01-01`

Use `@tixkit/next/server` for App Router route handlers and `@tixkit/next/client` for checkout UI.

```ts
import { TIXKIT_API_VERSION, createCheckoutSessionRouteHandler } from '@tixkit/next/server';

export const POST = createCheckoutSessionRouteHandler({
  apiKey: process.env.TIXKIT_API_KEY!,
  apiVersion: TIXKIT_API_VERSION,
  defaultSuccessUrl: 'https://app.example.com/success',
  defaultCancelUrl: 'https://app.example.com/cancel',
});
```

## Validation

Run `bun run --filter @tixkit/next test:unit`, `bun run --filter @tixkit/next build`, and `npm pack --dry-run` from `packages/sdk-next`.
