# `@tixkit/content-editor-shell`

## Purpose

Reusable React editing shell controls shared by Tixkit content studios.

## Consumers

Admin dashboard content editors for event pages, email, and messages.

## Status

Private UI package coupled to the dashboard’s React 19 stack.

## Installation

Add it as a `workspace:*` dependency and import its compiled root export.

## Example

`<EditorToolbar title="Event page" actions={actions} />`

## Public exports

Editor shell, toolbar, panel, field, preview, and `cn` styling utilities exported from the root.

## Runtime

React 19 ES modules with Radix UI, Lucide, and Tailwind-compatible classes.

## Configuration

No environment variables; parent editors own persistence, permissions, and preview data.

## Security

Do not place credentials or unsanitized HTML in editor props; authorization remains a server/API responsibility.

## Validation

`bun run --filter @tixkit/content-editor-shell typecheck && bun run --filter @tixkit/content-editor-shell lint && bun run --filter @tixkit/content-editor-shell test:unit`

## Compatibility

Private workspace API; coordinate component-prop changes with every editor consumer.

## Related guides

[Repository architecture](../../docs/public/contributing/architecture.mdx)
