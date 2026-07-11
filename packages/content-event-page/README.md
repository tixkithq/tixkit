# `@tixkit/content-event-page`

## Purpose

Framework-neutral event-page document schema, Puck contract, normalization, validation, and migration logic.

## Consumers

Event-page API/persistence, React renderer, editor, checkout, and public event surfaces.

## Status

Private canonical content contract, currently schema version 2.

## Installation

Add it as a `workspace:*` dependency; import Puck-only contracts from `@tixkit/content-event-page/puck`.

## Example

`const page = normalizeEventPageDocument(input);`

## Public exports

Event-page document/settings types, component catalogs, validators, normalizers, migrations, and `./puck` contracts.

## Runtime

TypeScript ES modules without a UI runtime.

## Configuration

No environment variables; brand, event, and content values are explicit inputs.

## Security

Validate untrusted documents and URLs before persistence or rendering; do not embed secrets in page content.

## Validation

`bun run --filter @tixkit/content-event-page typecheck && bun run --filter @tixkit/content-event-page lint && bun run --filter @tixkit/content-event-page test:unit`

## Compatibility

Schema-version changes must preserve migration paths and coordinate with React rendering and stored content.

## Related guides

[Event operations](../../docs/public/operators/events.mdx)
