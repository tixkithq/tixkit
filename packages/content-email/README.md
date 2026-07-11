# `@tixkit/content-email`

## Purpose

Email-template schemas, studio definitions, rendering, and theme support built on React Email.

## Consumers

Email content APIs, dashboard studio, seed tooling, and notification workflows.

## Status

Private workspace package; rendered output is production-facing and must remain deterministic.

## Installation

Add it as a `workspace:*` dependency; use server-side rendering entry points.

## Example

`const html = await renderEmailTemplate({ document, variables });`

## Public exports

Email template document helpers, validation/rendering functions, studio sections/templates, and theme contracts.

## Runtime

Node.js/Bun server rendering with React 19 and React Email packages.

## Configuration

No transport credentials are read here; callers provide template data and validated variables.

## Security

Sanitize variables, avoid secrets in template data, and rely on the transport layer for recipient and delivery controls.

## Validation

`bun run --filter @tixkit/content-email typecheck && bun run --filter @tixkit/content-email lint && bun run --filter @tixkit/content-email test:unit`

## Compatibility

Template schema changes require fixture, seed, workflow, and rendered-output test updates.

## Related guides

[Messaging operations](../../docs/public/operators/messaging.mdx)
