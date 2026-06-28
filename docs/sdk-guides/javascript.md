# JavaScript SDK

API version: `2026-01-01`

Use `@tixkit/js` for browser-safe public flows and server-side API-key flows.

```ts
import { TIXKIT_API_VERSION, TixkitClient } from "@tixkit/js";

const client = new TixkitClient({
  apiBaseUrl: "https://api.example.com/v1",
  apiKey: process.env.TIXKIT_API_KEY,
  apiVersion: TIXKIT_API_VERSION,
});

const session = await client.checkout.create({
  eventId: "evt_123",
  items: [{ ticketTypeId: "tt_123", quantity: 1 }],
  buyer: { email: "buyer@example.com" },
  idempotencyKey: crypto.randomUUID(),
});
```

## Validation

Run `bun run --filter @tixkit/js test:unit` and `npm pack --dry-run` from `packages/sdk-js`.
