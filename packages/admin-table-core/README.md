# `@tixkit/admin-table-core`

## Purpose

Private workspace contract for serializable admin-table schemas, filters, cursors, query validation, and URL state.

## Consumers

Admin dashboard table features and API/database adapters that share table query semantics.

## Status

Internal and evolving with the monorepo; not published.

## Installation

`bun install` at the repository root, then depend on `@tixkit/admin-table-core` with `workspace:*`.

## Example

`const query = paramsToQuery(new URLSearchParams(location.search));`

## Public exports

Table schema and query types, cursor codecs, filter helpers, URL converters, and Zod query validation.

## Runtime

ES modules on Bun or Node.js after build; browser-safe URL helpers.

## Configuration

No environment variables. Callers supply schemas, cursor secrets where required, and URL parameters.

## Security

Treat cursors and query input as untrusted; validate before database use and never expose sensitive filter values in URLs.

## Validation

`bun run --filter @tixkit/admin-table-core typecheck && bun run --filter @tixkit/admin-table-core lint && bun run --filter @tixkit/admin-table-core test:unit`

## Compatibility

Versioned with the workspace; producers and consumers must update together.

## Related guides

[Repository architecture](../../docs/public/contributing/architecture.mdx)
