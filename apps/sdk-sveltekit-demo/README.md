# Tixkit SvelteKit Demo

This workspace demonstrates `@tixkit/sveltekit` server client creation, a checkout form action, checkout elements, lifecycle events, and a signed webhook endpoint.

## Requirements

- Bun 1.3+ and Node.js 20+.
- Dependencies installed from the monorepo root.
- A running Tixkit API and checkout application for live checkout.

## Configure

Create `apps/sdk-sveltekit-demo/.env`:

```dotenv
TIXKIT_API_KEY=replace-with-a-local-server-key
TIXKIT_API_BASE_URL=http://localhost:4000/v1
TIXKIT_WEBHOOK_SECRET=replace-with-a-local-test-secret
```

SvelteKit reads these values only in server modules. Never import them into a browser component or rename them with a public prefix. The UI references `evt_demo_sveltekit`; replace it with an event available in the configured environment.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run --filter @tixkit/sdk-sveltekit-demo dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. The checkout form posts to the server action, which uses the server-side client to create a session and redirects to checkout. Browser lifecycle messages appear in the page output. `POST /api/tixkit/webhook` validates the signature before returning the parsed event.

Fallback demo strings keep local compilation deterministic; they are not production credentials. Supply environment-specific server values before connecting to a real API.

## Validate

```bash
bun run --filter @tixkit/sdk-sveltekit-demo typecheck
bun run --filter @tixkit/sdk-sveltekit-demo build
```

Typecheck synchronizes SvelteKit types first. Build must produce the adapter-node server output. These checks do not prove a remote checkout session succeeded.

## Troubleshooting

- **Form action fails:** verify the API origin includes `/v1`, the server key scopes, and the event ID.
- **Webhook returns 401:** sign the raw bytes with the same secret loaded by the SvelteKit server.
- **Unexpected local port:** use the URL Vite prints and update any return URL configured by the caller.
- **Client import exposes a secret:** move SDK creation to `+page.server.ts` or another server-only module.

## Security and related guides

Keep API keys and signing secrets out of load data, serialized action results, browser storage, URLs, screenshots, and analytics. Continue with the canonical [SvelteKit SDK guide](../../docs/public/sdks/sveltekit.mdx), [first API call](../../docs/public/getting-started/first-api-call.mdx), and [webhook signature guide](../../docs/public/developers/webhooks/verify-signatures.mdx).
