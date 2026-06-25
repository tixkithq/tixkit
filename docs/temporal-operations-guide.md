# Temporal Operations Guide

GateKit uses [Temporal](https://temporal.io) for all durable multi-step workflows: checkout finalization, payment reconciliation, refunds, notifications, SMS delivery, webhook delivery, exports, hold expiration, and Clerk identity sync. This guide covers local dev, worker deployment, task queues, workflow versioning, retries, replay safety, and incident recovery.

Implementation lives in `packages/workflows` (workflows and activities) and `packages/api/src/services/temporal.ts` (API client).

## Local Development

The dev stack includes Temporal plus a dedicated Temporal PostgreSQL and the Temporal UI:

```bash
bun run infra:up      # starts postgres, mysql, redis, temporal, temporal-ui, minio
bun run db:migrate
bun run dev:api       # API on :4000
bun run dev:worker    # worker on the 'gatekit' task queue
```

- Temporal address: `localhost:7233` (`TEMPORAL_ADDRESS`)
- Namespace: `default` (`TEMPORAL_NAMESPACE`)
- Temporal UI: `http://localhost:8080`

The worker (`packages/workflows/src/worker.ts`) registers all workflows and activities on the `gatekit` task queue. On boot it also starts the long-running `holdExpirationWorkflow` if it is not already running.

If Temporal is unreachable, the worker exits with a diagnostic message:

```
GateKit worker failed to start.
- Start local infrastructure with `bun run infra:up`.
- Verify Temporal is reachable at localhost:7233.
- Run `bun run db:migrate` before starting worker activities that touch storage.
Original error: ...
```

The API connects to Temporal lazily through `TemporalClient.connect()` at boot. Workflow start calls are idempotent: `WorkflowExecutionAlreadyStartedError` is caught and the existing handle is returned, so API retries do not create duplicate workflows.

## Worker Deployment

Run one or more worker processes alongside the API. The worker is a long-lived process; scale horizontally by starting more workers pointing at the same Temporal address and namespace.

Production checklist:

1. Set `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` to the production Temporal cluster.
2. Set `DATABASE_URL` and `REDIS_URL` so activities can read/write domain state.
3. Run `bun run dev:worker` (or the compiled equivalent `node dist/worker.js`) under your process supervisor (systemd, Kubernetes, ECS, etc.).
4. Ensure exactly one worker revision is live during a deploy that changes workflow code (see [Versioning](#workflow-versioning)) to avoid non-deterministic replay errors.
5. Monitor Temporal worker metrics; alert on `workflow_failed`, `activity_failed`, and dead-lettered webhook deliveries.

## Task Queues

GateKit uses a single task queue named `gatekit` for all workflows and activities. This keeps the worker deployment simple and is sufficient for the current workload. If you split task queues in the future, update `packages/workflows/src/worker.ts` and the `taskQueue: 'gatekit'` arguments in `packages/api/src/services/temporal.ts` together.

## Workflows

| Workflow | ID convention | Purpose |
| --- | --- | --- |
| `checkoutSessionWorkflow` | `checkout-session:<sessionId>` | Hold → payment intent → wait for signal → finalize → issue tickets → email → emit webhook |
| `paymentReconciliationWorkflow` | `payment-reconciliation:<providerEventId>` | Reconcile Stripe payment/refund/dispute events |
| `refundWorkflow` | `order-refund:<orderId>:<nonce>` | Process refund, update ledger, void tickets, restore inventory, notify |
| `notificationDeliveryWorkflow` | `notification:<jobId>` | Check suppression/consent → render → send email |
| `smsDeliveryWorkflow` | `sms-delivery:<jobId>` | Send SMS (consent-gated) |
| `webhookDeliveryWorkflow` | `webhook-delivery:<eventId>:<endpointId>` | Deliver outbound webhook with retries |
| `exportWorkflow` | `export:<exportId>` | Generate → upload → notify |
| `holdExpirationWorkflow` | `hold-expiration:scheduled` | Long-running loop: expire stale holds and sessions every 60s |
| `clerkIdentitySyncWorkflow` | `clerk-identity-sync:<clerkUserIdOrOrgId>` | Sync user/org from Clerk webhook |

Workflow IDs are deterministic. Re-using the same ID returns the existing handle, which makes API retries and webhook replays idempotent.

## Workflow Versioning

Every workflow input includes a numeric `version` field (constants in `packages/workflows/src/shared/types.ts`):

```
CHECKOUT_WORKFLOW_VERSION = 1
REFUND_WORKFLOW_VERSION = 1
NOTIFICATION_WORKFLOW_VERSION = 1
SMS_DELIVERY_WORKFLOW_VERSION = 1
WEBHOOK_DELIVERY_WORKFLOW_VERSION = 1
HOLD_EXPIRATION_WORKFLOW_VERSION = 1
EXPORT_WORKFLOW_VERSION = 1
CLERK_IDENTITY_SYNC_WORKFLOW_VERSION = 1
PAYMENT_RECONCILIATION_WORKFLOW_VERSION = 1
```

Workflows persist across deploys, so any change to the workflow body must be backward-compatible with in-flight executions or you must bump the version and use `patched`/`deprecate_patch` from the Temporal SDK. Rules:

- **Additive changes** (new signals, new queries, new conditional branches gated on `input.version`) are safe.
- **Removing or reordering activities, changing activity names, or changing signal semantics** are breaking. Bump the version and branch on `input.version` inside the workflow, or use the SDK's patching API.
- **Activity input/output changes** must be additive. New optional fields are fine; renamed or removed fields break replaying executions.
- The API always starts workflows with the current version constant. Existing in-flight executions continue with the version they were started with.

## Retries and Timeouts

Activity defaults (set via `proxyActivities` in each workflow):

| Workflow | `startToCloseTimeout` | `maximumAttempts` | `initialInterval` | `backoffCoefficient` |
| --- | --- | --- | --- | --- |
| checkout | 30s | 3 | 1s | 2 |
| payment-reconciliation | 30s | 5 | 2s | 2 |
| refund | 30s | 3 | 2s | 2 |
| notification / sms | 30s | 5 | 2s | 2 |
| webhook-delivery | 30s | 5 | 5s | 2 |
| export | 5 minutes | 3 | 10s | 2 |
| hold-expiration | 60s | 3 | 5s | 2 |
| clerk-identity-sync | 30s | 3 | 2s | 2 |

Activities return a `WorkflowActivityResult<T>` discriminated union (`{ ok: true, value }` or `{ ok: false, errorCode, retryable, message }`). Non-retryable activity errors should return `{ ok: false, retryable: false }` so the workflow can branch instead of burning retries. Retryable errors propagate to Temporal's retry policy.

The checkout workflow waits up to **10 minutes** for a payment signal before timing out and releasing the hold. Free orders skip the wait and finalize synchronously.

## Replay Safety

For replay to succeed, workflow code must be deterministic:

- **No random values, clocks, or network calls inside workflows.** All non-determinism lives in activities.
- **No `Date.now()` / `Math.random()` in workflow bodies.** Use signals and activity results for time-sensitive logic.
- **No iterating over `Map`/`Set` with non-deterministic order.** Use arrays or sort first.
- **Side effects only through activities.** The workflow orchestrates; activities mutate DBs, call providers, and send messages.
- **Always use `proxyActivities`** for any I/O. Never import a service client and call it directly in a workflow.

The checkout workflow follows this pattern: it uses `setHandler` for `paymentSucceeded`/`paymentFailed`/`cancelCheckout` signals, `condition()` for the payment wait, and `startChild` for webhook delivery sub-workflows. Replaying an in-flight checkout will re-await the condition and re-emit signals correctly.

## Incident Recovery

See [Incident Runbooks](./incident-runbooks.md) for step-by-step recovery procedures. Temporal-specific tools:

- **Temporal UI** (`http://localhost:8080` locally): inspect running/completed/failed workflows, view event history, and terminate or retry executions.
- **`temporal` CLI**: `temporal workflow list`, `temporal workflow show --id <workflowId>`, `temporal workflow signal --name <signal> --input '<json>'`.
- **Worker restart**: safe for all workflows; in-flight executions resume from their last event. The hold-expiration workflow auto-restarts on boot if not already running.

### Recovering stuck workflows

1. Find the workflow ID in Temporal UI (e.g. `checkout-session:cs_...`).
2. Inspect the event history to identify the stuck activity or signal wait.
3. If waiting on a signal that will never come (e.g. an orphaned payment), signal `cancelCheckout` to release the hold and close the workflow.
4. If an activity is repeatedly failing, fix the underlying issue (DB, provider) and let the retry policy recover. For non-retryable failures, terminate the workflow and re-start from the API after repairing state.
5. For refund/reconciliation workflows stuck after a provider outage, replay the original provider webhook (Stripe/Telnyx) or use the admin replay endpoint to re-queue webhook deliveries.

## Testing

Workflow tests live in `packages/workflows/src/__tests__` and use the Temporal testing environment (`TestWorkflowEnvironment`). Tests cover happy path, retry, timeout, duplicate signal, provider retry, non-retryable failure, full/partial refund, and compensation. Run them with:

```bash
bun run --env-file=.env.local --filter @gatekit/workflows test:unit
```
