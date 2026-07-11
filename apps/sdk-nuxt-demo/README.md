# Tixkit Nuxt Demo

This workspace demonstrates the `@tixkit/vue` web components in Nuxt: widget attributes, checkout handoff, lifecycle events, runtime configuration, and a signed server webhook endpoint.

## Requirements

- Bun 1.3+ and Node.js 20+.
- Dependencies installed from the monorepo root.
- A running checkout application for an interactive handoff.

## Configure

Create `apps/sdk-nuxt-demo/.env` when connecting the demo to local services:

```dotenv
TIXKIT_API_KEY=replace-with-a-local-server-key
TIXKIT_WEBHOOK_SECRET=replace-with-a-local-test-secret
NUXT_PUBLIC_TIXKIT_CHECKOUT_URL=http://localhost:3000
```

Nuxt exposes only the `public` checkout URL to browser code. The API key and webhook secret remain in private runtime configuration. The page uses `evt_demo` and `brd_demo`; replace them with workspace IDs when the seed does not provide those identifiers.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run --filter @tixkit/sdk-nuxt-demo dev
```

Open the URL printed by Nuxt, normally `http://localhost:3000`. The page renders the widget and checkout handoff, and verified widget messages append their type to **Tixkit lifecycle events**. `POST /api/tixkit/webhook` verifies `tixkit-signature` over the raw request body before parsing it.

## Validate

```bash
bun run --filter @tixkit/sdk-nuxt-demo typecheck
bun run --filter @tixkit/sdk-nuxt-demo build
```

Typecheck prepares Nuxt and validates the Vue SFC. Build must produce a Nitro application. Neither command proves external checkout or webhook delivery.

## Troubleshooting

- **No lifecycle events:** confirm the widget origin and event ID point to a running, compatible checkout.
- **Webhook returns 401:** confirm the exact raw bytes, `tixkit-signature`, and server-only secret agree.
- **Webhook returns 400:** send valid JSON after signing the same bytes.
- **Workspace import fails:** reinstall from the repository root; the demo intentionally consumes the current `workspace:*` SDK.

## Security and related guides

Do not put `TIXKIT_API_KEY` or `TIXKIT_WEBHOOK_SECRET` in `runtimeConfig.public`, a `NUXT_PUBLIC_` variable, browser logs, or committed environment files. Continue with the canonical [Vue and Nuxt guide](../../docs/public/sdks/vue-and-nuxt.mdx), [webhook setup](../../docs/public/developers/webhooks/setup.mdx), and [webhook troubleshooting](../../docs/public/developers/webhooks/troubleshooting.mdx).
