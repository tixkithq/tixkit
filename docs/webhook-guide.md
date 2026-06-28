# Tixkit Webhook Guide

Tixkit delivers outbound webhooks to customer-configured endpoints when domain events happen (order paid, ticket issued, attendee updated, etc.). This guide covers the envelope, headers, signing, retries, replay, and testing.

For inbound provider webhooks (Clerk, Stripe, Telnyx, and email feedback) see [Clerk Setup Guide](./clerk-setup-guide.md), [Production Deployment Guide](./production-deployment-guide.md), [Email/SMS Deliverability Runbook](./email-sms-deliverability-runbook.md), and `docs/telnyx-sms-local.md`.

## Local Stripe webhook forwarding (C-052)

For local development with real Stripe provider events, run:

```bash
bun run dev:webhooks
```

This checks that the Stripe CLI is installed and authenticated, starts `stripe listen`, forwards the required payment and Connect events to `http://localhost:4000/v1/stripe/webhooks`, captures the local webhook signing secret, and writes it to `STRIPE_WEBHOOK_SECRET` in `.env.local`. The forwarded event set is:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.refunded`
- `charge.refund.updated`
- `account.updated` (Stripe Connect)

Run a dry-run to see the planned forwarding without starting the Stripe CLI:

```bash
bun run dev:webhooks --dry-run
```

If the Stripe CLI is missing, the command prints an install link. If it is installed but not authenticated, run `stripe login` and retry.


## Endpoint Management

Webhook endpoints are scoped to an organization. Create one via the API (or the admin Developer settings):

```bash
curl -X POST http://localhost:4000/v1/webhook-endpoints \
  -H "Authorization: Bearer tk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "organizationId": "org_...",
    "url": "https://shop.example.com/tixkit-webhooks",
    "events": ["order.paid", "order.refunded", "ticket.issued"],
    "description": "Production order feed"
  }'
```

Response `201`:

```json
{
  "id": "whk_...",
  "organizationId": "org_...",
  "url": "https://shop.example.com/tixkit-webhooks",
  "secret": "whsec_...",
  "events": ["order.paid", "order.refunded", "ticket.issued"],
  "status": "active",
  "description": "Production order feed"
}
```

The `secret` is returned **exactly once** at creation. Store it securely; you will need it to verify signatures. To rotate, create a new endpoint and disable the old one.

Update the URL, event list, status, or description with `PATCH /v1/webhook-endpoints/:endpointId`. Disable an endpoint by setting `status: "disabled"`.

## Envelope

Every delivery uses a versioned envelope. The `apiVersion` field is currently `2026-01-01`.

```json
{
  "id": "wevt_01HN...",
  "type": "order.paid",
  "apiVersion": "2026-01-01",
  "createdAt": "2026-06-25T12:34:56.789Z",
  "tenantId": "tnt_...",
  "organizationId": "org_...",
  "data": {
    "orderId": "ord_...",
    "eventId": "evt_...",
    "checkoutSessionId": "cs_..."
  }
}
```

### Supported event types

| Type                | When emitted                                        | `data` shape                                       |
| ------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `order.created`     | Order finalized from checkout                       | `{ orderId, eventId, checkoutSessionId }`          |
| `order.paid`        | Paid order finalized (also emitted for free orders) | `{ orderId, eventId, checkoutSessionId }`          |
| `order.refunded`    | Refund workflow completed                           | `{ orderId, refundAmountCents, providerRefundId }` |
| `ticket.issued`     | Tickets issued after finalization                   | `{ orderId, ticketIds }`                           |
| `ticket.checked_in` | Attendee scanned in                                 | `{ ticketId, eventId, checkInListId }`             |
| `attendee.updated`  | Attendee record updated                             | `{ attendeeId, eventId }`                          |
| `event.published`   | Event status changed to `published`                 | `{ eventId }`                                      |
| `event.cancelled`   | Event cancelled                                     | `{ eventId }`                                      |

Only events listed in the endpoint's `events` array are delivered.

Successful provider payment alone does not emit order or ticket webhooks. If Tixkit cannot safely finalize the checkout session, hold, and order path, the payment is treated as orphaned and is canceled/voided or refunded; no `order.created`, `order.paid`, or `ticket.issued` event is emitted.

## Headers

Each delivery is a `POST` with these headers:

| Header                             | Description                       |
| ---------------------------------- | --------------------------------- |
| `Content-Type: application/json`   | UTF-8 JSON body                   |
| `X-Tixkit-Event-Id: wevt_...`      | Stable event ID (ULID)            |
| `X-Tixkit-Event-Type: order.paid`  | Event type                        |
| `X-Tixkit-Delivery: <deliveryId>`  | Unique per delivery attempt       |
| `X-Tixkit-Signature: t=...,v1=...` | HMAC-SHA256 signature (see below) |
| `User-Agent: Tixkit-Webhook/1.0`   | Static identifier                 |

## Signing

Signatures are HMAC-SHA256 over `${timestamp}.${rawBody}` using the endpoint's `secret`. The `X-Tixkit-Signature` header has the form:

```
t=1719250496,v1=4f3c...hex...signature
```

Verify in your handler:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyTixkitWebhook({
  rawBody,
  signatureHeader,
  secret,
  toleranceSeconds = 300,
}: {
  rawBody: string;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
}): boolean {
  const parts = new Map(
    signatureHeader.split(',').map((p) => {
      const [k, v] = p.split('=', 2);
      return [k, v] as const;
    }),
  );
  const timestamp = Number(parts.get('t'));
  const signature = parts.get('v1');
  if (!Number.isFinite(timestamp) || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Use the **raw** request body (bytes before JSON parsing) to compute the signature. Comparing the parsed/re-serialized body will fail. Always compare signatures in constant time.

This is the same algorithm used by `@tixkit/domain`'s `signWebhookPayload` / `verifyWebhookSignature` helpers, which the Tixkit SDKs expose directly.

## Retries and Dead-Lettering

Deliveries are run by the `webhookDeliveryWorkflow` Temporal workflow (`packages/workflows/src/workflows/webhook-delivery.ts`). One workflow runs per `(eventId, endpointId)` pair.

| Setting      | Value                                                              |
| ------------ | ------------------------------------------------------------------ |
| Max attempts | 5 (passed by the API; configurable per endpoint on start)          |
| Backoff      | Exponential: 5s, 10s, 20s, 40s after attempts 1-4                  |
| Success      | Any `2xx` response                                                 |
| Retry        | Non-2xx or activity failure                                        |
| Dead-letter  | After `maxAttempts` exhausted; delivery row marked `dead_lettered` |

The workflow returns `{ status: "delivered" }` on success or `{ status: "dead_lettered" }` when all attempts fail. Delivery records are persisted with `attempt`, `statusCode`, `response`, `deliveredAt`, and `status` for inspection.

## Replay

Re-deliver an event to all active endpoints subscribed to its type:

```bash
curl -X POST http://localhost:4000/v1/webhook-events/wevt_01HN.../replay \
  -H "Authorization: Bearer tk_..."
