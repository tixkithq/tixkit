# `@tixkit/astro`

## Purpose

Astro server/client helpers over `@tixkit/js`.

## Consumers

Astro integrations using server-side credentials and browser-safe checkout helpers.

## Status

Public SDK at version 0.1.0 and API version `2026-07-19`; pre-1.0 exports may evolve with release notes.

## Installation

bun add @tixkit/astro.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

`./server` creates clients and verifies webhooks; `./client` builds widget/checkout URLs.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass `apiKey` and optional `baseUrl` explicitly. Use `TIXKIT_API_KEY` and `TIXKIT_API_BASE_URL` in server environment configuration.

## Security

Astro server routes must keep API keys server-only.

## Validation

bun run --filter @tixkit/astro typecheck && bun run --filter @tixkit/astro lint && bun run --filter @tixkit/astro test:unit && bun run --filter @tixkit/astro build

## Compatibility

Tracks API version `2026-07-19`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[Astro SDK guide](../../docs/public/sdks/astro.mdx)
