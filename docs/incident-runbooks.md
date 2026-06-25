# Incident Runbooks

Step-by-step recovery procedures for common GateKit production incidents. Each runbook lists symptoms, root-cause checks, and recovery actions. When in doubt, consult the Temporal UI (`http://localhost:8080` locally) and the API logs (search by `requestId`).

## General Triage

1. Check `GET /health` on the API.
2. Check the worker process is running and connected to Temporal.
3. Open Temporal UI and filter by the failing workflow type.
4. Correlate API logs by `requestId` and worker logs by workflow ID.
5. Identify whether the failure is provider-side (Stripe/Telnyx/Clerk), DB-side, or code-side before applying a runbook.

---

## R1: Payment Reconciliation

### Symptoms

- Stripe webhook delivered but order/ticket state did not update.
- `payment_events` row exists with `processed_at` set but order status is stale.
- Order shows `pending_payment` after buyer completed payment.
- Dispute or refund event not reflected in admin order detail.

### Root-cause checks

1. `SELECT * FROM payment_events WHERE provider = 'stripe' AND provider_event_id = '<evt_id>';` — is `processed_at` set? Was the event stored at all?
2. In Temporal UI, look for `payment-reconciliation:<providerEventId>`. Is it running, failed, or missing?
3. Check Stripe dashboard for the event; confirm it was delivered to `POST /v1/webhooks/stripe` with a `200` response.
4. Check `payment_intents` for the matching `provider_intent_id` and `checkout_session_id` metadata.

### Recovery

- **Event stored but not processed** (`processed_at IS NULL`): Stripe will redeliver on its retry schedule. To force recovery, redeliver from the Stripe dashboard, or POST the raw event payload back to `/v1/webhooks/stripe` with valid signature headers. The handler will skip the duplicate check (event is stored but unprocessed) and start `paymentReconciliationWorkflow`, which is idempotent by `providerEventId`.
- **Reconciliation workflow failed**: inspect the failed activity in Temporal UI. Fix the downstream issue (DB connection, provider outage), then use the Temporal CLI to retry:
  ```bash
  temporal workflow reset --id payment-reconciliation:<providerEventId> --event-id <first_failed_event_id>
  ```
- **Order stuck in `pending_payment`**: confirm `payment_intent.succeeded` was delivered and the `checkout-session:<sessionId>` workflow received the `paymentSucceeded` signal. If the signal was lost, the reconciliation workflow will still reconcile DB state from the stored Stripe event; verify `orders.status` updated and the `order.paid` webhook emitted.
- **Dispute not reflected**: ensure the dispute event type (`charge.dispute.*`) is enabled in the Stripe webhook subscription. The reconciliation workflow routes dispute events to `reconcileDisputeActivity`.

### Verification

```sql
SELECT id, status, paid_at, refunded_cents
FROM orders
WHERE id = '<orderId>';
```

Confirm `payment_events.processed_at` is set and Temporal shows the reconciliation workflow as completed.

---

## R2: Refund Repair

### Symptoms

- Refund requested in admin but order `refunded_cents` did not update.
- Stripe shows a successful refund but GateKit order still reports `paid` or stale `refunded_cents`.
- Refund workflow status `failed` in Temporal UI.
- Tickets not voided after a full refund.
- Inventory not restored after a refund with `restoreInventory: true`.

### Root-cause checks

