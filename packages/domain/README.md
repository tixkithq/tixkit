# `@tixkit/domain`

## Purpose

Canonical runtime-independent business types, Zod schemas, invariants, errors, and readiness contracts.

## Consumers

Database, API, workflows, content packages, CLI, and tests.

## Status

Private foundational package; contracts change only with coordinated consumers and persistence.

## Installation

Add it as a `workspace:*` dependency and import the narrowest published subpath.

## Example

`const input = createCheckoutSessionSchema.parse(payload);`

## Public exports

Root exports and subpaths for tenant, identity, events, readiness, ticketing, pricing, checkout, payments, tickets, forms, messaging, reporting, developer, and eligibility.

## Runtime

TypeScript ES modules with Zod; no database or network runtime.

## Configuration

No environment variables; all business inputs and clocks/providers are explicit.

## Security

Validate every trust-boundary payload and preserve tenant/organization/brand identifiers through domain operations.

## Validation

`bun run --filter @tixkit/domain typecheck && bun run --filter @tixkit/domain lint && bun run --filter @tixkit/domain test:unit`

## Compatibility

Domain changes require API/OpenAPI/SDK/database/workflow parity in the same slice.

## Related guides

[System architecture](../../docs/public/contributing/architecture.mdx)
