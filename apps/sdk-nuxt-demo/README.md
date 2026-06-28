# Tixkit Nuxt Demo

Demonstrates the `@tixkit/vue` SDK: widget, checkout handoff, and lifecycle events.

## Run

```sh
cd apps/sdk-nuxt-demo
bun install
bun run dev
```

Open `http://localhost:3000` to see the demo.

## Webhook endpoint

The demo includes a webhook receiver at `server/api/tixkit/webhook.post.ts`. Set `TIXKIT_WEBHOOK_SECRET` in your `.env` file to verify incoming webhooks.

## Configuration

The demo uses placeholder event/brand IDs (`evt_demo`, `brd_demo`). Replace them with real identifiers from your Tixkit dashboard.
