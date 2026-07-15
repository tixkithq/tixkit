# `@tixkit/sveltekit`

## Purpose

SvelteKit server/client integration and a packaged checkout widget component.

## Consumers

SvelteKit endpoints, server loads/actions, and Svelte 5 pages.

## Status

Public SDK at version 0.1.0 and API version `2026-08-06`; pre-1.0 exports may evolve with release notes.

## Installation

bun add @tixkit/sveltekit.

## Example

const client = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY!, baseUrl: process.env.TIXKIT_API_BASE_URL });

## Public exports

`./server`, `./client`, and `./TixkitWidget.svelte` exports.

## Runtime

TypeScript ES modules; build and runtime peers are declared in `package.json`.

## Configuration

Pass `apiKey` and optional `baseUrl` explicitly. Use `TIXKIT_API_KEY` and `TIXKIT_API_BASE_URL` in server environment configuration.

## Security

Use private server environment modules for credentials; expose only public checkout configuration.

## Validation

bun run --filter @tixkit/sveltekit typecheck && bun run --filter @tixkit/sveltekit lint && bun run --filter @tixkit/sveltekit test:unit && bun run --filter @tixkit/sveltekit build

## Compatibility

Tracks API version `2026-08-06`; framework peer versions and subpath exports are the compatibility boundary.

## Related guides

[SvelteKit SDK guide](../../docs/public/sdks/sveltekit.mdx)
