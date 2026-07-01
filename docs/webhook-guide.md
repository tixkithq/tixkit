# Tixkit Webhook Guide

Tixkit delivers outbound webhooks to customer-configured endpoints when domain events happen (order paid, ticket issued, attendee updated, etc.). This guide covers the envelope, headers, signing, retries, replay, and testing.

For inbound provider webhooks (Clerk, Stripe, Telnyx, and email feedback) see [Clerk Setup Guide](./clerk-setup-guide.md), [Production Deployment Guide](./production-deployment-guide.md), [Email/SMS Deliverability Runbook](./email-sms-deliverability-runbook.md), and `docs/telnyx-sms-local.md`.

## Local Stripe webhook forwarding (C-052)

For local development with real Stripe provider events, run:

```bash
bun run dev:webhooks
```

This checks that the Stripe CLI is installed, starts `stripe listen`, forwards the required payment and Connect events to `http://localhost:4000/v1/webhooks/stripe`, captures the local webhook signing secret, and writes it to `STRIPE_WEBHOOK_SECRET` in `.env.local`. It authenticates with `STRIPE_API_KEY` or `STRIPE_SECRET_KEY` from the selected env file when present; otherwise use `stripe login`. The forwarded event set is:

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

Dry-run does not require Stripe CLI installation or authentication; it is the safe planning check for local runbooks and CI documentation review. For live forwarding, if the Stripe CLI is missing, the command prints an install link. If no Stripe API key is available in the selected env file and the CLI is not authenticated, run `stripe login` and retry.

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

Re-deliver an event to one endpoint when triage shows only that endpoint failed:

```bash
curl -X POST http://localhost:4000/v1/webhook-endpoints/whk_.../events/wevt_01HN.../replay \
  -H "Authorization: Bearer tk_..."
```

Response `202`:

```json
{ "queued": true, "eventId": "wevt_01HN...", "endpointId": "whk_..." }
```

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

## C-094 Validation Evidence

Latest local evidence on 2026-06-30:

- API/provider webhook route and developer endpoint coverage: `cd packages/api && ../../node_modules/.bin/vitest run src/__tests__/stripe-webhooks.test.ts src/__tests__/email-webhooks.test.ts src/__tests__/telnyx-webhooks.test.ts src/__tests__/integration/developer-routes.integration.test.ts` passed 38/38.
- Workflow/activity coverage: `cd packages/workflows && ../../node_modules/.bin/vitest run src/__tests__/webhook-delivery-activity.test.ts src/__tests__/webhook-event-activity.test.ts src/__tests__/workflows.test.ts` passed 100/100, including signature/header contract, bounded endpoint responses, hard request deadlines, replay-scoped delivery keys, in-flight final attempts, stale completion protection, inactive/missing endpoint dead-lettering, and dead-letter persistence failures.
- Load proof: the clean Postgres 16 load refresh ran `load-harness.integration.test.ts -t "prevents oversell|webhook burst|payment success SLO|large export"` and passed 4/4; the webhook burst gate deduped 50 concurrent deliveries for the same Stripe event to exactly one stored and processed row inside the 300,000 ms catch-up SLO.
- Operational CLI and live forwarding proof: `cd packages/cli && ../../node_modules/.bin/vitest run src/__tests__/dev-webhooks.test.ts --configLoader native` passed 7/7, including Stripe CLI auth via `STRIPE_API_KEY`/`STRIPE_SECRET_KEY` from the selected env file without putting the key in process arguments and root `.env.local` resolution when launched through the root `bun --filter @tixkit/cli` script. `bun run dev:webhooks --dry-run` confirms the six forwarded Stripe event types: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.refund.updated`, and `account.updated`. Live smoke on 2026-06-30 first ran API and worker processes on `tixkit-e2e-c094-live-2`, started `dev:webhooks --api-url http://localhost:4301 --no-write-secret`, forwarded to `/v1/webhooks/stripe`, triggered `payment_intent.succeeded`, and observed HTTP 200 plus stored provider event `evt_3To0tHCy5akHxoJx0iVSvHgd`.
- Mapped provider proof: `dev:webhooks --api-url http://localhost:4304` plus `TIXKIT_API_URL=http://localhost:4304 CHECKOUT_URL=http://localhost:3315 ADMIN_DASHBOARD_URL=http://localhost:3316 WORKER_HEALTH_URL=http://127.0.0.1:4402 TEMPORAL_TASK_QUEUE=tixkit-e2e-c094-cli-1782824025 E2E_STRIPE_PROVIDER=1 bun --env-file=.env.local playwright test e2e/checkout-stripe-provider-workflow.spec.ts --project=chromium --workers=1` passed 1/1. The live CLI-forwarded Stripe events `evt_3To1B8Cy5akHxoJx1VIiUMpF` (`payment_intent.succeeded`), `evt_3To1B8Cy5akHxoJx1nZdpi5U` (`charge.refunded`), and `evt_3To1B8Cy5akHxoJx1ek10VOg` (`charge.refund.updated`) were stored with `processed_at` set.

Generic `stripe trigger payment_intent.succeeded` fixtures still prove signature validation and storage only; they do not include local checkout metadata and are expected to stay unprocessed.

## Best Practices

- **Verify before processing.** Reject `401` early if the signature is missing or invalid.
- **Be idempotent.** Use `X-Tixkit-Event-Id` to deduplicate; the same event can be delivered more than once across replays or retries.
- **Return 2xx fast.** Long-running work should be queued asynchronously so Temporal sees a quick success and does not retry.
- **Never put secrets in the response body.** The endpoint `secret` is shown once; treat it like a password.
- **Pin to `apiVersion`.** When the API version bumps, update your handler to handle both envelopes during the deprecation window.
