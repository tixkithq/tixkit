# `@tixkit/shared`

## Purpose

Cross-cutting identifiers, cryptographic helpers, pagination, auth-provider interfaces, redaction, telemetry, and metrics.

## Consumers

API, workflows, provider adapters, and tests.

## Status

Private workspace utilities; security-sensitive helpers require compatibility review.

## Installation

Add it as a `workspace:*` dependency.

## Example

`const { key, hashedKey, keyPrefix } = generateApiKey();`

## Public exports

Auth-provider contracts, ID/hash/signature/API-key/webhook helpers, pagination, masking, and observability utilities.

## Runtime

Node.js 22+ ES modules; OpenTelemetry exporters require a server runtime.

## Configuration

Observability honors `OTEL_SDK_DISABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and standard service metadata supplied by callers.

## Security

Store only hashed API keys, compare signatures safely, and use exported redaction helpers before logging errors or attributes.

## Validation

`bun run --filter @tixkit/shared typecheck && bun run --filter @tixkit/shared lint && bun run --filter @tixkit/shared test:unit`

## Compatibility

Cryptographic and observability changes must retain API/workflow behavior and existing serialized formats.

## Related guides

[Observability](../../docs/public/self-hosting/observability.mdx)