```

Response `202`:

```json
{ "queued": true, "eventId": "wevt_01HN...", "endpoints": 2 }
```

Replay starts a fresh `webhookDeliveryWorkflow` per matching endpoint, each with the full retry/dead-letter behavior. Replay is idempotent at the delivery level only if your handler is idempotent; design handlers to handle duplicate deliveries gracefully.

## Inspecting Deliveries

List deliveries for an endpoint (newest first, cursor-paginated):

```bash
curl http://localhost:4000/v1/webhook-endpoints/whk_.../events?limit=50 \
  -H "Authorization: Bearer tk_..."
```

Returns delivery rows with `eventType`, `status`, `statusCode`, `attemptCount`, `deliveredAt`, and `createdAt`. Use this to triage failed deliveries before replaying.

## Testing Your Endpoint

### Local development with a public tunnel

1. Expose your local handler with a tunnel (e.g. `cloudflared tunnel`, `ngrok`, `localtunnel`).
2. Create a webhook endpoint pointing at the tunnel URL.
3. Trigger an event (e.g. complete a checkout in the local checkout app).
4. Watch delivery records via `GET /v1/webhook-endpoints/:endpointId/events`.

### Signature verification test

```bash
SECRET="whsec_..."
RAW=$(cat body.json)
TIMESTAMP=$(date +%s)
SIG="v1=$(printf '%s.%s' "$TIMESTAMP" "$RAW" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')"
curl -X POST https://your.endpoint/tixkit-webhooks \
  -H "Content-Type: application/json" \
  -H "X-Tixkit-Signature: t=$TIMESTAMP,$SIG" \
  -H "X-Tixkit-Event-Id: wevt_test_1" \
  -H "X-Tixkit-Event-Type: order.paid" \
  --data-binary "$RAW"
```

### SDK helpers

The Tixkit SDKs (`@tixkit/sdk-next`, `@tixkit/sdk-sveltekit`) ship a `verifyWebhookSignature` helper that wraps the algorithm above. Use it in your route handler to avoid re-implementing the crypto.

## Best Practices

- **Verify before processing.** Reject `401` early if the signature is missing or invalid.
- **Be idempotent.** Use `X-Tixkit-Event-Id` to deduplicate; the same event can be delivered more than once across replays or retries.
- **Return 2xx fast.** Long-running work should be queued asynchronously so Temporal sees a quick success and does not retry.
- **Never put secrets in the response body.** The endpoint `secret` is shown once; treat it like a password.
- **Pin to `apiVersion`.** When the API version bumps, update your handler to handle both envelopes during the deprecation window.
