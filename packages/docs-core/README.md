# `@tixkit/docs-core`

## Purpose

Shared documentation route, frontmatter, search, Help registry, readiness, and SDK-snippet contracts.

## Consumers

Documentation app, admin dashboard Help/onboarding/developer surfaces, and validators.

## Status

Private workspace source of truth for documentation integration contracts.

## Installation

Add it as a `workspace:*` dependency.

## Example

`const href = documentationRoutes.apiReference.path;`

## Public exports

Validated content metadata, canonical route registry, navigation-facing Help entries, search types, readiness re-exports, and SDK snippets.

## Runtime

TypeScript ES modules; contracts are usable in Next.js server and client code.

## Configuration

`NEXT_PUBLIC_TIXKIT_DOCS_URL` is interpreted by consuming apps, not by this package.

## Security

Route IDs are safer than arbitrary URLs; snippets must use environment variables and never contain real credentials.

## Validation

`bun run --filter @tixkit/docs-core typecheck && bun run --filter @tixkit/docs-core lint && bun run --filter @tixkit/docs-core test:unit`

## Compatibility

Route removals require redirects and dashboard-link updates; readiness types follow `@tixkit/domain`.

## Related guides

[Repository architecture](../../docs/public/contributing/architecture.mdx)
