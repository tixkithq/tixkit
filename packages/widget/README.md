# `@tixkit/widget`

## Purpose

Browser custom elements implementing Embed Contract v1 as `tixkit-widget` and `tixkit-button`.

## Consumers

HTML sites, CMS hosts, and framework SDKs embedding Tixkit checkout.

## Status

Public browser package; its custom-element and lifecycle contract is stable within Embed Contract v1.

## Installation

`bun add @tixkit/widget`, then import the module once in the browser.

## Example

`import '@tixkit/widget'; document.body.innerHTML = '<tixkit-widget event-id="evt_public"></tixkit-widget>';`

## Public exports

The package root exports `TixkitWidget`, `TixkitButton`, and all runtime and type exports from
`@tixkit/embed-core`. The lean `@tixkit/widget/browser` entry exports the widget classes and version
at runtime plus the embed contract types; it is the entry used for the immutable CDN artifact.

## Runtime

Modern browsers with Custom Elements, DOM, and `postMessage`; build tooling uses Bun/TypeScript.

## Configuration

Element attributes configure event, mode, theme, and trusted checkout origin; no API key is accepted.

## Security

Restrict message origins, deploy a deliberate CSP, and never expose server API keys or scanner secrets in widget markup.

## Validation

`bun run --filter @tixkit/widget typecheck && bun run --filter @tixkit/widget lint && bun run --filter @tixkit/widget test:unit && bun run --filter @tixkit/widget build`

## Compatibility

Widget releases must stay compatible with `@tixkit/embed-core` contract major 1.

## Related guides

[Widget embed guide](../../docs/public/developers/widget/embedding.mdx)
