# `@tixkit/embed-core`

## Purpose

Dependency-free Embed Contract v1 types, validation, lifecycle messages, generators, and CSP guidance.

## Consumers

Widget hosts, framework SDKs, CLI embed generation, and documentation examples.

## Status

Public package at contract version 1.0; compatibility is governed by the exported contract major.

## Installation

`bun add @tixkit/embed-core`.

## Example

`const result = generateEmbedSnippet({ eventId, mode: 'inline', widgetScriptUrl });`

## Public exports

Root contract constants/types/validators/generators; schema and fixture files; package metadata subpath.

## Runtime

ES modules in browsers, Node.js 22+, SSR, CLIs, and documentation builds.

## Configuration

No environment variables; production callers must pass an immutable trusted `widgetScriptUrl`.

## Security

Validate host configuration and `postMessage` origins; derive CSP deliberately and never place API secrets in embed attributes.

## Validation

`bun run --filter @tixkit/embed-core typecheck && bun run --filter @tixkit/embed-core lint && bun run --filter @tixkit/embed-core test:unit`

## Compatibility

Contract-major changes are breaking; legacy lifecycle aliases are compatibility-only.

## Related guides

[Widget embed guide](../../docs/public/developers/widget/embedding.mdx)
