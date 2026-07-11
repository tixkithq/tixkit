# Tixkit Astro Demo

This workspace demonstrates the supported `@tixkit/astro` integration: server-rendered widget attributes, checkout handoff URLs, browser lifecycle events, and an Astro webhook endpoint.

## Requirements

- Bun 1.3+ and Node.js 20+.
- The monorepo dependencies installed from the repository root.
- A running checkout application for an interactive checkout handoff.
- A webhook signing secret only when testing signed webhook delivery.

## Configure

Create `apps/sdk-astro-demo/.env` only when overriding local defaults:

```dotenv
PUBLIC_TIXKIT_CHECKOUT_URL=http://localhost:3000
TIXKIT_WEBHOOK_SECRET=replace-with-a-local-test-secret
```

`PUBLIC_TIXKIT_CHECKOUT_URL` is exposed to browser code. `TIXKIT_WEBHOOK_SECRET` is server-only and must never use the `PUBLIC_` prefix. The page uses `evt_demo` and `brd_demo`; these identifiers are useful only when the local seed guarantees them. Replace them with IDs from your own workspace for live integration testing.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run --filter @tixkit/sdk-astro-demo dev
```

Open `http://localhost:4321`. The page renders a widget iframe and checkout link. Widget messages append their event type to the **Tixkit lifecycle events** output. A checkout navigation requires the configured checkout app and a valid event.

The webhook receiver is `POST /api/tixkit/webhook`. It verifies `tixkit-signature` against the unmodified body before parsing JSON. An absent or invalid signature returns `401`; invalid JSON returns `400`; a verified event returns a success response.

## Validate

```bash
bun run --filter @tixkit/sdk-astro-demo typecheck
bun run --filter @tixkit/sdk-astro-demo build
```

The build must produce an Astro server output without TypeScript errors. A successful build does not prove that an external checkout or webhook sender is configured.

## Troubleshooting

- **Widget or checkout is empty:** confirm the checkout app is running and replace the demo event/brand IDs with seeded or real IDs.
- **Webhook returns 401:** send the signature generated for the exact raw request bytes and confirm the server-only secret matches the sender.
- **Port 4321 is occupied:** pass an Astro port override after `--` or stop the conflicting process.
- **Workspace package cannot resolve:** install from the repository root so `workspace:*` points to the current `@tixkit/astro` source.

## Security and related guides

Do not log webhook bodies from real customers or expose the signing secret to client code. Continue with the canonical [Astro SDK guide](../../docs/public/sdks/astro.mdx), [webhook signature verification](../../docs/public/developers/webhooks/verify-signatures.mdx), and [webhook testing](../../docs/public/developers/webhooks/testing.mdx).
