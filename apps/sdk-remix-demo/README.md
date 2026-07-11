# Tixkit Remix Demo

This workspace demonstrates `@tixkit/remix` checkout components, lifecycle events, checkout handoff construction, and a Remix action that verifies signed webhook requests.

## Requirements

- Bun 1.3+ and Node.js 20+.
- Dependencies installed from the monorepo root.
- A running checkout application for an interactive handoff.

## Configure

Create `apps/sdk-remix-demo/.env` when overriding local values:

```dotenv
TIXKIT_CHECKOUT_URL=http://localhost:3000
TIXKIT_WEBHOOK_SECRET=replace-with-a-local-test-secret
```

Both variables are read on the server. Do not forward the webhook secret through a loader or render it into HTML. The UI uses `evt_demo` and `brd_demo`, which must correspond to seeded or real records before checkout can succeed.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run --filter @tixkit/sdk-remix-demo dev
```

Open the URL printed by Remix. The page renders a widget, checkout handoff, and lifecycle-event output. `POST /api/tixkit-webhook` verifies the `tixkit-signature` header against the unmodified request body, rejects invalid JSON, and acknowledges a valid event.

## Validate

```bash
bun run --filter @tixkit/sdk-remix-demo typecheck
bun run --filter @tixkit/sdk-remix-demo build
```

The build must emit the Remix browser and server bundles. It does not prove that the configured event exists or an external webhook can reach the local process.

## Troubleshooting

- **Checkout target is wrong:** update `TIXKIT_CHECKOUT_URL` and restart so the server-rendered handoff uses the new origin.
- **Webhook returns 401:** generate the signature from the exact transmitted bytes and the matching server secret.
- **Webhook returns 400:** send a JSON body after signing it; do not parse and reserialize between signing and delivery.
- **No widget events:** verify the checkout origin, event/brand IDs, and browser message origin.

## Security and related guides

Do not log real webhook payloads as the demo receiver currently does; remove or sanitize diagnostic logging before adapting it to production. Continue with the canonical [Remix SDK guide](../../docs/public/sdks/remix.mdx), [webhook signature verification](../../docs/public/developers/webhooks/verify-signatures.mdx), and [webhook troubleshooting](../../docs/public/developers/webhooks/troubleshooting.mdx).
