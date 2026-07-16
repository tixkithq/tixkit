# `@tixkit/provider-clients`

## Purpose

Internal outbound-provider execution and narrow messaging/payment client adapters.

## Consumers

Server-side transport, workflow, and API packages that call external providers.

## Status

Private open-core runtime boundary. It is public source but not a supported integrator SDK.

## Installation

Add it as a `workspace:*` dependency. Business code should depend on a narrow provider interface rather than construct vendor SDKs or call provider URLs directly.

## Example

`const result = await client.sendSms({ from, to, body, idempotencyKey });`

## Public exports

Normalized provider errors, the shared HTTP executor, telemetry contracts, and provider-specific operations used by Tixkit.

## Runtime

TypeScript ES modules on server runtimes with standards-compatible `fetch` and `AbortController` implementations.

## Configuration

Callers provide credentials, provider base URLs, explicit deadlines, and optional telemetry listeners. The package performs no hidden retry.

## Security

Redirects are rejected rather than followed with provider credentials or message bodies. Errors expose
only bounded diagnostic shapes with provider-controlled values redacted; provider request identifiers
are represented by stable SHA-256 correlation tokens. Authorization material, secrets, payment tokens,
personal data, and unrestricted bodies must not leave this boundary. Ambiguous failures from
side-effecting operations are non-retryable until an adapter has executable provider deduplication or
reconciliation proof.

## Validation

`bun run --filter @tixkit/provider-clients typecheck && bun run --filter @tixkit/provider-clients lint && bun run --filter @tixkit/provider-clients test:unit`

## Compatibility

Retry classification and provider request/response mappings are runtime contracts. Change them only with failure-injection and owning workflow tests.

## Related guides

[Outbound provider client ADR](../../docs/internal/architecture/outbound-provider-clients.md)
