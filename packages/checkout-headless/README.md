# `@tixkit/checkout-headless`

## Purpose

Framework-neutral checkout state controller and fetch transport for building custom Tixkit buyer experiences without adopting the hosted React interface.

## Consumers

Custom storefronts, framework adapters, and the maintained checkout applications use this package when they need explicit cart, buyer, session, payment-handoff, confirmation, expiry, and recovery state.

## Status

Package version `1.0.0`. Its HTTP transport targets the public checkout contract and API version `2026-01-01`.

## Installation

```bash
bun add @tixkit/checkout-headless
```

## Example

```ts
import { createCheckoutController, createFetchCheckoutTransport } from '@tixkit/checkout-headless';

const checkout = createCheckoutController({
  eventId: 'evt_example',
  transport: createFetchCheckoutTransport({ apiBaseUrl: 'https://api.example.com/v1' }),
});

const unsubscribe = checkout.subscribe((state) => console.log(state.phase));
await checkout.bootstrap();
unsubscribe();
checkout.destroy();
```

## Public exports

- `CheckoutController` and `createCheckoutController`
- `createFetchCheckoutTransport`
- `createMemoryCheckoutStorage`
- `useTixkitCheckout` from `/react`, `useTixkitCheckout` from `/vue`, and `createTixkitCheckoutStore` from `/svelte`
- Checkout transport, storage, snapshot, session, cart, buyer, payment, error, and confirmation types
- `CHECKOUT_HEADLESS_VERSION`

## Runtime

ES modules on Node.js 22+ and browser runtimes with `fetch`, `AbortController`, Web Crypto, and timers. Consumers own rendering and accessibility.

## Configuration

Supply an event ID and a `CheckoutTransport`. The fetch transport requires an API base URL. Optional storage privately persists the resumable session credential and logical-attempt idempotency keys; configure a distinct `storageKey` when multiple checkouts share an origin. Public snapshots and subscriptions never contain the session token.

## Security

Use only public checkout endpoints in buyer clients. Never pass a server API key through transport headers. Treat checkout client tokens as scoped credentials: keep them out of URLs, logs, analytics, and cross-event storage. Hosted payment collection remains provider-owned; do not collect raw card data through this controller. For paid checkouts, the API creates a short-lived, session-scoped hosted-checkout handoff; the checkout application exchanges it and removes it from browser history. Provider client secrets, session tokens, and unknown response fields are never returned or emitted by the controller.

## Framework examples

Buildable clean-install examples for React, Next.js, Vue, Nuxt, Svelte, SvelteKit, Remix, and Astro live under `examples/checkout-headless`. The consumer verifier installs a packed artifact outside the monorepo and runs each framework's production build.

## Validation

```bash
bun run --filter @tixkit/checkout-headless typecheck
bun run --filter @tixkit/checkout-headless lint
bun run --filter @tixkit/checkout-headless test:unit
```

## Compatibility

Requires the matching Tixkit public checkout routes. Keep package, API, OpenAPI, and checkout application versions synchronized when session or payment handoff contracts change.

## Related guides

- [Complete a test checkout](../../docs/public/getting-started/test-checkout.mdx)
- [API authentication boundaries](../../docs/public/developers/api-fundamentals/authentication.mdx)
- [Embed the widget](../../docs/public/developers/widget/embedding.mdx)
