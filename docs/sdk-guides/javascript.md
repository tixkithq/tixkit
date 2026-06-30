# JavaScript SDK

API version: `2026-01-01`

Use `@tixkit/js` for browser-safe public flows and server-side API-key flows.

```ts
import { TIXKIT_API_VERSION, TixkitClient } from '@tixkit/js';

const client = new TixkitClient({
  apiBaseUrl: 'https://api.example.com/v1',
  apiKey: process.env.TIXKIT_API_KEY,
  apiVersion: TIXKIT_API_VERSION,
});

const session = await client.checkout.create({
  eventId: 'evt_123',
  items: [{ ticketTypeId: 'tt_123', quantity: 1 }],
  buyer: { email: 'buyer@example.com' },
  idempotencyKey: crypto.randomUUID(),
});
```

## Resale

Staff tools can list and complete provider-verified resale transfers:

```ts
const listings = await client.events.listResaleListings('evt_123', { limit: 25 });

const listing = await client.tickets.createResaleListing('tkt_123', {
  priceCents: 5500,
  expiresAt: '2026-07-01T00:00:00.000Z',
  idempotencyKey: crypto.randomUUID(),
});

await client.tickets.delistResaleListing(listing.id, {
  idempotencyKey: crypto.randomUUID(),
});

await client.tickets.completeResaleListing(listings.items[0].id, {
  buyerId: 'usr_456',
  buyerEmail: 'buyer@example.com',
  externalPaymentReference: 'stripe_pi_...',
  idempotencyKey: crypto.randomUUID(),
});
```

Buyer-owned checkout sessions can list an issued wallet-pass ticket without an API key by sending the session client token:

```ts
await client.checkout.createTicketResaleListing('cs_123', 'tkt_123', {
  clientToken: 'client_...',
  priceCents: 5500,
  idempotencyKey: crypto.randomUUID(),
});
```

## Validation

Run `bun run --filter @tixkit/js test:unit` and `npm pack --dry-run` from `packages/sdk-js`.
