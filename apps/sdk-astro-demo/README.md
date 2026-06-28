# Tixkit Astro Demo

Demonstrates the `@tixkit/astro` SDK: widget, checkout handoff, and lifecycle events.

## Run

```sh
cd apps/sdk-astro-demo
bun install
bun run dev
```

Open `http://localhost:4321` to see the demo.

## Webhook endpoint

The demo includes a webhook receiver at `src/pages/api/tixkit/webhook.ts`. Set `TIXKIT_WEBHOOK_SECRET` in your environment to verify incoming webhooks.

## Configuration

The demo uses placeholder event/brand IDs (`evt_demo`, `brd_demo`). Replace them with real identifiers from your Tixkit dashboard.
