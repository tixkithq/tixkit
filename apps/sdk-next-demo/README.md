# Tixkit Next.js Demo

This workspace demonstrates `@tixkit/next` in the App Router: checkout components, lifecycle events, a server-only checkout session route handler, and a signed webhook route handler.

## Requirements

- Bun 1.3+ and Node.js 20+.
- Dependencies installed from the monorepo root.
- A running Tixkit API and checkout application for live requests.

## Configure

Create `apps/sdk-next-demo/.env.local`:

```dotenv
TIXKIT_API_KEY=replace-with-a-local-server-key
TIXKIT_API_BASE_URL=http://localhost:4000/v1
TIXKIT_WEBHOOK_SECRET=replace-with-a-local-test-secret
TIXKIT_SUCCESS_URL=http://localhost:3000/success
TIXKIT_CANCEL_URL=http://localhost:3000/cancel
NEXT_PUBLIC_TIXKIT_CHECKOUT_URL=http://localhost:3000
```

Only `NEXT_PUBLIC_TIXKIT_CHECKOUT_URL` may enter the browser bundle. Keep the API key and webhook secret server-only. The UI references `evt_demo_next`; replace it with a seeded or real event ID when exercising checkout.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run --filter @tixkit/sdk-next-demo dev
```

Open `http://localhost:3000`. The page renders checkout components and a lifecycle-event output. `POST /api/tixkit/checkout` delegates session creation to the server adapter. `POST /api/tixkit/webhook` verifies the request signature and returns an acknowledgement containing the parsed event.

Local fallback strings in the example make compilation deterministic; they are not production credentials. Supply real server-only values before connecting the demo to any non-demo environment.

## Validate

```bash
bun run --filter @tixkit/sdk-next-demo typecheck
bun run --filter @tixkit/sdk-next-demo lint
bun run --filter @tixkit/sdk-next-demo build
```

The production build must complete and emit the page plus both route handlers. Build success does not prove that a remote API accepted a checkout session.

## Troubleshooting

- **Checkout creation fails:** verify `TIXKIT_API_BASE_URL`, the server key scopes, and the event ID; inspect only sanitized server output.
- **Browser code cannot read the API key:** expected—secret configuration is intentionally server-only.
- **Webhook returns an authorization error:** sign the exact raw body with the matching environment secret and use the `tixkit-signature` header.
- **Port 3000 conflicts with checkout:** pass a different Next.js dev port and update success, cancel, and checkout URLs consistently.

## Security and related guides

Never place the API key in a client component, URL, browser storage, screenshot, or analytics event. Continue with the canonical [Next.js SDK guide](../../docs/public/sdks/nextjs.mdx), [first API call](../../docs/public/getting-started/first-api-call.mdx), and [webhook signature guide](../../docs/public/developers/webhooks/verify-signatures.mdx).
