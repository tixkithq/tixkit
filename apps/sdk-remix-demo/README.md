# Tixkit Remix Demo

Demonstrates the `@tixkit/remix` SDK: widget, checkout handoff, and lifecycle events.

## Run

```sh
cd apps/sdk-remix-demo
bun install
bun run dev
```

Open `http://localhost:3002` to see the demo.

## Webhook endpoint

The demo includes a webhook receiver at `app/routes/api.tixkit-webhook.ts`. Set `TIXKIT_WEBHOOK_SECRET` in your `.env` file to verify incoming webhooks.

## Configuration

The demo uses placeholder event/brand IDs (`evt_demo`, `brd_demo`). Replace them with real identifiers from your Tixkit dashboard.
