# `@tixkit/content-message`

## Purpose

SMS template schema, normalization, validation, rendering, length analysis, and test-send contracts.

## Consumers

Messaging APIs, dashboard SMS studio, and Temporal notification activities.

## Status

Private workspace package for supported SMS channels.

## Installation

Add it as a `workspace:*` dependency.

## Example

`const rendered = renderSmsTemplate(document, variables);`

## Public exports

SMS document/settings types, defaults, normalizer, validator, renderer, short-link suggestions, and test-send types.

## Runtime

TypeScript ES modules on server runtimes; validation utilities are runtime-neutral.

## Configuration

No environment variables; transport and sender configuration belong to workflow/API layers.

## Security

Apply consent and suppression checks before delivery; never interpolate secrets or unvalidated recipient-controlled content.

## Validation

`bun run --filter @tixkit/content-message typecheck && bun run --filter @tixkit/content-message lint && bun run --filter @tixkit/content-message test:unit`

## Compatibility

SMS schema version changes require coordinated persistence, studio, and notification-workflow updates.

## Related guides

[Messaging operations](../../docs/public/operators/messaging.mdx)
