# `@tixkit/api`

## Purpose

Private Fastify HTTP service implementing Tixkit’s authenticated and public API routes.

## Consumers

The API server, local development stack, integration tests, dashboard, checkout, and SDK contract generation.

## Status

Internal deployable service; its public contract is the generated OpenAPI document.

## Installation

`bun install` at the repository root; run with `bun run --filter @tixkit/api dev`.

## Example

`const app = await buildApp({ database, redis }); await app.listen({ port: 3001 });`

## Public exports

Runtime entry points are `src/server.ts` and `src/app.ts`; route modules are service internals, not a published library surface.

## Runtime

Node.js 22+ or Bun-compatible tooling, PostgreSQL/MySQL/SQL Server, Redis, and Temporal for durable operations.

## Configuration

Uses the root environment contract for database, Redis, Temporal, auth, storage, payment, email, observability, and host URLs.

## Security

Keep API keys server-side; enforce tenant, organization, brand, and permission scopes at route boundaries; never log secrets or raw payment data.

## Validation

`bun run --filter @tixkit/api typecheck && bun run --filter @tixkit/api lint && bun run --filter @tixkit/api test:unit && bun run --filter @tixkit/api test:integration`

## Compatibility

Routes must remain synchronized with `@tixkit/openapi`, SDK API version `2026-09-04`, and dashboard client types.

## Related guides

[Repository architecture](../../docs/public/contributing/architecture.mdx), [API reference](../../docs/public/reference/api/index.mdx)
