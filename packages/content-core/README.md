# `@tixkit/content-core`

## Purpose

Channel-neutral content document, version, validation, and render-contract primitives.

## Consumers

Event-page, email, SMS, editor, API, and persistence packages.

## Status

Private stable workspace foundation; channels marked unsupported by its constants are not production features.

## Installation

Add `@tixkit/content-core` as a `workspace:*` dependency.

## Example

`const result = validateContentVersion(version, RENDER_CONTRACTS.email);`

## Public exports

Content channel/status types, document/version contracts, render contracts, schema version constants, and content validation.

## Runtime

TypeScript ES modules on server and browser runtimes.

## Configuration

No environment variables; callers pass content values and channel render contracts.

## Security

Validate untrusted document payloads before rendering and escape output in the channel-specific renderer.

## Validation

`bun run --filter @tixkit/content-core typecheck && bun run --filter @tixkit/content-core lint && bun run --filter @tixkit/content-core test:unit`

## Compatibility

Schema changes require coordinated migrations and renderer updates across content packages.

## Related guides

[Repository architecture](../../docs/public/contributing/architecture.mdx)
