# `@tixkit/workflows`

## Purpose

Temporal workflows, activities, worker startup, retry boundaries, and durable operational orchestration.

## Consumers

API command handlers, the Temporal worker process, provider integrations, and operational tests.

## Status

Private deployable service package; workflow determinism and compatibility are release constraints.

## Installation

Add it as a `workspace:*` dependency; run the worker with `bun run --filter @tixkit/workflows dev`.

## Example

`await client.workflow.start(checkoutSessionWorkflow, { taskQueue: 'tixkit', args: [input], workflowId });`

## Public exports

Workflow/activity functions and shared serializable types from the root; worker/config modules are service entry points.

## Runtime

Node.js 22+, Temporal, database, Redis, and configured payment/messaging/storage providers.

## Configuration

Requires Temporal/database/Redis settings; optional worker concurrency, OTEL, export storage, email, SMS, and provider variables are documented in self-hosting guides.

## Security

Keep workflow code deterministic, isolate I/O in activities, redact payloads, and use durable idempotency for provider side effects.

## Validation

`bun run --filter @tixkit/workflows typecheck && bun run --filter @tixkit/workflows lint && bun run --filter @tixkit/workflows test:unit && bun run --filter @tixkit/workflows test:integration`

## Compatibility

Do not rename deployed workflows/activities or change serialized inputs without a compatible rollout strategy.

## Related guides

[Temporal operations](../../docs/public/operations/temporal.mdx)
