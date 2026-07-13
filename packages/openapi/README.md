# `@tixkit/openapi`

## Purpose

Canonical OpenAPI 3.1 document and TypeScript reference/type-generation utilities for Tixkit APIs.

## Consumers

API contract tests, documentation reference generation, SDK parity, and external integrators downloading the spec.

## Status

Public contract package; generated artifacts must match runtime routes.

## Installation

`bun add @tixkit/openapi`, or consume the downloadable JSON from the documentation app.

## Example

`const spec = createOpenApiDocument();`

## Public exports

OpenAPI document/schema types, document factory, and `generateOpenApiTypes`.

## Runtime

TypeScript ES modules on Node.js/Bun; emitted JSON is runtime-neutral.

## Configuration

No environment variables; server URLs and examples are sanitized contract metadata.

## Security

Security schemes and scopes must match enforcement; examples cannot contain credentials, customer data, or private hosts.

## Validation

`bun run --filter @tixkit/openapi typecheck && bun run --filter @tixkit/openapi lint && bun run --filter @tixkit/openapi test:unit`

## Compatibility

Operation IDs, current API version `2026-07-13`, SDK exports, dashboard types, and docs reference must remain synchronized.

## Related guides

[API reference](../../docs/public/reference/api/index.mdx)
