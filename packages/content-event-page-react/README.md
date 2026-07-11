# `@tixkit/content-event-page-react`

## Purpose

React renderer and Puck configuration for canonical Tixkit event-page documents.

## Consumers

Public event pages, checkout previews, and dashboard event-page editor.

## Status

Private React 19 implementation of `@tixkit/content-event-page`.

## Installation

Add it as a `workspace:*` dependency and import `styles.css` once in the host.

## Example

`<EventPage document={document} event={event} />`

## Public exports

Root React renderer/components, `./puck` editor configuration, and `./styles.css`.

## Runtime

React 19 browser/SSR environments; Puck editor code is isolated behind the subpath export.

## Configuration

No environment variables; callers provide event, checkout URLs, assets, and canonical documents.

## Security

Only render validated documents; sanitize external URLs and keep privileged event data out of public props.

## Validation

`bun run --filter @tixkit/content-event-page-react typecheck && bun run --filter @tixkit/content-event-page-react lint && bun run --filter @tixkit/content-event-page-react test:unit`

## Compatibility

Must use the same event-page schema version as `@tixkit/content-event-page`.

## Related guides

[Event operations](../../docs/public/operators/events.mdx)