1. Find the workflow ID: `order-refund:<orderId>:<idempotencyKey>` (the nonce is the refund's `Idempotency-Key`).
2. In Temporal UI, inspect which activity failed: `processRefundActivity`, `updateLedgerActivity`, `voidTicketsActivity`, `restoreInventoryActivity`, or `notifyRefundActivity`.
3. Check `refunds` table for the `provider_refund_id` and `amount_cents`.
4. Check Stripe for the refund; if Stripe has the refund but `refunds` does not, the `processRefundActivity` failed after the provider accepted the request.

### Recovery

The refund workflow is idempotent by `(orderId, nonce)` workflow ID. Re-using the same `Idempotency-Key` returns the existing handle rather than starting a new run.

- **Activity failed transiently**: fix the downstream issue and let Temporal's retry policy recover, or reset the workflow to the failed event:
  ```bash
  temporal workflow reset --id order-refund:<orderId>:<nonce> --event-id <first_failed_event_id>
  ```
- **Provider refund succeeded but ledger did not update**: the `paymentReconciliationWorkflow` for the `refund.*` Stripe event will call `reconcileRefundActivity`, which recomputes order refund totals from persisted `refunds` rows. Re-deliver the Stripe refund event to trigger this.
- **Duplicate provider refund replays**: `reconcileRefundActivity` is idempotent. Replaying the same `refund.*` event repairs stale order state without double-counting.
- **Workflow never started** (API returned 5xx): re-POST the refund request with the same `Idempotency-Key`. The idempotency record was deleted on 5xx, so the request will start a fresh workflow.

### Verification

```sql
SELECT id, status, total_cents, refunded_cents, refunded_at
FROM orders
WHERE id = '<orderId>';

SELECT id, amount_cents, provider_refund_id, status
FROM refunds
WHERE order_id = '<orderId>';
```

Confirm ledger timeline events balance gross/tax/fee/net. Tickets for a full refund should be `voided`; partial refunds void a proportional subset.

---

## R3: Webhook Replay

### Symptoms

- Customer reports a missing integration event.
- Webhook delivery row shows `status = 'failed'` or `'dead_lettered'`.
- Endpoint was temporarily down and missed deliveries.

### Root-cause checks

1. `GET /v1/webhook-endpoints/:endpointId/events` — list delivery records, newest first.
2. Identify the `eventId` and the failed delivery's `statusCode`/`response`.
3. Confirm the endpoint URL is reachable and the customer's handler returns 2xx.

### Recovery

Replay the event to all active endpoints subscribed to its type:

```bash
curl -X POST https://api.example.com/v1/webhook-events/wevt_01HN.../replay \
  -H "Authorization: Bearer gk_..."
```

Response `202 { "queued": true, "eventId": "...", "endpoints": N }`. Each endpoint gets a fresh `webhookDeliveryWorkflow` with the full 5-attempt retry schedule.

Replay is idempotent only if the customer's handler is idempotent. Remind customers to deduplicate by `X-GateKit-Event-Id`. For endpoints that remain down, the new delivery will also dead-letter; fix the endpoint before replaying.

### Verification

```bash
curl https://api.example.com/v1/webhook-endpoints/whk_.../events?limit=10 \
  -H "Authorization: Bearer gk_..."
```

Confirm the new delivery row shows `status = 'delivered'` and `deliveredAt` is set.

---

## R4: Stuck Checkout Workflows

### Symptoms

- Checkout session stays in `pending_payment` indefinitely.
- Buyer completed payment but no order was created.
- `checkout-session:<sessionId>` workflow is running in Temporal UI with no recent events.
- Inventory hold is not released after a failed/abandoned checkout.

### Root-cause checks

1. Find the workflow ID in Temporal UI: `checkout-session:<sessionId>`.
2. Inspect the event history:
   - Did `createPaymentIntentActivity` succeed? If not, check Stripe keys and the connected account.
   - Is the workflow waiting on the `paymentSucceeded`/`paymentFailed` signal? The wait times out after 10 minutes.
   - Did `finalizeOrderActivity` fail? Check the activity error and DB state.
3. Check `payment_intents` for the session: `SELECT * FROM payment_intents WHERE checkout_session_id = '<sessionId>';`
4. Check `checkout_sessions.status` and `expires_at`.

### Recovery

- **Signal lost (payment succeeded but workflow did not get the signal)**: Stripe's `payment_intent.succeeded` webhook will signal the workflow. If the webhook was missed, redeliver it from the Stripe dashboard. The handler will signal the workflow AND start `paymentReconciliationWorkflow` as a backstop.
- **Workflow stuck waiting after the 10-minute timeout**: the workflow will release the hold and exit `failed` on its own. If it does not, terminate it:
  ```bash
  temporal workflow terminate --id checkout-session:<sessionId>
  ```
  The hold will be released by the hold-expiration loop, or you can call `releaseHoldActivity` manually if urgent.
- **Payment intent created but client never confirmed**: the workflow waits 10 minutes, then releases the hold. The session will be marked `expired` by `expireStaleSessionsActivity`. No refund is needed because no capture happened.
- **Finalize failed after payment succeeded**: do NOT terminate the workflow. Fix the finalize activity's downstream issue (DB, inventory) and reset to the failed event so the workflow resumes from `finalizeOrderActivity`. The payment is already captured; terminating without finalizing would lose the order.

### Verification

```sql
SELECT id, status, order_id, expires_at
FROM checkout_sessions
WHERE id = '<sessionId>';

SELECT id, status, paid_at
FROM orders
WHERE checkout_session_id = '<sessionId>';
```

Confirm `checkout_sessions.status = 'completed'` and `orders.status = 'paid'`. The `order.paid` webhook should be delivered (R3 if not).

---

## R5: Failed Exports

### Symptoms

- Admin export button shows `failed` status.
- `GET /v1/exports/:exportId` returns `status: 'failed'`.
- SSE stream sent a `failed` event.
- Download link returns 404 or expired URL.

### Root-cause checks

1. `SELECT * FROM export_jobs WHERE id = '<exportId>';` — check `status`, `error_message`, `file_url`.
2. In Temporal UI, find `export:<exportId>`. Inspect which activity failed:
   - `generateExportActivity` (5 minute timeout) — likely a slow query or OOM.
   - `uploadFileActivity` — likely S3/MinIO connectivity or credentials.
   - `markExportFailedActivity` — should always succeed; if it fails, the workflow itself errored.
   - `notifyExportCompleteActivity` — non-critical; export file is already uploaded.
3. Check `export_job_events` for the durable event replay log.

### Recovery

The export workflow is idempotent by `export:<exportId>` workflow ID. Re-running with the same ID returns the existing handle.

- **Re-run from the API**: POST `/v1/exports` with the same `Idempotency-Key` and parameters. The idempotency record was deleted on 5xx, so a new `exportWorkflow` start will be attempted. Because the workflow ID is deterministic, if the previous run is still open Temporal returns the existing handle; if it was terminated or completed as failed, you must terminate the old run first.
- **Reset the failed workflow**:
  ```bash
  temporal workflow terminate --id export:<exportId>   # only if stuck/failed
  # then re-POST /v1/exports with the same Idempotency-Key
  ```
- **File uploaded but notify failed**: the export is complete; the download link works. The SSE notification may not have fired; the admin UI will show `completed` on next poll or refresh.
- **Large export OOMs in `generateExportActivity`**: the activity has a 5 minute timeout and 3 retry attempts. For very large exports, consider streaming the query in the activity rather than materializing the full result set. Tune the activity timeout if needed (requires worker deploy).

### Verification

```sql
SELECT id, status, file_url, error_message, started_at, completed_at
FROM export_jobs
WHERE id = '<exportId>';
```

Confirm `status = 'completed'` and `file_url` is set. The download endpoint `GET /v1/exports/:exportId/download` should return a scoped, valid URL.

---

## Cross-Cutting: Worker Outage

If the worker is down, workflows started by the API will be pending until the worker recovers. Temporal retains the workflow start event; no data is lost. Recovery:

1. Fix the worker (check `TEMPORAL_ADDRESS`, `DATABASE_URL`, `REDIS_URL`).
2. Start the worker; it picks up the `gatekit` task queue and resumes pending workflows.
3. The `hold-expiration:scheduled` workflow auto-restarts on boot if not already running.
4. Monitor Temporal UI for backlog drain; alert if `pending_activities` grows unbounded.

API requests that start workflows will return `202`/`200` as long as Temporal accepts the start; buyer-facing latency is unaffected until a workflow needs an activity to complete (e.g. payment intent creation in checkout).
